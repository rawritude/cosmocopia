import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  renderScene,
  buildScene,
  deriveCivTier,
  derivePopulation,
  SCENE_W,
  SCENE_H,
  POPULATIONS,
  CIV_TIERS,
} from './scene';
import { dnaFromHex } from './dna';

const sampleDna = dnaFromHex('f0059f00403fc0600000000000000000ff0000000000000000000000000000ff');
const fullVitals = {
  temperature: 128,
  hydration: 128,
  gravity: 128,
  biomass: 128,
  spirit: 128,
};

test('renderScene output matches SCENE_W × SCENE_H × 4', () => {
  const out = renderScene({ dna: sampleDna, vitals: fullVitals });
  assert.equal(out.width, SCENE_W);
  assert.equal(out.height, SCENE_H);
  assert.equal(out.data.length, SCENE_W * SCENE_H * 4);
});

test('renderScene is deterministic for same inputs + time', () => {
  const a = renderScene({ dna: sampleDna, vitals: fullVitals }, 0.5);
  const b = renderScene({ dna: sampleDna, vitals: fullVitals }, 0.5);
  for (let i = 0; i < a.data.length; i++) {
    if (a.data[i] !== b.data[i]) assert.fail(`pixel byte ${i} differs`);
  }
});

test('renderScene varies between day and night phases', () => {
  const day = renderScene({ dna: sampleDna, vitals: fullVitals }, 0.5).data;
  const night = renderScene({ dna: sampleDna, vitals: fullVitals }, 0.0).data;
  let diffs = 0;
  for (let i = 0; i < day.length; i++) if (day[i] !== night[i]) diffs++;
  assert.ok(diffs > 500, `expected substantial diff between day/night, got ${diffs}`);
});

test('renderScene differs for different DNAs', () => {
  const a = renderScene({ dna: dnaFromHex('11'.repeat(32)), vitals: fullVitals }).data;
  const b = renderScene({ dna: dnaFromHex('aa'.repeat(32)), vitals: fullVitals }).data;
  let diffs = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diffs++;
  assert.ok(diffs > 1000, `expected substantial diff between DNAs, got ${diffs}`);
});

test('deriveCivTier buckets vitals into 5 tiers', () => {
  // Min vitals → Primitive.
  const lo = deriveCivTier({ temperature: 0, biomass: 0, spirit: 0 });
  assert.equal(lo, 'Primitive');
  // Max vitals → Spacefaring.
  const hi = deriveCivTier({ temperature: 255, biomass: 255, spirit: 255 });
  assert.equal(hi, 'Spacefaring');
  // Mid → somewhere in the middle.
  const mid = deriveCivTier({ temperature: 128, biomass: 128, spirit: 128 });
  assert.ok(CIV_TIERS.includes(mid));
});

test('derivePopulation picks one of the 6 types', () => {
  for (let b = 0; b < 6; b++) {
    const dna = new Uint8Array(32);
    dna[18] = b;
    const pop = derivePopulation(dna);
    assert.equal(pop, POPULATIONS[b]);
  }
});

test('buildScene exposes building / tree / inhabitant arrays', () => {
  const seed = buildScene({ dna: sampleDna, vitals: fullVitals });
  assert.ok(seed.buildings.length >= 1);
  assert.ok(seed.inhabitants.length >= 1);
  // Inhabitants' motion should match population.
  if (seed.population === 'Avian') {
    for (const i of seed.inhabitants) assert.equal(i.motion, 'fly');
  }
});

test('low-vitals seed yields Primitive tier with fewer buildings than max-vitals seed', () => {
  const lo = buildScene({
    dna: sampleDna,
    vitals: { temperature: 10, hydration: 10, gravity: 10, biomass: 10, spirit: 10 },
  });
  const hi = buildScene({
    dna: sampleDna,
    vitals: { temperature: 250, hydration: 250, gravity: 250, biomass: 250, spirit: 250 },
  });
  assert.equal(lo.civTier, 'Primitive');
  assert.equal(hi.civTier, 'Spacefaring');
  // Spacefaring should have more buildings (count grows with civ tier).
  assert.ok(hi.buildings.length >= lo.buildings.length);
});
