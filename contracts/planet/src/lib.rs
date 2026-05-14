#![no_std]

mod dna;
mod drand;
mod galaxy;
mod stats;

#[cfg(test)]
mod test;

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, BytesN, Env,
    String,
};
use stellar_tokens::non_fungible::{
    enumerable::{Enumerable, NonFungibleEnumerable},
    Base, NonFungibleToken,
};

use crate::drand::DrandClient;
use crate::stats::{Care, Vitals};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Drand,
    ConjoinCooldown,
    Dna(u32),
    Vitals(u32),
    Coords(u32),
    LastConjoin(u32),
    NextCommitmentId,
    Commitment(u32),
    /// Recessive allele blob (R1 + R2 per trait slot). Absent for planets
    /// minted before the dominance system shipped — those legacy planets
    /// behave as if they carried all-zero recessives.
    Latent(u32),
    /// Civilization tier (u8 in 0..=4). Stored as an additive key — *not*
    /// folded into the Vitals struct — so pre-civ-tier planets keep
    /// deserializing. Absent ⇒ tier 0 (Primitive).
    CivTier(u32),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotAdmin = 1,
    NotOwner = 2,
    DrandUnavailable = 3,
    UnknownPlanet = 4,
    SameParent = 5,
    OnCooldown = 6,
    InvalidCareAction = 7,
    Unhealthy = 8,
    RecipientNotParentOwner = 9,
    CooldownOutOfRange = 10,
    UnknownCommitment = 11,
    CommitmentNotReady = 12,
    InvalidCommitmentKind = 13,
}

/// Anti-grinding commit-reveal: two-step flow for mint_genesis and conjoin.
///
/// On commit, the contract stores `target_round = observed_round + LOOKAHEAD`
/// plus the current ledger seq. On reveal, the contract independently
/// requires `now >= commit_ledger + MIN_REVEAL_DELAY_LEDGERS` — a wide gap
/// that drand cannot have published `target_round` for *before* the user's
/// commit. So the user could not have peeked the randomness at commit time,
/// eliminating the "simulate-grind-pick-favorable-round" attack the audit
/// flagged as Critical #1/#2.
///
/// LOOKAHEAD_ROUNDS — how far ahead of `observed_round` the contract pins
/// the target. 10 rounds × 3 s/round = 30 s buffer.
///
/// MIN_REVEAL_DELAY_LEDGERS — minimum elapsed ledgers between commit and
/// reveal. At ~5 s/ledger and ~3 s/drand-round, 8 ledgers ≈ 40 s ≈ 13
/// rounds — comfortably more than LOOKAHEAD_ROUNDS so the target's
/// randomness must have been generated *after* commit.
pub const LOOKAHEAD_ROUNDS: u64 = 10;
pub const MIN_REVEAL_DELAY_LEDGERS: u32 = 8;

/// Tuple variants are required by Soroban's #[contracttype] enum encoding.
/// `Genesis(x, y)` and `Conjoin(parent_a, parent_b)`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommitmentKind {
    Genesis(i32, i32),
    Conjoin(u32, u32),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Commitment {
    pub committer: Address,
    pub to: Address,
    pub target_round: u64,
    pub commit_ledger: u32,
    pub kind: CommitmentKind,
}

/// Emitted on every new planet creation (both genesis mint and conjoin
/// child). Complements — does not replace — the OpenZeppelin `Mint` event
/// that `sequential_mint` fires for any NFT indexer. `Born` carries
/// Cosmocopia-specific genetics: which drand round seeded the DNA and how
/// many generations deep the lineage is.
///
/// Owner is in the topic vector so indexers can filter "all planets born to
/// address X" without scanning the entire event stream.
#[contractevent(topics = ["born"])]
pub struct Born {
    #[topic]
    pub owner: Address,
    pub id: u32,
    pub generation: u32,
    pub drand_round: u64,
}

#[contractevent(topics = ["conjoin"])]
pub struct Conjoin {
    pub child: u32,
    pub parent_a: u32,
    pub parent_b: u32,
    pub drand_round: u64,
}

/// Emitted once per trait slot when a child's expressed D byte equals
/// neither parent's visible D for that slot — i.e. a hidden recessive
/// surfaced. Lets off-chain indexers build "your planet inherited X from
/// grandparent Y" UX without re-reading both parent latents (audit I5).
#[contractevent(topics = ["recessive"])]
pub struct RecessiveEmerged {
    pub id: u32,
    pub trait_index: u32,
    pub allele: u32,
}

#[contractevent(topics = ["care"])]
pub struct Cared {
    pub id: u32,
    pub action: u32,
}

/// Emitted on every new planet creation (genesis + conjoin) with the
/// expressed population type (0..5). Frontends can index by `id` to drive
/// "your planet birthed an Avian colony" UX without reading the latent blob.
#[contractevent(topics = ["pop"])]
pub struct PopulationExpressed {
    #[topic]
    pub id: u32,
    pub population: u32, // 0..5 — see art/src/scene.ts:POPULATIONS
}

/// Emitted whenever `care` ratchets a planet's civ_tier up. Pinned `from`/`to`
/// types are u32 because contractevent macros don't accept u8 directly.
#[contractevent(topics = ["civ"])]
pub struct CivTierChanged {
    #[topic]
    pub id: u32,
    pub from: u32,
    pub to: u32,
}

#[contractevent(topics = ["moved"])]
pub struct Moved {
    pub id: u32,
    pub x: i32,
    pub y: i32,
}

/// Emitted whenever an admin changes a contract-level configuration value
/// (cooldown window, admin rotation, drand verifier rotation). Off-chain
/// indexers can use this for an audit trail of governance actions.
#[contractevent(topics = ["config"])]
pub struct ConfigChanged {
    pub key: soroban_sdk::Symbol,
    pub value: u64,
}

/// Emitted at commit time so the frontend can show pending commitments and
/// know when they become revealable. `target_round` lets a watcher poll the
/// drand verifier to see if randomness has been published.
#[contractevent(topics = ["committed"])]
pub struct Committed {
    #[topic]
    pub committer: Address,
    pub commitment_id: u32,
    pub target_round: u64,
    pub reveal_after_ledger: u32,
}

#[contract]
pub struct PlanetContract;

const DEFAULT_COOLDOWN: u32 = 720; // ~1h at 5s ledgers
const TTL_THRESHOLD: u32 = 17_280; // ~1 day
const TTL_EXTEND_TO: u32 = 518_400; // ~30 days

// set_cooldown bounds (audit Low #1): keep admin from disabling cooldowns
// entirely (0) or pinning them at u32::MAX (effective DoS for breeding).
const MIN_COOLDOWN: u32 = 30; // ~2.5 min
const MAX_COOLDOWN: u32 = 30 * 17_280; // ~30 days

#[contractimpl]
impl PlanetContract {
    pub fn __constructor(
        e: &Env,
        admin: Address,
        drand: Address,
        uri: String,
        name: String,
        symbol: String,
    ) {
        e.storage().instance().set(&DataKey::Admin, &admin);
        e.storage().instance().set(&DataKey::Drand, &drand);
        e.storage()
            .instance()
            .set(&DataKey::ConjoinCooldown, &DEFAULT_COOLDOWN);
        Base::set_metadata(e, uri, name, symbol);
    }

    /// Admin-only: commit to a genesis mint. `observed_round` is the
    /// caller's view of the current drand round; the contract stores
    /// `target_round = observed_round + LOOKAHEAD_ROUNDS`. Reveal can land
    /// after MIN_REVEAL_DELAY_LEDGERS ledgers, at which point the target
    /// round's randomness exists and the user could not have predicted it
    /// at commit time. Closes audit Critical #1/#2 (DNA grinding).
    pub fn commit_genesis(
        e: &Env,
        to: Address,
        observed_round: u64,
        x: i32,
        y: i32,
    ) -> Result<u32, Error> {
        let admin = require_admin(e)?;
        admin.require_auth();
        let now = e.ledger().sequence();
        let id = stash_commitment(
            e,
            Commitment {
                committer: admin,
                to,
                target_round: observed_round + LOOKAHEAD_ROUNDS,
                commit_ledger: now,
                kind: CommitmentKind::Genesis(x, y),
            },
        );
        Ok(id)
    }

    /// Reveal a previously committed genesis mint. Anyone can call (the
    /// commitment carries the recipient) — but reveal will fail if the
    /// minimum reveal delay hasn't passed or the drand round still isn't
    /// available.
    pub fn reveal_genesis(e: &Env, commitment_id: u32) -> Result<u32, Error> {
        let c = take_commitment(e, commitment_id)?;
        let (x, y) = match c.kind {
            CommitmentKind::Genesis(x, y) => (x, y),
            _ => return Err(Error::InvalidCommitmentKind),
        };
        let now = e.ledger().sequence();
        if now < c.commit_ledger.saturating_add(MIN_REVEAL_DELAY_LEDGERS) {
            return Err(Error::CommitmentNotReady);
        }

        let seed = random_at(e, c.target_round)?;
        let token_id = Enumerable::sequential_mint(e, &c.to);
        let dna = dna::from_seed(e, &seed, c.target_round, token_id);
        let latent = dna::latent_from_seed(e, &seed, token_id);
        write_planet(e, token_id, &dna, (x, y));
        e.storage()
            .persistent()
            .set(&DataKey::Latent(token_id), &latent);
        e.storage().persistent().extend_ttl(
            &DataKey::Latent(token_id),
            TTL_THRESHOLD,
            TTL_EXTEND_TO,
        );
        // Genesis planets start at civ_tier 0 (Primitive).
        e.storage()
            .persistent()
            .set(&DataKey::CivTier(token_id), &0u32);
        e.storage().persistent().extend_ttl(
            &DataKey::CivTier(token_id),
            TTL_THRESHOLD,
            TTL_EXTEND_TO,
        );

        let population = dna::population_of_latent(&latent.to_array()) as u32;
        Born {
            owner: c.to,
            id: token_id,
            generation: 0,
            drand_round: c.target_round,
        }
        .publish(e);
        PopulationExpressed {
            id: token_id,
            population,
        }
        .publish(e);
        e.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(token_id)
    }

    /// Commit to conjoining two parents. Same anti-grinding flow as
    /// commit_genesis: target_round is pinned to a future drand round so
    /// the user can't peek the seed at commit time.
    ///
    /// `to` must be one of the parents' owners (audit High #1).
    pub fn commit_conjoin(
        e: &Env,
        parent_a: u32,
        parent_b: u32,
        to: Address,
        observed_round: u64,
    ) -> Result<u32, Error> {
        if parent_a == parent_b {
            return Err(Error::SameParent);
        }
        let owner_a = Base::owner_of(e, parent_a);
        let owner_b = Base::owner_of(e, parent_b);
        owner_a.require_auth();
        if owner_a != owner_b {
            owner_b.require_auth();
        }
        if to != owner_a && to != owner_b {
            return Err(Error::RecipientNotParentOwner);
        }

        let now = e.ledger().sequence();
        check_cooldown(e, parent_a, now)?;
        check_cooldown(e, parent_b, now)?;

        // Health gate uses *current* vitals: an unhealthy planet can't even
        // start the breeding process, not just finish it.
        let vit_a = current_vitals_for_id(e, parent_a, now)?;
        let vit_b = current_vitals_for_id(e, parent_b, now)?;
        if stats::healthy_factor(&vit_a) < 40 || stats::healthy_factor(&vit_b) < 40 {
            return Err(Error::Unhealthy);
        }

        // Cooldown both parents the moment the commitment is in flight so
        // the same parents can't be double-committed before reveal.
        e.storage()
            .persistent()
            .set(&DataKey::LastConjoin(parent_a), &now);
        e.storage()
            .persistent()
            .set(&DataKey::LastConjoin(parent_b), &now);

        let id = stash_commitment(
            e,
            Commitment {
                committer: owner_a,
                to,
                target_round: observed_round + LOOKAHEAD_ROUNDS,
                commit_ledger: now,
                kind: CommitmentKind::Conjoin(parent_a, parent_b),
            },
        );
        Ok(id)
    }

    /// Reveal a previously committed conjoin. Anyone can call.
    pub fn reveal_conjoin(e: &Env, commitment_id: u32) -> Result<u32, Error> {
        let c = take_commitment(e, commitment_id)?;
        let (parent_a, parent_b) = match c.kind {
            CommitmentKind::Conjoin(parent_a, parent_b) => (parent_a, parent_b),
            _ => return Err(Error::InvalidCommitmentKind),
        };
        let now = e.ledger().sequence();
        if now < c.commit_ledger.saturating_add(MIN_REVEAL_DELAY_LEDGERS) {
            return Err(Error::CommitmentNotReady);
        }

        let dna_a = read_dna(e, parent_a)?;
        let dna_b = read_dna(e, parent_b)?;
        let coords_a = read_coords(e, parent_a)?;
        let coords_b = read_coords(e, parent_b)?;
        let class_a = dna::class_of(&dna_a.to_array());
        let class_b = dna::class_of(&dna_b.to_array());
        let vit_a = stats::project(&read_vitals(e, parent_a)?, now, class_a, coords_a);
        let vit_b = stats::project(&read_vitals(e, parent_b)?, now, class_b, coords_b);

        let seed = random_at(e, c.target_round)?;
        let child_id = Enumerable::sequential_mint(e, &c.to);
        // Read parents' latent blobs with a *visible-DNA* fallback for
        // pre-dominance genesis planets: when no Latent storage exists,
        // synthesize a latent whose R1[i] = R2[i] = the parent's visible D
        // byte for trait i. This collapses the dominance roll to "always
        // contribute D" for that parent (instead of "70% D, 30% 0x00" which
        // injected spurious zero-class/zero-surface alleles into descendant
        // lineages — audit M3).
        let latent_a = read_latent_for_breeding(e, parent_a, &dna_a);
        let latent_b = read_latent_for_breeding(e, parent_b, &dna_b);
        let (child_dna, child_latent) = dna::crossover_with_latent(
            e,
            &dna_a,
            &latent_a,
            &dna_b,
            &latent_b,
            &seed,
            c.target_round,
            child_id,
        );

        let child_coords = midpoint(coords_a, coords_b);
        write_planet(e, child_id, &child_dna, child_coords);
        e.storage()
            .persistent()
            .set(&DataKey::Latent(child_id), &child_latent);
        e.storage().persistent().extend_ttl(
            &DataKey::Latent(child_id),
            TTL_THRESHOLD,
            TTL_EXTEND_TO,
        );

        let starting = Vitals {
            temperature: (vit_a.temperature + vit_b.temperature) / 2,
            hydration: (vit_a.hydration + vit_b.hydration) / 2,
            gravity: (vit_a.gravity + vit_b.gravity) / 2,
            biomass: (vit_a.biomass + vit_b.biomass) / 2,
            spirit: (vit_a.spirit + vit_b.spirit) / 2,
            last_ledger: now,
        };
        e.storage()
            .persistent()
            .set(&DataKey::Vitals(child_id), &starting);

        // Child civ_tier = min(parent_a.civ_tier, parent_b.civ_tier). The
        // child can't exceed the *weaker* parent — a Primitive partner pins
        // the child at Primitive even when conjoined with a Spacefaring one.
        // Care progress beyond that is then earned per-planet. Both parents
        // default to 0 if their tier wasn't recorded (legacy planet) — note
        // that this means any conjoin with a legacy parent seeds the child
        // at tier 0 regardless of the other parent (audit M-3 — documented,
        // not changed in this pass; see test conjoin_with_legacy_parent_*).
        let tier_a = read_civ_tier(e, parent_a);
        let tier_b = read_civ_tier(e, parent_b);
        let child_tier = tier_a.min(tier_b);
        e.storage()
            .persistent()
            .set(&DataKey::CivTier(child_id), &(child_tier as u32));
        e.storage().persistent().extend_ttl(
            &DataKey::CivTier(child_id),
            TTL_THRESHOLD,
            TTL_EXTEND_TO,
        );

        // Re-extend parents' TTL since the conjoin reveal touched them.
        extend_planet_ttl(e, parent_a);
        extend_planet_ttl(e, parent_b);

        let population = dna::population_of_latent(&child_latent.to_array()) as u32;
        Born {
            owner: c.to,
            id: child_id,
            generation: child_dna.to_array()[dna::IDX_GENERATION] as u32,
            drand_round: c.target_round,
        }
        .publish(e);
        Conjoin {
            child: child_id,
            parent_a,
            parent_b,
            drand_round: c.target_round,
        }
        .publish(e);
        PopulationExpressed {
            id: child_id,
            population,
        }
        .publish(e);

        // Audit I5: emit one event per trait slot where the child's
        // expressed allele differs from BOTH parents' visible D — i.e. a
        // hidden recessive surfaced. Cheap inline comparison; no extra
        // storage reads since we still have parents' DNA in scope.
        let child_bytes = child_dna.to_array();
        let a_bytes = dna_a.to_array();
        let b_bytes = dna_b.to_array();
        for i in 0..dna::TRAIT_SLOTS {
            let cd = child_bytes[i];
            if cd != a_bytes[i] && cd != b_bytes[i] {
                RecessiveEmerged {
                    id: child_id,
                    trait_index: i as u32,
                    allele: cd as u32,
                }
                .publish(e);
            }
        }

        Ok(child_id)
    }

    /// Apply a care action. Caller must own the planet. Extends the planet's
    /// TTL — see audit Critical #4.
    ///
    /// After applying the care effect, `care` re-evaluates the planet's
    /// civ_signal (a 0..255 score from class-specific vital weights) and
    /// ratchets the stored civ_tier up if `signal / 51` exceeds it. Care
    /// never demotes — if the signal has fallen below the stored tier the
    /// planet keeps its current tier until the next ratchet evaluation.
    pub fn care(e: &Env, id: u32, action: u32) -> Result<(), Error> {
        let owner = Base::owner_of(e, id);
        owner.require_auth();

        let care = Care::from_u32(action).ok_or(Error::InvalidCareAction)?;
        let now = e.ledger().sequence();
        let dna = read_dna(e, id)?;
        let coords = read_coords(e, id)?;
        let class = dna::class_of(&dna.to_array());

        let projected = stats::project(&read_vitals(e, id)?, now, class, coords);
        let updated = stats::apply_care(&projected, class, care, now);
        e.storage().persistent().set(&DataKey::Vitals(id), &updated);

        // Civ-tier ratchet: target tier = signal / 51 (clamped to 4). Only
        // writes if `target > stored`. Demotion happens lazily — a fallen
        // signal doesn't persist a write here, the stored tier just stops
        // increasing until vitals recover.
        let signal = stats::civ_signal(&updated, class);
        let current = read_civ_tier(e, id);
        let target = core::cmp::min(4u8, signal / 51);
        if target > current {
            e.storage()
                .persistent()
                .set(&DataKey::CivTier(id), &(target as u32));
            CivTierChanged {
                id,
                from: current as u32,
                to: target as u32,
            }
            .publish(e);
        }

        extend_planet_ttl(e, id);

        Cared { id, action }.publish(e);
        Ok(())
    }

    /// Migrate a planet to new coords. Caller must own. Extends the planet's
    /// TTL — see audit Critical #4.
    pub fn migrate(e: &Env, id: u32, x: i32, y: i32) -> Result<(), Error> {
        let owner = Base::owner_of(e, id);
        owner.require_auth();
        // Touch the planet to make sure it still exists — closes a corner
        // case where the planet's DNA was evicted while migrate could
        // succeed on a brand-new coords entry.
        let _ = read_dna(e, id)?;
        e.storage().persistent().set(&DataKey::Coords(id), &(x, y));
        extend_planet_ttl(e, id);
        Moved { id, x, y }.publish(e);
        Ok(())
    }

    // ----- views -----
    // Views call extend_planet_ttl after every successful read so an actively-
    // viewed planet keeps its DNA/Vitals/Coords alive — closes audit Critical #4.

    pub fn dna_of(e: &Env, id: u32) -> Result<BytesN<32>, Error> {
        let dna = read_dna(e, id)?;
        extend_planet_ttl(e, id);
        Ok(dna)
    }

    /// Return the recessive allele blob (R1 + R2 per trait slot). For
    /// planets minted before the dominance system shipped, returns 32 zero
    /// bytes — those legacy planets carry no recessives.
    pub fn latent_of(e: &Env, id: u32) -> Result<BytesN<32>, Error> {
        // Confirm the planet exists first so we don't return a spurious
        // zero latent for an unknown id.
        let _ = read_dna(e, id)?;
        extend_planet_ttl(e, id);
        Ok(read_latent(e, id))
    }

    pub fn vitals_of(e: &Env, id: u32) -> Result<Vitals, Error> {
        let now = e.ledger().sequence();
        let dna = read_dna(e, id)?;
        let coords = read_coords(e, id)?;
        let class = dna::class_of(&dna.to_array());
        let projected = stats::project(&read_vitals(e, id)?, now, class, coords);
        extend_planet_ttl(e, id);
        Ok(projected)
    }

    /// Return the planet's expressed population type (0..5). Maps directly
    /// to art/src/scene.ts:POPULATIONS. Returns 0 (Humanoid) for legacy
    /// planets with no latent blob.
    pub fn population_of(e: &Env, id: u32) -> Result<u32, Error> {
        // Confirm the planet exists; surfaces UnknownPlanet for bad ids.
        let _ = read_dna(e, id)?;
        let latent = read_latent(e, id);
        extend_planet_ttl(e, id);
        Ok(dna::population_of_latent(&latent.to_array()) as u32)
    }

    /// Return the planet's stored civilization tier (0..=4). Reads the
    /// `CivTier(id)` slot directly with a 0 fallback — view calls do *not*
    /// project demotion based on current signal, so a tier earned through
    /// care stays "on file" until the next `care` ratchet evaluation. This
    /// keeps the view cheap and avoids spurious storage writes from reads.
    pub fn civ_tier_of(e: &Env, id: u32) -> Result<u32, Error> {
        let _ = read_dna(e, id)?;
        let tier = read_civ_tier(e, id);
        extend_planet_ttl(e, id);
        Ok(tier as u32)
    }

    pub fn coords_of(e: &Env, id: u32) -> Result<(i32, i32), Error> {
        // Returns Result instead of (0,0) for unknown — closes audit Low #4.
        let xy = read_coords(e, id)?;
        extend_planet_ttl(e, id);
        Ok(xy)
    }

    /// Returns the stored commitment so a watcher can show pending state.
    pub fn commitment_of(e: &Env, commitment_id: u32) -> Result<Commitment, Error> {
        e.storage()
            .persistent()
            .get(&DataKey::Commitment(commitment_id))
            .ok_or(Error::UnknownCommitment)
    }

    /// View: at which ledger does `commitment_id` become revealable. Returns
    /// `commit_ledger + MIN_REVEAL_DELAY_LEDGERS`. Frontend can compare to
    /// the current ledger to decide whether to enable a "reveal" button.
    pub fn reveal_after(e: &Env, commitment_id: u32) -> Result<u32, Error> {
        let c: Commitment = e
            .storage()
            .persistent()
            .get(&DataKey::Commitment(commitment_id))
            .ok_or(Error::UnknownCommitment)?;
        Ok(c.commit_ledger.saturating_add(MIN_REVEAL_DELAY_LEDGERS))
    }

    pub fn cooldown_of(e: &Env, id: u32) -> u32 {
        let key = DataKey::LastConjoin(id);
        if !e.storage().persistent().has(&key) {
            return 0;
        }
        let last: u32 = e.storage().persistent().get(&key).unwrap();
        let now = e.ledger().sequence();
        let cooldown: u32 = e
            .storage()
            .instance()
            .get(&DataKey::ConjoinCooldown)
            .unwrap_or(DEFAULT_COOLDOWN);
        cooldown.saturating_sub(now.saturating_sub(last))
    }

    pub fn admin(e: &Env) -> Address {
        e.storage().instance().get(&DataKey::Admin).unwrap()
    }

    pub fn drand_verifier(e: &Env) -> Address {
        e.storage().instance().get(&DataKey::Drand).unwrap()
    }

    /// Admin-only: rotate the admin to a new address. Closes audit High #3 +
    /// Medium upgrade-path: lets a compromised admin be replaced, and lets
    /// the project move to a multisig later without redeploying.
    pub fn set_admin(e: &Env, new_admin: Address) -> Result<(), Error> {
        let admin = require_admin(e)?;
        admin.require_auth();
        e.storage().instance().set(&DataKey::Admin, &new_admin);
        e.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        ConfigChanged {
            key: soroban_sdk::symbol_short!("admin"),
            value: 0,
        }
        .publish(e);
        Ok(())
    }

    /// Admin-only: rotate the drand verifier address (audit Critical #3).
    /// Use this if the canonical verifier ever needs replacing.
    pub fn set_drand(e: &Env, new_drand: Address) -> Result<(), Error> {
        let admin = require_admin(e)?;
        admin.require_auth();
        e.storage().instance().set(&DataKey::Drand, &new_drand);
        e.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        ConfigChanged {
            key: soroban_sdk::symbol_short!("drand"),
            value: 0,
        }
        .publish(e);
        Ok(())
    }

    pub fn set_cooldown(e: &Env, ledgers: u32) -> Result<(), Error> {
        let admin = require_admin(e)?;
        admin.require_auth();
        // Range guard — audit Low #1.
        if !(MIN_COOLDOWN..=MAX_COOLDOWN).contains(&ledgers) {
            return Err(Error::CooldownOutOfRange);
        }
        e.storage()
            .instance()
            .set(&DataKey::ConjoinCooldown, &ledgers);
        e.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        ConfigChanged {
            key: soroban_sdk::symbol_short!("cooldown"),
            value: ledgers as u64,
        }
        .publish(e);
        Ok(())
    }

    /// Anyone can call this to refresh a planet's persistent TTL. Useful for
    /// secondary-market buyers or scripts that want to keep dormant planets
    /// alive without taking a game action.
    pub fn extend(e: &Env, id: u32) -> Result<(), Error> {
        let _ = read_dna(e, id)?; // confirm the planet exists
        extend_planet_ttl(e, id);
        Ok(())
    }
}

#[contractimpl(contracttrait)]
impl NonFungibleToken for PlanetContract {
    type ContractType = Enumerable;
}

#[contractimpl(contracttrait)]
impl NonFungibleEnumerable for PlanetContract {}

// ----- internal helpers -----

fn require_admin(e: &Env) -> Result<Address, Error> {
    e.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotAdmin)
}

fn current_vitals_for_id(e: &Env, id: u32, now: u32) -> Result<Vitals, Error> {
    let dna = read_dna(e, id)?;
    let coords = read_coords(e, id)?;
    let class = dna::class_of(&dna.to_array());
    Ok(stats::project(&read_vitals(e, id)?, now, class, coords))
}

/// Allocate the next commitment id, write the commitment to persistent
/// storage, fire the Committed event, and return the id.
fn stash_commitment(e: &Env, c: Commitment) -> u32 {
    let id: u32 = e
        .storage()
        .instance()
        .get(&DataKey::NextCommitmentId)
        .unwrap_or(0);
    e.storage().persistent().set(&DataKey::Commitment(id), &c);
    e.storage()
        .persistent()
        .extend_ttl(&DataKey::Commitment(id), TTL_THRESHOLD, TTL_EXTEND_TO);
    e.storage()
        .instance()
        .set(&DataKey::NextCommitmentId, &(id + 1));
    e.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);

    Committed {
        committer: c.committer.clone(),
        commitment_id: id,
        target_round: c.target_round,
        reveal_after_ledger: c.commit_ledger.saturating_add(MIN_REVEAL_DELAY_LEDGERS),
    }
    .publish(e);

    id
}

/// Read + remove a commitment in one shot. Prevents replay — once revealed,
/// the commitment is gone.
fn take_commitment(e: &Env, id: u32) -> Result<Commitment, Error> {
    let c: Commitment = e
        .storage()
        .persistent()
        .get(&DataKey::Commitment(id))
        .ok_or(Error::UnknownCommitment)?;
    e.storage().persistent().remove(&DataKey::Commitment(id));
    Ok(c)
}

fn random_at(e: &Env, round: u64) -> Result<BytesN<32>, Error> {
    let drand_addr: Address = e.storage().instance().get(&DataKey::Drand).unwrap();
    let client = DrandClient::new(e, &drand_addr);
    client.get(&round).ok_or(Error::DrandUnavailable)
}

fn write_planet(e: &Env, id: u32, dna: &BytesN<32>, coords: (i32, i32)) {
    e.storage().persistent().set(&DataKey::Dna(id), dna);
    e.storage().persistent().set(&DataKey::Coords(id), &coords);
    let now = e.ledger().sequence();
    let v = Vitals {
        temperature: 128,
        hydration: 128,
        gravity: 128,
        biomass: 128,
        spirit: 160,
        last_ledger: now,
    };
    e.storage().persistent().set(&DataKey::Vitals(id), &v);
    extend_planet_ttl(e, id);
}

fn extend_planet_ttl(e: &Env, id: u32) {
    e.storage()
        .persistent()
        .extend_ttl(&DataKey::Dna(id), TTL_THRESHOLD, TTL_EXTEND_TO);
    e.storage()
        .persistent()
        .extend_ttl(&DataKey::Vitals(id), TTL_THRESHOLD, TTL_EXTEND_TO);
    e.storage()
        .persistent()
        .extend_ttl(&DataKey::Coords(id), TTL_THRESHOLD, TTL_EXTEND_TO);
    // Latent may be absent for legacy planets — `has` guards the extend
    // so we don't write a TTL marker for nonexistent storage.
    let latent_key = DataKey::Latent(id);
    if e.storage().persistent().has(&latent_key) {
        e.storage()
            .persistent()
            .extend_ttl(&latent_key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }
    // CivTier is also absent for pre-civ-tier planets — same `has` guard.
    let civ_key = DataKey::CivTier(id);
    if e.storage().persistent().has(&civ_key) {
        e.storage()
            .persistent()
            .extend_ttl(&civ_key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }
}

fn read_dna(e: &Env, id: u32) -> Result<BytesN<32>, Error> {
    e.storage()
        .persistent()
        .get(&DataKey::Dna(id))
        .ok_or(Error::UnknownPlanet)
}

fn read_vitals(e: &Env, id: u32) -> Result<Vitals, Error> {
    e.storage()
        .persistent()
        .get(&DataKey::Vitals(id))
        .ok_or(Error::UnknownPlanet)
}

fn read_coords(e: &Env, id: u32) -> Result<(i32, i32), Error> {
    e.storage()
        .persistent()
        .get(&DataKey::Coords(id))
        .ok_or(Error::UnknownPlanet)
}

/// Read a planet's latent blob with a zero fallback for legacy planets.
/// This is the *informational* read path (used by `latent_of`): legacy
/// planets simply have no recessives recorded, so returning zeros is the
/// most honest signal to off-chain indexers.
///
/// Breeding callers should use `read_latent_for_breeding` instead — see
/// audit M3 for why a zero fallback is the wrong shape for crossover.
fn read_latent(e: &Env, id: u32) -> BytesN<32> {
    e.storage()
        .persistent()
        .get(&DataKey::Latent(id))
        .unwrap_or_else(|| BytesN::from_array(e, &[0u8; 32]))
}

/// Read a planet's latent for use in `crossover_with_latent`. For planets
/// with stored latents this is identical to `read_latent`. For pre-dominance
/// legacy planets we synthesize a latent so the parent contributes its
/// visible D for every allele slot instead of injecting 0x00.
///
/// - Trait slots 0..7: R1[i] = R2[i] = visible DNA[i]. Mirrors audit M3.
/// - Population slot (latent 16/17/18): R1 = R2 = D = visible DNA[18].
///   Byte 18 is the same one `derivePopulation` reads in the frontend, so
///   legacy parents contribute the population they already display.
///
/// With this shape, `sample_allele` returns the parent's visible D byte
/// 100% of the time for both trait slots and population.
fn read_latent_for_breeding(e: &Env, id: u32, dna: &BytesN<32>) -> BytesN<32> {
    if let Some(latent) = e.storage().persistent().get(&DataKey::Latent(id)) {
        return latent;
    }
    let d = dna.to_array();
    let mut out = [0u8; dna::LATENT_LEN];
    out[dna::LATENT_R1_OFFSET..dna::LATENT_R1_OFFSET + dna::TRAIT_SLOTS]
        .copy_from_slice(&d[..dna::TRAIT_SLOTS]);
    out[dna::LATENT_R2_OFFSET..dna::LATENT_R2_OFFSET + dna::TRAIT_SLOTS]
        .copy_from_slice(&d[..dna::TRAIT_SLOTS]);
    // Population trio — seed D/R1/R2 from visible DNA byte 18 so legacy
    // descendants don't all collapse to pop=0 (Humanoid). Closes audit M-2.
    let pop_seed = d[dna::IDX_RESERVED];
    out[dna::LATENT_POP_D] = pop_seed;
    out[dna::LATENT_POP_R1] = pop_seed;
    out[dna::LATENT_POP_R2] = pop_seed;
    BytesN::from_array(e, &out)
}

/// Read a planet's stored civ_tier with a 0 fallback for legacy / pre-civ-tier
/// planets. Stored as u32 (Soroban's persistent storage doesn't accept u8
/// directly); narrowed to u8 here and clamped to the public range 0..=4 so
/// any out-of-range value already in storage can't surface as garbage.
fn read_civ_tier(e: &Env, id: u32) -> u8 {
    let raw: u32 = e
        .storage()
        .persistent()
        .get(&DataKey::CivTier(id))
        .unwrap_or(0u32);
    core::cmp::min(raw, 4) as u8
}

fn check_cooldown(e: &Env, id: u32, now: u32) -> Result<(), Error> {
    let key = DataKey::LastConjoin(id);
    if !e.storage().persistent().has(&key) {
        return Ok(());
    }
    let last: u32 = e.storage().persistent().get(&key).unwrap();
    let cooldown: u32 = e
        .storage()
        .instance()
        .get(&DataKey::ConjoinCooldown)
        .unwrap_or(DEFAULT_COOLDOWN);
    if now.saturating_sub(last) < cooldown {
        return Err(Error::OnCooldown);
    }
    Ok(())
}

fn midpoint(a: (i32, i32), b: (i32, i32)) -> (i32, i32) {
    (
        ((a.0 as i64 + b.0 as i64) / 2) as i32,
        ((a.1 as i64 + b.1 as i64) / 2) as i32,
    )
}
