'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import PlanetSprite from '../../../components/PlanetSprite';
import PlanetView from '../../../components/PlanetView';
import RarityBadge from '../../../components/RarityBadge';
import Traits from '../../../components/Traits';
import ConnectButton from '../../../components/ConnectButton';
import { getPlanet, type Planet } from '../../../lib/cosmocopia';
import { WalletProvider } from '../../../lib/wallet-context';
import { POPULATIONS, CIV_TIERS, computeRarity } from '@cosmocopia/art';

export default function PlanetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <WalletProvider>
      <PlanetInner id={Number(id)} />
    </WalletProvider>
  );
}

function PlanetInner({ id }: { id: number }) {
  const [planet, setPlanet] = useState<Planet | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [viewing, setViewing] = useState(false);

  useEffect(() => {
    if (!Number.isFinite(id) || id < 0) {
      setErr(`invalid planet id`);
      setPlanet(null);
      return;
    }
    setPlanet(undefined);
    getPlanet(id)
      .then((p) => setPlanet(p))
      .catch((e: any) => { setErr(e?.message ?? String(e)); setPlanet(null); });
  }, [id]);

  if (planet === undefined) {
    return (
      <main className="page">
        <header className="hero-hud">
          <div className="hero-mark">
            <div className="hero-title">
              <h1>planet #{id}</h1>
              <p className="hero-subtitle">resolving on-chain…</p>
            </div>
          </div>
        </header>
        <p className="note">loading planet #{id} from contract…</p>
      </main>
    );
  }

  if (planet === null) {
    return (
      <main className="page">
        <header className="hero-hud">
          <div className="hero-mark">
            <div className="hero-title">
              <h1>not found</h1>
              <p className="hero-subtitle">planet #{id} doesn&apos;t exist (or the rpc dropped)</p>
            </div>
          </div>
        </header>
        {err && <p className="errBox">{err}</p>}
        <p className="note" style={{ marginTop: 'var(--space-4)' }}>
          <Link href="/galaxy" className="btn btn-secondary btn-sm">← back to the galaxy</Link>
        </p>
      </main>
    );
  }

  const rarity = computeRarity({ dna: planet.dna, coords: planet.coords });
  const population = typeof planet.population === 'number'
    ? POPULATIONS[planet.population % POPULATIONS.length]
    : null;
  const civTier = typeof planet.civTier === 'number'
    ? CIV_TIERS[Math.min(planet.civTier, CIV_TIERS.length - 1)]
    : null;
  const lineageHex = Array.from(planet.dna.slice(8, 12))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const isGenesis = lineageHex === '00000000';
  const dnaHex = Array.from(planet.dna, (b) => b.toString(16).padStart(2, '0')).join('');

  return (
    <main className="page">
      <header className="hero-hud">
        <div className="hero-mark">
          <div className="hero-glyph">
            <PlanetSprite dna={planet.dna} scale={1} coords={planet.coords} />
            <span className="hero-glyph-ring" aria-hidden />
          </div>
          <div className="hero-title">
            <h1>planet #{planet.id}</h1>
            <p className="hero-subtitle">
              at <span className="hero-em">({planet.coords.x}, {planet.coords.y})</span>
              {' · '}gen <span className="hero-em">{planet.dna[16]}</span>
              {population && (<>{' · '}<span className="hero-em">{population.toLowerCase()}</span></>)}
              {civTier && (<>{' · '}<span className="hero-em">{civTier.toLowerCase()}</span></>)}
            </p>
          </div>
        </div>
        <div className="hero-telemetry">
          <div className="hero-stat">
            <div className="hero-stat-label">tier</div>
            <div className="hero-stat-value" style={{ fontSize: 18 }}>{rarity.tier}</div>
            <div className="hero-stat-hint">score {rarity.score}</div>
          </div>
          <div className="hero-stat">
            <div className="hero-stat-label">civ</div>
            <div className="hero-stat-value">{planet.civTier ?? 0}/4</div>
            <div className="hero-stat-hint">{civTier ?? '—'}</div>
          </div>
          <div className="hero-stat">
            <div className="hero-stat-label">pop</div>
            <div className="hero-stat-value">{planet.population ?? 0}/5</div>
            <div className="hero-stat-hint">{population ?? '—'}</div>
          </div>
        </div>
        <div className="hero-strip">
          <div className="hero-strip-left">
            {planet.owner ? (
              <span className="chip chip-anon" title={planet.owner}>
                owner <span className="mono">{planet.owner.slice(0, 5)}…{planet.owner.slice(-4)}</span>
              </span>
            ) : (
              <span className="chip chip-anon">owner unknown</span>
            )}
            {isGenesis && (
              <span className="chip chip-anon" style={{ marginLeft: 'var(--space-2)' }}>genesis (G0)</span>
            )}
          </div>
          <div className="hero-strip-right">
            <button className="btn btn-primary btn-sm" onClick={() => setViewing(true)}>visit surface →</button>
            <Link href="/galaxy" className="btn btn-secondary btn-sm">galaxy →</Link>
            <ConnectButton />
          </div>
        </div>
      </header>

      <div className="row" style={{ marginBottom: 'var(--space-8)' }}>
        <div className="panel has-titlebar" style={{ flex: '0 0 auto' }}>
          <div className="panel-titlebar">
            <span className="tb-title">portrait</span>
            <span className="tb-stripes" />
          </div>
          <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-3)' }}>
            <div style={{ position: 'relative' }}>
              <PlanetSprite dna={planet.dna} scale={4} coords={planet.coords} />
              <span className="rarityRow"><RarityBadge dna={planet.dna} coords={planet.coords} size="md" /></span>
            </div>
            <div style={{ width: '100%' }}>
              <Vital label="🔥 temperature" v={planet.vitals.temperature} />
              <Vital label="💧 hydration"   v={planet.vitals.hydration} />
              <Vital label="🌑 gravity"     v={planet.vitals.gravity} />
              <Vital label="🌱 biomass"     v={planet.vitals.biomass} />
              <Vital label="✨ spirit"      v={planet.vitals.spirit} />
            </div>
          </div>
        </div>

        <div className="panel has-titlebar" style={{ flex: 1, minWidth: 280 }}>
          <div className="panel-titlebar">
            <span className="tb-title">traits</span>
            <span className="tb-stripes" />
          </div>
          <div className="panel-body">
            <Traits dna={planet.dna} coords={planet.coords} />
          </div>
        </div>
      </div>

      <div className="panel has-titlebar" style={{ marginBottom: 'var(--space-6)' }}>
        <div className="panel-titlebar">
          <span className="tb-title">lineage</span>
          <span className="tb-stripes" />
        </div>
        <div className="panel-body" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          {isGenesis ? (
            <p className="note" style={{ margin: 0 }}>
              <strong style={{ color: 'var(--primary)' }}>G0 genesis planet</strong> — no parents.
              Generation = 0, parent_mix = <code>00000000</code>. Minted directly from a
              drand-seeded commit-reveal.
            </p>
          ) : (
            <>
              <p className="note" style={{ margin: 0, marginBottom: 'var(--space-2)' }}>
                Generation <strong style={{ color: 'var(--primary)' }}>{planet.dna[16]}</strong> · parent_mix signature{' '}
                <code>{lineageHex}</code> (XOR of parents&apos; first 4 DNA bytes — every conjoin child carries this).
              </p>
              <p className="note" style={{ margin: 0 }}>
                Born at drand round <code>{
                  ((planet.dna[12] << 24) | (planet.dna[13] << 16) | (planet.dna[14] << 8) | planet.dna[15]) >>> 0
                }</code>.
              </p>
            </>
          )}
        </div>
      </div>

      <div className="panel has-titlebar" style={{ marginBottom: 'var(--space-6)' }}>
        <div className="panel-titlebar">
          <span className="tb-title">dna</span>
          <span className="tb-stripes" />
        </div>
        <div className="panel-body" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--stardust)', wordBreak: 'break-all' }}>
          {dnaHex}
        </div>
      </div>

      {viewing && <PlanetView planet={planet} onClose={() => setViewing(false)} />}
    </main>
  );
}

function Vital({ label, v }: { label: string; v: number }) {
  const pct = Math.max(0, Math.min(100, (v / 255) * 100));
  const state: 'good' | 'warn' | 'bad' =
    v < 40 || v > 220 ? 'bad' : v < 100 ? 'warn' : 'good';
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '140px 1fr 40px',
      alignItems: 'center',
      gap: 'var(--space-2)',
      fontSize: 11,
      fontFamily: 'var(--font-mono)',
      marginTop: 'var(--space-1)',
    }}>
      <span style={{ color: 'var(--stardust)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
      <div className="vital-bar">
        <div className="vital-fill" data-state={state} style={{ width: `${pct}%` }} />
      </div>
      <span className="vital-num">{v}</span>
    </div>
  );
}
