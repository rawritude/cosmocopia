import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { renderPlanet, NATIVE_SIZE } from './render';
import { dnaFromHex, dnaToHex } from './dna';

// Encode a PixelCanvas to PNG bytes via pngjs.
function toPng(rgba: Uint8ClampedArray, w: number, h: number, scale = 4): Buffer {
  // Nearest-neighbor upscale so the PNG is more visible at native size.
  const W = w * scale;
  const H = h * scale;
  const png = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = Math.floor(x / scale);
      const sy = Math.floor(y / scale);
      const si = (sy * w + sx) * 4;
      const di = (y * W + x) * 4;
      png.data[di] = rgba[si];
      png.data[di + 1] = rgba[si + 1];
      png.data[di + 2] = rgba[si + 2];
      png.data[di + 3] = rgba[si + 3];
    }
  }
  return PNG.sync.write(png);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: tsx src/cli.ts <hex-dna|random> [outfile.png] [scale]');
    process.exit(1);
  }

  let dna: Uint8Array;
  if (args[0] === 'random') {
    dna = new Uint8Array(32);
    for (let i = 0; i < 32; i++) dna[i] = Math.floor(Math.random() * 256);
  } else {
    dna = dnaFromHex(args[0]);
  }

  const out = args[1] ?? `planet-${dnaToHex(dna).slice(0, 8)}.png`;
  const scale = args[2] ? parseInt(args[2], 10) : 4;

  const canvas = renderPlanet(dna);
  const png = toPng(canvas.data, canvas.width, canvas.height, scale);
  writeFileSync(out, png);
  console.log(`wrote ${out}  (DNA ${dnaToHex(dna)})`);
}

main();
