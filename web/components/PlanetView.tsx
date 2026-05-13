'use client';

import { useEffect, useRef } from 'react';
import {
  buildScene,
  renderSceneFromSeed,
  SCENE_W,
  SCENE_H,
  type Population,
  type CivTier,
} from '@cosmocopia/art';
import type { Planet } from '../lib/cosmocopia';

const SCALE = 4;
const CYCLE_SECONDS = 60; // one full day cycle in 60s of wall time

export default function PlanetView({
  planet,
  onClose,
}: {
  planet: Planet;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offRef = useRef<HTMLCanvasElement | null>(null);

  // Build the static seed once per planet; animation just feeds it `time`.
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;

    const seed = buildScene({ dna: planet.dna, vitals: planet.vitals });
    const off = document.createElement('canvas');
    off.width = SCENE_W;
    off.height = SCENE_H;
    offRef.current = off;
    const offCtx = off.getContext('2d')!;

    let handle = 0;
    let start = 0;
    const loop = (now: number) => {
      if (!start) start = now;
      const elapsed = (now - start) / 1000;
      const time = (elapsed % CYCLE_SECONDS) / CYCLE_SECONDS;

      const canvas = renderSceneFromSeed(seed, time);
      const img = offCtx.createImageData(SCENE_W, SCENE_H);
      img.data.set(canvas.data);
      offCtx.putImageData(img, 0, 0);

      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, SCENE_W * SCALE, SCENE_H * SCALE);
      ctx.drawImage(off, 0, 0, SCENE_W * SCALE, SCENE_H * SCALE);

      handle = requestAnimationFrame(loop);
    };
    handle = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(handle);
  }, [planet.dna, planet.vitals]);

  const seed = buildScene({ dna: planet.dna, vitals: planet.vitals });

  return (
    <div className="modalScrim" onClick={onClose}>
      <div className="modal planetView" onClick={(e) => e.stopPropagation()}>
        <div className="planetViewHeader">
          <div>
            <h3 style={{ margin: 0 }}>#{planet.id} surface</h3>
            <p className="note" style={{ marginTop: 4 }}>
              ({planet.coords.x}, {planet.coords.y}) ·{' '}
              <PopBadge pop={seed.population} /> · <CivBadge tier={seed.civTier} />
            </p>
          </div>
          <button className="secondary" onClick={onClose}>close</button>
        </div>
        <div className="planetViewCanvasWrap">
          <canvas
            ref={canvasRef}
            width={SCENE_W * SCALE}
            height={SCENE_H * SCALE}
            style={{
              imageRendering: 'pixelated',
              width: SCENE_W * SCALE,
              height: SCENE_H * SCALE,
              maxWidth: '100%',
            }}
          />
        </div>
        <p className="note">
          A day passes every {CYCLE_SECONDS}s. Buildings, population, and civ-tier
          are derived from this planet&apos;s DNA + current vitals. Care actions
          that raise warmth, biomass, and spirit progress the civilization.
        </p>
      </div>
    </div>
  );
}

function PopBadge({ pop }: { pop: Population }) {
  return <span className="popBadge">{pop}</span>;
}

function CivBadge({ tier }: { tier: CivTier }) {
  return <span className="civBadge">{tier}</span>;
}
