// Side-view "surface" scene for a planet. v1 derives population type from
// DNA byte 18 (currently part of the salt) and civ tier from the vitals
// triplet (temp + biomass + spirit). When the contract grows a real Population
// gene and civ_tier stat, those reads move on-chain and this file stops
// computing them.

import { PixelCanvas } from './canvas';
import { paletteFor, type Palette, type RGB } from './palette';
import { parseDna, type Dna } from './dna';
import { seededRng, type Rng } from './rng';

export const SCENE_W = 160;
export const SCENE_H = 96;

const HORIZON_Y = 64; // sky above, terrain below

export const POPULATIONS = [
  'Humanoid',
  'Aquatic',
  'Avian',
  'Crystalline',
  'Subterranean',
  'Hive',
] as const;
export type Population = (typeof POPULATIONS)[number];

export const CIV_TIERS = [
  'Primitive',
  'Agricultural',
  'Industrial',
  'Information',
  'Spacefaring',
] as const;
export type CivTier = (typeof CIV_TIERS)[number];

// 5 vitals are u8 (0..255). The contract today doesn't expose civ_tier so we
// derive it from the "human" vitals: warmth + biomass + spirit.
export function deriveCivTier(vitals: {
  temperature: number;
  biomass: number;
  spirit: number;
}): CivTier {
  const avg = (vitals.temperature + vitals.biomass + vitals.spirit) / 3;
  const idx = Math.min(4, Math.floor(avg / 51));
  return CIV_TIERS[idx];
}

// Population is derived from DNA byte 18 % 6. This byte is currently part of
// the reserved salt region but is deterministic from drand + token_id, so
// derived population is stable per planet.
export function derivePopulation(dna: Uint8Array | Dna): Population {
  const raw = dna instanceof Uint8Array ? dna : dna.raw;
  return POPULATIONS[raw[18] % POPULATIONS.length];
}

export type SceneInputs = {
  dna: Uint8Array | Dna;
  vitals: {
    temperature: number;
    hydration: number;
    gravity: number;
    biomass: number;
    spirit: number;
  };
  /// Optional on-chain population index 0..5 (from `population_of`). When
  /// provided, overrides the local `derivePopulation(dna)` heuristic so the
  /// scene matches what the contract actually stored. Undefined for legacy
  /// planets or pre-pop-civ contract versions; we fall back to the local
  /// derivation in that case.
  population?: number;
  /// Optional on-chain civ tier 0..4 (from `civ_tier_of`). Same fallback
  /// semantics as `population`.
  civTier?: number;
};

export type SceneSeed = {
  population: Population;
  civTier: CivTier;
  buildings: Building[];
  trees: Tree[];
  inhabitants: Inhabitant[];
  palette: Palette;
  dna: Dna;
  // Derived sky tone — palette glow modulated by time, computed by renderScene.
};

export type Building = {
  x: number;
  baseY: number;
  width: number;
  height: number;
  style: BuildingStyle;
  windows: number;
  hasSpire: boolean;
};

export type BuildingStyle =
  | 'hut'           // Primitive
  | 'longhouse'     // Agricultural
  | 'block'         // Industrial
  | 'tower'         // Information
  | 'spire'         // Spacefaring
  | 'shard'         // Crystalline override
  | 'mound'         // Hive/Subterranean override
  | 'reefBlock';    // Aquatic override

export type Tree = { x: number; baseY: number; size: number; kind: 'tree' | 'kelp' | 'crystal' };

export type Inhabitant = {
  /// X position at t=0, will animate around this anchor.
  x: number;
  /// Y position — usually horizon for walkers, sky for flyers.
  y: number;
  /// 0..1 phase used so the same inhabitant moves consistently across frames.
  phase: number;
  /// Color, with alpha optional.
  color: RGB;
  /// 'walk' | 'fly' | 'swim' | 'burrow'.
  motion: 'walk' | 'fly' | 'swim' | 'burrow';
};

export function buildScene(inputs: SceneInputs): SceneSeed {
  const dna = inputs.dna instanceof Uint8Array ? parseDna(inputs.dna) : inputs.dna;

  // Prefer the on-chain values when the caller provided them, otherwise fall
  // back to the local derivations that worked before pop + civ_tier moved on
  // chain. Bounds-clamp so a misbehaved contract response can't index OOB.
  const population: Population =
    typeof inputs.population === 'number' && inputs.population >= 0
      ? POPULATIONS[inputs.population % POPULATIONS.length]
      : derivePopulation(dna);
  const civTier: CivTier =
    typeof inputs.civTier === 'number' && inputs.civTier >= 0
      ? CIV_TIERS[Math.min(inputs.civTier, CIV_TIERS.length - 1)]
      : deriveCivTier(inputs.vitals);

  const rng = seededRng(dna.raw);
  const palette = paletteFor(dna);

  const civIdx = CIV_TIERS.indexOf(civTier);
  const buildingCount = 3 + civIdx * 2 + rng.int(3);
  const buildings: Building[] = [];
  for (let i = 0; i < buildingCount; i++) {
    const w = clamp(6 + rng.int(10) + civIdx * 2, 4, 28);
    const h = clamp(6 + civIdx * 4 + rng.int(civIdx * 6 + 4), 4, 70);
    const x = clamp(rng.int(SCENE_W - w - 4) + 2, 2, SCENE_W - w - 2);
    const style: BuildingStyle = pickBuildingStyle(population, civTier, rng);
    buildings.push({
      x, baseY: HORIZON_Y, width: w, height: h, style,
      windows: civIdx >= 2 ? rng.int(3) + 2 : 0,
      hasSpire: civIdx >= 3 && rng.chance(0.6),
    });
  }

  const treeCount = population === 'Subterranean' ? 1 : 3 + rng.int(6);
  const trees: Tree[] = [];
  for (let i = 0; i < treeCount; i++) {
    const kind: Tree['kind'] =
      population === 'Aquatic' ? 'kelp' :
      population === 'Crystalline' ? 'crystal' :
      'tree';
    trees.push({
      x: rng.int(SCENE_W - 4) + 2,
      baseY: HORIZON_Y,
      size: 3 + rng.int(5),
      kind,
    });
  }

  const inhabitantCount = 4 + Math.min(civIdx, 3) * 2 + rng.int(3);
  const inhabitants: Inhabitant[] = [];
  for (let i = 0; i < inhabitantCount; i++) {
    const motion: Inhabitant['motion'] =
      population === 'Avian'       ? 'fly' :
      population === 'Aquatic'     ? 'swim' :
      population === 'Subterranean' ? 'burrow' :
                                      'walk';
    const x = rng.int(SCENE_W);
    let y = HORIZON_Y - 1;
    if (motion === 'fly') y = 16 + rng.int(40);
    if (motion === 'swim') y = HORIZON_Y + 4 + rng.int(20);
    if (motion === 'burrow') y = HORIZON_Y + 4 + rng.int(10);
    inhabitants.push({
      x, y,
      phase: rng.next(),
      color: tintForPopulation(population, palette, rng),
      motion,
    });
  }

  return { population, civTier, buildings, trees, inhabitants, palette, dna };
}

function pickBuildingStyle(pop: Population, tier: CivTier, rng: Rng): BuildingStyle {
  if (pop === 'Crystalline') return 'shard';
  if (pop === 'Hive' || pop === 'Subterranean') return rng.chance(0.6) ? 'mound' : 'hut';
  if (pop === 'Aquatic') return 'reefBlock';
  switch (tier) {
    case 'Primitive':    return 'hut';
    case 'Agricultural': return rng.chance(0.5) ? 'longhouse' : 'hut';
    case 'Industrial':   return rng.chance(0.5) ? 'block' : 'longhouse';
    case 'Information':  return 'tower';
    case 'Spacefaring':  return 'spire';
  }
}

function tintForPopulation(pop: Population, pal: Palette, rng: Rng): RGB {
  switch (pop) {
    case 'Humanoid':     return jitter(pal.highlight, rng);
    case 'Aquatic':      return jitter(pal.glow, rng);
    case 'Avian':        return jitter(pal.accent, rng);
    case 'Crystalline':  return jitter(pal.mid, rng);
    case 'Subterranean': return jitter(pal.shadow, rng);
    case 'Hive':         return jitter(pal.accent, rng);
  }
}

function jitter(rgb: RGB, rng: Rng): RGB {
  const k = (rng.next() - 0.5) * 30;
  return [
    clamp(rgb[0] + k, 0, 255),
    clamp(rgb[1] + k, 0, 255),
    clamp(rgb[2] + k, 0, 255),
  ];
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

// ---------------------------------------------------------------------------
// Rendering: scene → PixelCanvas. `time` is a 0..1 phase that drives the
// day/night cycle and inhabitant motion.
// ---------------------------------------------------------------------------

export function renderScene(inputs: SceneInputs, time: number = 0.4): PixelCanvas {
  const seed = buildScene(inputs);
  return renderSceneFromSeed(seed, time);
}

export function renderSceneFromSeed(seed: SceneSeed, time: number): PixelCanvas {
  const canvas = new PixelCanvas(SCENE_W, SCENE_H);
  const { palette: pal, dna, buildings, trees, inhabitants, population, civTier } = seed;

  // ----- Sky (gradient, atmosphere-tinted) -----
  drawSky(canvas, pal, dna.atmosphere, time);

  // ----- Distant features: sun/moon, then stars -----
  drawCelestials(canvas, pal, time);

  // ----- Terrain (foreground silhouette band) -----
  drawTerrain(canvas, pal, dna);

  // ----- Trees / kelp / crystals on horizon -----
  for (const tree of trees) drawTree(canvas, tree, pal);

  // ----- Buildings -----
  for (const b of buildings) drawBuilding(canvas, b, pal);

  // ----- Inhabitants (animated) -----
  for (const i of inhabitants) drawInhabitant(canvas, i, pal, time);

  // ----- Weather overlay (if storm/aurora) -----
  drawWeather(canvas, pal, dna.atmosphere, time);

  // Suppress unused-var lint for population/civTier — they are exported via
  // the seed and used by callers, just not in the static render.
  void population; void civTier;

  return canvas;
}

function drawSky(canvas: PixelCanvas, pal: Palette, atmosphere: string, t: number) {
  // Day/night phase: t=0 midnight, t=0.5 noon, t=1 midnight again. We blend
  // between a night and day color to give the modal a subtle motion.
  const dayness = Math.sin(t * Math.PI); // 0 at midnight, 1 at noon
  const top = mix(pal.bg, pal.shadow, 0.4); // deep band high in the sky
  const horizonNight: RGB = mix(pal.shadow, pal.glow, 0.2);
  const horizonDay: RGB = mix(pal.glow, pal.highlight, 0.4);
  const horizon = mix(horizonNight, horizonDay, dayness);

  for (let y = 0; y < HORIZON_Y; y++) {
    const f = y / (HORIZON_Y - 1);
    let col = mix(top, horizon, f);
    // Atmospheres tint the sky.
    if (atmosphere === 'aurora') col = mix(col, pal.accent, 0.15 * Math.sin(t * Math.PI * 4 + y * 0.2));
    else if (atmosphere === 'storm') col = mix(col, pal.shadow, 0.25);
    else if (atmosphere === 'eclipse') col = mix(col, [0,0,0], 0.4);
    else if (atmosphere === 'toxic') col = mix(col, pal.accent, 0.20);
    for (let x = 0; x < SCENE_W; x++) canvas.set(x, y, col);
  }
}

function drawCelestials(canvas: PixelCanvas, pal: Palette, t: number) {
  // Sun arcs from x=0..SCENE_W as t goes 0..1.
  const angle = t * Math.PI; // 0..pi
  const sunX = Math.round((1 - Math.cos(angle)) * 0.5 * SCENE_W);
  const sunY = Math.round(HORIZON_Y - Math.sin(angle) * (HORIZON_Y - 8));
  const dayness = Math.sin(angle);
  if (dayness > 0.05) {
    canvas.disk(sunX, sunY, 3, () => pal.highlight);
    canvas.disk(sunX, sunY, 2, () => [255, 240, 220]);
  }
  // Stars visible mostly at night.
  const starAlpha = Math.round(255 * (1 - dayness));
  if (starAlpha > 20) {
    // Cheap deterministic star field — same positions each frame.
    const STAR_SEEDS: Array<[number, number, number]> = [
      [5,6,200],[12,3,180],[24,9,255],[31,15,160],[45,4,200],[58,12,180],
      [70,7,255],[83,3,200],[97,14,180],[112,8,255],[128,5,180],[143,11,200],
      [18,18,160],[40,22,180],[64,20,200],[90,24,180],[120,18,200],[150,22,160],
    ];
    for (const [x, y, bright] of STAR_SEEDS) {
      const a = Math.min(255, Math.round(starAlpha * (bright / 255)));
      canvas.set(x, y, [255, 255, 240], a);
    }
  }
}

function drawTerrain(canvas: PixelCanvas, pal: Palette, dna: Dna) {
  // Horizon line + soft slope under it.
  const groundShallow = mix(pal.base, pal.shadow, 0.35);
  const groundDeep = pal.shadow;
  for (let y = HORIZON_Y; y < SCENE_H; y++) {
    const f = (y - HORIZON_Y) / (SCENE_H - HORIZON_Y);
    const col = mix(groundShallow, groundDeep, f);
    for (let x = 0; x < SCENE_W; x++) canvas.set(x, y, col);
  }
  // Horizon ridge — a thin highlight band.
  for (let x = 0; x < SCENE_W; x++) {
    canvas.set(x, HORIZON_Y, pal.mid);
  }
  // Surface scatter — pattern-driven flecks.
  if (dna.pattern === 'speckled' || dna.pattern === 'cracked') {
    for (let i = 0; i < 60; i++) {
      const x = (i * 17 + 3) % SCENE_W;
      const y = HORIZON_Y + 4 + ((i * 11) % (SCENE_H - HORIZON_Y - 6));
      canvas.set(x, y, pal.highlight, 100);
    }
  }
}

function drawTree(canvas: PixelCanvas, tree: Tree, pal: Palette) {
  const { x, baseY, size, kind } = tree;
  if (kind === 'crystal') {
    // Angular shard.
    for (let dy = 0; dy < size; dy++) {
      const w = size - dy;
      for (let dx = -w; dx <= w; dx++) {
        canvas.set(x + dx, baseY - dy, pal.accent, 220);
      }
    }
    canvas.set(x, baseY - size, pal.highlight);
    return;
  }
  if (kind === 'kelp') {
    // Wavy vertical line.
    for (let dy = 0; dy < size * 2; dy++) {
      const sway = Math.round(Math.sin(dy * 0.5 + x * 0.1) * 1);
      canvas.set(x + sway, baseY - dy, pal.glow);
    }
    return;
  }
  // Tree: trunk + canopy.
  for (let dy = 0; dy < size; dy++) canvas.set(x, baseY - dy, pal.shadow);
  for (let dx = -size; dx <= size; dx++) {
    for (let dy = -size; dy <= 0; dy++) {
      if (dx * dx + dy * dy <= size * size) {
        canvas.set(x + dx, baseY - size + dy - 1, pal.accent, 220);
      }
    }
  }
}

function drawBuilding(canvas: PixelCanvas, b: Building, pal: Palette) {
  const wallNear = mix(pal.mid, pal.highlight, 0.15);
  const wallShade = mix(pal.shadow, pal.base, 0.4);
  for (let dx = 0; dx < b.width; dx++) {
    for (let dy = 0; dy < b.height; dy++) {
      const x = b.x + dx;
      const y = b.baseY - dy - 1;
      let col = dx < 2 ? wallShade : wallNear;
      if (b.style === 'shard') {
        // Pyramid taper.
        const taper = Math.floor(dy / 2);
        if (dx < taper || dx > b.width - taper - 1) continue;
        col = mix(pal.accent, pal.highlight, dy / b.height);
      }
      if (b.style === 'mound' || b.style === 'hut') {
        // Bell curve.
        const r = b.width / 2;
        const local = dx - r;
        const ceiling = Math.round(b.height * (1 - (local * local) / (r * r)));
        if (dy > ceiling) continue;
        col = b.style === 'hut' ? mix(pal.shadow, pal.base, 0.5) : mix(pal.base, pal.shadow, 0.4);
      }
      if (b.style === 'reefBlock') {
        // Curved top.
        const r = b.width / 2;
        const local = dx - r;
        const top = b.height - Math.floor(((local * local) / (r * r)) * 4);
        if (dy > top) continue;
      }
      canvas.set(x, y, col);
    }
  }
  // Roof line.
  for (let dx = 0; dx < b.width; dx++) {
    canvas.set(b.x + dx, b.baseY - b.height, pal.highlight);
  }
  // Windows (warm lights).
  if (b.windows > 0) {
    for (let i = 0; i < b.windows; i++) {
      const wy = b.baseY - 3 - i * 4;
      for (let wx = 2; wx < b.width - 2; wx += 3) {
        canvas.set(b.x + wx, wy, [255, 220, 140]);
      }
    }
  }
  if (b.hasSpire) {
    const sx = b.x + Math.floor(b.width / 2);
    for (let dy = 0; dy < 6; dy++) {
      canvas.set(sx, b.baseY - b.height - dy - 1, pal.glow);
    }
    canvas.set(sx, b.baseY - b.height - 7, [255, 200, 220]);
  }
}

function drawInhabitant(canvas: PixelCanvas, i: Inhabitant, pal: Palette, t: number) {
  let x = i.x;
  let y = i.y;
  let bob = 0;
  switch (i.motion) {
    case 'walk': {
      const phase = (i.phase + t * 0.18) % 1;
      x = Math.round((i.x + phase * SCENE_W) % SCENE_W);
      // Tiny vertical bob simulates a footstep cycle.
      bob = Math.sin(phase * Math.PI * 16) > 0 ? 0 : -1;
      y = HORIZON_Y - 2 + bob;
      break;
    }
    case 'fly': {
      const phase = (i.phase + t * 0.5) % 1;
      x = Math.round((i.x + phase * SCENE_W) % SCENE_W);
      y = Math.round(i.y + Math.sin(t * Math.PI * 4 + i.phase * 6) * 2);
      break;
    }
    case 'swim': {
      const phase = (i.phase + t * 0.3) % 1;
      x = Math.round((i.x + phase * SCENE_W) % SCENE_W);
      y = Math.round(i.y + Math.sin(t * Math.PI * 6 + i.phase * 6) * 1.5);
      break;
    }
    case 'burrow': {
      const phase = (i.phase + t * 0.15) % 1;
      x = Math.round((i.x + phase * SCENE_W) % SCENE_W);
      // Pop above ground briefly.
      const popping = (phase * 4) % 1 < 0.3;
      y = popping ? HORIZON_Y - 2 : HORIZON_Y + 5;
      break;
    }
  }
  // Flyers read as a 3-pixel wingline that flaps.
  if (i.motion === 'fly') {
    canvas.set(x - 1, y, i.color);
    canvas.set(x, y, i.color);
    canvas.set(x + 1, y, i.color);
    const flap = Math.sin(t * Math.PI * 8 + i.phase * 6) > 0;
    if (flap) {
      canvas.set(x - 1, y - 1, i.color);
      canvas.set(x + 1, y - 1, i.color);
    } else {
      canvas.set(x - 1, y + 1, i.color);
      canvas.set(x + 1, y + 1, i.color);
    }
    return;
  }
  // Body (2x2) + head (1)
  canvas.set(x, y, i.color);
  canvas.set(x + 1, y, i.color);
  canvas.set(x, y + 1, i.color);
  canvas.set(x + 1, y + 1, i.color);
  canvas.set(x, y - 1, i.color);
  if (i.motion === 'walk') {
    canvas.set(x, y + 2, pal.shadow, 140);
    canvas.set(x + 1, y + 2, pal.shadow, 140);
  }
}

function drawWeather(canvas: PixelCanvas, pal: Palette, atmosphere: string, t: number) {
  if (atmosphere === 'storm') {
    // Streaks of rain in the lower sky.
    for (let i = 0; i < 24; i++) {
      const x = (i * 13 + Math.floor(t * 80)) % SCENE_W;
      const y = 20 + ((i * 7) % (HORIZON_Y - 22));
      canvas.set(x, y, pal.highlight, 120);
      canvas.set(x, y + 1, pal.highlight, 80);
    }
  } else if (atmosphere === 'sparkle') {
    for (let i = 0; i < 30; i++) {
      const x = ((i * 11 + Math.floor(t * 40)) * 5) % SCENE_W;
      const y = (i * 7) % HORIZON_Y;
      canvas.set(x, y, [255, 255, 220], 200);
    }
  }
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] * (1 - t) + b[0] * t),
    Math.round(a[1] * (1 - t) + b[1] * t),
    Math.round(a[2] * (1 - t) + b[2] * t),
  ];
}
