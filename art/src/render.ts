import { PixelCanvas } from './canvas';
import { paletteFor, type Palette, type RGB } from './palette';
import { parseDna, type Dna } from './dna';
import { seededRng, type Rng } from './rng';

// Native pixel grid. Frontend scales this 4x for display; the renderer stays
// pixel-perfect.
export const NATIVE_SIZE = 64;
const CX = NATIVE_SIZE / 2;
const CY = NATIVE_SIZE / 2;
const PLANET_R = 22;

function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] * (1 - t) + b[0] * t),
    Math.round(a[1] * (1 - t) + b[1] * t),
    Math.round(a[2] * (1 - t) + b[2] * t),
  ];
}

function drawStarfield(canvas: PixelCanvas, rng: Rng, pal: Palette) {
  canvas.fill(pal.bg);
  const stars = 18 + rng.int(20);
  for (let i = 0; i < stars; i++) {
    const x = rng.int(canvas.width);
    const y = rng.int(canvas.height);
    const bright = rng.next();
    const c: RGB = bright > 0.8 ? pal.highlight : bright > 0.5 ? pal.mid : pal.glow;
    canvas.set(x, y, c, 180);
  }
}

function drawAuraBack(canvas: PixelCanvas, dna: Dna, pal: Palette) {
  if (dna.aura === 'none') return;
  const intensity = dna.auraIntensity / 31; // 0..1
  const halo = PLANET_R + 6 + Math.round(intensity * 5);
  for (let r = halo; r > PLANET_R + 1; r--) {
    const t = (halo - r) / Math.max(1, halo - PLANET_R - 1);
    const a = Math.round(40 * t * (0.4 + intensity * 0.6));
    canvas.ring(CX, CY, r, 1, pal.glow, a);
  }
}

function drawRingsBack(canvas: PixelCanvas, dna: Dna, pal: Palette) {
  if (dna.ringsCount === 0) return;
  const base = PLANET_R + 4;
  for (let i = 0; i < dna.ringsCount; i++) {
    const rx = base + i * 2;
    const ry = Math.max(3, Math.round(rx * 0.32));
    // Draw only the back half (above the planet's vertical center).
    drawHalfEllipse(canvas, CX, CY, rx, ry, pal.accent, true);
  }
}

function drawHalfEllipse(
  canvas: PixelCanvas,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rgb: RGB,
  topHalf: boolean,
) {
  // Sample x across the ellipse, draw upper or lower arc.
  for (let x = -rx; x <= rx; x++) {
    const yFloat = ry * Math.sqrt(Math.max(0, 1 - (x * x) / (rx * rx)));
    const y = Math.round(yFloat);
    if (topHalf) {
      canvas.set(cx + x, cy - y, rgb);
    } else {
      canvas.set(cx + x, cy + y, rgb);
    }
  }
}

function drawCore(canvas: PixelCanvas, dna: Dna, pal: Palette, rng: Rng) {
  // The planet body: a shaded sphere with class-specific surface texture.
  canvas.disk(CX, CY, PLANET_R, (dx, dy, d2) => {
    // Normalized direction & "depth" — fake lighting from upper-left.
    const r = PLANET_R;
    const nx = dx / r;
    const ny = dy / r;
    const lit = (-nx + -ny) / 1.41; // dot with (-1,-1) normalized
    const t = (lit + 1) / 2; // 0..1

    // Base shading.
    let c: RGB;
    if (t > 0.78) c = pal.highlight;
    else if (t > 0.55) c = mixRgb(pal.mid, pal.highlight, (t - 0.55) / 0.23);
    else if (t > 0.32) c = mixRgb(pal.base, pal.mid, (t - 0.32) / 0.23);
    else if (t > 0.12) c = mixRgb(pal.shadow, pal.base, (t - 0.12) / 0.20);
    else c = pal.shadow;

    // Apply surface pattern.
    c = applyPattern(c, dx, dy, dna, pal, rng);
    return c;
  });
}

function applyPattern(c: RGB, dx: number, dy: number, dna: Dna, pal: Palette, _rng: Rng): RGB {
  const r = PLANET_R;
  const u = dx / r;
  const v = dy / r;
  switch (dna.pattern) {
    case 'striped': {
      const band = Math.floor((v + 1) * 6);
      if (band % 2 === 0) return mixRgb(c, pal.accent, 0.25);
      return c;
    }
    case 'banded': {
      const band = Math.floor((v + 1) * 4);
      if (band % 2 === 0) return mixRgb(c, pal.shadow, 0.18);
      return c;
    }
    case 'spotted': {
      const k = Math.sin(u * 9.3) * Math.cos(v * 7.1);
      if (k > 0.55) return pal.accent;
      return c;
    }
    case 'speckled': {
      const k = (Math.sin(u * 17.7) * Math.cos(v * 19.3) + Math.sin(u * 31.1) * 0.5);
      if (k > 0.9) return pal.highlight;
      if (k < -0.85) return pal.shadow;
      return c;
    }
    case 'swirled': {
      const r2 = u * u + v * v;
      const angle = Math.atan2(v, u);
      const swirl = Math.sin(r2 * 8 + angle * 3);
      if (swirl > 0.5) return mixRgb(c, pal.accent, 0.35);
      return c;
    }
    case 'cracked': {
      const k = Math.sin(u * 4.3 + Math.cos(v * 3.7) * 3.0);
      if (Math.abs(k) < 0.05) return pal.shadow;
      return c;
    }
    case 'patchy': {
      const k = Math.sin(u * 5) + Math.cos(v * 6);
      if (k > 0.7) return mixRgb(c, pal.accent, 0.5);
      return c;
    }
    case 'smooth':
    default:
      return c;
  }
}

function drawAtmosphere(canvas: PixelCanvas, dna: Dna, pal: Palette) {
  if (dna.atmosphere === 'none') return;
  const density = Math.min(1, dna.atmosphereDensity / 31);
  const layers = Math.max(1, Math.round(density * 4));
  for (let i = 1; i <= layers; i++) {
    const r = PLANET_R + i;
    const a = Math.round(80 * density / i);
    const tint =
      dna.atmosphere === 'aurora'
        ? pal.glow
        : dna.atmosphere === 'toxic'
          ? pal.accent
          : dna.atmosphere === 'storm'
            ? pal.shadow
            : dna.atmosphere === 'eclipse'
              ? pal.shadow
              : pal.highlight;
    canvas.ring(CX, CY, r, 1, tint, a);
  }
  if (dna.atmosphere === 'sparkle') {
    // sprinkle bright pixels just inside the rim
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const x = Math.round(CX + Math.cos(a) * (PLANET_R - 1));
      const y = Math.round(CY + Math.sin(a) * (PLANET_R - 1));
      if ((i % 2) === 0) canvas.set(x, y, pal.highlight);
    }
  }
}

function drawFeatures(canvas: PixelCanvas, dna: Dna, pal: Palette, rng: Rng) {
  const count = dna.featureIntensity;
  if (count === 0 || dna.feature === 'none') return;

  for (let i = 0; i < count; i++) {
    // Pick a random point inside the planet, biased away from the rim.
    const r = (PLANET_R - 3) * Math.sqrt(rng.next());
    const a = rng.next() * Math.PI * 2;
    const x = Math.round(CX + Math.cos(a) * r);
    const y = Math.round(CY + Math.sin(a) * r);
    paintFeature(canvas, dna.feature, x, y, pal, rng);
  }
}

function paintFeature(c: PixelCanvas, kind: string, x: number, y: number, pal: Palette, rng: Rng) {
  switch (kind) {
    case 'craters': {
      const r = 1 + rng.int(2);
      c.disk(x, y, r, (dx, dy, d2) => (d2 < r * r ? pal.shadow : null));
      c.set(x - 1, y - 1, pal.highlight, 180);
      return;
    }
    case 'oceans': {
      const r = 2 + rng.int(3);
      c.disk(x, y, r, () => pal.accent);
      return;
    }
    case 'mountains': {
      c.set(x, y, pal.highlight);
      c.set(x - 1, y + 1, pal.shadow);
      c.set(x + 1, y + 1, pal.shadow);
      return;
    }
    case 'forests': {
      c.set(x, y, pal.accent);
      c.set(x, y - 1, pal.accent);
      c.set(x + 1, y, pal.accent);
      return;
    }
    case 'cities': {
      c.set(x, y, pal.highlight);
      c.set(x + 1, y, pal.glow);
      c.set(x, y + 1, pal.glow);
      return;
    }
    case 'eyes': {
      c.disk(x, y, 2, (dx, dy, d2) => (d2 < 4 ? pal.highlight : null));
      c.set(x, y, pal.shadow);
      return;
    }
    case 'volcanoes': {
      c.set(x, y, pal.glow);
      c.set(x, y - 1, pal.accent);
      c.set(x + 1, y, pal.shadow);
      c.set(x - 1, y, pal.shadow);
      return;
    }
    case 'runes': {
      // a tiny cross / plus
      c.set(x, y, pal.highlight);
      c.set(x + 1, y, pal.highlight);
      c.set(x - 1, y, pal.highlight);
      c.set(x, y + 1, pal.highlight);
      c.set(x, y - 1, pal.highlight);
      return;
    }
    case 'blossoms': {
      c.set(x, y, pal.glow);
      c.set(x + 1, y, pal.accent);
      c.set(x - 1, y, pal.accent);
      c.set(x, y + 1, pal.accent);
      c.set(x, y - 1, pal.accent);
      return;
    }
    case 'spires': {
      c.set(x, y, pal.highlight);
      c.set(x, y - 1, pal.highlight);
      c.set(x, y - 2, pal.shadow);
      return;
    }
    case 'archipelago': {
      for (let i = 0; i < 3; i++) {
        const xi = x + rng.int(5) - 2;
        const yi = y + rng.int(3) - 1;
        c.set(xi, yi, pal.accent);
      }
      return;
    }
  }
}

function drawRingsFront(canvas: PixelCanvas, dna: Dna, pal: Palette) {
  if (dna.ringsCount === 0) return;
  const base = PLANET_R + 4;
  for (let i = 0; i < dna.ringsCount; i++) {
    const rx = base + i * 2;
    const ry = Math.max(3, Math.round(rx * 0.32));
    drawHalfEllipse(canvas, CX, CY, rx, ry, pal.highlight, false);
  }
}

function drawMoons(canvas: PixelCanvas, dna: Dna, pal: Palette) {
  if (dna.moonCount === 0) return;
  const tilt = (dna.moonTilt / 31) * Math.PI;
  for (let i = 0; i < dna.moonCount; i++) {
    const angle = tilt + i * ((Math.PI * 2) / Math.max(1, dna.moonCount));
    const orbit = PLANET_R + 10;
    const x = Math.round(CX + Math.cos(angle) * orbit);
    const y = Math.round(CY + Math.sin(angle) * orbit * 0.5);
    canvas.disk(x, y, 1 + (i % 2), (dx, dy, d2) =>
      d2 < 4 ? pal.highlight : pal.mid,
    );
  }
}

function drawAuraFront(canvas: PixelCanvas, dna: Dna, pal: Palette) {
  if (dna.aura === 'pulse') {
    // four cardinal bright pixels
    canvas.set(CX, CY - PLANET_R - 3, pal.highlight);
    canvas.set(CX, CY + PLANET_R + 3, pal.highlight);
    canvas.set(CX - PLANET_R - 3, CY, pal.highlight);
    canvas.set(CX + PLANET_R + 3, CY, pal.highlight);
  } else if (dna.aura === 'crown') {
    for (let i = -2; i <= 2; i++) {
      canvas.set(CX + i, CY - PLANET_R - 2, pal.glow);
    }
  }
}

export function renderPlanet(dna: Uint8Array): PixelCanvas {
  const parsed = parseDna(dna);
  const rng = seededRng(dna);
  const pal = paletteFor(parsed);
  const canvas = new PixelCanvas(NATIVE_SIZE, NATIVE_SIZE);

  drawStarfield(canvas, rng, pal);
  drawAuraBack(canvas, parsed, pal);
  drawRingsBack(canvas, parsed, pal);
  drawCore(canvas, parsed, pal, rng);
  drawAtmosphere(canvas, parsed, pal);
  drawFeatures(canvas, parsed, pal, rng);
  drawRingsFront(canvas, parsed, pal);
  drawMoons(canvas, parsed, pal);
  drawAuraFront(canvas, parsed, pal);

  return canvas;
}
