'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { listAllPlanets, type Planet } from '../lib/cosmocopia';
import { renderPlanet } from '@cosmocopia/art';

// Match the contract's sector_of() thresholds exactly. r² thresholds avoid
// sqrt — same as `contracts/planet/src/galaxy.rs`.
const SECTORS = [
  { name: 'Inner Core',     r: 5,   color: '#ffb648', desc: 'Tight orbits, slow decay, big gravity' },
  { name: 'Habitable Belt', r: 15,  color: '#4dffae', desc: 'Neutral drift, social bonuses' },
  { name: 'Asteroid Field', r: 30,  color: '#8b7a5e', desc: 'Biomass↓, rare-trait mint bonus' },
  { name: 'Frontier',       r: 50,  color: '#b06aff', desc: 'Spirit↑ from isolation' },
  { name: 'Outer Dark',     r: 80,  color: '#3e4878', desc: 'Temp↓, exotic traits, harsh decay' },
] as const;

function sectorOf(x: number, y: number) {
  const r2 = x * x + y * y;
  if (r2 < 25) return 0;
  if (r2 < 225) return 1;
  if (r2 < 900) return 2;
  if (r2 < 2500) return 3;
  return 4;
}

export default function GalaxyMap() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [planets, setPlanets] = useState<Planet[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState<Planet | null>(null);
  const [selected, setSelected] = useState<Planet | null>(null);

  // viewport: world coords for the center of the canvas + zoom (pixels per world unit)
  const [view, setView] = useState({ cx: 0, cy: 0, zoom: 6 });
  const dragRef = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);

  // Cache rendered planet sprites so we redraw cheaply.
  const spriteCache = useRef<Map<number, HTMLCanvasElement>>(new Map());

  // Wait for the web-loaded display font (JetBrains Mono) to be ready before
  // first paint, otherwise the canvas falls back to a system mono and the
  // labels render in the wrong typography. Re-runs the render effect once
  // fonts are ready.
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    if (typeof document === 'undefined' || !document.fonts?.ready) {
      setFontsReady(true);
      return;
    }
    document.fonts.ready.then(() => setFontsReady(true));
  }, []);

  // Load planets on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listAllPlanets();
        if (cancelled) return;
        setPlanets(list);
        // Auto-fit zoom to the data
        if (list.length > 0) {
          const maxR = Math.max(20, ...list.map((p) => Math.max(Math.abs(p.coords.x), Math.abs(p.coords.y))));
          setView((v) => ({ ...v, zoom: Math.max(3, Math.floor(280 / maxR)) }));
        }
      } catch (e: any) {
        setErr(e?.message ?? String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Build sprite cache when planets arrive.
  useEffect(() => {
    if (!planets) return;
    for (const p of planets) {
      if (spriteCache.current.has(p.id)) continue;
      const out = renderPlanet(p.dna);
      const off = document.createElement('canvas');
      off.width = out.width;
      off.height = out.height;
      const offCtx = off.getContext('2d')!;
      const img = offCtx.createImageData(out.width, out.height);
      img.data.set(out.data);
      offCtx.putImageData(img, 0, 0);
      spriteCache.current.set(p.id, off);
    }
  }, [planets]);

  // Render the map.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cssW = c.clientWidth;
    const cssH = c.clientHeight;
    if (c.width !== cssW * dpr || c.height !== cssH * dpr) {
      c.width = cssW * dpr;
      c.height = cssH * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // World → screen helpers.
    const ox = cssW / 2 - view.cx * view.zoom;
    const oy = cssH / 2 - view.cy * view.zoom;
    const w2sX = (x: number) => x * view.zoom + ox;
    const w2sY = (y: number) => y * view.zoom + oy;

    // Resolve design-system colors from the page so we don't drift when
    // tokens change. Canvas can't read CSS vars directly.
    const rootStyle = getComputedStyle(document.documentElement);
    const VOID = (rootStyle.getPropertyValue('--void').trim() || '#0a0b0e');
    const VOID_DEEP = (rootStyle.getPropertyValue('--void-deep').trim() || '#050507');
    const CONJOIN = (rootStyle.getPropertyValue('--conjoin').trim() || '#ff85c4');

    // Background.
    ctx.fillStyle = VOID;
    ctx.fillRect(0, 0, cssW, cssH);

    // Starfield.
    const rng = mulberry32(42);
    for (let i = 0; i < 300; i++) {
      const x = rng() * cssW;
      const y = rng() * cssH;
      const a = rng();
      ctx.fillStyle = `rgba(255,255,255,${0.06 + a * 0.12})`;
      ctx.fillRect(x, y, 1, 1);
    }

    // Sector rings — outermost first so inner fills overlap.
    for (let i = SECTORS.length - 1; i >= 0; i--) {
      const s = SECTORS[i];
      const r = s.r * view.zoom;
      // Soft fill.
      ctx.beginPath();
      ctx.arc(w2sX(0), w2sY(0), r, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(s.color, 0.05);
      ctx.fill();
      // Boundary.
      ctx.beginPath();
      ctx.arc(w2sX(0), w2sY(0), r, 0, Math.PI * 2);
      ctx.strokeStyle = hexToRgba(s.color, 0.35);
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      // Stagger labels around the ring so adjacent boundaries don't collide.
      const angle = -Math.PI / 2 + (i * (Math.PI * 2)) / SECTORS.length;
      const lx = w2sX(0) + Math.cos(angle) * r;
      const ly = w2sY(0) + Math.sin(angle) * r;
      const text = s.name.toLowerCase();
      ctx.font = "11px 'JetBrains Mono', ui-monospace, monospace";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const m = ctx.measureText(text);
      // Dark backdrop for legibility against starfield — derived from --void
      // so the panel matches the page's true background.
      ctx.fillStyle = hexToRgba(VOID_DEEP, 0.88);
      ctx.fillRect(lx - m.width / 2 - 4, ly - 8, m.width + 8, 16);
      ctx.fillStyle = hexToRgba(s.color, 0.9);
      ctx.fillText(text, lx, ly);
    }
    ctx.textBaseline = 'alphabetic';

    // Origin marker.
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.beginPath();
    ctx.arc(w2sX(0), w2sY(0), 2, 0, Math.PI * 2);
    ctx.fill();

    // Planets.
    if (planets) {
      ctx.imageSmoothingEnabled = false;
      for (const p of planets) {
        const sprite = spriteCache.current.get(p.id);
        if (!sprite) continue;
        const px = w2sX(p.coords.x);
        const py = w2sY(p.coords.y);
        const size = Math.max(20, Math.min(48, view.zoom * 2));
        const isSel = selected?.id === p.id || hover?.id === p.id;
        if (isSel) {
          ctx.beginPath();
          ctx.arc(px, py, size * 0.65, 0, Math.PI * 2);
          ctx.strokeStyle = CONJOIN;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        ctx.drawImage(sprite, px - size / 2, py - size / 2, size, size);
        // Id label.
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = "10px 'JetBrains Mono', ui-monospace, monospace";
        ctx.textAlign = 'center';
        ctx.fillText(`#${p.id}`, px, py + size / 2 + 12);
      }
    }
  }, [planets, view, hover, selected, fontsReady]);

  // Mouse handlers — pan, zoom, hover/click.
  function s2w(canvasX: number, canvasY: number) {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    const ox = rect.width / 2 - view.cx * view.zoom;
    const oy = rect.height / 2 - view.cy * view.zoom;
    return {
      x: (canvasX - ox) / view.zoom,
      y: (canvasY - oy) / view.zoom,
    };
  }

  function planetAt(canvasX: number, canvasY: number) {
    if (!planets) return null;
    const { x: wx, y: wy } = s2w(canvasX, canvasY);
    const hitRadius = Math.max(2, 24 / view.zoom);
    let best: { p: Planet; d2: number } | null = null;
    for (const p of planets) {
      const dx = wx - p.coords.x;
      const dy = wy - p.coords.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > hitRadius * hitRadius) continue;
      if (!best || d2 < best.d2) best = { p, d2 };
    }
    return best?.p ?? null;
  }

  return (
    <div className="galaxy-stage">
      {err && (
        <div className="floating-panel galaxy-detail">
          <div className="panel has-titlebar">
            <div className="panel-titlebar"><span className="tb-title">error</span><span className="tb-stripes" /></div>
            <div className="panel-body"><p className="errBox" style={{ margin: 0 }}>{err}</p></div>
          </div>
        </div>
      )}
      {!planets && !err && (
        <div className="galaxy-hint" style={{ top: 8, bottom: 'auto' }}>scanning chain…</div>
      )}
      <canvas
        ref={canvasRef}
        className="galaxy-canvas"
        onMouseDown={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          dragRef.current = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
            cx: view.cx,
            cy: view.cy,
          };
        }}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const cx = e.clientX - rect.left;
          const cy = e.clientY - rect.top;
          if (dragRef.current) {
            const dx = cx - dragRef.current.x;
            const dy = cy - dragRef.current.y;
            setView((v) => ({ ...v, cx: dragRef.current!.cx - dx / v.zoom, cy: dragRef.current!.cy - dy / v.zoom }));
          } else {
            setHover(planetAt(cx, cy));
          }
        }}
        onMouseUp={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const cx = e.clientX - rect.left;
          const cy = e.clientY - rect.top;
          const wasDrag = dragRef.current && (Math.abs(cx - dragRef.current.x) > 3 || Math.abs(cy - dragRef.current.y) > 3);
          dragRef.current = null;
          if (!wasDrag) {
            const p = planetAt(cx, cy);
            setSelected(p);
          }
        }}
        onMouseLeave={() => { dragRef.current = null; setHover(null); }}
        onWheel={(e) => {
          e.preventDefault();
          const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
          setView((v) => ({ ...v, zoom: Math.max(1, Math.min(40, v.zoom * factor)) }));
        }}
      />
      <div className="galaxy-hint">
        {planets ? `${planets.length} planet${planets.length === 1 ? '' : 's'}` : '—'} ·
        {' drag · scroll · click'}
      </div>

      <div className="floating-panel galaxy-legend">
        <div className="panel has-titlebar">
          <div className="panel-titlebar">
            <span className="tb-title">sectors</span>
            <span className="tb-stripes" />
          </div>
          <div className="panel-body">
            <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
              {SECTORS.map((s) => (
                <li key={s.name} style={{ marginBottom: 'var(--space-3)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
                  <span
                    style={{
                      display: 'inline-block',
                      width: 12,
                      height: 12,
                      background: s.color,
                      border: '1px solid var(--pitch)',
                      marginRight: 8,
                      verticalAlign: 'middle',
                    }}
                  />
                <strong style={{ fontWeight: 700, letterSpacing: '0.04em' }}>{s.name}</strong>
                <br />
                <span
                  style={{
                    color: 'var(--lumen)',
                    marginLeft: 'var(--space-5)',
                    fontSize: 11,
                    fontFamily: 'var(--font-sans)',
                  }}
                >
                  r &lt; {s.r} · {s.desc}
                </span>
              </li>
            ))}
            </ul>
          </div>
        </div>
      </div>

      {selected && (
        <div className="floating-panel galaxy-detail">
          <div className="panel has-titlebar">
            <div className="panel-titlebar">
              <span className="tb-title">planet #{selected.id}</span>
              <span className="tb-stripes" />
            </div>
            <div className="panel-body">
              <PlanetDetail planet={selected} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PlanetDetail({ planet }: { planet: Planet }) {
  const v = planet.vitals;
  const sectorIdx = sectorOf(planet.coords.x, planet.coords.y);
  const sector = SECTORS[sectorIdx];
  return (
    <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>
      <p
        style={{
          margin: '0 0 12px',
          color: 'var(--stardust)',
          fontSize: 11,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
        }}
      >
        at ({planet.coords.x}, {planet.coords.y}) · {sector.name.toLowerCase()}
      </p>
      <p style={{ margin: '0 0 4px' }}>🔥 temperature {v.temperature}</p>
      <p style={{ margin: '0 0 4px' }}>💧 hydration {v.hydration}</p>
      <p style={{ margin: '0 0 4px' }}>🌑 gravity {v.gravity}</p>
      <p style={{ margin: '0 0 4px' }}>🌱 biomass {v.biomass}</p>
      <p style={{ margin: '0 0 8px' }}>✨ spirit {v.spirit}</p>
      <p style={{ margin: '0 0 8px', color: 'var(--stardust)', wordBreak: 'break-all', fontSize: 11 }}>
        owner: {planet.owner ? `${planet.owner.slice(0, 5)}…${planet.owner.slice(-4)}` : '?'}
      </p>
      <Link
        href={`/planet/${planet.id}`}
        className="btn btn-primary btn-sm"
        style={{ display: 'inline-block', marginBottom: 'var(--space-2)' }}
      >
        open detail →
      </Link>
      <p
        style={{
          margin: 0,
          color: 'var(--lumen)',
          wordBreak: 'break-all',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          lineHeight: 1.4,
        }}
      >
        dna: {Array.from(planet.dna, (b) => b.toString(16).padStart(2, '0')).join('')}
      </p>
    </div>
  );
}

function mulberry32(seed: number) {
  let s = seed;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgba(hex: string, alpha: number) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
