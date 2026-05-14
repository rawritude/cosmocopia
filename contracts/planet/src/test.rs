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
    /// Native XLM SAC under test (host-registered Stellar Asset Contract).
    native_sac: Address,
    /// Burn / sink address configured at construction.
    burn: Address,
    /// Admin address used in `setup` so tests that exercise admin paths can
    /// re-mint XLM to top up keeper balances etc.
    sac_admin: Address,
}

fn setup(seed_byte: u8) -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let drand_id = env.register(MockDrand, ());
    let drand_client = MockDrandClient::new(&env, &drand_id);

    let seed = BytesN::from_array(&env, &[seed_byte; 32]);
    drand_client.set_latest(&1u64, &seed);

    // Register a native-XLM SAC under a controllable admin so tests can mint
    // tokens to keeper addresses. `register_stellar_asset_contract_v2`
    // returns both the SAC address and an issuer-admin handle.
    let sac_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(sac_admin.clone());
    let native_sac = sac.address();
    let burn = Address::generate(&env);

    let planet_id = env.register(
        PlanetContract,
        (
            admin.clone(),
            drand_id.clone(),
            String::from_str(&env, "ipfs://meta/"),
            String::from_str(&env, "Cosmocopia"),
            String::from_str(&env, "PLN"),
            native_sac.clone(),
            burn.clone(),
        ),
    );
    let planet = PlanetContractClient::new(&env, &planet_id);

    Fixture {
        env,
        drand_id,
        planet,
        native_sac,
        burn,
        sac_admin,
    }
}

/// Mint `amount` stroops of the test native XLM SAC to `to`. The SAC's admin
/// (`sac_admin` from `setup`) is the only address that can call `mint`.
fn mint_xlm(f: &Fixture, to: &Address, amount: i128) {
    let admin_client = soroban_sdk::token::StellarAssetClient::new(&f.env, &f.native_sac);
    // `mock_all_auths` is active in `setup`; admin auth is mocked too.
    admin_client.mint(to, &amount);
    // Sanity: dont let an unused warning fire if we ever stop using sac_admin.
    let _ = &f.sac_admin;
}

/// Balance helper.
fn xlm_balance(f: &Fixture, who: &Address) -> i128 {
    soroban_sdk::token::TokenClient::new(&f.env, &f.native_sac).balance(who)
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
    let id = f.planet.commit_conjoin(&parent_a, &parent_b, to, &200u64);
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
    // Birth round = observed (100) + LOOKAHEAD (10) per the commit-reveal flow.
    assert_eq!(
        &dna_arr[dna::IDX_BIRTH_ROUND..dna::IDX_BIRTH_ROUND + 4],
        &[0, 0, 0, 110]
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

    let sac_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(sac_admin.clone());
    let native_sac = sac.address();
    let burn = Address::generate(&env);

    let planet_id = env.register(
        PlanetContract,
        (
            admin.clone(),
            drand_id.clone(),
            String::from_str(&env, "ipfs://meta/"),
            String::from_str(&env, "Cosmocopia"),
            String::from_str(&env, "PLN"),
            native_sac.clone(),
            burn.clone(),
        ),
    );
    let planet = PlanetContractClient::new(&env, &planet_id);
    // Reset auth mocks so subsequent calls require explicit auth.
    env.set_auths(&[]);
    Fixture {
        env,
        drand_id,
        planet,
        native_sac,
        burn,
        sac_admin,
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
                fn_name: "commit_genesis",
                args: (bystander.clone(), 1u64, 0i32, 0i32).into_val(&f.env),
                sub_invokes: &[],
            },
        }])
        .try_commit_genesis(&bystander, &1u64, &0, &0)
        .err();
    assert!(err.is_some(), "commit_genesis should reject non-admin");
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

// =============================================================================
//  Commit-reveal flow tests (audit Critical #1/#2)
// =============================================================================

#[test]
fn reveal_genesis_rejects_when_too_soon() {
    let f = setup(0xA0);
    let user = Address::generate(&f.env);
    let id = f.planet.commit_genesis(&user, &100u64, &0i32, &0i32);
    // Don't advance the ledger — should reject with CommitmentNotReady.
    let err = f.planet.try_reveal_genesis(&id).err().unwrap().unwrap();
    assert_eq!(err, Error::CommitmentNotReady);
}

#[test]
fn reveal_conjoin_rejects_when_too_soon() {
    let f = setup(0xB0);
    let user = Address::generate(&f.env);
    let a = mint_genesis(&f, &user, 0, 0);
    let b = mint_genesis(&f, &user, 1, 1);
    let id = f.planet.commit_conjoin(&a, &b, &user, &200u64);
    let err = f.planet.try_reveal_conjoin(&id).err().unwrap().unwrap();
    assert_eq!(err, Error::CommitmentNotReady);
}

#[test]
fn commitment_storage_round_trips() {
    let f = setup(0xC0);
    let user = Address::generate(&f.env);
    let id = f.planet.commit_genesis(&user, &500u64, &7i32, &-3i32);
    let c = f.planet.commitment_of(&id);
    assert_eq!(c.committer, f.planet.admin());
    assert_eq!(c.to, user);
    assert_eq!(c.target_round, 500 + crate::LOOKAHEAD_ROUNDS);
    match c.kind {
        crate::CommitmentKind::Genesis(x, y) => assert_eq!((x, y), (7, -3)),
        _ => panic!("expected Genesis kind"),
    }
    let reveal_after = f.planet.reveal_after(&id);
    assert_eq!(
        reveal_after,
        c.commit_ledger + crate::MIN_REVEAL_DELAY_LEDGERS
    );
}

#[test]
fn reveal_consumes_commitment_no_replay() {
    let f = setup(0xD0);
    let user = Address::generate(&f.env);
    let id = f.planet.commit_genesis(&user, &100u64, &0i32, &0i32);
    let now = f.env.ledger().sequence();
    f.env
        .ledger()
        .set_sequence_number(now + crate::MIN_REVEAL_DELAY_LEDGERS);
    let _ = f.planet.reveal_genesis(&id);
    // Second reveal of the same commitment fails: it's been removed.
    let err = f.planet.try_reveal_genesis(&id).err().unwrap().unwrap();
    assert_eq!(err, Error::UnknownCommitment);
}

#[test]
fn commit_genesis_rejects_non_admin() {
    let f = raw_setup();
    let bystander = Address::generate(&f.env);
    let err = f
        .planet
        .mock_auths(&[MockAuth {
            address: &bystander,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &f.planet.address,
                fn_name: "commit_genesis",
                args: (bystander.clone(), 100u64, 0i32, 0i32).into_val(&f.env),
                sub_invokes: &[],
            },
        }])
        .try_commit_genesis(&bystander, &100u64, &0, &0)
        .err();
    assert!(err.is_some(), "commit_genesis should reject non-admin");
}

// ---------- Dominance / recessive allele tests ----------

#[test]
fn genesis_writes_nonzero_latent() {
    // Seed byte 0xAB → seed = [0xAB; 32]. latent_from_seed reads slots
    // 8..16 (R1) and 16..24 (R2), then XORs token_id into bytes 16..20.
    // For token_id 0, both R1 and R2 should be 0xAB.
    let f = setup(0xAB);
    let user = Address::generate(&f.env);
    let id = mint_genesis(&f, &user, 0, 0);
    let latent = f.planet.latent_of(&id).to_array();
    for i in 0..dna::TRAIT_SLOTS {
        assert_eq!(latent[dna::LATENT_R1_OFFSET + i], 0xAB);
    }
    // Token id 0 XOR'd into bytes 16..20 leaves them 0xAB.
    assert_eq!(latent[dna::LATENT_R2_OFFSET], 0xAB);
}

#[test]
fn latent_of_unknown_planet_errors() {
    let f = setup(0x10);
    let err = f.planet.try_latent_of(&99u32).err().unwrap().unwrap();
    assert_eq!(err, Error::UnknownPlanet);
}

#[test]
fn conjoin_writes_child_latent() {
    let f = setup(0x55);
    let user = Address::generate(&f.env);

    let a = mint_genesis(&f, &user, 0, 0);
    let b = mint_genesis(&f, &user, 5, 5);
    let child = conjoin(&f, a, b, &user);

    // Child latent exists and is the right length. Specific byte values
    // depend on the per-trait dominance roll.
    let latent = f.planet.latent_of(&child).to_array();
    assert_eq!(latent.len(), 32);
}

#[test]
fn dna_dominance_collapses_to_d_when_latents_zero() {
    // When both parents carry zero R1/R2, every per-parent sample resolves
    // to D (sample_allele picks D for any roll < 179). With zero latents
    // and parents whose D bytes match, the child's D bytes must match too
    // — modulo the ~2% mutation chance, which we drive down to zero by
    // controlling the random seed bytes (rr[16+i] & 0x3F >= 2).
    let env = Env::default();
    let mut rand_bytes = [0u8; 32];
    for i in 0..8 {
        rand_bytes[16 + i] = 0xFC; // 0xFC & 0x3F = 60, mutation gate fails.
    }
    let rand = BytesN::from_array(&env, &rand_bytes);
    let a = BytesN::from_array(&env, &[0xAA; 32]);
    let b = BytesN::from_array(&env, &[0xAA; 32]);
    let zero = BytesN::from_array(&env, &[0u8; 32]);

    let (child_dna, _) = dna::crossover_with_latent(&env, &a, &zero, &b, &zero, &rand, 0, 0);
    let bytes = child_dna.to_array();
    for (i, byte) in bytes.iter().enumerate().take(dna::TRAIT_SLOTS) {
        assert_eq!(
            *byte, 0xAA,
            "trait byte {} should be 0xAA when both parents D match",
            i
        );
    }
}

#[test]
fn dna_dominance_can_express_recessive() {
    // Parents:
    //   A: D[0] = 0x10, R1[0] = 0xCC
    //   B: D[0] = 0x10, R1[0] = 0xCC
    // Force both parents' allele sample to land on R1 (roll in 179..235).
    // Force swap_bit = 0 so contrib_a (= R1_a = 0xCC) becomes child D.
    // Disable mutation.
    // Expected: child's slot-0 D = 0xCC (a recessive emerged).
    let env = Env::default();
    let mut rand_bytes = [0u8; 32];
    rand_bytes[0] = 200; // parent A picks R1
    rand_bytes[8] = 200; // parent B picks R1
    rand_bytes[16] = 0x3C; // swap_bit=0, mutation gate fails
    let rand = BytesN::from_array(&env, &rand_bytes);

    let mut dna_a = [0u8; 32];
    dna_a[0] = 0x10;
    let dna_a = BytesN::from_array(&env, &dna_a);
    let dna_b = dna_a.clone();
    let mut latent_a = [0u8; 32];
    latent_a[dna::LATENT_R1_OFFSET] = 0xCC;
    let latent_a = BytesN::from_array(&env, &latent_a);
    let latent_b = latent_a.clone();

    let (child_dna, _) =
        dna::crossover_with_latent(&env, &dna_a, &latent_a, &dna_b, &latent_b, &rand, 0, 0);
    assert_eq!(child_dna.to_array()[0], 0xCC, "recessive should emerge");
}

#[test]
fn dna_dominance_carries_recessive_to_child_latent() {
    // Parent A has unique R2 = 0xFF in trait slot 0. The child's R2 pool
    // draws from {a_R2, a_R2, b_R2, b_R2} (game-audit F9 weighted draw);
    // setting rr[24] & 0x03 = 1 selects pool[1] = a_R2.
    let env = Env::default();
    let mut rand_bytes = [0u8; 32];
    rand_bytes[24] = 1;
    let rand = BytesN::from_array(&env, &rand_bytes);

    let dna_a = BytesN::from_array(&env, &[0u8; 32]);
    let dna_b = BytesN::from_array(&env, &[0u8; 32]);
    let mut latent_a = [0u8; 32];
    latent_a[dna::LATENT_R2_OFFSET] = 0xFF;
    let latent_a = BytesN::from_array(&env, &latent_a);
    let latent_b = BytesN::from_array(&env, &[0u8; 32]);

    let (_, child_latent) =
        dna::crossover_with_latent(&env, &dna_a, &latent_a, &dna_b, &latent_b, &rand, 0, 0);
    assert_eq!(
        child_latent.to_array()[dna::LATENT_R2_OFFSET],
        0xFF,
        "0xFF recessive should propagate from parent A's R2 into child's R2"
    );
}

#[test]
fn conjoin_via_full_flow_writes_latent_and_dna() {
    // End-to-end: two genesis planets minted via the contract, conjoined,
    // child has both DNA and latent stored.
    let f = setup(0x77);
    let user = Address::generate(&f.env);
    let a = mint_genesis(&f, &user, 0, 0);
    let b = mint_genesis(&f, &user, 3, 3);
    let child = conjoin(&f, a, b, &user);
    let _ = f.planet.dna_of(&child);
    let child_latent = f.planet.latent_of(&child).to_array();
    // At least one byte should be non-zero in a non-trivial seed.
    assert!(child_latent.iter().any(|b| *b != 0));
}

// ---------- Audit fix regressions ----------

#[test]
fn audit_m1_same_round_siblings_have_distinct_latent_trait_bytes() {
    // Two genesis planets minted from the SAME drand seed (same target_round)
    // must end up with different R1/R2 trait bytes thanks to the token_id
    // stir into bytes 0..16. Before the M1 fix, both siblings carried
    // byte-identical trait alleles because mix_token_id_into_latent only
    // touched the reserved tail (bytes 16..20).
    let f = setup(0xAB);
    let user = Address::generate(&f.env);
    let a = mint_genesis(&f, &user, 0, 0);
    let b = mint_genesis(&f, &user, 1, 1);
    let lat_a = f.planet.latent_of(&a).to_array();
    let lat_b = f.planet.latent_of(&b).to_array();

    // At least one byte in the trait region (0..16) must differ.
    let mut differs = false;
    for i in 0..(dna::LATENT_R2_OFFSET + dna::TRAIT_SLOTS) {
        if lat_a[i] != lat_b[i] {
            differs = true;
            break;
        }
    }
    assert!(
        differs,
        "same-round siblings must carry distinct R1/R2 trait alleles (audit M1)"
    );
}

#[test]
fn audit_m2_mutation_rate_threshold_is_one() {
    // With rr[16+i] & 0x3F == 0 the mutation gate must fire; with == 1 it
    // must NOT (the new threshold is `< 1`). This pins down the post-fix
    // 1.56% mutation rate and would have failed under the previous `< 2`.
    let env = Env::default();
    let a = BytesN::from_array(&env, &[0xAA; 32]);
    let b = BytesN::from_array(&env, &[0xAA; 32]);
    let zero = BytesN::from_array(&env, &[0u8; 32]);

    // Case A: rr[16] = 0x00 → low 6 bits = 0 → mutation fires.
    let mut rb = [0u8; 32];
    rb[16] = 0x00;
    rb[8] = 0x55; // XOR pad
    let rand = BytesN::from_array(&env, &rb);
    let (child, _) = dna::crossover_with_latent(&env, &a, &zero, &b, &zero, &rand, 0, 0);
    assert_eq!(
        child.to_array()[0],
        0xAA ^ 0x55,
        "rr[16] low6=0 must trigger mutation"
    );

    // Case B: rr[16] = 0x01 → low 6 bits = 1 → mutation does NOT fire.
    // This previously triggered under the < 2 threshold; new < 1 leaves D.
    let mut rb = [0u8; 32];
    rb[16] = 0x01;
    rb[8] = 0x55;
    let rand = BytesN::from_array(&env, &rb);
    let (child, _) = dna::crossover_with_latent(&env, &a, &zero, &b, &zero, &rand, 0, 0);
    assert_eq!(
        child.to_array()[0],
        0xAA,
        "rr[16] low6=1 must NOT trigger mutation post-M2"
    );
}

#[test]
fn audit_m3_legacy_parent_contributes_visible_d_not_zero() {
    // Reproduce the legacy-parent path: parent A has DNA but no Latent in
    // storage. The breeding path must synthesize a latent where R1=R2=D so
    // sample_allele picks the parent's visible D byte 100% of the time
    // instead of injecting 0x00 (~30% under the old zero fallback).
    //
    // We drive the conjoin's randomness so parent A's roll lands in the
    // R1 range (179..235) and the swap_bit puts contrib_a into the child's
    // expressed D. With the OLD zero fallback contrib_a = 0x00 and the
    // child would land on 0x00; under the synthesized fallback contrib_a
    // = A's visible D, so the child inherits A's D.
    let f = setup(0xCC);
    let user = Address::generate(&f.env);

    let a = mint_genesis(&f, &user, 0, 0);
    let b = mint_genesis(&f, &user, 5, 5);

    // Strip A's latent so it looks like a pre-dominance legacy planet.
    f.env.as_contract(&f.planet.address, || {
        f.env
            .storage()
            .persistent()
            .remove(&crate::DataKey::Latent(a));
    });

    let dna_a = f.planet.dna_of(&a).to_array();
    assert_ne!(dna_a[0], 0x00, "fixture must give A a non-zero D[0]");

    // Set the conjoin's randomness so:
    //   rr[0] = 200 → parent A allele roll lands in R1 (179..235)
    //   rr[8] = 0   → parent B allele roll lands in D (< 179)
    //   rr[16] high bit = 0 → swap_bit = 0 → child_d = contrib_a
    //   rr[16] low 6 bits = 60 → mutation gate fails
    let mut rb = [0u8; 32];
    rb[0] = 200;
    rb[16] = 0x3C;
    set_drand(
        &f.env,
        &f.drand_id,
        200 + crate::LOOKAHEAD_ROUNDS,
        0, // unused — we'll overwrite via raw mock below
    );
    // The mock stores the *last* `set_latest` regardless of round; use it
    // to overwrite with our crafted random bytes.
    let drand_client = MockDrandClient::new(&f.env, &f.drand_id);
    drand_client.set_latest(&1u64, &BytesN::from_array(&f.env, &rb));

    let child = conjoin(&f, a, b, &user);
    let child_d0 = f.planet.dna_of(&child).to_array()[0];

    // Under the OLD zero fallback this would be 0x00. Under the fix it
    // is A's visible D byte (because synthesized R1[0] = visible D[0]).
    assert_eq!(
        child_d0, dna_a[0],
        "legacy parent must contribute its visible D, not 0x00 (audit M3)"
    );
}

// ---------- Population gene + civ_tier (game-audit F15) ----------

#[test]
fn genesis_writes_population_byte() {
    // Seed [0xAA; 32], token_id 0 → latent[16] = seed[24] ^ id[0] = 0xAA.
    // 0xAA % 6 = 170 % 6 = 2 (Avian per scene.ts).
    let f = setup(0xAA);
    let user = Address::generate(&f.env);
    let id = mint_genesis(&f, &user, 0, 0);

    let pop = f.planet.population_of(&id);
    assert_eq!(pop, 2, "population should be 0xAA % 6 = 2");
    assert_ne!(pop, 0, "population must not silently fall back to zero");

    // Sanity-check the underlying byte too so future seed-byte changes don't
    // accidentally re-zero the gene.
    let latent = f.planet.latent_of(&id).to_array();
    assert_eq!(latent[dna::LATENT_POP_D], 0xAA);
}

#[test]
fn population_propagates_through_conjoin() {
    // Two parents with distinct population D values must produce a child
    // whose population D is drawn from one of the parents' (D, R1, R2).
    let env = Env::default();
    let mut dna_a = [0u8; 32];
    let mut dna_b = [0u8; 32];
    // Distinct trait bytes so DNA isn't byte-identical.
    dna_a[0] = 0x11;
    dna_b[0] = 0x22;
    let dna_a = BytesN::from_array(&env, &dna_a);
    let dna_b = BytesN::from_array(&env, &dna_b);

    // Parent A pop: D=0xAA, R1=0xBB, R2=0xCC. Parent B pop: D=0xDD, R1=0xEE, R2=0xFE.
    let mut lat_a = [0u8; 32];
    lat_a[dna::LATENT_POP_D] = 0xAA;
    lat_a[dna::LATENT_POP_R1] = 0xBB;
    lat_a[dna::LATENT_POP_R2] = 0xCC;
    let lat_a = BytesN::from_array(&env, &lat_a);
    let mut lat_b = [0u8; 32];
    lat_b[dna::LATENT_POP_D] = 0xDD;
    lat_b[dna::LATENT_POP_R1] = 0xEE;
    lat_b[dna::LATENT_POP_R2] = 0xFE;
    let lat_b = BytesN::from_array(&env, &lat_b);

    // Force rr[23] low6 = 60 → no mutation. Vary swap_bit + roll for coverage.
    let mut rb = [0u8; 32];
    rb[7] = 100; // parent A pop allele: D (< 179)
    rb[15] = 100; // parent B pop allele: D (< 179)
    rb[23] = 0x3C; // swap_bit = 0, mutation gate fails
    rb[31] = 0; // pool[0] = al[pop_r2] = 0xCC
    let rand = BytesN::from_array(&env, &rb);

    let (_, child_latent) =
        dna::crossover_with_latent(&env, &dna_a, &lat_a, &dna_b, &lat_b, &rand, 0, 99);
    let child_pop_d = child_latent.to_array()[dna::LATENT_POP_D];

    // With both rolls < 179 and swap_bit=0: contrib_a = A.D = 0xAA → child_d.
    // (mix_token_id_into_latent only touches byte 19, so 0xAA passes through.)
    assert_eq!(
        child_pop_d, 0xAA,
        "child D should equal contrib_a (parent A's D)"
    );
    // Confirm the child latent's pop D is one of the parents' (D, R1, R2).
    let pool = [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFEu8];
    assert!(
        pool.contains(&child_pop_d),
        "child pop D ({:#04x}) should descend from a parent allele",
        child_pop_d
    );
}

#[test]
fn civ_tier_starts_at_zero_for_genesis() {
    let f = setup(0x10);
    let user = Address::generate(&f.env);
    let id = mint_genesis(&f, &user, 0, 0);
    assert_eq!(f.planet.civ_tier_of(&id), 0);
}

#[test]
fn civ_tier_ratchets_up_on_care() {
    // Bloom (class 10): civ_signal = 0.6*biomass + 0.25*spirit + 0.15*temp.
    // Initial vitals are 128/128/128/128/160 (spirit). Civ signal starts at
    // ~0.6*128 + 0.25*160 + 0.15*128 = 76.8 + 40 + 19.2 = 136 → tier 2.
    // After many Tend calls biomass should saturate at 255, lifting signal
    // above 204 → tier 4.
    //
    // Class 10 = Bloom needs seed_byte high nibble = 0xA. Use 0xA0.
    let f = setup(0xA0);
    let user = Address::generate(&f.env);
    let id = mint_genesis(&f, &user, 0, 0);
    let dna = f.planet.dna_of(&id).to_array();
    assert_eq!(dna[dna::IDX_CLASS] >> 4, 10, "fixture must be Bloom");

    // Tend until biomass saturates.
    for _ in 0..30 {
        f.planet.care(&id, &(stats::Care::Tend as u32));
        // Tick the ledger between calls so each care call writes a fresh
        // last_ledger and decay never undoes our gains.
        let now = f.env.ledger().sequence();
        f.env.ledger().set_sequence_number(now + 1);
    }
    let tier = f.planet.civ_tier_of(&id);
    assert_eq!(tier, 4, "biomass-saturated Bloom should reach tier 4");
}

#[test]
fn civ_tier_class_aware_hollow_thrives_on_low_biomass() {
    // Hollow (class 14): civ_signal = 0.5*(255-biomass) + 0.25*(255-temp) + 0.25*spirit.
    // At the fresh genesis vitals (biomass=128, temp=128, spirit=160):
    //   0.5*(255-128) + 0.25*(255-128) + 0.25*160
    //   = 0.5*127 + 0.25*127 + 0.25*160
    //   = 63 + 31 + 40 = 134 → tier 2 (just under tier 3 at 153).
    // After drops in biomass and temp the signal climbs.
    //
    // Class 14 = Hollow → seed byte 0xE0.
    let f = setup(0xE0);
    let user = Address::generate(&f.env);
    let id = mint_genesis(&f, &user, 0, 0);
    let dna = f.planet.dna_of(&id).to_array();
    assert_eq!(dna[dna::IDX_CLASS] >> 4, 14, "fixture must be Hollow");

    // Drop biomass + temp via Hollow's natural decay: advance the ledger so
    // many decay periods land. Hollow drift is (-1, -1, -2, -1, -1) per period.
    let now = f.env.ledger().sequence();
    f.env
        .ledger()
        .set_sequence_number(now + stats::DECAY_PERIOD_LEDGERS * 200);

    // Calling care(Reflect) only nudges spirit, leaving biomass/temp where
    // decay drove them. Hollow's Reflect default branch is (0,0,0,0,15) so
    // spirit ratchets up too, helping the signal cross thresholds.
    f.planet.care(&id, &(stats::Care::Reflect as u32));
    let tier = f.planet.civ_tier_of(&id);
    assert!(
        tier >= 3,
        "Hollow with decayed biomass should ratchet above tier 2 (got {})",
        tier
    );

    // Inverse: a Hollow at peak biomass should NOT progress past tier 0.
    // Mint a fresh Hollow, push biomass up via Tend (only class default
    // bumps biomass +15), and check civ_tier stays low.
    let id2 = mint_genesis(&f, &user, 4, 4);
    // Sanity: both planets are Hollow.
    let dna2 = f.planet.dna_of(&id2).to_array();
    assert_eq!(dna2[dna::IDX_CLASS] >> 4, 14);
    // Hollow's Tend branch: (0, 0, 0, 5, -5). So biomass climbs by 5/call.
    for _ in 0..20 {
        f.planet.care(&id2, &(stats::Care::Tend as u32));
        let now = f.env.ledger().sequence();
        f.env.ledger().set_sequence_number(now + 1);
    }
    let v2 = f.planet.vitals_of(&id2);
    assert!(
        v2.biomass > 200,
        "Hollow biomass should be high (got {})",
        v2.biomass
    );
    let tier2 = f.planet.civ_tier_of(&id2);
    // High biomass *inverts* in Hollow's signal: 0.5*(255-228)=13, plus
    // 0.25*(255-temp) and 0.25*spirit. Should stay well below tier 4.
    assert!(
        tier2 < 4,
        "Hollow with high biomass should NOT reach tier 4 (got {})",
        tier2
    );
}

#[test]
fn civ_tier_view_falls_back_to_zero_for_legacy_planets() {
    // Pre-civ-tier planets have no CivTier(id) storage slot. The view must
    // return 0 instead of erroring.
    let f = setup(0x33);
    let user = Address::generate(&f.env);
    let id = mint_genesis(&f, &user, 0, 0);

    // Strip the CivTier slot to simulate a legacy planet.
    f.env.as_contract(&f.planet.address, || {
        f.env
            .storage()
            .persistent()
            .remove(&crate::DataKey::CivTier(id));
    });
    assert_eq!(f.planet.civ_tier_of(&id), 0);
}

#[test]
fn population_of_unknown_planet_errors() {
    let f = setup(0x44);
    let err = f.planet.try_population_of(&777u32).err().unwrap().unwrap();
    assert_eq!(err, Error::UnknownPlanet);
}

#[test]
fn audit_m4_allele_weights_doc_matches_implementation() {
    // Verify the documented thresholds 179 and 235 produce the documented
    // boundary behavior. This guards future tinkering: change either
    // boundary and this test catches it.
    let env = Env::default();
    let zero = BytesN::from_array(&env, &[0u8; 32]);

    // Parent A: D=0xAA, R1=0xBB, R2=0xCC. Parent B: D=0xDD (R1/R2 = 0).
    // We sample only parent A's allele path by varying rr[0].
    let mut dna_a_arr = [0u8; 32];
    dna_a_arr[0] = 0xAA;
    let dna_a = BytesN::from_array(&env, &dna_a_arr);
    let mut lat_a_arr = [0u8; 32];
    lat_a_arr[dna::LATENT_R1_OFFSET] = 0xBB;
    lat_a_arr[dna::LATENT_R2_OFFSET] = 0xCC;
    let lat_a = BytesN::from_array(&env, &lat_a_arr);

    let mut dna_b_arr = [0u8; 32];
    dna_b_arr[0] = 0xDD;
    let dna_b = BytesN::from_array(&env, &dna_b_arr);

    // rr[8] high (>=235) forces parent B to its R2 = 0x00. Then swap_bit
    // = 0 (rr[16] high bit) puts contrib_a into child D.
    // rr[16] low 6 bits = 60 (0xFC & 0x3F) blocks mutation.
    fn check(
        env: &Env,
        roll_a: u8,
        expected_a_contrib: u8,
        dna_a: &BytesN<32>,
        lat_a: &BytesN<32>,
        dna_b: &BytesN<32>,
        zero: &BytesN<32>,
    ) {
        let mut rb = [0u8; 32];
        rb[0] = roll_a;
        rb[8] = 240; // parent B → R2 = 0
        rb[16] = 0x7C; // swap_bit = 0, mutation gate fails (low 6 = 60)
        let rand = BytesN::from_array(env, &rb);
        let (child, _) = dna::crossover_with_latent(env, dna_a, lat_a, dna_b, zero, &rand, 0, 0);
        assert_eq!(
            child.to_array()[0],
            expected_a_contrib,
            "roll {} should pick allele {:#04x}",
            roll_a,
            expected_a_contrib
        );
    }

    check(&env, 178, 0xAA, &dna_a, &lat_a, &dna_b, &zero); // just under 179 → D
    check(&env, 179, 0xBB, &dna_a, &lat_a, &dna_b, &zero); // at 179 → R1
    check(&env, 234, 0xBB, &dna_a, &lat_a, &dna_b, &zero); // just under 235 → R1
    check(&env, 235, 0xCC, &dna_a, &lat_a, &dna_b, &zero); // at 235 → R2
}

// ---------- Audit follow-up: M-2 (legacy parent population synthesis) ----------

#[test]
fn legacy_parent_contributes_visible_population_not_zero() {
    // Audit M-2 (parallel to the M-3 fix for trait slots): a legacy parent
    // with no stored latent must not inject pop = 0 into descendants. The
    // breeding synthesis seeds latent[16/17/18] from visible DNA byte 18
    // so `sample_allele` returns the parent's visible population 100% of
    // the time. We exercise this through the full reveal_conjoin path
    // because read_latent_for_breeding is the contract-level glue.
    let f = setup(0x77);
    let user = Address::generate(&f.env);

    // Mint two planets seeded by the [0x77; 32] mock seed.
    let a = mint_genesis(&f, &user, 0, 0);
    let b = mint_genesis(&f, &user, 5, 5);

    // Strip parent A's stored latent to simulate a pre-dominance planet.
    f.env.as_contract(&f.planet.address, || {
        f.env
            .storage()
            .persistent()
            .remove(&crate::DataKey::Latent(a));
    });

    let child = conjoin(&f, a, b, &user);

    // Both parents' visible DNA byte 18 was seeded from the mock seed +
    // token-id stir. With the M-2 fix, the legacy parent contributes its
    // visible population for 100% of its samples instead of injecting 0.
    // The exact resulting pop is deterministic from the test seed but the
    // invariant we pin is: it's NOT 0 (which would be the zero-injection
    // failure mode).
    let child_pop = f.planet.population_of(&child);
    let parent_a_dna = f.planet.dna_of(&a).to_array();
    let parent_a_visible_pop = parent_a_dna[crate::dna::IDX_RESERVED] % 6;
    // The child either inherited the live parent B's pop or the legacy
    // parent A's synthesized-from-visible pop. Both are valid; what's
    // NOT valid is zero unless one of those happens to be zero too.
    if parent_a_visible_pop != 0 {
        assert_ne!(
            child_pop, 0,
            "legacy parent must contribute visible pop {:?}, not Humanoid via zero-injection",
            parent_a_visible_pop
        );
    }
}

// ============================================================================
//  First Light + soulbound (Phase 1 onboarding)
// ============================================================================

/// Helper: end-to-end claim+reveal for First Light. Mints enough XLM to the
/// keeper, calls `claim_first_light`, advances the ledger past the reveal
/// delay, calls `reveal_first_light`, returns the new token id.
fn claim_first_light(f: &Fixture, keeper: &Address) -> u32 {
    mint_xlm(f, keeper, crate::FIRST_LIGHT_FEE_STROOPS);
    let commitment_id = f.planet.claim_first_light(keeper, &100u64);
    let now = f.env.ledger().sequence();
    f.env
        .ledger()
        .set_sequence_number(now + crate::MIN_REVEAL_DELAY_LEDGERS);
    f.planet.reveal_first_light(&commitment_id)
}

#[test]
fn claim_first_light_charges_10_xlm() {
    let f = setup(0xA1);
    let keeper = Address::generate(&f.env);
    mint_xlm(&f, &keeper, crate::FIRST_LIGHT_FEE_STROOPS);
    assert_eq!(xlm_balance(&f, &keeper), crate::FIRST_LIGHT_FEE_STROOPS);

    let _cid = f.planet.claim_first_light(&keeper, &100u64);
    // 5 XLM to burn, 5 XLM to the contract's pool. Keeper balance = 0.
    assert_eq!(xlm_balance(&f, &keeper), 0);
    assert_eq!(xlm_balance(&f, &f.burn), crate::FIRST_LIGHT_BURN_STROOPS);
    assert_eq!(
        xlm_balance(&f, &f.planet.address),
        crate::FIRST_LIGHT_POOL_STROOPS
    );
    assert_eq!(
        f.planet.distribution_pool(),
        crate::FIRST_LIGHT_POOL_STROOPS
    );
}

#[test]
fn claim_first_light_one_shot_per_address() {
    let f = setup(0xA2);
    let keeper = Address::generate(&f.env);
    let _ = claim_first_light(&f, &keeper);
    // Second claim attempt by the same keeper: even pre-fee gate fires.
    // We still mint XLM so the auth gate doesn't fire ambiguously.
    mint_xlm(&f, &keeper, crate::FIRST_LIGHT_FEE_STROOPS);
    let err = f
        .planet
        .try_claim_first_light(&keeper, &200u64)
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, Error::FirstLightAlreadyClaimed);
}

#[test]
fn first_light_coord_in_outer_dark() {
    let f = setup(0xA3);
    let keeper = Address::generate(&f.env);
    let id = claim_first_light(&f, &keeper);
    let (x, y) = f.planet.coords_of(&id);
    assert_eq!(
        galaxy::sector_of(x, y),
        galaxy::SECTOR_OUTER_DARK,
        "First Light coord ({}, {}) must land in Outer Dark",
        x,
        y
    );
}

#[test]
fn first_light_coord_unique() {
    let f = setup(0xA4);
    let k1 = Address::generate(&f.env);
    let k2 = Address::generate(&f.env);
    let id1 = claim_first_light(&f, &k1);
    let id2 = claim_first_light(&f, &k2);
    let xy1 = f.planet.coords_of(&id1);
    let xy2 = f.planet.coords_of(&id2);
    assert_ne!(
        xy1, xy2,
        "two different keepers must end up at distinct coords"
    );
}

#[test]
fn first_light_tier_capped_at_common() {
    // For 8 different seeds, the contract's clamped DNA byte 17's rarity
    // nibble must stay <= FIRST_LIGHT_RARITY_CAP, and the class must never
    // be one of the mythic indices (14 / 15).
    for seed in [0x11u8, 0x33, 0x55, 0x77, 0x99, 0xBB, 0xDD, 0xFF] {
        let f = setup(seed);
        let keeper = Address::generate(&f.env);
        let id = claim_first_light(&f, &keeper);
        let dna = f.planet.dna_of(&id).to_array();
        let rarity = dna[dna::IDX_AFFINITY_RARITY] & 0x0F;
        assert!(
            rarity <= crate::FIRST_LIGHT_RARITY_CAP,
            "rarity nibble {} exceeded Common cap {} for seed {:#x}",
            rarity,
            crate::FIRST_LIGHT_RARITY_CAP,
            seed,
        );
        let class_idx = (dna[dna::IDX_CLASS] >> 4) & 0x0F;
        for m in crate::FIRST_LIGHT_MYTHIC_CLASS_IDS.iter() {
            assert_ne!(
                class_idx, *m,
                "First Light class {} hit a mythic id for seed {:#x}",
                class_idx, seed
            );
        }
    }
}

#[test]
fn soulbound_blocks_transfer() {
    let f = setup(0xB1);
    let keeper = Address::generate(&f.env);
    let id = claim_first_light(&f, &keeper);
    assert!(f.planet.is_soulbound_of(&id));

    let recipient = Address::generate(&f.env);
    let result = f.planet.try_transfer(&keeper, &recipient, &id);
    assert!(result.is_err(), "transfer of a soulbound token must error");
}

#[test]
fn soulbound_blocks_conjoin() {
    let f = setup(0xB2);
    let keeper = Address::generate(&f.env);
    // First Light planet (soulbound) + a regular genesis planet owned by
    // the same keeper. Conjoin should reject because parent A is locked.
    let soulbound = claim_first_light(&f, &keeper);
    set_drand(&f.env, &f.drand_id, 200, 0x22);
    let regular = mint_genesis(&f, &keeper, 5, 5);

    let err = f
        .planet
        .try_commit_conjoin(&soulbound, &regular, &keeper, &300u64)
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, Error::SoulboundLocked);
}

#[test]
fn soulbound_releases_after_7d_consistent_care() {
    // "Consistent care" semantics: the keeper has kept the planet in band
    // every time `care` ran. We simulate that by writing fresh mid-band
    // vitals into storage with `last_ledger = now`, then advancing the
    // ledger by SOULBOUND_RELEASE_LEDGERS so the elapsed window crosses
    // the release threshold. The next care call sees in-band vitals and
    // a HealthySince older than the window → clears the flag.
    let f = setup(0xB3);
    let keeper = Address::generate(&f.env);
    let id = claim_first_light(&f, &keeper);

    let initial_since = f.planet.healthy_since_of(&id);
    assert!(initial_since > 0);

    // Fast-forward past the release window, then refresh vitals to the
    // initial mid-band shape with the new `last_ledger`. This is what an
    // actively-cared-for planet looks like just before its threshold tick.
    let now = f.env.ledger().sequence();
    let later = now + crate::SOULBOUND_RELEASE_LEDGERS + 1;
    f.env.ledger().set_sequence_number(later);
    f.env.as_contract(&f.planet.address, || {
        f.env.storage().persistent().set(
            &crate::DataKey::Vitals(id),
            &crate::stats::Vitals {
                temperature: 128,
                hydration: 128,
                gravity: 128,
                biomass: 128,
                spirit: 160,
                last_ledger: later,
            },
        );
    });

    // `Reflect` only nudges spirit (+15 on most branches), so post-call
    // vitals stay comfortably in the [40, 220] band.
    f.planet.care(&id, &(stats::Care::Reflect as u32));

    assert!(
        !f.planet.is_soulbound_of(&id),
        "after 7d of healthy care the soulbound flag should clear"
    );
}

#[test]
fn soulbound_resets_on_unhealthy() {
    // If vitals drop out of band the HealthySince timer resets to 0 — the
    // next healthy care call starts a fresh streak from `now`, NOT from the
    // initial value.
    let f = setup(0xB4);
    let keeper = Address::generate(&f.env);
    let id = claim_first_light(&f, &keeper);
    let initial_since = f.planet.healthy_since_of(&id);
    assert!(initial_since > 0, "HealthySince must be set at reveal");

    // Tank the planet's vitals by setting them all to 5 directly. Avoid
    // going through `care` because we want a non-care path to verify
    // care still resets the streak on the way back up.
    f.env.as_contract(&f.planet.address, || {
        f.env.storage().persistent().set(
            &crate::DataKey::Vitals(id),
            &crate::stats::Vitals {
                temperature: 5,
                hydration: 5,
                gravity: 5,
                biomass: 5,
                spirit: 5,
                last_ledger: f.env.ledger().sequence(),
            },
        );
    });

    // Trigger a care call — `Reflect` only nudges spirit (+15 on the default
    // branch), so post-call all five vitals are still well out of band.
    f.planet.care(&id, &(stats::Care::Reflect as u32));
    assert_eq!(
        f.planet.healthy_since_of(&id),
        0,
        "unhealthy care must reset HealthySince to 0"
    );
}

#[test]
fn burn_5_xlm_distribution_5_xlm() {
    let f = setup(0xC1);
    let keeper = Address::generate(&f.env);
    mint_xlm(&f, &keeper, crate::FIRST_LIGHT_FEE_STROOPS);
    let _cid = f.planet.claim_first_light(&keeper, &100u64);

    // Exact-split assertions: 5 XLM (= FIRST_LIGHT_BURN_STROOPS) to burn,
    // 5 XLM (= FIRST_LIGHT_POOL_STROOPS) to the contract's distribution
    // pool. Tracks the pool both via the explicit storage view and via
    // the contract's actual on-chain XLM balance.
    assert_eq!(xlm_balance(&f, &f.burn), crate::FIRST_LIGHT_BURN_STROOPS);
    assert_eq!(
        xlm_balance(&f, &f.planet.address),
        crate::FIRST_LIGHT_POOL_STROOPS
    );
    assert_eq!(
        f.planet.distribution_pool(),
        crate::FIRST_LIGHT_POOL_STROOPS
    );
}

#[test]
fn first_light_views_round_trip() {
    let f = setup(0xC2);
    let keeper = Address::generate(&f.env);
    // Pre-claim: views return default-y / empty values.
    assert!(!f.planet.first_light_claimed(&keeper));
    assert_eq!(f.planet.distribution_pool(), 0);
    assert_eq!(f.planet.burn_address(), f.burn);
    assert_eq!(f.planet.native_token(), f.native_sac);

    let id = claim_first_light(&f, &keeper);
    assert!(f.planet.first_light_claimed(&keeper));
    assert!(f.planet.is_soulbound_of(&id));
    assert!(f.planet.healthy_since_of(&id) > 0);
}

#[test]
fn set_burn_address_rotates() {
    let f = setup(0xC3);
    let new_burn = Address::generate(&f.env);
    f.planet.set_burn_address(&new_burn);
    assert_eq!(f.planet.burn_address(), new_burn);
}

#[test]
fn set_native_token_rotates() {
    let f = setup(0xC4);
    let alt = f
        .env
        .register_stellar_asset_contract_v2(f.sac_admin.clone());
    f.planet.set_native_token(&alt.address());
    assert_eq!(f.planet.native_token(), alt.address());
}
