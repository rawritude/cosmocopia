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

pub fn class_of(dna: &[u8; DNA_LEN]) -> u8 {
    (dna[IDX_CLASS] >> 4) & 0x0F
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

/// Per-gene crossover with mutation. Stats are handled separately.
///
/// For each gene byte 0..8:
///   - Pick parent A or B based on a bit from `rand`.
///   - With ~12.5% probability, XOR a mutation byte from `rand`.
///
/// Parent_mix (bytes 8..12) is the XOR of the parents' first four gene bytes,
/// giving every child a deterministic lineage signature.
pub fn crossover(
    env: &Env,
    a: &BytesN<32>,
    b: &BytesN<32>,
    rand: &BytesN<32>,
    round: u64,
    token_id: u32,
) -> BytesN<32> {
    let aa = a.to_array();
    let bb = b.to_array();
    let rr = rand.to_array();
    let mut out = [0u8; DNA_LEN];

    // Trait genes: per-byte crossover with mutation.
    for i in 0..8 {
        let bit = (rr[0] >> i) & 1;
        let mut gene = if bit == 0 { aa[i] } else { bb[i] };
        // Mutation chance ~12.5%.
        if (rr[8 + i] & 0x07) == 0 {
            gene ^= rr[16 + i];
        }
        out[i] = gene;
    }

    // Lineage signature.
    for i in 0..4 {
        out[IDX_PARENT_MIX + i] = aa[i] ^ bb[i];
    }

    write_birth_round(&mut out, round);

    let child_gen = aa[IDX_GENERATION].max(bb[IDX_GENERATION]).saturating_add(1);
    out[IDX_GENERATION] = child_gen;

    // Inherit dominant affinity, mutate rarity from rand.
    let aff_a = aa[IDX_AFFINITY_RARITY] & 0xF0;
    let aff_b = bb[IDX_AFFINITY_RARITY] & 0xF0;
    let rarity = (aa[IDX_AFFINITY_RARITY] & 0x0F)
        .max(bb[IDX_AFFINITY_RARITY] & 0x0F)
        .saturating_add(rr[24] & 0x01);
    let affinity = if (rr[25] & 1) == 0 { aff_a } else { aff_b };
    out[IDX_AFFINITY_RARITY] = affinity | (rarity & 0x0F);

    // Unique salt: stir rand into bytes 18..32 + XOR child token id so
    // siblings born from the same conjoin transaction (impossible today, but
    // robust to future batching) and same-round mints stay distinct.
    out[IDX_RESERVED..DNA_LEN].copy_from_slice(&rr[IDX_RESERVED..DNA_LEN]);
    mix_token_id_into_salt(&mut out, token_id);

    BytesN::from_array(env, &out)
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
