import type { Dna } from './dna';

export type RGB = [number, number, number];

function hslToRgb(h: number, s: number, l: number): RGB {
  h = ((h % 360) + 360) % 360;
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [
    Math.round(f(0) * 255),
    Math.round(f(8) * 255),
    Math.round(f(4) * 255),
  ];
}

export type Palette = {
  bg: RGB;
  shadow: RGB;
  base: RGB;
  mid: RGB;
  highlight: RGB;
  accent: RGB;
  glow: RGB;
};

const CLASS_HUE_BIAS: Record<string, number> = {
  Rocky: 25, Gas: 30, Ocean: 210, Lava: 10,
  Ice: 200, Desert: 35, Jungle: 110, Crystal: 280,
  Void: 270, Forge: 15, Bloom: 320, Cinder: 5,
  Mist: 190, Quartz: 60, Hollow: 0, Aether: 260,
};

export function paletteFor(dna: Dna): Palette {
  const baseHue = (dna.paletteHue / 255) * 360;
  const classBias = CLASS_HUE_BIAS[dna.klass] ?? 0;
  // Blend palette hue toward the class's natural hue. Lower weight = wilder
  // mutations stay visible; higher weight = species reads clearly.
  const h = baseHue * 0.55 + classBias * 0.45;

  const sat = dna.paletteSat;
  const lum = dna.paletteLum;

  let h2 = h;
  let h3 = h;
  switch (dna.paletteScheme) {
    case 'mono':         h2 = h;       h3 = h;       break;
    case 'analogous':    h2 = h + 30;  h3 = h - 30;  break;
    case 'complementary':h2 = h + 180; h3 = h + 150; break;
    case 'triadic':      h2 = h + 120; h3 = h + 240; break;
    case 'split':        h2 = h + 150; h3 = h + 210; break;
  }

  return {
    bg:        hslToRgb(h + 180, Math.min(sat, 25), 6),
    shadow:    hslToRgb(h, sat, Math.max(lum - 30, 8)),
    base:      hslToRgb(h, sat, lum),
    mid:       hslToRgb(h, sat, Math.min(lum + 15, 85)),
    highlight: hslToRgb(h, Math.min(sat + 10, 100), Math.min(lum + 30, 92)),
    accent:    hslToRgb(h2, sat, lum),
    glow:      hslToRgb(h3, sat, Math.min(lum + 20, 80)),
  };
}
