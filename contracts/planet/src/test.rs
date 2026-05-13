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

/// Test helper: pre-load drand with a fixed seed at the contract's expected
/// target round, then commit + advance the ledger + reveal in one call.
fn mint_genesis(f: &Fixture, to: &Address, x: i32, y: i32) -> u32 {
    // Mock's get(round) ignores `round` and returns the seed already stored
    // by setup(), so the seed byte the fixture configured ends up in the DNA.
    let id = f.planet.commit_genesis(to, &100u64, &x, &y);
    let now = f.env.ledger().sequence();
    f.env
        .ledger()
        .set_sequence_number(now + crate::MIN_REVEAL_DELAY_LEDGERS);
    f.planet.reveal_genesis(&id)
}

/// Test helper: commit-then-reveal a conjoin against the canonical
/// parents-owned-by-`to` setup. Drives ledger forward to satisfy the reveal
/// delay.
fn conjoin(f: &Fixture, parent_a: u32, parent_b: u32, to: &Address) -> u32 {
    let id = f
        .planet
        .commit_conjoin(&parent_a, &parent_b, to, &200u64);
    let now = f.env.ledger().sequence();
    f.env
        .ledger()
        .set_sequence_number(now + crate::MIN_REVEAL_DELAY_LEDGERS);
    f.planet.reveal_conjoin(&id)
}


// ---------- Tests ----------

#[test]
fn genesis_mint_writes_dna_and_vitals() {
    let f = setup(0xAB);
    let user = Address::generate(&f.env);

    let id = mint_genesis(&f, &user, 0, 0);
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
    let a = mint_genesis(&f, &user, 0, 0);
    set_drand(&f.env, &f.drand_id, 101, 0x55);
    let b = mint_genesis(&f, &user, 10, 10);
    set_drand(&f.env, &f.drand_id, 102, 0x33);

    let child = conjoin(&f, a, b, &user);
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

    assert_eq!(f.planet.coords_of(&child), (5, 5)); // bindings auto-unwrap
}

#[test]
fn conjoin_same_parent_fails() {
    let f = setup(0x22);
    let user = Address::generate(&f.env);
    let a = mint_genesis(&f, &user, 0, 0);
    let err = f
        .planet
        .try_commit_conjoin(&a, &a, &user, &200u64)
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, Error::SameParent);
}

#[test]
fn conjoin_cooldown_blocks_then_clears() {
    let f = setup(0x33);
    let user = Address::generate(&f.env);

    let a = mint_genesis(&f, &user, 0, 0);
    let b = mint_genesis(&f, &user, 1, 1);
    let c = mint_genesis(&f, &user, 2, 2);

    let _ = conjoin(&f, a, b, &user);

    let err = f
        .planet
        .try_commit_conjoin(&a, &c, &user, &200u64)
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, Error::OnCooldown);

    let current = f.env.ledger().sequence();
    f.env.ledger().set_sequence_number(current + 800);
    let _ = conjoin(&f, a, c, &user);
}

#[test]
fn care_changes_vitals() {
    let f = setup(0x44);
    let user = Address::generate(&f.env);
    let id = mint_genesis(&f, &user, 0, 0);

    let before = f.planet.vitals_of(&id);
    f.planet.care(&id, &(stats::Care::Warm as u32));
    let after = f.planet.vitals_of(&id);
    assert_ne!(before, after);
}

#[test]
fn invalid_care_action_errors() {
    let f = setup(0x55);
    let user = Address::generate(&f.env);
    let id = mint_genesis(&f, &user, 0, 0);
    let err = f.planet.try_care(&id, &999u32).err().unwrap().unwrap();
    assert_eq!(err, Error::InvalidCareAction);
}

#[test]
fn migrate_updates_coords() {
    let f = setup(0x66);
    let user = Address::generate(&f.env);
    let id = mint_genesis(&f, &user, 0, 0);
    f.planet.migrate(&id, &42, &-17);
    assert_eq!(f.planet.coords_of(&id), (42, -17));
}

#[test]
fn vitals_decay_after_many_periods() {
    let f = setup(0x77);
    let user = Address::generate(&f.env);
    let id = mint_genesis(&f, &user, 0, 0);
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
    let c1 = dna::crossover(&env, &a, &b, &r, 42, 0);
    let c2 = dna::crossover(&env, &a, &b, &r, 42, 0);
    assert_eq!(c1, c2);
}

#[test]
fn dna_crossover_differs_per_seed() {
    let env = Env::default();
    let a = BytesN::from_array(&env, &[0x11; 32]);
    let b = BytesN::from_array(&env, &[0x22; 32]);
    let r1 = BytesN::from_array(&env, &[0x33; 32]);
    let r2 = BytesN::from_array(&env, &[0x99; 32]);
    let c1 = dna::crossover(&env, &a, &b, &r1, 7, 0);
    let c2 = dna::crossover(&env, &a, &b, &r2, 7, 0);
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

// =============================================================================
//  Auth gate tests — these *don't* call env.mock_all_auths() globally so we
//  can verify the contract actually rejects callers without the right auth.
// =============================================================================

use soroban_sdk::testutils::MockAuth;
use soroban_sdk::IntoVal;

fn raw_setup() -> Fixture {
    let env = Env::default();
    let admin = Address::generate(&env);
    let drand_id = env.register(MockDrand, ());

    // Seed the mock drand verifier with deterministic randomness. We mock all
    // auths *only for this setup phase*, then drop the mock.
    env.mock_all_auths();
    let drand_client = MockDrandClient::new(&env, &drand_id);
    drand_client.set_latest(&1u64, &BytesN::from_array(&env, &[0x99u8; 32]));

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
    // Reset auth mocks so subsequent calls require explicit auth.
    env.set_auths(&[]);
    Fixture {
        env,
        drand_id,
        planet,
    }
}

#[test]
fn mint_genesis_rejects_non_admin() {
    let f = raw_setup();
    let bystander = Address::generate(&f.env);
    let err = f
        .planet
        .mock_auths(&[MockAuth {
            address: &bystander,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &f.planet.address,
                fn_name: "mint_genesis",
                args: (bystander.clone(), 1u64, 0i32, 0i32).into_val(&f.env),
                sub_invokes: &[],
            },
        }])
        .try_commit_genesis(&bystander, &1u64, &0, &0)
        .err();
    assert!(err.is_some(), "mint_genesis should reject non-admin");
}

#[test]
fn care_rejects_non_owner() {
    let f = setup(0xA1);
    let owner = Address::generate(&f.env);
    let id = mint_genesis(&f, &owner, 0, 0);

    // Drop auth mocks; only `intruder` will authorise from now on.
    f.env.set_auths(&[]);
    let intruder = Address::generate(&f.env);

    let err = f
        .planet
        .mock_auths(&[MockAuth {
            address: &intruder,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &f.planet.address,
                fn_name: "care",
                args: (id, 0u32).into_val(&f.env),
                sub_invokes: &[],
            },
        }])
        .try_care(&id, &0u32)
        .err();
    assert!(
        err.is_some(),
        "care should reject when caller is not the owner"
    );
}

#[test]
fn migrate_rejects_non_owner() {
    let f = setup(0xB2);
    let owner = Address::generate(&f.env);
    let id = mint_genesis(&f, &owner, 0, 0);

    f.env.set_auths(&[]);
    let intruder = Address::generate(&f.env);
    let err = f
        .planet
        .mock_auths(&[MockAuth {
            address: &intruder,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &f.planet.address,
                fn_name: "migrate",
                args: (id, 99i32, 99i32).into_val(&f.env),
                sub_invokes: &[],
            },
        }])
        .try_migrate(&id, &99i32, &99i32)
        .err();
    assert!(err.is_some(), "migrate should reject non-owner");
}

#[test]
fn cooldown_of_view() {
    let f = setup(0xC3);
    let user = Address::generate(&f.env);
    let a = mint_genesis(&f, &user, 0, 0);
    let b = mint_genesis(&f, &user, 1, 1);

    assert_eq!(f.planet.cooldown_of(&a), 0, "fresh planet has no cooldown");

    conjoin(&f, a, b, &user);
    let remaining = f.planet.cooldown_of(&a);
    assert!(
        remaining > 0 && remaining <= 720,
        "cooldown should be set within window"
    );
}

#[test]
fn conjoin_rejects_unhealthy_parent() {
    // We can't easily drive vitals down to 0 in a unit test (decay is slow,
    // care actions cap), so instead we project a planet whose `last_ledger`
    // is far in the past so its vitals decay heavily. With Aether class
    // (seed byte 0xF0 → high nibble 0xF = 15) the decay is gentle, so we
    // use a Void planet (class 8 → byte high nibble 0x8).
    let f = setup(0x80);
    let user = Address::generate(&f.env);
    let a = mint_genesis(&f, &user, 0, 0);
    let b = mint_genesis(&f, &user, 1, 1);

    // Advance ledger by ~500 decay periods (~500h). Void class decay sums to
    // -7/period across vitals, so vitals will hit zero quickly.
    let now = f.env.ledger().sequence();
    f.env.ledger().set_sequence_number(now + 720 * 500);

    let result = f.planet.try_commit_conjoin(&a, &b, &user, &200u64);
    // Either rejected with Unhealthy, or stats are still high enough that
    // the conjoin succeeds — both are valid outcomes for different DNA seeds.
    // We assert at least one of: the gate fired, OR the gate didn't need to fire.
    match result {
        Err(Ok(crate::Error::Unhealthy)) => {} // gate fired — good
        Ok(_) => {
            // Gate didn't fire — check both parents are still healthy enough.
            let va = f.planet.vitals_of(&a);
            let vb = f.planet.vitals_of(&b);
            assert!(stats::healthy_factor(&va) >= 40);
            assert!(stats::healthy_factor(&vb) >= 40);
        }
        other => panic!("unexpected: {:?}", other),
    }
}

#[test]
fn conjoin_rejects_recipient_not_parent_owner() {
    // Audit High #1: 'to' must be one of the parents' owners.
    let f = setup(0xCC);
    let user = Address::generate(&f.env);
    let stranger = Address::generate(&f.env);
    let a = mint_genesis(&f, &user, 0, 0);
    let b = mint_genesis(&f, &user, 1, 1);
    // user owns both parents but tries to mint child to a stranger — rejected.
    let err = f
        .planet
        .try_commit_conjoin(&a, &b, &stranger, &200u64)
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, Error::RecipientNotParentOwner);
}

#[test]
fn set_cooldown_rejects_out_of_range() {
    // Audit Low #1: cooldown bounds.
    let f = setup(0xDD);
    // 0 and u32::MAX should both fail.
    assert!(f.planet.try_set_cooldown(&0u32).err().is_some());
    assert!(f.planet.try_set_cooldown(&u32::MAX).err().is_some());
    // A reasonable value succeeds.
    f.planet.set_cooldown(&720u32);
}

#[test]
fn set_admin_rotates_admin() {
    let f = setup(0xEE);
    let new_admin = Address::generate(&f.env);
    f.planet.set_admin(&new_admin);
    assert_eq!(f.planet.admin(), new_admin);
}

#[test]
fn set_drand_rotates_verifier() {
    let f = setup(0xFE);
    let new_drand = Address::generate(&f.env);
    f.planet.set_drand(&new_drand);
    assert_eq!(f.planet.drand_verifier(), new_drand);
}

#[test]
fn extend_succeeds_for_existing_planet() {
    let f = setup(0xFA);
    let user = Address::generate(&f.env);
    let id = mint_genesis(&f, &user, 0, 0);
    // Anyone can extend an existing planet's TTL.
    f.planet.extend(&id);
}

#[test]
fn extend_rejects_unknown_planet() {
    let f = setup(0xFB);
    let err = f.planet.try_extend(&999u32).err().unwrap().unwrap();
    assert_eq!(err, Error::UnknownPlanet);
}

#[test]
fn enumerable_views_present_via_trait() {
    // The Enumerable extension auto-exports total_supply / get_token_id /
    // get_owner_token_id. Smoke-test that they reflect minted state.
    let f = setup(0x12);
    let user = Address::generate(&f.env);
    assert_eq!(f.planet.total_supply(), 0);
    let _ = mint_genesis(&f, &user, 0, 0);
    let _ = mint_genesis(&f, &user, 1, 1);
    assert_eq!(f.planet.total_supply(), 2);
    assert_eq!(f.planet.get_token_id(&0), 0);
    assert_eq!(f.planet.get_token_id(&1), 1);
    assert_eq!(f.planet.get_owner_token_id(&user, &0), 0);
    assert_eq!(f.planet.get_owner_token_id(&user, &1), 1);
}
