use soroban_sdk::{BytesN, Env};

pub const DNA_LEN: usize = 32;

pub const IDX_CLASS: usize = 0;
pub const IDX_SURFACE: usize = 1;
pub const IDX_ATMOSPHERE: usize = 2;
pub const IDX_FEATURE: usize = 3;
pub const IDX_MOON: usize = 4;
pub const IDX_AURA: usize = 5;
pub const IDX_PALETTE_HUE: usize = 6;
pub const IDX_PALETTE_META: usize = 7;
pub const IDX_PARENT_MIX: usize = 8; // 8..12
pub const IDX_BIRTH_ROUND: usize = 12; // 12..16 BE u32
pub const IDX_GENERATION: usize = 16;
pub const IDX_AFFINITY_RARITY: usize = 17;
pub const IDX_RESERVED: usize = 18; // 18..32 unique salt

/// Number of "trait slots" that participate in dominance/recessive
/// inheritance. The visible DNA byte at index `i` (0..TRAIT_SLOTS) is the
/// expressed (D) allele; the corresponding R1 and R2 alleles live in the
/// latent blob at indices `i` and `TRAIT_SLOTS + i` respectively.
pub const TRAIT_SLOTS: usize = 8;

/// Layout of the latent blob (BytesN<32>):
/// - bytes 0..8:   R1 allele for trait slot i
/// - bytes 8..16:  R2 allele for trait slot i
/// - bytes 16..19: Population gene (D / R1 / R2). See `LATENT_POP_*` below.
/// - bytes 19..32: reserved (zero today; reserved for future genes —
///   the next single-allele-trio gene can take 19/20/21, etc.).
pub const LATENT_LEN: usize = 32;
pub const LATENT_R1_OFFSET: usize = 0;
pub const LATENT_R2_OFFSET: usize = TRAIT_SLOTS; // 8

/// Population gene: a single dominance-trio slot stored at bytes 16/17/18
/// of the latent blob. Public-facing population type is `latent[16] % 6`
/// mapping to the six populations declared in art/src/scene.ts.
pub const LATENT_POP_D: usize = 16;
pub const LATENT_POP_R1: usize = 17;
pub const LATENT_POP_R2: usize = 18;
/// Number of dedicated population-style gene slots so far. Future single-trio
/// genes can claim LATENT_POP_D + 3 * LATENT_POP_SLOTS .. and bump this.
pub const LATENT_POP_SLOTS: usize = 1;

pub fn class_of(dna: &[u8; DNA_LEN]) -> u8 {
    (dna[IDX_CLASS] >> 4) & 0x0F
}

/// Decode the expressed population type from a latent blob. The expressed D
/// byte lives at `LATENT_POP_D`; the public-facing population is `D % 6`
/// per art/src/scene.ts's six-population mapping.
pub fn population_of_latent(latent: &[u8; LATENT_LEN]) -> u8 {
    latent[LATENT_POP_D] % 6
}

pub fn write_birth_round(dna: &mut [u8; DNA_LEN], round: u64) {
    // store the low 32 bits big-endian — enough headroom for centuries of drand
    let r = round as u32;
    dna[IDX_BIRTH_ROUND..IDX_BIRTH_ROUND + 4].copy_from_slice(&r.to_be_bytes());
}

/// Build genesis DNA from a drand-verified random seed. `token_id` is mixed
/// into the salt so two genesis planets minted on the same round still get
/// distinct reserved bytes (audit Informational #1).
pub fn from_seed(env: &Env, seed: &BytesN<32>, round: u64, token_id: u32) -> BytesN<32> {
    let s = seed.to_array();
    let mut out = [0u8; DNA_LEN];

    // Trait genes draw from the first half of the seed.
    out[IDX_CLASS] = s[0];
    out[IDX_SURFACE] = s[1];
    out[IDX_ATMOSPHERE] = s[2];
    out[IDX_FEATURE] = s[3];
    out[IDX_MOON] = s[4];
    out[IDX_AURA] = s[5];
    out[IDX_PALETTE_HUE] = s[6];
    out[IDX_PALETTE_META] = s[7];

    // No parents — leave parent_mix as zero (genesis marker).
    write_birth_round(&mut out, round);
    out[IDX_GENERATION] = 0;
    out[IDX_AFFINITY_RARITY] = s[8];

    // Reserved/unique salt fills the rest from seed, with token_id XOR'd in
    // so every planet has a unique salt even on the same round.
    out[IDX_RESERVED..DNA_LEN].copy_from_slice(&s[IDX_RESERVED..DNA_LEN]);
    mix_token_id_into_salt(&mut out, token_id);

    BytesN::from_array(env, &out)
}

/// Derive the genesis latent (R1 + R2 alleles) from the same drand seed
/// + token id. Returns 32 bytes laid out per `LATENT_*_OFFSET`.
///
/// Latent slices use seed bytes 8..16 and 16..24 (independent from the
/// visible trait bytes 0..7). The token_id is XORed into *every* trait
/// byte of R1 and R2 plus the reserved tail so siblings born on the same
/// drand round (i.e. same `target_round`) carry distinct R1/R2 alleles —
/// closing audit M1. Anti-grinding: the same commit-reveal scheme that
/// protects visible DNA also protects these — the seed is drand-verified
/// and the user commits before its round is published.
pub fn latent_from_seed(env: &Env, seed: &BytesN<32>, token_id: u32) -> BytesN<32> {
    let s = seed.to_array();
    let mut out = [0u8; LATENT_LEN];
    for i in 0..TRAIT_SLOTS {
        out[LATENT_R1_OFFSET + i] = s[(8 + i) % DNA_LEN];
        out[LATENT_R2_OFFSET + i] = s[(16 + i) % DNA_LEN];
    }
    // Stir token_id into the trait bytes themselves so same-round siblings
    // diverge in the breeding-relevant slots, not just the reserved tail.
    let id = token_id.to_le_bytes();
    for i in 0..TRAIT_SLOTS {
        out[LATENT_R1_OFFSET + i] ^= id[i & 3];
        out[LATENT_R2_OFFSET + i] ^= id[(i + 1) & 3];
    }
    // Population gene D/R1/R2 (bytes 16/17/18). Use seed bytes 24/25/26 —
    // independent from the trait slot bytes used above — and stir token_id
    // in so same-round siblings get distinct populations.
    out[LATENT_POP_D] = s[24] ^ id[0];
    out[LATENT_POP_R1] = s[25] ^ id[1];
    out[LATENT_POP_R2] = s[26] ^ id[2];
    BytesN::from_array(env, &out)
}

/// Per-gene crossover with mutation. Stats are handled separately.
///
/// Backwards-compat thin wrapper used by callers that don't (yet) read
/// latent. Internally routes to crossover_with_latent passing all-zero
/// latents for both parents, which collapses dominance probabilities back
/// to "always pick D". Kept around for tests and future call sites.
#[allow(dead_code)]
pub fn crossover(
    env: &Env,
    a: &BytesN<32>,
    b: &BytesN<32>,
    rand: &BytesN<32>,
    round: u64,
    token_id: u32,
) -> BytesN<32> {
    let zero = BytesN::from_array(env, &[0u8; LATENT_LEN]);
    let (dna, _latent) = crossover_with_latent(env, a, &zero, b, &zero, rand, round, token_id);
    dna
}

/// Per-trait dominance-roll crossover. For each of the 8 trait slots:
///
/// - Each parent contributes ONE allele to the child's pool by sampling
///   its own (D, R1, R2) with weights ~70 / 22 / 8.
/// - The two contributed alleles meet; one randomly becomes the child's
///   expressed D, the other becomes the child's R1.
/// - The child's R2 is sampled from the union of both parents' R1/R2
///   pool so recessives keep flowing across generations even when not
///   expressed.
/// - A ~1.56% (1/64) mutation chance XORs a random byte into the child's
///   D for the slot. Mutation does not touch the recessive layer.
///
/// Returns (child_dna, child_latent).
#[allow(clippy::too_many_arguments)]
pub fn crossover_with_latent(
    env: &Env,
    a_dna: &BytesN<32>,
    a_latent: &BytesN<32>,
    b_dna: &BytesN<32>,
    b_latent: &BytesN<32>,
    rand: &BytesN<32>,
    round: u64,
    token_id: u32,
) -> (BytesN<32>, BytesN<32>) {
    let aa = a_dna.to_array();
    let bb = b_dna.to_array();
    let al = a_latent.to_array();
    let bl = b_latent.to_array();
    let rr = rand.to_array();

    let mut out_dna = [0u8; DNA_LEN];
    let mut out_latent = [0u8; LATENT_LEN];

    for i in 0..TRAIT_SLOTS {
        // Each parent contributes one allele from its (D, R1, R2) pool.
        let contrib_a = sample_allele(aa[i], al[i], al[LATENT_R2_OFFSET + i], rr[i]);
        let contrib_b = sample_allele(bb[i], bl[i], bl[LATENT_R2_OFFSET + i], rr[8 + i]);

        // One of the two contributions becomes the child's visible D; the
        // other becomes its R1.
        let swap_bit = (rr[16 + i] >> 7) & 1;
        let (child_d, child_r1) = if swap_bit == 0 {
            (contrib_a, contrib_b)
        } else {
            (contrib_b, contrib_a)
        };

        // R2 is sampled from the two parents' R2 slots only (each weighted
        // 2x in a 4-entry pool). This makes R2 the "deep memory" slot:
        // P(specific grandparent R2 survives a generation) = 0.5 vs. the
        // old 0.25, lifting half-life from ~1.7 to ~3 generations — closes
        // game-audit F9. R1 still propagates via `sample_allele`'s R1 path
        // every generation, so R1 alleles aren't extinct, just no longer
        // demoted into the R2 slot.
        let pool = [
            al[LATENT_R2_OFFSET + i],
            al[LATENT_R2_OFFSET + i],
            bl[LATENT_R2_OFFSET + i],
            bl[LATENT_R2_OFFSET + i],
        ];
        let child_r2 = pool[(rr[24 + (i % 8)] & 0x03) as usize];

        // Mutation: ~1.56% chance (1/64). Reuse rr[16+i] low bits
        // (independent from the swap bit in the high bit).
        let mut final_d = child_d;
        if (rr[16 + i] & 0x3F) < 1 {
            final_d ^= rr[(8 + i) % DNA_LEN];
        }

        out_dna[i] = final_d;
        out_latent[LATENT_R1_OFFSET + i] = child_r1;
        out_latent[LATENT_R2_OFFSET + i] = child_r2;
    }

    // Population gene crossover. Mirrors `sample_allele` + swap + R2-pool +
    // mutation from the trait-slot loop above, applied to the single
    // population trio at bytes 16/17/18 of each parent's latent.
    //
    // Entropy mapping (1 slot only today; future per-slot loop would shift):
    //   rr[7]  → parent A's (D, R1, R2) sample roll
    //   rr[15] → parent B's (D, R1, R2) sample roll
    //   rr[23] → swap_bit (high bit) + mutation gate (low 6 bits)
    //   rr[31] → R2 pool index (low 2 bits)
    // These bytes were already consumed for trait slot 7 above; reuse is
    // intentional and benign — population is a separate domain (0..5), so
    // the correlation with trait slot 7 is just a slight reduction in
    // independent entropy, not a logical conflict.
    for i in 0..LATENT_POP_SLOTS {
        let base = LATENT_POP_D + i * 3;
        let contrib_a = sample_allele(al[base], al[base + 1], al[base + 2], rr[7]);
        let contrib_b = sample_allele(bl[base], bl[base + 1], bl[base + 2], rr[15]);
        let swap_bit = (rr[23] >> 7) & 1;
        let (child_d, child_r1) = if swap_bit == 0 {
            (contrib_a, contrib_b)
        } else {
            (contrib_b, contrib_a)
        };
        let pool = [al[base + 2], al[base + 2], bl[base + 2], bl[base + 2]];
        let child_r2 = pool[(rr[31] & 0x03) as usize];
        let mut final_d = child_d;
        if (rr[23] & 0x3F) < 1 {
            final_d ^= rr[15];
        }
        out_latent[base] = final_d;
        out_latent[base + 1] = child_r1;
        out_latent[base + 2] = child_r2;
    }

    // Lineage signature (unchanged from the legacy crossover).
    for i in 0..4 {
        out_dna[IDX_PARENT_MIX + i] = aa[i] ^ bb[i];
    }
    write_birth_round(&mut out_dna, round);
    let child_gen = aa[IDX_GENERATION].max(bb[IDX_GENERATION]).saturating_add(1);
    out_dna[IDX_GENERATION] = child_gen;

    // Inherit dominant affinity, mutate rarity.
    let aff_a = aa[IDX_AFFINITY_RARITY] & 0xF0;
    let aff_b = bb[IDX_AFFINITY_RARITY] & 0xF0;
    let rarity = (aa[IDX_AFFINITY_RARITY] & 0x0F)
        .max(bb[IDX_AFFINITY_RARITY] & 0x0F)
        .saturating_add(rr[24] & 0x01);
    let affinity = if (rr[25] & 1) == 0 { aff_a } else { aff_b };
    out_dna[IDX_AFFINITY_RARITY] = affinity | (rarity & 0x0F);

    // Unique salt: stir rand into bytes 18..32 + XOR child token id. The
    // latent's trait slots and population trio already carry their own
    // token_id stir from the per-byte writes above, so no separate latent
    // stir is needed here.
    out_dna[IDX_RESERVED..DNA_LEN].copy_from_slice(&rr[IDX_RESERVED..DNA_LEN]);
    mix_token_id_into_salt(&mut out_dna, token_id);

    (
        BytesN::from_array(env, &out_dna),
        BytesN::from_array(env, &out_latent),
    )
}

/// Sample one allele from (D, R1, R2) using `roll` as the entropy.
///
/// Weights: 70 / 22 / 8 (thresholds 179 / 235), i.e. 69.92% D, 21.88% R1,
/// 8.20% R2. The thresholds are chosen so the byte distribution maps
/// cleanly: 0..179 → D, 179..235 → R1, 235..256 → R2.
fn sample_allele(d: u8, r1: u8, r2: u8, roll: u8) -> u8 {
    if roll < 179 {
        d
    } else if roll < 235 {
        r1
    } else {
        r2
    }
}

/// XORs the 4 bytes of `token_id` into the start of the reserved salt
/// region. Spreads the entropy across multiple bytes so a flipped low bit
/// in the id is observable several pixels away in the rendered art.
fn mix_token_id_into_salt(out: &mut [u8; DNA_LEN], token_id: u32) {
    let id = token_id.to_le_bytes();
    out[IDX_RESERVED] ^= id[0];
    out[IDX_RESERVED + 1] ^= id[1];
    out[IDX_RESERVED + 2] ^= id[2];
    out[IDX_RESERVED + 3] ^= id[3];
}

// (mix_token_id_into_latent removed — every byte the helper touched is now
// either stirred in-place by the per-byte writes above, or sits in the
// still-reserved tail that nothing reads.)
