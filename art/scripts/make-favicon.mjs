// Render the brand-mark planet, flood-fill the exterior into transparency
// so the planet floats over any browser tab background. Flood-fill from the
// edge preserves the planet body + rings + moons even if they share colour
// channels with the bg.

import { PNG } from 'pngjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { renderPlanet, dnaFromHex } from '../src/index';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webApp = resolve(__dirname, '../../web/app');
mkdirSync(webApp, { recursive: true });

const BRAND_DNA = 'f0059f00403fc060000000000000000000000000000000000000000000000000';
const dna = dnaFromHex(BRAND_DNA);
const native = renderPlanet(dna);
const W = native.width;
const H = native.height;

// Luma threshold: bg pixels in the rendered planet are dark (the planet
// body is much brighter). Anything below this is a candidate for exterior.
function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
function isDarkish(i) {
  const r = native.data[i];
  const g = native.data[i + 1];
  const b = native.data[i + 2];
  return luma(r, g, b) < 60;
}

// BFS flood-fill from every edge pixel that's "darkish". Only those connected
// to the edge through darkish pixels become transparent; the planet's inner
// shadow stays solid.
const transparent = new Uint8Array(W * H);
const queue = [];
for (let x = 0; x < W; x++) {
  queue.push([x, 0]);
  queue.push([x, H - 1]);
}
for (let y = 0; y < H; y++) {
  queue.push([0, y]);
  queue.push([W - 1, y]);
}
while (queue.length) {
  const [x, y] = queue.shift();
  if (x < 0 || y < 0 || x >= W || y >= H) continue;
  const idx = y * W + x;
  if (transparent[idx]) continue;
  if (!isDarkish(idx * 4)) continue;
  transparent[idx] = 1;
  queue.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
}

function emit(scale, outPath) {
  const OW = W * scale;
  const OH = H * scale;
  const png = new PNG({ width: OW, height: OH });
  for (let y = 0; y < OH; y++) {
    for (let x = 0; x < OW; x++) {
      const sx = Math.floor(x / scale);
      const sy = Math.floor(y / scale);
      const si = (sy * W + sx) * 4;
      const di = (y * OW + x) * 4;
      png.data[di] = native.data[si];
      png.data[di + 1] = native.data[si + 1];
      png.data[di + 2] = native.data[si + 2];
      png.data[di + 3] = transparent[sy * W + sx] ? 0 : native.data[si + 3];
    }
  }
  writeFileSync(outPath, PNG.sync.write(png));
  console.log(`wrote ${outPath} (${OW}x${OH})`);
}

emit(2, resolve(webApp, 'icon.png'));         // 128×128
emit(3, resolve(webApp, 'apple-icon.png'));   // 192×192
