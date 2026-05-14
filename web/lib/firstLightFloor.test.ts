// Belt-and-suspenders test for the First Light Common-tier floor (audit
// C-1 + H-1). The on-chain clamp lives in
// `contracts/planet/src/lib.rs::clamp_first_light_dna` and is sweep-tested
// in `contracts/planet/src/test.rs::first_light_dna_stays_common_across_seed_sweep`.
//
// This test mirrors that clamp in TypeScript and runs the resulting bytes
// through `computeRarity` from @cosmocopia/art — the exact scorer the
// frontend renders. If the on-chain clamp and the frontend scorer ever
// drift, one of the two tests fires.

import { describe, expect, it } from 'vitest';
import { computeRarity } from '@cosmocopia/art';

// ---- Constants mirroring contracts/planet/src/lib.rs FIRST_LIGHT_* ----

const RARITY_CAP = 4;
const ATM_DENSITY_CAP = 27;
const FEAT_INTENSITY_CAP = 13;
const AURA_INTENSITY_CAP = 27;
const MOON_COUNT_CAP = 1;
const RING_COUNT_CAP = 2;
const MYTHIC_CLASS_IDS = new Set([14, 15]);
const MYTHIC_ATM_IDS = new Set([4, 6, 7]);
const MYTHIC_FEAT_IDS = new Set([8, 9, 10]);
const MYTHIC_AURA_IDS = new Set([5, 7]);

// DNA byte indices, mirror of contracts/planet/src/dna.rs.
const IDX_CLASS = 0;
const IDX_SURFACE = 1;       // low 3 bits = ring count
const IDX_ATMOSPHERE = 2;    // high 3 bits = atm idx, low 5 = density
const IDX_FEATURE = 3;       // high 4 bits = feat idx, low 4 = intensity
const IDX_MOON = 4;          // high 3 bits = moon count
const IDX_AURA = 5;          // high 3 bits = aura idx, low 5 = intensity
const IDX_GENERATION = 16;   // pinned to 0 for First Light
const IDX_AFFINITY_RARITY = 17; // low 4 bits = rarity nibble

function clampFirstLightDna(seed: number): Uint8Array {
  const out = new Uint8Array(32).fill(seed);

  // Generation pin (First Light reveals call `dna::from_seed` which sets
  // byte 16 to 0). We mirror that so the +3 G0 bonus is the only
  // unavoidable contribution.
  out[IDX_GENERATION] = 0;

  // 1. Rarity nibble.
  out[IDX_AFFINITY_RARITY] =
    (out[IDX_AFFINITY_RARITY] & 0xf0) |
    Math.min(out[IDX_AFFINITY_RARITY] & 0x0f, RARITY_CAP);

  // 2. Class: deflect mythic via & 0b0111.
  const classIdx = (out[IDX_CLASS] >> 4) & 0x0f;
  if (MYTHIC_CLASS_IDS.has(classIdx)) {
    out[IDX_CLASS] = ((classIdx & 0b0111) << 4) | (out[IDX_CLASS] & 0x0f);
  }

  // 3 + 4. Atmosphere.
  const atmIdx = (out[IDX_ATMOSPHERE] >> 5) & 0x07;
  if (MYTHIC_ATM_IDS.has(atmIdx)) {
    out[IDX_ATMOSPHERE] = ((atmIdx & 0b011) << 5) | (out[IDX_ATMOSPHERE] & 0x1f);
  }
  const atmDensity = Math.min(out[IDX_ATMOSPHERE] & 0x1f, ATM_DENSITY_CAP);
  out[IDX_ATMOSPHERE] = (out[IDX_ATMOSPHERE] & 0xe0) | atmDensity;

  // 5 + 6. Feature.
  const featIdx = (out[IDX_FEATURE] >> 4) & 0x0f;
  if (MYTHIC_FEAT_IDS.has(featIdx)) {
    out[IDX_FEATURE] = ((featIdx & 0b0111) << 4) | (out[IDX_FEATURE] & 0x0f);
  }
  const featIntensity = Math.min(out[IDX_FEATURE] & 0x0f, FEAT_INTENSITY_CAP);
  out[IDX_FEATURE] = (out[IDX_FEATURE] & 0xf0) | featIntensity;

  // 7 + 8. Aura.
  const auraIdx = (out[IDX_AURA] >> 5) & 0x07;
  if (MYTHIC_AURA_IDS.has(auraIdx)) {
    out[IDX_AURA] = ((auraIdx & 0b011) << 5) | (out[IDX_AURA] & 0x1f);
  }
  const auraIntensity = Math.min(out[IDX_AURA] & 0x1f, AURA_INTENSITY_CAP);
  out[IDX_AURA] = (out[IDX_AURA] & 0xe0) | auraIntensity;

  // 9. Moons.
  const moonCount = Math.min((out[IDX_MOON] >> 5) & 0x07, MOON_COUNT_CAP);
  out[IDX_MOON] = (moonCount << 5) | (out[IDX_MOON] & 0x1f);

  // 10. Rings.
  const ringCount = Math.min(out[IDX_SURFACE] & 0x07, RING_COUNT_CAP);
  out[IDX_SURFACE] = (out[IDX_SURFACE] & 0xf8) | ringCount;

  return out;
}

describe('First Light Common-tier floor (belt-and-suspenders)', () => {
  // First Light coords always land in Outer Dark (50 <= r <= ~85 in the
  // ±60 clamp). The scorer's "rim coordinate" bonus needs r² >= 10000 = r >=
  // 100, so First Light coords *never* trigger the +1 rim bonus. We still
  // pass a representative Outer-Dark coord to mirror the production read path.
  const flCoords = { x: 42, y: 42 };

  it('every seed byte yields a Common-tier planet', () => {
    for (let s = 0; s <= 0xff; s++) {
      const clamped = clampFirstLightDna(s);
      const rarity = computeRarity({ dna: clamped, coords: flCoords });
      expect(rarity.tier, `seed ${s.toString(16)} produced ${rarity.tier} (score ${rarity.score})`).toBe('Common');
    }
  });

  it('worst-case score stays below the Rare cutoff of 12', () => {
    let max = 0;
    for (let s = 0; s <= 0xff; s++) {
      const clamped = clampFirstLightDna(s);
      const rarity = computeRarity({ dna: clamped, coords: flCoords });
      if (rarity.score > max) max = rarity.score;
    }
    // The bound proved by the clamp is 7 (G0 + exotic class + rare feature
    // + rare aura). Allow some slack for combos we might add later, but
    // still well below 12.
    expect(max).toBeLessThan(12);
  });
});
