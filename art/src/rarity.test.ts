import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { computeRarity, tierColor, TIERS, type Tier } from './rarity';
import { dnaFromHex, parseDna } from './dna';

// Helper: build a 32-byte DNA from a per-byte overrides map. Unspecified
// bytes default to 0, which produces the most common possible planet.
function buildDna(overrides: Partial<Record<number, number>> = {}): Uint8Array {
  const buf = new Uint8Array(32);
  for (const [k, v] of Object.entries(overrides)) {
    buf[Number(k)] = v!;
  }
  return buf;
}

// ---------- Baseline ----------

test('all-zero DNA is Common — only the genesis bonus contributes', () => {
  const r = computeRarity({ dna: buildDna() });
  assert.equal(r.tier, 'Common');
  // All-zero implies generation 0, which is the G0 scarcity bonus.
  assert.equal(r.score, 3);
  assert.equal(r.contributions.length, 1);
  assert.equal(r.contributions[0].source, 'Generation');
});

test('gen 1 DNA with no other features scores 0', () => {
  // Byte 16 = generation; set to 1 to drop the G0 bonus.
  const r = computeRarity({ dna: buildDna({ 16: 1 }) });
  assert.equal(r.score, 0);
  assert.equal(r.tier, 'Common');
  assert.deepEqual(r.contributions, []);
});

// ---------- Single-source contributions ----------

test('Aether class adds 6 (mythic biome)', () => {
  // class index 15 (Aether) lives in the high nibble of byte 0.
  const dna = buildDna({ 0: 0xf0 });
  const r = computeRarity({ dna });
  const cls = r.contributions.find((c) => c.source === 'Class');
  assert.ok(cls);
  assert.equal(cls!.points, 6);
});

test('Void class adds 2 (exotic biome)', () => {
  // class index 8 (Void).
  const dna = buildDna({ 0: 0x80 });
  const r = computeRarity({ dna });
  const cls = r.contributions.find((c) => c.source === 'Class');
  assert.ok(cls);
  assert.equal(cls!.points, 2);
});

test('aurora atmosphere adds 4', () => {
  // ATMOSPHERES[4] = 'aurora'; high 3 bits of byte 2.
  // To get index 4 in high 3 bits, byte = 4 << 5 = 0x80.
  const dna = buildDna({ 2: 0x80 });
  const r = computeRarity({ dna });
  const atm = r.contributions.find((c) => c.source === 'Atmosphere');
  assert.ok(atm);
  assert.equal(atm!.points, 4);
});

test('crown aura adds 5', () => {
  // AURAS[7] = 'crown'; high 3 bits of byte 5 = 7 << 5 = 0xe0.
  const dna = buildDna({ 5: 0xe0 });
  const r = computeRarity({ dna });
  const aura = r.contributions.find((c) => c.source === 'Aura');
  assert.ok(aura);
  assert.equal(aura!.points, 5);
});

test('5+ rings add 5', () => {
  // rings count = low 3 bits of byte 1 = 5.
  const dna = buildDna({ 1: 0x05 });
  const r = computeRarity({ dna });
  const rings = r.contributions.find((c) => c.source === 'Rings');
  assert.ok(rings);
  assert.equal(rings!.points, 5);
});

test('feature intensity 15 adds the density bonus', () => {
  // feature kind = high nibble of byte 3; intensity = low nibble.
  // Set feature index 9 (blossoms) + intensity 15.
  const dna = buildDna({ 3: 0x9f });
  const r = computeRarity({ dna });
  const feat = r.contributions.find((c) => c.source === 'Feature');
  const dens = r.contributions.find((c) => c.source === 'Feature density');
  assert.ok(feat);
  assert.ok(dens);
  assert.equal(feat!.points, 4); // blossoms is mythic
  assert.equal(dens!.points, 2);
});

// ---------- Combos ----------

test('Aether + aurora-aura triggers the combo bonus', () => {
  // class 15 (Aether) in byte 0 high nibble + aura 5 (aurora-aura) in byte 5
  // high 3 bits = 5 << 5 = 0xa0.
  const dna = buildDna({ 0: 0xf0, 5: 0xa0 });
  const r = computeRarity({ dna });
  const combo = r.contributions.find((c) => c.source === 'Combo');
  assert.ok(combo);
  assert.equal(combo!.note, 'Aether × aurora-aura');
  assert.equal(combo!.points, 5);
});

test('Hollow + eyes triggers the hollow-with-eyes combo', () => {
  // class 14 (Hollow) + feature 6 (eyes).
  const dna = buildDna({ 0: 0xe0, 3: 0x60 });
  const r = computeRarity({ dna });
  const combos = r.contributions.filter((c) => c.source === 'Combo');
  const hollowEyes = combos.find((c) => c.note === 'Hollow × eyes');
  assert.ok(hollowEyes);
  assert.equal(hollowEyes!.points, 4);
});

// ---------- Location ----------

test('inner-core coords add 5', () => {
  const dna = buildDna();
  const r = computeRarity({ dna, coords: { x: 0, y: 0 } });
  const loc = r.contributions.find((c) => c.source === 'Location');
  assert.ok(loc);
  assert.equal(loc!.points, 5);
});

test('rim coords add 1', () => {
  const dna = buildDna();
  const r = computeRarity({ dna, coords: { x: 200, y: 0 } });
  const loc = r.contributions.find((c) => c.source === 'Location');
  assert.ok(loc);
  assert.equal(loc!.points, 1);
});

test('mid-galaxy coords (radius 50) add nothing', () => {
  const dna = buildDna();
  const r = computeRarity({ dna, coords: { x: 50, y: 0 } });
  const loc = r.contributions.find((c) => c.source === 'Location');
  assert.equal(loc, undefined);
});

// ---------- Tier mapping ----------

test('tier cutoffs are monotonic', () => {
  // Construct synthetic DNAs across the score range by stacking bonuses.
  // Common: all-zero plain (score 3 — only G0). Already covered.
  // Mystic-eligible: Aether + crown + aurora atmo + 5 rings + 4 moons +
  // density bonuses + feature mythic.
  // class 15 (Aether) + aura 7 (crown).
  const allBonuses = buildDna({
    0: 0xf0,              // class = Aether
    1: 0x05,              // 5 rings
    2: (4 << 5) | 31,     // aurora atmosphere, density 31
    3: (9 << 4) | 0xf,    // feature blossoms, intensity 15
    4: (4 << 5) | 0,      // 4 moons
    5: (7 << 5) | 31,     // aura crown, intensity 31
    17: 0xff,             // rarity nibble 15 (max)
  });
  const r = computeRarity({ dna: allBonuses, coords: { x: 0, y: 0 } });
  assert.equal(r.tier, 'Mystic');
});

test('TIERS array order is fixed', () => {
  assert.deepEqual(TIERS, ['Common', 'Rare', 'Epic', 'Legendary', 'Mystic']);
});

test('tierColor returns a hex string for every tier', () => {
  for (const t of TIERS as readonly Tier[]) {
    const c = tierColor(t);
    assert.match(c, /^#[0-9a-f]{6}$/i);
  }
});

// ---------- Pre-parsed DNA path ----------

test('computeRarity accepts a pre-parsed Dna', () => {
  const raw = buildDna({ 0: 0xf0 });
  const parsed = parseDna(raw);
  const r1 = computeRarity({ dna: raw });
  const r2 = computeRarity({ dna: parsed });
  assert.equal(r1.score, r2.score);
  assert.equal(r1.tier, r2.tier);
});

// ---------- Distribution sanity ----------

test('uniformly-random DNAs land in the expected distribution', async () => {
  const { randomBytes } = await import('node:crypto');
  const counts: Record<Tier, number> = {
    Common: 0, Rare: 0, Epic: 0, Legendary: 0, Mystic: 0,
  };
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const r = computeRarity({ dna: new Uint8Array(randomBytes(32)) });
    counts[r.tier]++;
  }
  // Sanity bands — Common should dominate, Mystic should stay rare.
  // (Mean DNA score on uniform bytes is ~12; cutoffs put ~50% under Common.)
  assert.ok(counts.Common >= N * 0.40, `Common too rare: ${counts.Common}/${N}`);
  assert.ok(counts.Mystic <= N * 0.03, `Mystic too common: ${counts.Mystic}/${N}`);
  assert.ok(counts.Legendary <= N * 0.08, `Legendary too common: ${counts.Legendary}/${N}`);
});

// ---------- Real DNA round-trip ----------

test('brand-mark DNA renders to a valid tier', () => {
  // The favicon brand-mark used in the README header.
  const dna = dnaFromHex('f0059f00403fc0600000000000000000ff0000000000000000000000000000ff');
  const r = computeRarity({ dna });
  // Aether (mythic) + 5 rings should land well above Common at least.
  assert.notEqual(r.tier, 'Common');
});
