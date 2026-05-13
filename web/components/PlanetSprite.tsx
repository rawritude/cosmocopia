'use client';

import { useEffect, useRef } from 'react';
import { renderPlanet, NATIVE_SIZE, computeRarity, tierColor, type Tier } from '@cosmocopia/art';

export default function PlanetSprite({
  dna,
  coords,
  scale = 4,
}: {
  dna: Uint8Array;
  coords?: { x: number; y: number };
  scale?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);

  // Pre-render the pixel art to an off-screen canvas. The animation loop
  // re-blits this each frame, with rarity-driven overlays painted on top.
  useEffect(() => {
    const out = renderPlanet(dna);
    const off = document.createElement('canvas');
    off.width = out.width;
    off.height = out.height;
    const offCtx = off.getContext('2d')!;
    const img = offCtx.createImageData(out.width, out.height);
    img.data.set(out.data);
    offCtx.putImageData(img, 0, 0);
    baseRef.current = off;
  }, [dna]);

  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;

    const { tier } = computeRarity({ dna, coords });
    const tierC = tierColor(tier);

    // Common planets are static — no rAF loop, just one paint.
    if (tier === 'Common') {
      const paint = () => {
        if (!baseRef.current) return requestAnimationFrame(paint);
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(baseRef.current, 0, 0, W, H);
        cancelAnimationFrame(handle);
      };
      const handle = requestAnimationFrame(paint);
      return () => cancelAnimationFrame(handle);
    }

    let handle = 0;
    let start = 0;
    const center = W / 2;
    const planetR = (W / NATIVE_SIZE) * 22; // matches PLANET_R in render.ts

    const loop = (t: number) => {
      if (!start) start = t;
      const elapsed = (t - start) / 1000; // seconds
      if (!baseRef.current) {
        handle = requestAnimationFrame(loop);
        return;
      }

      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(baseRef.current, 0, 0, W, H);

      paintOverlay(ctx, W, H, center, planetR, tier, tierC, elapsed);
      handle = requestAnimationFrame(loop);
    };
    handle = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(handle);
  }, [dna, coords, scale]);

  return (
    <canvas
      ref={ref}
      width={NATIVE_SIZE * scale}
      height={NATIVE_SIZE * scale}
      style={{
        imageRendering: 'pixelated',
        width: NATIVE_SIZE * scale,
        height: NATIVE_SIZE * scale,
      }}
    />
  );
}

// Paint the tier-specific overlay. We deliberately keep these subtle — the
// planet art should still be the focus. The overlays compose: Mystic stacks
// every effect below it.
function paintOverlay(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  cx: number,
  planetR: number,
  tier: Tier,
  color: string,
  t: number,
) {
  // Rare: a gentle aura pulse — radial gradient that breathes.
  if (tier === 'Rare' || tier === 'Epic' || tier === 'Legendary' || tier === 'Mystic') {
    const pulse = 0.5 + 0.5 * Math.sin(t * 1.6);
    const innerR = planetR * 1.05;
    const outerR = planetR * (1.45 + 0.10 * pulse);
    const grad = ctx.createRadialGradient(cx, cx, innerR, cx, cx, outerR);
    grad.addColorStop(0, withAlpha(color, 0.0));
    grad.addColorStop(0.4, withAlpha(color, 0.10 + 0.10 * pulse));
    grad.addColorStop(1, withAlpha(color, 0.0));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  // Epic: 3 orbiting sparkle pixels around the planet.
  if (tier === 'Epic' || tier === 'Legendary' || tier === 'Mystic') {
    const count = tier === 'Epic' ? 3 : 5;
    const orbit = planetR * 1.55;
    for (let i = 0; i < count; i++) {
      const phase = t * (0.7 + i * 0.05) + (i * Math.PI * 2) / count;
      const x = cx + Math.cos(phase) * orbit;
      const y = cx + Math.sin(phase) * orbit * 0.45; // flat ellipse
      const sparkleR = 2 + (W / NATIVE_SIZE);
      ctx.fillStyle = withAlpha(color, 0.85);
      ctx.beginPath();
      ctx.arc(x, y, sparkleR, 0, Math.PI * 2);
      ctx.fill();
      // Bright core
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.arc(x, y, sparkleR * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Legendary: a rotating halo ring.
  if (tier === 'Legendary' || tier === 'Mystic') {
    const ringR = planetR * 1.35;
    ctx.save();
    ctx.translate(cx, cx);
    ctx.rotate(t * 0.35);
    ctx.scale(1, 0.35); // foreshortened
    ctx.strokeStyle = withAlpha(color, 0.55);
    ctx.lineWidth = Math.max(1.5, W / NATIVE_SIZE);
    ctx.beginPath();
    ctx.arc(0, 0, ringR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Mystic: corona arcs that sweep around the disc.
  if (tier === 'Mystic') {
    const arcs = 3;
    for (let i = 0; i < arcs; i++) {
      const phase = t * 0.8 + (i * Math.PI * 2) / arcs;
      const startA = phase;
      const sweep = Math.PI * 0.35;
      ctx.strokeStyle = withAlpha(color, 0.50 + 0.20 * Math.sin(t * 2 + i));
      ctx.lineWidth = Math.max(1, W / NATIVE_SIZE * 0.75);
      ctx.beginPath();
      ctx.arc(cx, cx, planetR * 1.15, startA, startA + sweep);
      ctx.stroke();
    }
    // particle field — tiny twinkles in a ring
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + t * 0.4;
      const r = planetR * (1.7 + 0.2 * Math.sin(t * 3 + i));
      const x = cx + Math.cos(a) * r;
      const y = cx + Math.sin(a) * r * 0.55;
      const tw = 0.5 + 0.5 * Math.sin(t * 5 + i * 1.3);
      ctx.fillStyle = withAlpha(color, 0.45 + 0.45 * tw);
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }
  }
}

function withAlpha(hex: string, a: number): string {
  const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})`;
}
