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
use stellar_tokens::non_fungible::{Base, NonFungibleToken};

use crate::drand::DrandClient;
use crate::stats::{Care, Vitals};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Drand,
    Treasury,
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
}

#[contractevent(topics = ["born"])]
pub struct Born {
    pub id: u32,
    pub owner: Address,
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

#[contract]
pub struct PlanetContract;

const DEFAULT_COOLDOWN: u32 = 720; // ~1h at 5s ledgers
const TTL_THRESHOLD: u32 = 17_280; // ~1 day
const TTL_EXTEND_TO: u32 = 518_400; // ~30 days

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
        e.storage().instance().set(&DataKey::Treasury, &admin);
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
    pub fn mint_genesis(e: &Env, to: Address, round: u64, x: i32, y: i32) -> Result<u32, Error> {
        let admin = require_admin(e)?;
        admin.require_auth();

        let seed = random_at(e, round)?;
        let dna = dna::from_seed(e, &seed, round);

        let token_id = Base::sequential_mint(e, &to);
        write_planet(e, token_id, &dna, (x, y));

        Born {
            id: token_id,
            owner: to,
            generation: 0,
            drand_round: round,
        }
        .publish(e);

        e.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(token_id)
    }

    /// Conjoin two parents the caller owns. Mints a child whose DNA is a per-byte
    /// crossover with mutation. Both parents go on cooldown.
    /// `round` pins the drand round used to source mutation entropy so the
    /// transaction footprint is stable between simulate and submit.
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

        let now = e.ledger().sequence();
        check_cooldown(e, parent_a, now)?;
        check_cooldown(e, parent_b, now)?;

        // Project vitals forward to "now" and require both parents healthy enough.
        let dna_a: BytesN<32> = read_dna(e, parent_a)?;
        let dna_b: BytesN<32> = read_dna(e, parent_b)?;
        let coords_a: (i32, i32) = read_coords(e, parent_a);
        let coords_b: (i32, i32) = read_coords(e, parent_b);
        let class_a = dna::class_of(&dna_a.to_array());
        let class_b = dna::class_of(&dna_b.to_array());
        let vit_a = stats::project(&read_vitals(e, parent_a)?, now, class_a, coords_a);
        let vit_b = stats::project(&read_vitals(e, parent_b)?, now, class_b, coords_b);
        if stats::healthy_factor(&vit_a) < 40 || stats::healthy_factor(&vit_b) < 40 {
            return Err(Error::Unhealthy);
        }

        let seed = random_at(e, round)?;
        let child_dna = dna::crossover(e, &dna_a, &dna_b, &seed, round);

        let child_id = Base::sequential_mint(e, &to);
        let child_coords = midpoint(coords_a, coords_b);
        write_planet(e, child_id, &child_dna, child_coords);

        // Average parent vitals as the child's starting vitals.
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
        e.storage().persistent().set(&DataKey::LastConjoin(parent_a), &now);
        e.storage().persistent().set(&DataKey::LastConjoin(parent_b), &now);

        Conjoin {
            child: child_id,
            parent_a,
            parent_b,
            drand_round: round,
        }
        .publish(e);

        Ok(child_id)
    }

    /// Apply a care action. Caller must own the planet.
    pub fn care(e: &Env, id: u32, action: u32) -> Result<(), Error> {
        let owner = Base::owner_of(e, id);
        owner.require_auth();

        let care = Care::from_u32(action).ok_or(Error::InvalidCareAction)?;
        let now = e.ledger().sequence();
        let dna = read_dna(e, id)?;
        let coords = read_coords(e, id);
        let class = dna::class_of(&dna.to_array());

        let projected = stats::project(&read_vitals(e, id)?, now, class, coords);
        let updated = stats::apply_care(&projected, class, care, now);
        e.storage().persistent().set(&DataKey::Vitals(id), &updated);

        Cared { id, action }.publish(e);
        Ok(())
    }

    /// Migrate a planet to new coords. Caller must own. Treasury fee TODO (v2).
    pub fn migrate(e: &Env, id: u32, x: i32, y: i32) -> Result<(), Error> {
        let owner = Base::owner_of(e, id);
        owner.require_auth();
        e.storage().persistent().set(&DataKey::Coords(id), &(x, y));
        Moved { id, x, y }.publish(e);
        Ok(())
    }

    // ----- views -----

    pub fn dna_of(e: &Env, id: u32) -> Result<BytesN<32>, Error> {
        read_dna(e, id)
    }

    pub fn vitals_of(e: &Env, id: u32) -> Result<Vitals, Error> {
        let now = e.ledger().sequence();
        let dna = read_dna(e, id)?;
        let coords = read_coords(e, id);
        let class = dna::class_of(&dna.to_array());
        Ok(stats::project(&read_vitals(e, id)?, now, class, coords))
    }

    pub fn coords_of(e: &Env, id: u32) -> (i32, i32) {
        read_coords(e, id)
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

    pub fn set_cooldown(e: &Env, ledgers: u32) -> Result<(), Error> {
        let admin = require_admin(e)?;
        admin.require_auth();
        e.storage().instance().set(&DataKey::ConjoinCooldown, &ledgers);
        Ok(())
    }
}

#[contractimpl(contracttrait)]
impl NonFungibleToken for PlanetContract {
    type ContractType = Base;
}

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

fn read_coords(e: &Env, id: u32) -> (i32, i32) {
    e.storage()
        .persistent()
        .get(&DataKey::Coords(id))
        .unwrap_or((0, 0))
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
    (((a.0 as i64 + b.0 as i64) / 2) as i32, ((a.1 as i64 + b.1 as i64) / 2) as i32)
}

