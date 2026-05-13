'use client';

import { useEffect, useState } from 'react';
import PlanetSprite from './PlanetSprite';
import PlanetView from './PlanetView';
import RarityBadge from './RarityBadge';
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
    <div className="panel" style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>
          {isReadOnly ? 'preview' : 'your cosmocopia'}
        </h2>
        <button className="secondary" onClick={reload} disabled={loading}>
          {loading ? 'refreshing…' : 'refresh'}
        </button>
        {!isReadOnly && planets && planets.length >= 2 && (
          <button
            className="secondary"
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
        <div className="gallery">
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
      className={`card ${conjoinMode ? 'pickable' : ''} ${picked ? 'picked' : ''}`}
      style={{ textAlign: 'left', cursor: conjoinMode ? 'pointer' : 'default' }}
      onClick={conjoinMode ? onPick : undefined}
    >
      <div style={{ display: 'flex', justifyContent: 'center', position: 'relative' }}>
        <PlanetSprite dna={planet.dna} scale={3} coords={planet.coords} />
        <span className="rarityRow">
          <RarityBadge dna={planet.dna} coords={planet.coords} size="sm" />
        </span>
        {picked && <span className="pickBadge">picked</span>}
      </div>
      <div
        style={{
          marginTop: 8,
          fontSize: 11,
          color: 'var(--stardust)',
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
        }}
      >
        #{planet.id} · ({planet.coords.x}, {planet.coords.y})
      </div>
      <Vital label="🔥" v={v.temperature} />
      <Vital label="💧" v={v.hydration} />
      <Vital label="🌑" v={v.gravity} />
      <Vital label="🌱" v={v.biomass} />
      <Vital label="✨" v={v.spirit} />
      {!conjoinMode && (
        <>
          <div className="careRow">
            {(['Warm', 'Rain', 'Tide', 'Tend', 'Reflect'] as CareName[]).map((a) => (
              <button
                key={a}
                className="secondary careBtn"
                onClick={() => onCare(a)}
                disabled={readOnly || acting !== null}
                title={readOnly ? 'connect a wallet to take this action' : undefined}
              >
                {acting === a ? '…' : a.toLowerCase()}
              </button>
            ))}
          </div>
          <button
            className="secondary careBtn"
            style={{ marginTop: 4, width: '100%' }}
            onClick={(e) => { e.stopPropagation(); onSurface(); }}
          >
            visit surface →
          </button>
        </>
      )}
    </div>
  );
}

function Vital({ label, v }: { label: string; v: number }) {
  const pct = Math.max(0, Math.min(100, (v / 255) * 100));
  const colour = v < 40 || v > 220 ? 'var(--mars)' : v < 100 ? 'var(--solar)' : 'var(--auroral)';
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '20px 1fr 32px',
        alignItems: 'center',
        gap: 8,
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        marginTop: 4,
      }}
    >
      <span style={{ lineHeight: 1, fontSize: 12 }}>{label}</span>
      <div
        style={{
          background: 'var(--pitch)',
          height: 10,
          border: '1px solid var(--pitch)',
          outline: '1px solid var(--hairline)',
          outlineOffset: -2,
          overflow: 'hidden',
        }}
      >
        <div style={{ width: `${pct}%`, height: '100%', background: colour }} />
      </div>
      <span
        style={{
          textAlign: 'right',
          color: 'var(--stardust)',
          fontFamily: 'var(--font-mono)',
          fontWeight: 600,
        }}
      >
        {v}
      </span>
    </div>
  );
}
