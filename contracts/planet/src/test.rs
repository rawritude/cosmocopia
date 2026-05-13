#![cfg(test)]

extern crate std;

use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env, String, Symbol,
};

use crate::{dna, galaxy, stats, Error, PlanetContract, PlanetContractClient};

// ---------- Mock Drand verifier ----------

const STATE_KEY: Symbol = symbol_short!("LATEST");

#[contracttype]
#[derive(Clone)]
struct LatestRandom {
    round: u64,
    value: BytesN<32>,
}

#[contract]
pub struct MockDrand;

#[contractimpl]
impl MockDrand {
    pub fn set_latest(env: Env, round: u64, value: BytesN<32>) {
        env.storage()
            .instance()
            .set(&STATE_KEY, &LatestRandom { round, value });
    }

    pub fn latest(env: Env) -> Option<(u64, BytesN<32>)> {
        env.storage()
            .instance()
            .get::<_, LatestRandom>(&STATE_KEY)
            .map(|l| (l.round, l.value))
    }

    pub fn get(env: Env, _round: u64) -> Option<BytesN<32>> {
        env.storage()
            .instance()
            .get::<_, LatestRandom>(&STATE_KEY)
            .map(|l| l.value)
    }
}

// ---------- Fixture ----------

struct Fixture {
    env: Env,
    drand_id: Address,
    planet: PlanetContractClient<'static>,
}

fn setup(seed_byte: u8) -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let drand_id = env.register(MockDrand, ());
    let drand_client = MockDrandClient::new(&env, &drand_id);

    let seed = BytesN::from_array(&env, &[seed_byte; 32]);
    drand_client.set_latest(&1u64, &seed);

    let planet_id = env.register(
        PlanetContract,
        (
            admin.clone(),
            drand_id.clone(),
            String::from_str(&env, "ipfs://meta/"),
            String::from_str(&env, "Cosmocopia"),
            String::from_str(&env, "PLN"),
        ),
    );
    let planet = PlanetContractClient::new(&env, &planet_id);

    Fixture {
        env,
        drand_id,
        planet,
    }
}

fn set_drand(env: &Env, drand_id: &Address, round: u64, byte: u8) {
    let client = MockDrandClient::new(env, drand_id);
    client.set_latest(&round, &BytesN::from_array(env, &[byte; 32]));
}

// ---------- Tests ----------

#[test]
fn genesis_mint_writes_dna_and_vitals() {
    let f = setup(0xAB);
    let user = Address::generate(&f.env);

    let id = f.planet.mint_genesis(&user, &1u64, &0, &0);
    assert_eq!(id, 0);
    assert_eq!(f.planet.owner_of(&id), user);

    let dna_arr = f.planet.dna_of(&id).to_array();
    assert_eq!(dna_arr[dna::IDX_CLASS], 0xAB);
    assert_eq!(dna_arr[dna::IDX_GENERATION], 0);
    assert_eq!(
        &dna_arr[dna::IDX_BIRTH_ROUND..dna::IDX_BIRTH_ROUND + 4],
        &[0, 0, 0, 1]
    );

    let v = f.planet.vitals_of(&id);
    assert_eq!(v.temperature, 128);
    assert_eq!(v.spirit, 160);
}

#[test]
fn conjoin_produces_child_with_lineage_signature() {
    let f = setup(0x11);
    let user = Address::generate(&f.env);

    set_drand(&f.env, &f.drand_id, 100, 0xAA);
    let a = f.planet.mint_genesis(&user, &1u64, &0, &0);
    set_drand(&f.env, &f.drand_id, 101, 0x55);
    let b = f.planet.mint_genesis(&user, &1u64, &10, &10);
    set_drand(&f.env, &f.drand_id, 102, 0x33);

    let child = f.planet.conjoin(&a, &b, &user, &1u64);
    assert_eq!(f.planet.owner_of(&child), user);

    let child_dna = f.planet.dna_of(&child).to_array();
    let dna_a = f.planet.dna_of(&a).to_array();
    let dna_b = f.planet.dna_of(&b).to_array();

    for i in 0..4 {
        assert_eq!(child_dna[dna::IDX_PARENT_MIX + i], dna_a[i] ^ dna_b[i]);
    }

    assert_eq!(
        child_dna[dna::IDX_GENERATION],
        dna_a[dna::IDX_GENERATION].max(dna_b[dna::IDX_GENERATION]) + 1
    );

    assert_eq!(f.planet.coords_of(&child), (5, 5));
}

#[test]
fn conjoin_same_parent_fails() {
    let f = setup(0x22);
    let user = Address::generate(&f.env);
    let a = f.planet.mint_genesis(&user, &1u64, &0, &0);
    let err = f
        .planet
        .try_conjoin(&a, &a, &user, &1u64)
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, Error::SameParent);
}

#[test]
fn conjoin_cooldown_blocks_then_clears() {
    let f = setup(0x33);
    let user = Address::generate(&f.env);

    let a = f.planet.mint_genesis(&user, &1u64, &0, &0);
    let b = f.planet.mint_genesis(&user, &1u64, &1, &1);
    let c = f.planet.mint_genesis(&user, &1u64, &2, &2);

    let _ = f.planet.conjoin(&a, &b, &user, &1u64);

    let err = f
        .planet
        .try_conjoin(&a, &c, &user, &1u64)
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, Error::OnCooldown);

    let current = f.env.ledger().sequence();
    f.env.ledger().set_sequence_number(current + 800);
    let _ = f.planet.conjoin(&a, &c, &user, &1u64);
}

#[test]
fn care_changes_vitals() {
    let f = setup(0x44);
    let user = Address::generate(&f.env);
    let id = f.planet.mint_genesis(&user, &1u64, &0, &0);

    let before = f.planet.vitals_of(&id);
    f.planet.care(&id, &(stats::Care::Warm as u32));
    let after = f.planet.vitals_of(&id);
    assert_ne!(before, after);
}

#[test]
fn invalid_care_action_errors() {
    let f = setup(0x55);
    let user = Address::generate(&f.env);
    let id = f.planet.mint_genesis(&user, &1u64, &0, &0);
    let err = f.planet.try_care(&id, &999u32).err().unwrap().unwrap();
    assert_eq!(err, Error::InvalidCareAction);
}

#[test]
fn migrate_updates_coords() {
    let f = setup(0x66);
    let user = Address::generate(&f.env);
    let id = f.planet.mint_genesis(&user, &1u64, &0, &0);
    f.planet.migrate(&id, &42, &-17);
    assert_eq!(f.planet.coords_of(&id), (42, -17));
}

#[test]
fn vitals_decay_after_many_periods() {
    let f = setup(0x77);
    let user = Address::generate(&f.env);
    let id = f.planet.mint_genesis(&user, &1u64, &0, &0);
    let v0 = f.planet.vitals_of(&id);

    let now = f.env.ledger().sequence();
    f.env.ledger().set_sequence_number(now + 720 * 50);
    let v1 = f.planet.vitals_of(&id);

    let unchanged = v0.temperature == v1.temperature
        && v0.hydration == v1.hydration
        && v0.gravity == v1.gravity
        && v0.biomass == v1.biomass
        && v0.spirit == v1.spirit;
    assert!(!unchanged);
}

#[test]
fn dna_crossover_is_deterministic() {
    let env = Env::default();
    let a = BytesN::from_array(&env, &[0x11; 32]);
    let b = BytesN::from_array(&env, &[0x22; 32]);
    let r = BytesN::from_array(&env, &[0x33; 32]);
    let c1 = dna::crossover(&env, &a, &b, &r, 42);
    let c2 = dna::crossover(&env, &a, &b, &r, 42);
    assert_eq!(c1, c2);
}

#[test]
fn dna_crossover_differs_per_seed() {
    let env = Env::default();
    let a = BytesN::from_array(&env, &[0x11; 32]);
    let b = BytesN::from_array(&env, &[0x22; 32]);
    let r1 = BytesN::from_array(&env, &[0x33; 32]);
    let r2 = BytesN::from_array(&env, &[0x99; 32]);
    let c1 = dna::crossover(&env, &a, &b, &r1, 7);
    let c2 = dna::crossover(&env, &a, &b, &r2, 7);
    assert_ne!(c1, c2);
}

#[test]
fn sector_boundaries() {
    assert_eq!(galaxy::sector_of(0, 0), galaxy::SECTOR_INNER_CORE);
    assert_eq!(galaxy::sector_of(3, 3), galaxy::SECTOR_INNER_CORE);
    assert_eq!(galaxy::sector_of(10, 0), galaxy::SECTOR_HABITABLE_BELT);
    assert_eq!(galaxy::sector_of(25, 0), galaxy::SECTOR_ASTEROID_FIELD);
    assert_eq!(galaxy::sector_of(40, 0), galaxy::SECTOR_FRONTIER);
    assert_eq!(galaxy::sector_of(100, 100), galaxy::SECTOR_OUTER_DARK);
}

#[test]
fn healthy_factor_scoring() {
    let mid = stats::Vitals {
        temperature: 128,
        hydration: 128,
        gravity: 128,
        biomass: 128,
        spirit: 128,
        last_ledger: 0,
    };
    assert_eq!(stats::healthy_factor(&mid), 100);

    let dying = stats::Vitals {
        temperature: 5,
        hydration: 5,
        gravity: 5,
        biomass: 5,
        spirit: 5,
        last_ledger: 0,
    };
    assert_eq!(stats::healthy_factor(&dying), 0);
}
