// Mirrors the 32-byte DNA layout in contracts/planet/src/dna.rs.

export const DNA_LEN = 32;

export const CLASS_NAMES = [
  'Rocky', 'Gas', 'Ocean', 'Lava',
  'Ice', 'Desert', 'Jungle', 'Crystal',
  'Void', 'Forge', 'Bloom', 'Cinder',
  'Mist', 'Quartz', 'Hollow', 'Aether',
] as const;
export type ClassName = (typeof CLASS_NAMES)[number];

export const SURFACE_PATTERNS = [
  'smooth', 'striped', 'spotted', 'swirled',
  'cracked', 'banded', 'patchy', 'speckled',
] as const;
export type SurfacePattern = (typeof SURFACE_PATTERNS)[number];

export const ATMOSPHERES = [
  'none', 'thin', 'thick', 'storm',
  'aurora', 'toxic', 'sparkle', 'eclipse',
] as const;
export type Atmosphere = (typeof ATMOSPHERES)[number];

export const FEATURES = [
  'none', 'craters', 'oceans', 'mountains',
  'forests', 'cities', 'eyes', 'volcanoes',
  'runes', 'blossoms', 'spires', 'archipelago',
] as const;
export type Feature = (typeof FEATURES)[number];

export const AURAS = [
  'none', 'halo', 'glow', 'shadow',
  'pulse', 'aurora-aura', 'static', 'crown',
] as const;
export type Aura = (typeof AURAS)[number];

export const PALETTE_SCHEMES = [
  'mono', 'analogous', 'complementary', 'triadic', 'split',
] as const;
export type PaletteScheme = (typeof PALETTE_SCHEMES)[number];

export type Dna = {
  raw: Uint8Array;
  klass: ClassName;
  klassByte: number;
  pattern: SurfacePattern;
  ringsCount: number;
  atmosphere: Atmosphere;
  atmosphereDensity: number;
  feature: Feature;
  featureIntensity: number;
  moonCount: number;
  moonTilt: number;
  aura: Aura;
  auraIntensity: number;
  paletteHue: number;
  paletteScheme: PaletteScheme;
  paletteSat: number;
  paletteLum: number;
  generation: number;
  affinity: number;
  rarity: number;
  birthRound: number;
  parentMix: Uint8Array;
  salt: Uint8Array;
};

export function parseDna(raw: Uint8Array): Dna {
  if (raw.length !== DNA_LEN) {
    throw new Error(`expected ${DNA_LEN}-byte DNA, got ${raw.length}`);
  }

  const klassByte = raw[0];
  const klass = CLASS_NAMES[(klassByte >> 4) & 0x0f];
  const pattern = SURFACE_PATTERNS[(raw[1] >> 5) & 0x07];
  const ringsCount = raw[1] & 0x07;

  const atmosphere = ATMOSPHERES[(raw[2] >> 5) & 0x07];
  const atmosphereDensity = raw[2] & 0x1f;

  const feature = FEATURES[(raw[3] >> 4) & 0x0f];
  const featureIntensity = raw[3] & 0x0f;

  const moonCount = (raw[4] >> 5) & 0x07;
  const moonTilt = raw[4] & 0x1f;

  const aura = AURAS[(raw[5] >> 5) & 0x07];
  const auraIntensity = raw[5] & 0x1f;

  const paletteHue = raw[6];
  const paletteScheme = PALETTE_SCHEMES[(raw[7] >> 5) % PALETTE_SCHEMES.length];
  const paletteSat = ((raw[7] >> 2) & 0x07) * 8 + 50; // 50..106
  const paletteLum = (raw[7] & 0x03) * 8 + 45; // 45..69

  const parentMix = raw.slice(8, 12);
  const birthRound =
    (raw[12] << 24) | (raw[13] << 16) | (raw[14] << 8) | raw[15];
  const generation = raw[16];
  const affinity = (raw[17] >> 4) & 0x0f;
  const rarity = raw[17] & 0x0f;
  const salt = raw.slice(18, 32);

  return {
    raw, klass, klassByte, pattern, ringsCount,
    atmosphere, atmosphereDensity,
    feature, featureIntensity,
    moonCount: Math.min(moonCount, 4),
    moonTilt,
    aura, auraIntensity,
    paletteHue, paletteScheme, paletteSat, paletteLum,
    generation, affinity, rarity, birthRound,
    parentMix, salt,
  };
}

export function dnaFromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length !== DNA_LEN * 2) throw new Error('hex must be 64 chars');
  const out = new Uint8Array(DNA_LEN);
  for (let i = 0; i < DNA_LEN; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function dnaToHex(dna: Uint8Array): string {
  return Array.from(dna, (b) => b.toString(16).padStart(2, '0')).join('');
}
