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

#[contractevent(topics = ["care"])]
pub struct Cared {
    pub id: u32,
    pub action: u32,
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

    /// Admin-only: mint a genesis planet at coords (x, y) using drand round `round`.
    ///
    /// The caller picks a concrete drand round so the read footprint is
    /// deterministic between simulate and submit. Calling `latest()` inside
    /// the contract would race the ever-advancing verifier state.
    /// **Note:** until commit-reveal lands (v2), the caller can grind by
    /// picking favorable rounds — see audit Critical #1/#2.
    pub fn mint_genesis(e: &Env, to: Address, round: u64, x: i32, y: i32) -> Result<u32, Error> {
        let admin = require_admin(e)?;
        admin.require_auth();

        let seed = random_at(e, round)?;
        // Mint first so the token id is available to salt the DNA — gives
        // every planet a unique salt even if two are minted in the same
        // drand round (audit Informational #1).
        let token_id = Enumerable::sequential_mint(e, &to);
        let dna = dna::from_seed(e, &seed, round, token_id);
        write_planet(e, token_id, &dna, (x, y));

        Born {
            owner: to,
            id: token_id,
            generation: 0,
            drand_round: round,
        }
        .publish(e);

        e.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(token_id)
    }

    /// Conjoin two parents the caller owns. Mints a child whose DNA is a
    /// per-byte crossover with mutation. Both parents go on cooldown.
    ///
    /// `to` must be one of the parents' owners — preventing minting children
    /// onto unrelated addresses (audit High #1).
    pub fn conjoin(
        e: &Env,
        parent_a: u32,
        parent_b: u32,
        to: Address,
        round: u64,
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
        // Recipient must be one of the parent owners. Closes audit High #1.
        if to != owner_a && to != owner_b {
            return Err(Error::RecipientNotParentOwner);
        }

        let now = e.ledger().sequence();
        check_cooldown(e, parent_a, now)?;
        check_cooldown(e, parent_b, now)?;

        // Project vitals forward to "now" and require both parents healthy enough.
        let dna_a: BytesN<32> = read_dna(e, parent_a)?;
        let dna_b: BytesN<32> = read_dna(e, parent_b)?;
        let coords_a: (i32, i32) = read_coords(e, parent_a)?;
        let coords_b: (i32, i32) = read_coords(e, parent_b)?;
        let class_a = dna::class_of(&dna_a.to_array());
        let class_b = dna::class_of(&dna_b.to_array());
        let vit_a = stats::project(&read_vitals(e, parent_a)?, now, class_a, coords_a);
        let vit_b = stats::project(&read_vitals(e, parent_b)?, now, class_b, coords_b);
        if stats::healthy_factor(&vit_a) < 40 || stats::healthy_factor(&vit_b) < 40 {
            return Err(Error::Unhealthy);
        }

        let seed = random_at(e, round)?;
        // Mint first so the child id can salt the DNA (audit Informational #1).
        let child_id = Enumerable::sequential_mint(e, &to);
        let child_dna = dna::crossover(e, &dna_a, &dna_b, &seed, round, child_id);

        let child_coords = midpoint(coords_a, coords_b);
        write_planet(e, child_id, &child_dna, child_coords);

        // Override the default starting vitals — children inherit the average
        // of their parents' projected vitals so investment in care carries
        // forward to the next generation.
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

        // Cooldown both parents.
        e.storage()
            .persistent()
            .set(&DataKey::LastConjoin(parent_a), &now);
        e.storage()
            .persistent()
            .set(&DataKey::LastConjoin(parent_b), &now);

        // Also bump parents' TTL so a long-dormant parent that just bred
        // doesn't archive its own DNA right after.
        extend_planet_ttl(e, parent_a);
        extend_planet_ttl(e, parent_b);

        Born {
            owner: to,
            id: child_id,
            generation: child_dna.to_array()[dna::IDX_GENERATION] as u32,
            drand_round: round,
        }
        .publish(e);
        Conjoin {
            child: child_id,
            parent_a,
            parent_b,
            drand_round: round,
        }
        .publish(e);

        Ok(child_id)
    }

    /// Apply a care action. Caller must own the planet. Extends the planet's
    /// TTL — see audit Critical #4.
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

    pub fn vitals_of(e: &Env, id: u32) -> Result<Vitals, Error> {
        let now = e.ledger().sequence();
        let dna = read_dna(e, id)?;
        let coords = read_coords(e, id)?;
        let class = dna::class_of(&dna.to_array());
        let projected = stats::project(&read_vitals(e, id)?, now, class, coords);
        extend_planet_ttl(e, id);
        Ok(projected)
    }

    pub fn coords_of(e: &Env, id: u32) -> Result<(i32, i32), Error> {
        // Returns Result instead of (0,0) for unknown — closes audit Low #4.
        let xy = read_coords(e, id)?;
        extend_planet_ttl(e, id);
        Ok(xy)
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
