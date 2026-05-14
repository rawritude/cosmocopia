#![no_std]

mod dna;
mod drand;
mod galaxy;
mod stats;

#[cfg(test)]
mod test;

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, BytesN,
    Env, String,
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
    /// Native XLM Stellar Asset Contract address. Used by `claim_first_light`
    /// to charge the 10 XLM observation fee. Set in `__constructor`,
    /// rotatable by the admin via `set_native_token`.
    NativeToken,
    /// Burn / sink address for the 5 XLM half of every First Light fee that
    /// is destroyed. Set in `__constructor`, rotatable via
    /// `set_burn_address`.
    BurnAddress,
    /// One-shot per address: true once an address has revealed a First Light
    /// claim. `claim_first_light` rejects on subsequent calls.
    FirstLightClaimed(Address),
    /// Per-token soulbound flag. When true the token cannot be transferred
    /// or used as a `conjoin` parent. Cleared by 7 days of healthy `care`
    /// or (Phase 3) by a cross-owner conjunction reveal.
    Soulbound(u32),
    /// Ledger at which this token's vitals first entered the healthy band
    /// `[40, 220]` (and have been there continuously since). 0 ⇒ not
    /// currently healthy. Resets whenever any vital falls out of band.
    HealthySince(u32),
    /// Phase 4 accumulator: the 5 XLM half of every First Light fee that
    /// isn't burned lands here so a future `claim_share` entrypoint can
    /// distribute it. Stored as i128 to mirror SAC amounts.
    DistributionPool,
    /// Coord-uniqueness check for revealed First Light claims. Set to true
    /// once any planet has been minted at exactly (x, y) by First Light.
    /// Used to drive the retry-salt path in `reveal_first_light`.
    FirstLightCoord(i32, i32),
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
    /// First Light: the keeper has already claimed.
    FirstLightAlreadyClaimed = 14,
    /// Transfer / conjoin rejected because the token is soulbound.
    SoulboundLocked = 15,
    /// `reveal_first_light` exhausted the coord-collision retry budget.
    FirstLightCoordCollision = 16,
    /// A required storage slot was never populated. Today only fires on
    /// First Light flows that depend on the constructor having wired
    /// `NativeToken` + `BurnAddress`. Surface a typed error rather than the
    /// misleading `NotAdmin` overload the dev shipped first (audit M-2).
    Uninitialized = 17,
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
/// `Genesis(x, y)` and `Conjoin(parent_a, parent_b)`. `FirstLight(keeper)`
/// carries the keeper address so reveal can re-look-up the claim flag.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommitmentKind {
    Genesis(i32, i32),
    Conjoin(u32, u32),
    FirstLight(Address),
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

/// Emitted on a successful First Light reveal. Carries the assigned
/// token id and the (x, y) coord the contract derived for the keeper. The
/// commit half does NOT emit its own event — the generic `Committed` fires
/// with `committer = keeper` and is enough for indexers to track pending
/// First Light flows. Saves WASM bytes vs. a dedicated `FirstLightCommitted`.
#[contractevent(topics = ["fl_claimed"])]
pub struct FirstLightClaimedEvent {
    #[topic]
    pub keeper: Address,
    pub id: u32,
    pub x: i32,
    pub y: i32,
}

/// Emitted whenever the soulbound flag is cleared on a token. `path` is a
/// short label describing how it cleared — for Phase 1 the only path is
/// `"care"` (7 days of healthy care).
#[contractevent(topics = ["soulbound_release"])]
pub struct SoulboundReleased {
    #[topic]
    pub id: u32,
    pub path: soroban_sdk::Symbol,
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

/// First Light fee. 10 XLM in stroops (1 XLM = 1e7 stroops). Half is burned,
/// half lands in `DistributionPool` for Phase 4 to consume.
pub const FIRST_LIGHT_FEE_STROOPS: i128 = 10 * 10_000_000;
pub const FIRST_LIGHT_BURN_STROOPS: i128 = 5 * 10_000_000;
pub const FIRST_LIGHT_POOL_STROOPS: i128 = 5 * 10_000_000;

/// Ledger window for soulbound auto-release via consistent care. 7 days at
/// ~5 s/ledger → 7 * 86_400 / 5 = 120_960 ledgers.
pub const SOULBOUND_RELEASE_LEDGERS: u32 = 120_960;

/// Sampling span for First Light coord derivation. The keeper hash is mapped
/// into `x, y ∈ [-100, 100]`, a 201² = 40_401-point square lattice. This
/// controls *where* we sample, not *whether* a sample is accepted — the
/// Outer-Dark threshold below is independent.
pub const FIRST_LIGHT_SAMPLE_SPAN: i32 = 100;

/// Outer Dark threshold matching `galaxy::sector_of`: `r² >= 2500` (`r >= 50`).
/// Of the 40_401 sample points, ≈ 32_500 satisfy this (~80%). An earlier
/// version of this code conflated the sampling span with the threshold and
/// gated on `r² >= 10_000` (re-audit finding N-1) — that pushed the per-
/// iteration success rate down to ~22% and made ~1 in 55 claimers exhaust
/// their salt budget. Restored to match the actual sector definition.
pub const FIRST_LIGHT_OUTER_DARK_R2: u64 = 2500;

/// Coord-collision retry budget. Per-iteration success rate is ~80% (sample
/// lands in Outer Dark) × (1 − P(coord taken)). For honest single-claim
/// usage P(taken) ≈ 0, so the expected first-success salt is ~1. 16 leaves
/// a wide safety margin for adversarial pre-claim grief over a known target
/// keeper — P(all 16 fail | no taken) < 1e-11.
pub const FIRST_LIGHT_RETRY_BUDGET: u32 = 16;

/// Maximum value of the DNA rarity nibble (low 4 bits of byte 17) that
/// `computeRarity` in art/src/rarity.ts will score as a Common contribution.
/// The scorer adds `Math.floor(nibble / 5)` points; with all other Common-
/// floor traits zeroed the cap is 4 (so the nibble can contribute 0 points
/// without breaking class/aura/feature constraints). We clamp on-chain to
/// guarantee Common-tier output regardless of seed.
pub const FIRST_LIGHT_RARITY_CAP: u8 = 4;

/// Mythic class indices that First Light reveals must avoid (Hollow + Aether,
/// per `art/src/rarity.ts:MYTHIC_CLASS_IDS`). These are the upper-nibble
/// values of DNA byte 0. We clamp into the safe range by masking off the
/// top bit of the nibble (mythic indices are 14/15 = 0b1110/0b1111).
pub const FIRST_LIGHT_MYTHIC_CLASS_IDS: [u8; 2] = [14, 15];

/// Atmosphere indices that score `+4` mythic in the rarity scorer (aurora=4,
/// sparkle=6, eclipse=7 — see `RARE_ATMOSPHERES` in art/src/rarity.ts; the
/// constant is mis-named there but rewards +4 like a mythic). The byte 2
/// high three bits encode 0..=7; clamping these three indices to safe values
/// removes the +4 contribution.
pub const FIRST_LIGHT_MYTHIC_ATM_IDS: [u8; 3] = [4, 6, 7];

/// Feature indices that score `+4` mythic (runes=8, blossoms=9, spires=10 —
/// see `MYTHIC_FEATURES` in art/src/rarity.ts).
pub const FIRST_LIGHT_MYTHIC_FEAT_IDS: [u8; 3] = [8, 9, 10];

/// Aura indices that score `+5` mythic (aurora-aura=5, crown=7 — see
/// `MYTHIC_AURAS` in art/src/rarity.ts).
pub const FIRST_LIGHT_MYTHIC_AURA_IDS: [u8; 2] = [5, 7];

/// Atmosphere density threshold: scorer awards +2 for density ≥ 28. We clamp
/// the low 5 bits of byte 2 to <= 27.
pub const FIRST_LIGHT_ATM_DENSITY_CAP: u8 = 27;

/// Feature intensity threshold: scorer awards +2 for intensity ≥ 14. We
/// clamp the low 4 bits of byte 3 to <= 13.
pub const FIRST_LIGHT_FEAT_INTENSITY_CAP: u8 = 13;

/// Aura intensity threshold: scorer awards +2 for intensity ≥ 28. We clamp
/// the low 5 bits of byte 5 to <= 27.
pub const FIRST_LIGHT_AURA_INTENSITY_CAP: u8 = 27;

/// Max moon count after clamping (high 3 bits of byte 4). Scorer awards
/// `min(3, max(0, count - 1))` so capping at 1 zeros the contribution.
pub const FIRST_LIGHT_MOON_COUNT_CAP: u8 = 1;

/// Max ring count after clamping (low 3 bits of byte 1). Scorer awards
/// `min(4, max(0, count - 2))` so capping at 2 zeros the contribution.
pub const FIRST_LIGHT_RING_COUNT_CAP: u8 = 2;

#[contractimpl]
impl PlanetContract {
    #[allow(clippy::too_many_arguments)]
    pub fn __constructor(
        e: &Env,
        admin: Address,
        drand: Address,
        uri: String,
        name: String,
        symbol: String,
        native_token: Address,
        burn_address: Address,
    ) {
        e.storage().instance().set(&DataKey::Admin, &admin);
        e.storage().instance().set(&DataKey::Drand, &drand);
        e.storage()
            .instance()
            .set(&DataKey::ConjoinCooldown, &DEFAULT_COOLDOWN);
        e.storage()
            .instance()
            .set(&DataKey::NativeToken, &native_token);
        e.storage()
            .instance()
            .set(&DataKey::BurnAddress, &burn_address);
        // Initialize the distribution pool accumulator at 0 so the i128 type
        // is pinned in storage from the start.
        e.storage()
            .instance()
            .set(&DataKey::DistributionPool, &0i128);
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

    /// First Light: commit half. Charges the keeper 10 XLM at commit time
    /// (split 5/5 between burn + DistributionPool), stashes a commitment of
    /// `kind = FirstLight(keeper)`, and emits `FirstLightCommitted`.
    ///
    /// One-shot per keeper: rejects with `FirstLightAlreadyClaimed` if the
    /// address has already revealed a First Light claim. Repeated *commits*
    /// without a reveal are NOT blocked — that's a self-imposed user fee and
    /// the contract has no way to refund without a separate flow.
    ///
    /// Soulbound + Common-tier + Outer-Dark constraints are enforced at
    /// reveal time, not here, so this entrypoint stays cheap.
    pub fn claim_first_light(e: &Env, keeper: Address, observed_round: u64) -> Result<u32, Error> {
        keeper.require_auth();

        // One-shot gate. A reveal sets FirstLightClaimed(keeper)=true; this
        // check makes repeated claims by the same keeper revert before any
        // funds move.
        if e.storage()
            .persistent()
            .get::<_, bool>(&DataKey::FirstLightClaimed(keeper.clone()))
            .unwrap_or(false)
        {
            return Err(Error::FirstLightAlreadyClaimed);
        }

        // Charge 10 XLM. Split: 5 burned to BurnAddress, 5 accumulated in
        // DistributionPool. Both legs require the keeper's auth (covered by
        // `keeper.require_auth()` above) and the contract is the recipient
        // for the pool leg.
        let native: Address = e
            .storage()
            .instance()
            .get(&DataKey::NativeToken)
            .ok_or(Error::Uninitialized)?;
        let burn: Address = e
            .storage()
            .instance()
            .get(&DataKey::BurnAddress)
            .ok_or(Error::Uninitialized)?;
        let token = token::Client::new(e, &native);
        // Burn leg: keeper → burn address.
        token.transfer(&keeper, &burn, &FIRST_LIGHT_BURN_STROOPS);
        // Pool leg: keeper → this contract.
        let pool_recipient = e.current_contract_address();
        token.transfer(&keeper, &pool_recipient, &FIRST_LIGHT_POOL_STROOPS);
        let pool: i128 = e
            .storage()
            .instance()
            .get(&DataKey::DistributionPool)
            .unwrap_or(0);
        e.storage().instance().set(
            &DataKey::DistributionPool,
            &(pool.saturating_add(FIRST_LIGHT_POOL_STROOPS)),
        );

        let now = e.ledger().sequence();
        let commitment_id = stash_commitment(
            e,
            Commitment {
                committer: keeper.clone(),
                to: keeper.clone(),
                target_round: observed_round + LOOKAHEAD_ROUNDS,
                commit_ledger: now,
                kind: CommitmentKind::FirstLight(keeper),
            },
        );
        Ok(commitment_id)
    }

    /// First Light: reveal half. Anyone can call (the commitment carries the
    /// keeper). Mints the planet to the keeper with:
    ///  * Common-tier-floor DNA (rarity nibble clamped, mythic classes
    ///    deflected),
    ///  * an Outer-Dark coord derived deterministically from the keeper's
    ///    address (with a small retry budget to avoid collisions),
    ///  * `Soulbound(token_id) = true`,
    ///  * `HealthySince(token_id) = current ledger` (so the 7-day timer
    ///    starts ticking on day 0 of the keeper's care).
    pub fn reveal_first_light(e: &Env, id: u32) -> Result<u32, Error> {
        let c = take_commitment(e, id)?;
        let keeper = match c.kind.clone() {
            CommitmentKind::FirstLight(k) => k,
            _ => return Err(Error::InvalidCommitmentKind),
        };
        let now = e.ledger().sequence();
        if now < c.commit_ledger.saturating_add(MIN_REVEAL_DELAY_LEDGERS) {
            return Err(Error::CommitmentNotReady);
        }
        // Defensive: surfacing a second reveal of the same keeper through a
        // race condition (two open commitments) should still reject. The
        // commitment was already consumed by `take_commitment`, so we re-
        // check the persistent flag.
        if e.storage()
            .persistent()
            .get::<_, bool>(&DataKey::FirstLightClaimed(keeper.clone()))
            .unwrap_or(false)
        {
            return Err(Error::FirstLightAlreadyClaimed);
        }

        let seed = random_at(e, c.target_round)?;
        let token_id = Enumerable::sequential_mint(e, &keeper);
        let dna_raw = dna::from_seed(e, &seed, c.target_round, token_id);
        let dna = clamp_first_light_dna(e, &dna_raw);
        let latent = dna::latent_from_seed(e, &seed, token_id);
        let (x, y) = derive_first_light_coord(e, &keeper)?;

        write_planet(e, token_id, &dna, (x, y));
        // Note: write_planet already extends Dna/Vitals/Coords TTL. The
        // additional keys below are written + their TTL is extended in one
        // pass at the end of this function via `extend_planet_ttl(token_id)`.
        let p = e.storage().persistent();
        p.set(&DataKey::Latent(token_id), &latent);
        p.set(&DataKey::CivTier(token_id), &0u32);
        p.set(&DataKey::Soulbound(token_id), &true);
        p.set(&DataKey::HealthySince(token_id), &now);
        p.set(&DataKey::FirstLightCoord(x, y), &true);
        p.set(&DataKey::FirstLightClaimed(keeper.clone()), &true);
        // One TTL bump covers Dna/Vitals/Coords + (now-present) Latent,
        // CivTier, Soulbound, HealthySince. FirstLightCoord +
        // FirstLightClaimed are tied to keeper / coord rather than the
        // planet — bump them explicitly so they outlive the planet's
        // ordinary care cycle.
        extend_planet_ttl(e, token_id);
        p.extend_ttl(
            &DataKey::FirstLightCoord(x, y),
            TTL_THRESHOLD,
            TTL_EXTEND_TO,
        );
        p.extend_ttl(
            &DataKey::FirstLightClaimed(keeper.clone()),
            TTL_THRESHOLD,
            TTL_EXTEND_TO,
        );

        let population = dna::population_of_latent(&latent.to_array()) as u32;
        Born {
            owner: keeper.clone(),
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
        FirstLightClaimedEvent {
            keeper,
            id: token_id,
            x,
            y,
        }
        .publish(e);
        e.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(token_id)
    }

    /// View: has this address already revealed a First Light claim?
    pub fn first_light_claimed(e: &Env, keeper: Address) -> bool {
        e.storage()
            .persistent()
            .get::<_, bool>(&DataKey::FirstLightClaimed(keeper))
            .unwrap_or(false)
    }

    /// View: is this token soulbound? Returns false for unknown tokens.
    pub fn is_soulbound_of(e: &Env, id: u32) -> bool {
        is_soulbound(e, id)
    }

    /// View: ledger at which `id`'s healthy-since timer started, or 0 if
    /// the planet is not currently in the healthy band.
    pub fn healthy_since_of(e: &Env, id: u32) -> u32 {
        e.storage()
            .persistent()
            .get(&DataKey::HealthySince(id))
            .unwrap_or(0)
    }

    /// View: current contents of the Phase 4 distribution pool, in stroops.
    pub fn distribution_pool(e: &Env) -> i128 {
        e.storage()
            .instance()
            .get(&DataKey::DistributionPool)
            .unwrap_or(0)
    }

    /// View: the configured burn address.
    pub fn burn_address(e: &Env) -> Address {
        e.storage().instance().get(&DataKey::BurnAddress).unwrap()
    }

    /// View: the configured native XLM SAC.
    pub fn native_token(e: &Env) -> Address {
        e.storage().instance().get(&DataKey::NativeToken).unwrap()
    }

    /// Admin-only: rotate the burn address (e.g. point at a governance
    /// multisig once one is deployed).
    pub fn set_burn_address(e: &Env, new_burn: Address) -> Result<(), Error> {
        let admin = require_admin(e)?;
        admin.require_auth();
        e.storage().instance().set(&DataKey::BurnAddress, &new_burn);
        e.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        ConfigChanged {
            key: soroban_sdk::symbol_short!("burn"),
            value: 0,
        }
        .publish(e);
        Ok(())
    }

    /// Admin-only: rotate the native token SAC. Provided for future-proofing
    /// if Stellar ever issues a new canonical XLM SAC.
    pub fn set_native_token(e: &Env, new_token: Address) -> Result<(), Error> {
        let admin = require_admin(e)?;
        admin.require_auth();
        e.storage()
            .instance()
            .set(&DataKey::NativeToken, &new_token);
        e.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        ConfigChanged {
            key: soroban_sdk::symbol_short!("native"),
            value: 0,
        }
        .publish(e);
        Ok(())
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
        // Soulbound parents can't breed. Phase 3 will *clear* soulbound on a
        // successful cross-owner reveal, but Phase 1's contract just rejects.
        if is_soulbound(e, parent_a) || is_soulbound(e, parent_b) {
            return Err(Error::SoulboundLocked);
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

        // Soulbound auto-release via consistent care. The healthy band is
        // `[40, 220]` for every vital; the moment any vital is out of band
        // we reset HealthySince, and once HealthySince has been continuously
        // set for `SOULBOUND_RELEASE_LEDGERS` (7 days) the soulbound flag
        // clears. `clear_soulbound` is a no-op for tokens that were never
        // soulbound, so it's safe to call on every healthy care.
        update_healthy_since(e, id, &updated, now);

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

    /// Override the default `NonFungibleToken::transfer` so soulbound tokens
    /// can't be moved. Panics with `Error::SoulboundLocked` instead of
    /// delegating to the Enumerable contract type when the token is locked.
    fn transfer(e: &Env, from: Address, to: Address, token_id: u32) {
        if is_soulbound(e, token_id) {
            soroban_sdk::panic_with_error!(e, Error::SoulboundLocked);
        }
        Enumerable::transfer(e, &from, &to, token_id);
    }

    /// Override `transfer_from` (operator-driven transfer) with the same
    /// soulbound gate. Without this an approved operator could route around
    /// the lock that `transfer` enforces.
    fn transfer_from(e: &Env, spender: Address, from: Address, to: Address, token_id: u32) {
        if is_soulbound(e, token_id) {
            soroban_sdk::panic_with_error!(e, Error::SoulboundLocked);
        }
        Enumerable::transfer_from(e, &spender, &from, &to, token_id);
    }

    /// Override `approve` to reject approvals on soulbound tokens (audit
    /// H-4: defense in depth). Without this an off-chain listener watching
    /// `approve` events would believe a soulbound token is transferable; a
    /// later operator-driven `transfer_from` still hits the lock, but the
    /// leak signals the wrong semantics. We reject at the approval gate so
    /// no soulbound token ever has a live approval recorded.
    ///
    /// `approve_for_all` is intentionally left at the default. It is an
    /// operator-level approval (covering every token the owner ever holds,
    /// past and future), not a per-token grant. Rejecting it would force
    /// non-soulbound tokens owned by the same keeper to also be unapproveable
    /// — too broad. Any later `transfer_from` invoked under such an
    /// operator approval is still gated by the soulbound check above.
    fn approve(
        e: &Env,
        approver: Address,
        approved: Address,
        token_id: u32,
        live_until_ledger: u32,
    ) {
        if is_soulbound(e, token_id) {
            soroban_sdk::panic_with_error!(e, Error::SoulboundLocked);
        }
        Base::approve(e, &approver, &approved, token_id, live_until_ledger);
    }
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
    // Soulbound + HealthySince exist only for First Light planets — guard so
    // we don't accidentally write TTL markers for empty slots on every care.
    let sb_key = DataKey::Soulbound(id);
    if e.storage().persistent().has(&sb_key) {
        e.storage()
            .persistent()
            .extend_ttl(&sb_key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }
    let hs_key = DataKey::HealthySince(id);
    if e.storage().persistent().has(&hs_key) {
        e.storage()
            .persistent()
            .extend_ttl(&hs_key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }
}

/// Read a planet's soulbound flag with a `false` default. False covers all
/// non-First-Light planets (the storage slot only exists on FL reveals).
fn is_soulbound(e: &Env, id: u32) -> bool {
    e.storage()
        .persistent()
        .get::<_, bool>(&DataKey::Soulbound(id))
        .unwrap_or(false)
}

/// Healthy-band check + bookkeeping for the soulbound auto-release path.
/// Called from `care` AFTER vitals have been updated.
///
/// Logic:
///  - In-band care: set HealthySince to `now` if previously 0; otherwise
///    leave it alone. If `now - since >= SOULBOUND_RELEASE_LEDGERS` AND
///    the token is currently soulbound, clear the flag + emit release.
///  - Out-of-band care: reset HealthySince to 0 (next healthy call starts
///    a fresh streak).
fn update_healthy_since(e: &Env, id: u32, v: &Vitals, now: u32) {
    let in_band = |x: u32| (40..=220).contains(&x);
    let all_healthy = in_band(v.temperature)
        && in_band(v.hydration)
        && in_band(v.gravity)
        && in_band(v.biomass)
        && in_band(v.spirit);
    let p = e.storage().persistent();
    let since: u32 = p.get(&DataKey::HealthySince(id)).unwrap_or(0);
    if all_healthy {
        if since == 0 {
            p.set(&DataKey::HealthySince(id), &now);
            return;
        }
        if now.saturating_sub(since) >= SOULBOUND_RELEASE_LEDGERS && is_soulbound(e, id) {
            p.remove(&DataKey::Soulbound(id));
            SoulboundReleased {
                id,
                path: soroban_sdk::symbol_short!("care"),
            }
            .publish(e);
        }
    } else if since != 0 {
        p.set(&DataKey::HealthySince(id), &0u32);
    }
}

/// Clamp generated DNA to the Common-tier floor. Defends every byte the
/// rarity scorer reads (see `computeRarity` in art/src/rarity.ts), not just
/// the rarity nibble + class — which alone are insufficient to keep First
/// Light planets out of Rare+. Every clamp here corresponds to a scorer
/// contribution that would otherwise push the total ≥ 12 (the Rare cutoff).
///
/// After clamping, the maximum achievable score is:
///   `+3` (Generation 0 baseline, unavoidable for First Light)
///   `+2` (an exotic-but-non-mythic class index 8..=13, allowed through)
///   `+1` (a rare feature: eyes / volcanoes / archipelago)
///   `+1` (a rare aura: pulse / static)
///   `+1` (rim coordinate bonus when r² ≥ 10_000 — fires for the subset
///         of FL coords beyond radius 100; FL coords with r in [50, 100)
///         skip this row)
///   ----
///   `=8`, well below the Rare cutoff of 12.
///
/// Clamps (each one is a typed contribution removal):
///   1. Rarity nibble (byte 17 low) ≤ `FIRST_LIGHT_RARITY_CAP` so the
///      `floor(nibble / 5)` term contributes 0.
///   2. Class nibble (byte 0 high): mythic 14/15 → 6/7 (Jungle/Crystal —
///      both outside `EXOTIC_CLASS_IDS = {8..=13}`, so no exotic bonus
///      either). Non-mythic indices are left as-is.
///   3. Atmosphere idx (byte 2 high 3 bits): mythic ids {4, 6, 7} deflect
///      via `& 0b011` to {0, 2, 3} (none / thick / storm) — none of which
///      land in the +4 mythic set.
///   4. Atmosphere density (byte 2 low 5 bits) capped at 27 so the
///      `density ≥ 28 → +2` branch never fires.
///   5. Feature idx (byte 3 high nibble): mythic ids {8, 9, 10} deflect
///      via `& 0b0111` to {0, 1, 2} (none / craters / oceans).
///   6. Feature intensity (byte 3 low nibble) capped at 13 so the
///      `intensity ≥ 14 → +2` branch never fires.
///   7. Aura idx (byte 5 high 3 bits): mythic ids {5, 7} deflect to safe
///      non-mythic values. The mapping is hand-picked so the deflection
///      lands inside 0..=4 (none/halo/glow/shadow/pulse).
///   8. Aura intensity (byte 5 low 5 bits) capped at 27.
///   9. Moon count (byte 4 high 3 bits) capped at 1 → 0 points
///      (`min(3, max(0, count - 1)) = 0`).
///  10. Ring count (byte 1 low 3 bits) capped at 2 → 0 points
///      (`min(4, max(0, count - 2)) = 0`).
pub(crate) fn clamp_first_light_dna(e: &Env, dna: &BytesN<32>) -> BytesN<32> {
    let mut out = dna.to_array();

    // 1. Rarity nibble.
    let aff = out[dna::IDX_AFFINITY_RARITY] & 0xF0;
    let rarity = (out[dna::IDX_AFFINITY_RARITY] & 0x0F).min(FIRST_LIGHT_RARITY_CAP);
    out[dna::IDX_AFFINITY_RARITY] = aff | rarity;

    // 2. Class nibble. Mythic ids 14 (0xE) and 15 (0xF) → 6 / 7 via `& 0b0111`.
    // 6 = Jungle (basic biome), 7 = Crystal — neither is in `EXOTIC_CLASS_IDS`
    // (8..=13) so neither earns the +2 exotic bonus either.
    let class_idx = (out[dna::IDX_CLASS] >> 4) & 0x0F;
    if FIRST_LIGHT_MYTHIC_CLASS_IDS.contains(&class_idx) {
        out[dna::IDX_CLASS] = ((class_idx & 0b0111) << 4) | (out[dna::IDX_CLASS] & 0x0F);
    }

    // 3. Atmosphere idx (byte 2 high 3 bits per art/src/dna.ts:79).
    //    Mythic set {4, 6, 7} → deflect via `& 0b011` → {0, 2, 3} (none /
    //    thick / storm), all outside the mythic set.
    let atm_idx = (out[dna::IDX_ATMOSPHERE] >> 5) & 0x07;
    if FIRST_LIGHT_MYTHIC_ATM_IDS.contains(&atm_idx) {
        out[dna::IDX_ATMOSPHERE] = ((atm_idx & 0b011) << 5) | (out[dna::IDX_ATMOSPHERE] & 0x1F);
    }
    // 4. Atmosphere density cap. Re-read byte 2 because (3) may have touched
    //    the high bits; the low 5 bits are unchanged but we re-mask for clarity.
    let atm_density = (out[dna::IDX_ATMOSPHERE] & 0x1F).min(FIRST_LIGHT_ATM_DENSITY_CAP);
    out[dna::IDX_ATMOSPHERE] = (out[dna::IDX_ATMOSPHERE] & 0xE0) | atm_density;

    // 5. Feature idx (byte 3 high nibble per art/src/dna.ts:82).
    //    Mythic set {8, 9, 10} → deflect via `& 0b0111` → {0, 1, 2}.
    let feat_idx = (out[dna::IDX_FEATURE] >> 4) & 0x0F;
    if FIRST_LIGHT_MYTHIC_FEAT_IDS.contains(&feat_idx) {
        out[dna::IDX_FEATURE] = ((feat_idx & 0b0111) << 4) | (out[dna::IDX_FEATURE] & 0x0F);
    }
    // 6. Feature intensity cap (byte 3 low nibble).
    let feat_intensity = (out[dna::IDX_FEATURE] & 0x0F).min(FIRST_LIGHT_FEAT_INTENSITY_CAP);
    out[dna::IDX_FEATURE] = (out[dna::IDX_FEATURE] & 0xF0) | feat_intensity;

    // 7. Aura idx (byte 5 high 3 bits per art/src/dna.ts:88).
    //    Mythic set {5, 7} → deflect via `& 0b011` → {1, 3} (halo / shadow).
    let aura_idx = (out[dna::IDX_AURA] >> 5) & 0x07;
    if FIRST_LIGHT_MYTHIC_AURA_IDS.contains(&aura_idx) {
        out[dna::IDX_AURA] = ((aura_idx & 0b011) << 5) | (out[dna::IDX_AURA] & 0x1F);
    }
    // 8. Aura intensity cap (byte 5 low 5 bits).
    let aura_intensity = (out[dna::IDX_AURA] & 0x1F).min(FIRST_LIGHT_AURA_INTENSITY_CAP);
    out[dna::IDX_AURA] = (out[dna::IDX_AURA] & 0xE0) | aura_intensity;

    // 9. Moon count (byte 4 high 3 bits per art/src/dna.ts:85).
    let moon_count = ((out[dna::IDX_MOON] >> 5) & 0x07).min(FIRST_LIGHT_MOON_COUNT_CAP);
    out[dna::IDX_MOON] = (moon_count << 5) | (out[dna::IDX_MOON] & 0x1F);

    // 10. Ring count (byte 1 low 3 bits per art/src/dna.ts:77).
    let ring_count = (out[dna::IDX_SURFACE] & 0x07).min(FIRST_LIGHT_RING_COUNT_CAP);
    out[dna::IDX_SURFACE] = (out[dna::IDX_SURFACE] & 0xF8) | ring_count;

    BytesN::from_array(e, &out)
}

/// Derive an Outer-Dark coord from the keeper's contract-encoded address.
/// We salt the hash with a retry counter so two keepers whose first-derived
/// coord happens to collide each get their own lattice point.
///
/// The keeper byte view is the strkey (`G...` / `C...`) — stable across
/// host versions because it's the user-visible identity, not the internal
/// `ScAddress` encoding. `String::to_bytes()` yields the UTF-8 strkey bytes.
///
/// Mapping:
///   - hash(salt || strkey(keeper)) → 32 bytes via the host's `crypto.sha256`
///   - byte slices [0..4] and [4..8] interpreted as i32 LE coords
///   - both modded into `±FIRST_LIGHT_SAMPLE_SPAN`
///   - if `r²` lands inside Outer Dark and the point isn't already taken,
///     return it; else bump the salt and retry up to FIRST_LIGHT_RETRY_BUDGET.
///
/// Audit H-2 history: an earlier version had a "push outward to ±span" fall-
/// back when the hash landed inside the ring. With only 4 corner points,
/// the fallback degraded to corner-spam after 4 keepers claimed those corners.
/// We dropped the fallback and rely on salt rotation: with sampling span 100
/// and Outer-Dark gate r² ≥ 2500, per-iteration success rate is ≈ 80% and
/// 16 retries gives P(all fail) < 1e-11 even against adversarial pre-claiming.
fn derive_first_light_coord(e: &Env, keeper: &Address) -> Result<(i32, i32), Error> {
    use soroban_sdk::Bytes;
    let keeper_bytes = keeper.to_string().to_bytes();
    let span = FIRST_LIGHT_SAMPLE_SPAN;
    let modspan = (span as i64) * 2 + 1; // -span..=+span inclusive
    for salt in 0..FIRST_LIGHT_RETRY_BUDGET {
        let mut payload = Bytes::new(e);
        payload.append(&Bytes::from_array(e, &salt.to_be_bytes()));
        payload.append(&keeper_bytes);
        let h = e.crypto().sha256(&payload).to_bytes().to_array();
        // i32 from first 4 bytes (LE) so a tiny salt swap moves the point.
        let raw_x = i32::from_le_bytes([h[0], h[1], h[2], h[3]]);
        let raw_y = i32::from_le_bytes([h[4], h[5], h[6], h[7]]);
        // Mod into ±FIRST_LIGHT_SAMPLE_SPAN. rem_euclid keeps the sign sane.
        let x = (raw_x as i64).rem_euclid(modspan) as i32 - span;
        let y = (raw_y as i64).rem_euclid(modspan) as i32 - span;

        // Only accept the point if it lands inside Outer Dark AND is free.
        // Otherwise bump the salt and retry. No "push outward" fallback —
        // see the audit-H-2 comment above for why.
        let r2 = (x as i64).unsigned_abs() * (x as i64).unsigned_abs()
            + (y as i64).unsigned_abs() * (y as i64).unsigned_abs();
        if r2 >= FIRST_LIGHT_OUTER_DARK_R2
            && !e
                .storage()
                .persistent()
                .has(&DataKey::FirstLightCoord(x, y))
        {
            return Ok((x, y));
        }
    }
    Err(Error::FirstLightCoordCollision)
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
