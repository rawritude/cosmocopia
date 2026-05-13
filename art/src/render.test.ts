import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { renderPlanet } from './render';
import { dnaFromHex } from './dna';

test('renderPlanet is deterministic across calls', () => {
  const dna = dnaFromHex('ab11223344556677aabbccddeeff0011223344556677aabbccddeeff00112233');
  const a = renderPlanet(dna).data;
  const b = renderPlanet(dna).data;
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) assert.fail(`pixel byte ${i} differs`);
  }
});

test('renderPlanet differs for different DNAs', () => {
  const a = renderPlanet(dnaFromHex('11'.repeat(32))).data;
  const b = renderPlanet(dnaFromHex('22'.repeat(32))).data;
  let diffs = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diffs++;
  assert.ok(diffs > 1000, `expected substantial differences, got ${diffs}`);
});
