import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { renderPlanet, NATIVE_SIZE } from './render';
import { parseDna, dnaFromHex, dnaToHex, CLASS_NAMES, ATMOSPHERES } from './dna';
import { paletteFor } from './palette';
import { seededRng } from './rng';

// ---------- determinism ----------

test('renderPlanet is deterministic across calls', () => {
  const dna = dnaFromHex('ab11223344556677aabbccddeeff0011223344556677aabbccddeeff00112233');
  const a = renderPlanet(dna).data;
  const b = renderPlanet(dna).data;
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) assert.fail(`pixel byte ${i} differs`);
  }
});

test('renderPlanet differs substantially for different DNAs', () => {
  const a = renderPlanet(dnaFromHex('11'.repeat(32))).data;
  const b = renderPlanet(dnaFromHex('22'.repeat(32))).data;
  let diffs = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diffs++;
  assert.ok(diffs > 1000, `expected substantial differences, got ${diffs}`);
});

test('output size matches NATIVE_SIZE × 4 (RGBA)', () => {
  const dna = dnaFromHex('aa'.repeat(32));
  const out = renderPlanet(dna);
  assert.equal(out.width, NATIVE_SIZE);
  assert.equal(out.height, NATIVE_SIZE);
  assert.equal(out.data.length, NATIVE_SIZE * NATIVE_SIZE * 4);
});

// ---------- DNA layout parity with the Rust contract ----------

test('parseDna picks correct class from high nibble of byte 0', () => {
  // Each class index 0..15 should map to its named class.
  for (let i = 0; i < 16; i++) {
    const bytes = new Uint8Array(32);
    bytes[0] = i << 4;
    const parsed = parseDna(bytes);
    assert.equal(parsed.klass, CLASS_NAMES[i], `class index ${i}`);
  }
});

test('parseDna decodes birth_round as u32 big-endian from bytes 12..16', () => {
  const bytes = new Uint8Array(32);
  // round = 28632125 → 0x01_B4_E4_3D big-endian
  bytes[12] = 0x01;
  bytes[13] = 0xb4;
  bytes[14] = 0xe4;
  bytes[15] = 0x3d;
  const parsed = parseDna(bytes);
  assert.equal(parsed.birthRound, 28632125);
});

test('parseDna pulls generation from byte 16 directly', () => {
  for (const gen of [0, 1, 7, 255]) {
    const bytes = new Uint8Array(32);
    bytes[16] = gen;
    const parsed = parseDna(bytes);
    assert.equal(parsed.generation, gen);
  }
});

test('parseDna lineage parent_mix is bytes 8..12 verbatim', () => {
  const bytes = new Uint8Array(32);
  bytes[8] = 0x0f;
  bytes[9] = 0xc6;
  bytes[10] = 0x8b;
  bytes[11] = 0x42;
  const parsed = parseDna(bytes);
  assert.deepEqual(Array.from(parsed.parentMix), [0x0f, 0xc6, 0x8b, 0x42]);
});

test('parseDna rejects wrong length', () => {
  assert.throws(() => parseDna(new Uint8Array(31)));
  assert.throws(() => parseDna(new Uint8Array(33)));
});

test('dnaFromHex / dnaToHex round-trip', () => {
  const hex = 'f8d581a2a28581790000000001b4e43d001f96b1d5112404c0973db2c80915f3';
  assert.equal(dnaToHex(dnaFromHex(hex)), hex);
});

// ---------- traits actually affect the rendered output ----------

function pixelsDiffer(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

test('palette hue (byte 6) changes the output', () => {
  const base = new Uint8Array(32);
  base[0] = 0x00;        // class Rocky
  base[1] = 0x00;        // smooth, no rings
  base[6] = 0x40;        // hue ~90°
  const altered = new Uint8Array(base);
  altered[6] = 0xC0;     // hue ~270°
  const a = renderPlanet(base).data;
  const b = renderPlanet(altered).data;
  const d = pixelsDiffer(a, b);
  assert.ok(d > 200, `palette change should propagate to pixels, got ${d}`);
});

test('class (byte 0 high nibble) changes the output via class hue bias', () => {
  const a = new Uint8Array(32);
  a[0] = 0x00; // Rocky → warm hue bias
  const b = new Uint8Array(32);
  b[0] = 0x70; // Crystal → purple hue bias
  const pa = renderPlanet(a).data;
  const pb = renderPlanet(b).data;
  assert.ok(pixelsDiffer(pa, pb) > 200);
});

test('rings (byte 1 low 3 bits) change the output', () => {
  const noRings = new Uint8Array(32);
  noRings[1] = 0x00;        // pattern + rings = 0
  const withRings = new Uint8Array(32);
  withRings[1] = 0x03;      // 3 rings, same pattern
  const a = renderPlanet(noRings).data;
  const b = renderPlanet(withRings).data;
  assert.ok(pixelsDiffer(a, b) > 100);
});

test('aura intensity (byte 5) changes the output', () => {
  const off = new Uint8Array(32);
  off[5] = 0x00; // aura none, intensity 0
  const on = new Uint8Array(32);
  on[5] = 0x3F; // aura type 1 (halo), max intensity
  const a = renderPlanet(off).data;
  const b = renderPlanet(on).data;
  assert.ok(pixelsDiffer(a, b) > 50);
});

// ---------- palette ----------

test('paletteFor returns six distinct named slots', () => {
  const dna = parseDna(dnaFromHex('aa'.repeat(32)));
  const p = paletteFor(dna);
  for (const k of ['bg', 'shadow', 'base', 'mid', 'highlight', 'accent', 'glow']) {
    assert.ok(p[k as keyof typeof p], `palette missing slot: ${k}`);
  }
  // base and bg should be visually distinct for any non-degenerate hue.
  const dist = (a: number[], b: number[]) => Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);
  assert.ok(dist(p.base, p.bg) > 30, 'base and bg should be visually distinct');
});

// ---------- rng ----------

test('seededRng is deterministic from the same seed', () => {
  const r1 = seededRng(new Uint8Array([1, 2, 3]));
  const r2 = seededRng(new Uint8Array([1, 2, 3]));
  const a = [r1.next(), r1.next(), r1.next()];
  const b = [r2.next(), r2.next(), r2.next()];
  assert.deepEqual(a, b);
});

test('seededRng produces uniform-ish ints', () => {
  const r = seededRng(new Uint8Array([42]));
  const buckets = [0, 0, 0, 0];
  for (let i = 0; i < 4000; i++) buckets[r.int(4)]++;
  // Expect each bucket within 20% of 1000 — loose but catches obvious bias.
  for (const c of buckets) assert.ok(c > 800 && c < 1200, `bucket ${c}`);
});
