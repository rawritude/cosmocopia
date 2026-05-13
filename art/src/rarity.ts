// Rarity derivation from DNA + coords. Pure function — no contract changes.
// Tiers map to visual treatment in the frontend (badge color + sprite anim).

import { parseDna, type Dna } from './dna';

export const TIERS = ['Common', 'Rare', 'Epic', 'Legendary', 'Mystic'] as const;
export type Tier = (typeof TIERS)[number];

// Tier cutoffs. Tuned so a uniformly-random DNA roll yields roughly:
//   Common ~60%, Rare ~25%, Epic ~10%, Legendary ~3%, Mystic ~1%.
// Sources contributing to the score are documented inline below.
const TIER_CUTOFFS: Array<[Tier, number]> = [
  ['Mystic', 30],
  ['Legendary', 24],
  ['Epic', 18],
  ['Rare', 12],
  ['Common', 0],
];

export type Contribution = { source: string; points: number; note?: string };

export type Rarity = {
  score: number;
  tier: Tier;
  contributions: Contribution[];
};

export type RarityInput = {
  dna: Dna | Uint8Array;
  coords?: { x: number; y: number };
};

// Class indices considered "exotic" (worth points). Indices 14-15 are mythic.
const MYTHIC_CLASS_IDS = new Set([14, 15]);          // Hollow, Aether
const EXOTIC_CLASS_IDS = new Set([8, 9, 10, 11, 12, 13]); // Void..Quartz

const RARE_ATMOSPHERES = new Set(['aurora', 'sparkle', 'eclipse']);

const MYTHIC_FEATURES = new Set(['runes', 'blossoms', 'spires']);
const RARE_FEATURES = new Set(['eyes', 'volcanoes', 'archipelago']);

const MYTHIC_AURAS = new Set(['aurora-aura', 'crown']);
const RARE_AURAS = new Set(['pulse', 'static']);

export function computeRarity(input: RarityInput): Rarity {
  const dna = input.dna instanceof Uint8Array ? parseDna(input.dna) : input.dna;
  const contributions: Contribution[] = [];
  const add = (source: string, points: number, note?: string) => {
    if (points !== 0) contributions.push({ source, points, note });
  };

  // ----- Class (mythic / exotic biome) -----
  const classIdx = (dna.klassByte >> 4) & 0x0f;
  if (MYTHIC_CLASS_IDS.has(classIdx)) add('Class', 6, `${dna.klass} (mythic biome)`);
  else if (EXOTIC_CLASS_IDS.has(classIdx)) add('Class', 2, `${dna.klass} (exotic biome)`);

  // ----- Atmosphere -----
  if (RARE_ATMOSPHERES.has(dna.atmosphere)) add('Atmosphere', 4, dna.atmosphere);
  // uncommon atmospheres (thick/storm/toxic) no longer contribute — they're
  // visually distinct but not actually rare.
  if (dna.atmosphere !== 'none' && dna.atmosphereDensity >= 28) {
    add('Atmosphere density', 2, `density ${dna.atmosphereDensity}/31`);
  }

  // ----- Feature -----
  if (MYTHIC_FEATURES.has(dna.feature)) add('Feature', 4, dna.feature);
  else if (RARE_FEATURES.has(dna.feature)) add('Feature', 1, dna.feature);
  if (dna.feature !== 'none' && dna.featureIntensity >= 14) {
    add('Feature density', 2, `intensity ${dna.featureIntensity}/15`);
  }

  // ----- Aura -----
  if (MYTHIC_AURAS.has(dna.aura)) add('Aura', 5, dna.aura);
  else if (RARE_AURAS.has(dna.aura)) add('Aura', 1, dna.aura);
  if (dna.aura !== 'none' && dna.auraIntensity >= 28) {
    add('Aura intensity', 2, `intensity ${dna.auraIntensity}/31`);
  }

  // ----- Orbital -----
  if (dna.ringsCount >= 5) add('Rings', 5, `${dna.ringsCount} rings`);
  else if (dna.ringsCount >= 3) add('Rings', 1, `${dna.ringsCount} rings`);
  if (dna.moonCount >= 4) add('Moons', 3, `${dna.moonCount} moons`);

  // ----- Stored rarity nibble (0..15) — quantized so it can't dominate -----
  const nibble = dna.rarity;
  const nibblePts = Math.floor(nibble / 5);
  if (nibblePts > 0) add('DNA rarity nibble', nibblePts, `nibble ${nibble}/15`);

  // ----- Generation: G0 (genesis) gets a small scarcity bonus -----
  if (dna.generation === 0) add('Generation', 3, 'genesis (G0)');

  // ----- Combo bonuses -----
  if (dna.klass === 'Aether' && dna.aura === 'aurora-aura') {
    add('Combo', 5, 'Aether × aurora-aura');
  }
  if (dna.klass === 'Hollow' && dna.feature === 'eyes') {
    add('Combo', 4, 'Hollow × eyes');
  }
  if (dna.ringsCount >= 4 && dna.moonCount >= 3) {
    add('Combo', 3, 'orbital wonder (rings 4+ & moons 3+)');
  }
  if (dna.atmosphere === 'eclipse' && dna.aura === 'crown') {
    add('Combo', 4, 'sovereign (eclipse × crown)');
  }
  if (dna.atmosphere === 'aurora' && dna.aura === 'aurora-aura') {
    add('Combo', 3, 'twin aurora');
  }

  // ----- Location (galaxy scarcity) -----
  if (input.coords) {
    const { x, y } = input.coords;
    const d2 = x * x + y * y;
    if (d2 <= 25) add('Location', 5, 'inner-core coordinate');
    else if (d2 <= 100) add('Location', 2, 'near-core coordinate');
    else if (d2 >= 10000) add('Location', 1, 'rim coordinate');
  }

  const score = contributions.reduce((sum, c) => sum + c.points, 0);
  let tier: Tier = 'Common';
  for (const [t, cutoff] of TIER_CUTOFFS) {
    if (score >= cutoff) { tier = t; break; }
  }

  return { score, tier, contributions };
}

export function tierColor(tier: Tier): string {
  switch (tier) {
    case 'Mystic':    return '#ff66ff';
    case 'Legendary': return '#ffb347';
    case 'Epic':      return '#9d6cff';
    case 'Rare':      return '#5cb8ff';
    case 'Common':    return '#94a3b8';
  }
}
