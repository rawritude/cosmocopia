'use client';

import { useEffect, useRef } from 'react';
import { renderPlanet, NATIVE_SIZE } from '@cosmocopia/art';

export default function PlanetSprite({
  dna,
  scale = 4,
}: {
  dna: Uint8Array;
  scale?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    const out = renderPlanet(dna);

    // Build the source ImageData via createImageData so the buffer typing
    // matches what the DOM expects, then upscale onto the display canvas.
    const off = document.createElement('canvas');
    off.width = out.width;
    off.height = out.height;
    const offCtx = off.getContext('2d')!;
    const img = offCtx.createImageData(out.width, out.height);
    img.data.set(out.data);
    offCtx.putImageData(img, 0, 0);

    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.drawImage(off, 0, 0, ctx.canvas.width, ctx.canvas.height);
  }, [dna, scale]);

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
