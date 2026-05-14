'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import PlanetSprite from './PlanetSprite';
import PlanetView from './PlanetView';
import RarityBadge from './RarityBadge';
import SoulboundChip from './SoulboundChip';
import { listOwnedPlanets, submitCare, submitConjoin, CARE, type CareName, type Planet } from '../lib/cosmocopia';
import { useWallet } from '../lib/wallet-context';

export default function OwnedPlanets() {
  const { state } = useWallet();
  const [planets, setPlanets] = useState<Planet[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [acting, setActing] = useState<{ id: number; action: CareName } | null>(null);
  const [conjoinMode, setConjoinMode] = useState(false);
  const [picks, setPicks] = useState<number[]>([]);
  const [conjoining, setConjoining] = useState(false);
  const [viewing, setViewing] = useState<Planet | null>(null);

  function togglePick(id: number) {
    setPicks((cur) => {
      if (cur.includes(id)) return cur.filter((x) => x !== id);
      if (cur.length >= 2) return [cur[1], id]; // sliding window of 2
      return [...cur, id];
    });
  }

  // `?view=<address>` lets the demo render any address's gallery without a
  // wallet. Read client-side only to avoid SSR hydration mismatch — the
  // server never knows about location.
  const [previewAddr, setPreviewAddr] = useState<string | null>(null);
  useEffect(() => {
    setPreviewAddr(new URLSearchParams(window.location.search).get('view'));
  }, []);

  const effectiveAddress =
    state.status === 'connected' ? state.address : previewAddr;
  const isReadOnly = state.status !== 'connected';

  async function reload() {
    if (!effectiveAddress) return;
    setLoading(true);
    setErr(null);
    try {
      const list = await listOwnedPlanets(effectiveAddress);
      setPlanets(list);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!effectiveAddress) {
      setPlanets(null);
      return;
    }
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveAddress]);

  if (!effectiveAddress) return null;

  return (
    <div className="panel has-titlebar" style={{ marginBottom: 'var(--space-6)' }}>
      <div className="panel-titlebar">
        <span className="tb-title">{isReadOnly ? 'preview' : 'your cosmocopia'}</span>
        <span className="tb-stripes" />
      </div>
      <div className="panel-body">
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
          <button className="btn btn-secondary btn-sm" onClick={reload} disabled={loading}>
            {loading ? 'refreshing…' : 'refresh'}
          </button>
          {!isReadOnly && planets && planets.length >= 2 && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setConjoinMode((m) => !m);
                setPicks([]);
              }}
            >
              {conjoinMode ? 'cancel conjoin' : 'conjoin two planets'}
            </button>
          )}
          {conjoinMode && picks.length === 2 && (
            <button
              className="btn btn-primary btn-sm"
              disabled={conjoining}
              onClick={async () => {
                setConjoining(true);
                setErr(null);
                try {
                  await submitConjoin(picks[0], picks[1], state);
                  setPicks([]);
                  setConjoinMode(false);
                  await reload();
                } catch (e: any) {
                  setErr(e?.message ?? String(e));
                } finally {
                  setConjoining(false);
                }
              }}
            >
              {conjoining ? 'conjoining…' : `conjoin #${picks[0]} + #${picks[1]} →`}
            </button>
          )}
        </div>
        <p className="note">
          Live read from contract <code>{process.env.NEXT_PUBLIC_PLANET_CONTRACT?.slice(0, 6)}…</code> on testnet.
          {' '}Address: <code title={effectiveAddress!}>{effectiveAddress!.slice(0, 6)}…{effectiveAddress!.slice(-4)}</code>
          {isReadOnly && ' · read-only preview (connect a wallet to take care actions)'}
        </p>
        {err && <p className="errBox">{err}</p>}
        {planets === null && !err && <p className="note">loading…</p>}
        {planets && planets.length === 0 && (
          <p className="note">
            No planets at this address yet. The deployer holds the genesis batch — use{' '}
            <code>scripts/deploy-testnet.sh</code> or invoke <code>mint_genesis</code> via the CLI.
          </p>
        )}
        {conjoinMode && (
          <p className="note">
            Pick two parents. Child is born at the midpoint of their coords, with
            DNA crossed-over from theirs + drand-driven mutation.
          </p>
        )}
        {planets && planets.length > 0 && (
          <div className="gallery">{/* card grid below */}
          {planets.map((p) => (
            <PlanetCard
              key={p.id}
              planet={p}
              readOnly={isReadOnly}
              conjoinMode={conjoinMode}
              picked={picks.includes(p.id)}
              onPick={() => togglePick(p.id)}
              onSurface={() => setViewing(p)}
              onCare={async (action) => {
                if (isReadOnly) {
                  setErr('Connect a wallet to take care actions.');
                  return;
                }
                setActing({ id: p.id, action });
                setErr(null);
                try {
                  await submitCare(p.id, CARE[action], state);
                  await reload();
                } catch (e: any) {
                  setErr(e?.message ?? String(e));
                } finally {
                  setActing(null);
                }
              }}
              acting={acting?.id === p.id ? acting.action : null}
            />
          ))}
          </div>
        )}
      </div>
      {viewing && <PlanetView planet={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function PlanetCard({
  planet,
  onCare,
  acting,
  readOnly,
  conjoinMode,
  picked,
  onPick,
  onSurface,
}: {
  planet: Planet;
  onCare: (action: CareName) => void;
  acting: CareName | null;
  readOnly: boolean;
  conjoinMode: boolean;
  picked: boolean;
  onPick: () => void;
  onSurface: () => void;
}) {
  const v = planet.vitals;
  return (
    <div
      className={`card has-titlebar ${conjoinMode ? 'pickable' : ''} ${picked ? 'picked' : ''}`}
      style={{ textAlign: 'left', cursor: conjoinMode ? 'pointer' : 'default' }}
      onClick={conjoinMode ? onPick : undefined}
    >
      <div className="card-titlebar">
        <Link
          href={`/planet/${planet.id}`}
          onClick={(e) => e.stopPropagation()}
          style={{ flexShrink: 0, color: 'inherit', textDecoration: 'none' }}
          title="open full planet detail"
        >
          #{planet.id}
        </Link>
        <span className="tb-stripes" />
        <span style={{ flexShrink: 0, color: 'var(--stardust)' }}>({planet.coords.x}, {planet.coords.y})</span>
      </div>
      <div style={{ padding: 'var(--space-3)' }}>
        <div style={{ display: 'flex', justifyContent: 'center', position: 'relative' }}>
          <PlanetSprite dna={planet.dna} scale={3} coords={planet.coords} />
          <span className="rarityRow" style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <RarityBadge dna={planet.dna} coords={planet.coords} size="sm" />
            {planet.soulbound && (
              <SoulboundChip
                healthySince={planet.healthySince ?? 0}
                // No `currentLedger` here — without polling the latest
                // ledger every card render the hover detail falls back to
                // the timer-paused / static copy, which is accurate for
                // a snapshot view. PlanetView pulls the live value.
              />
            )}
          </span>
          {picked && <span className="pickBadge">picked</span>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', marginTop: 'var(--space-2)' }}>
          <Vital label="🔥" v={v.temperature} />
          <Vital label="💧" v={v.hydration} />
          <Vital label="🌑" v={v.gravity} />
          <Vital label="🌱" v={v.biomass} />
          <Vital label="✨" v={v.spirit} />
        </div>
        {!conjoinMode && (
          <>
            <div className="careRow">
              {(['Warm', 'Rain', 'Tide', 'Tend', 'Reflect'] as CareName[]).map((a) => (
                <button
                  key={a}
                  className="btn btn-secondary btn-sm"
                  onClick={(e) => { e.stopPropagation(); onCare(a); }}
                  disabled={readOnly || acting !== null}
                  title={readOnly ? 'connect a wallet to take this action' : undefined}
                >
                  {acting === a ? '…' : a.toLowerCase()}
                </button>
              ))}
            </div>
            <button
              className="btn btn-secondary btn-sm"
              style={{ marginTop: 'var(--space-1)', width: '100%' }}
              onClick={(e) => { e.stopPropagation(); onSurface(); }}
            >
              visit surface →
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Vital({ label, v }: { label: string; v: number }) {
  const pct = Math.max(0, Math.min(100, (v / 255) * 100));
  const state: 'good' | 'warn' | 'bad' =
    v < 40 || v > 220 ? 'bad' : v < 100 ? 'warn' : 'good';
  return (
    <div className="vital">
      <span className="vital-glyph">{label}</span>
      <div className="vital-bar">
        <div className="vital-fill" data-state={state} style={{ width: `${pct}%` }} />
      </div>
      <span className="vital-num">{v}</span>
    </div>
  );
}
