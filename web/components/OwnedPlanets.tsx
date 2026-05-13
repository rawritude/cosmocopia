'use client';

import { useEffect, useState } from 'react';
import PlanetSprite from './PlanetSprite';
import { listOwnedPlanets, submitCare, CARE, type CareName, type Planet } from '../lib/cosmocopia';
import { useWallet } from '../lib/wallet-context';

export default function OwnedPlanets() {
  const { state } = useWallet();
  const [planets, setPlanets] = useState<Planet[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [acting, setActing] = useState<{ id: number; action: CareName } | null>(null);

  async function reload() {
    if (state.status !== 'connected') return;
    setLoading(true);
    setErr(null);
    try {
      const list = await listOwnedPlanets(state.address);
      setPlanets(list);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (state.status !== 'connected') {
      setPlanets(null);
      return;
    }
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status === 'connected' ? state.address : null]);

  if (state.status !== 'connected') return null;

  return (
    <div className="panel" style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ margin: 0 }}>your cosmocopia</h2>
        <button className="secondary" onClick={reload} disabled={loading}>
          {loading ? 'refreshing…' : 'refresh'}
        </button>
      </div>
      <p className="note">
        Live read from contract <code>{process.env.NEXT_PUBLIC_PLANET_CONTRACT?.slice(0, 6)}…</code> on testnet.
      </p>
      {err && <p className="errBox">{err}</p>}
      {planets === null && !err && <p className="note">loading…</p>}
      {planets && planets.length === 0 && (
        <p className="note">
          No planets at this address yet. The deployer holds the genesis batch — use{' '}
          <code>scripts/deploy-testnet.sh</code> or invoke <code>mint_genesis</code> via the CLI.
        </p>
      )}
      {planets && planets.length > 0 && (
        <div className="gallery">
          {planets.map((p) => (
            <PlanetCard
              key={p.id}
              planet={p}
              onCare={async (action) => {
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
  );
}

function PlanetCard({
  planet,
  onCare,
  acting,
}: {
  planet: Planet;
  onCare: (action: CareName) => void;
  acting: CareName | null;
}) {
  const v = planet.vitals;
  return (
    <div className="card" style={{ textAlign: 'left' }}>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <PlanetSprite dna={planet.dna} scale={3} />
      </div>
      <div style={{ marginTop: 8, fontSize: 12, color: 'var(--dim)' }}>
        #{planet.id} · ({planet.coords.x}, {planet.coords.y})
      </div>
      <Vital label="🔥" v={v.temperature} />
      <Vital label="💧" v={v.hydration} />
      <Vital label="🌑" v={v.gravity} />
      <Vital label="🌱" v={v.biomass} />
      <Vital label="✨" v={v.spirit} />
      <div className="careRow">
        {(['Warm', 'Rain', 'Tide', 'Tend', 'Reflect'] as CareName[]).map((a) => (
          <button
            key={a}
            className="secondary careBtn"
            onClick={() => onCare(a)}
            disabled={acting !== null}
          >
            {acting === a ? '…' : a.toLowerCase()}
          </button>
        ))}
      </div>
    </div>
  );
}

function Vital({ label, v }: { label: string; v: number }) {
  const pct = Math.max(0, Math.min(100, (v / 255) * 100));
  const colour = v < 40 || v > 220 ? '#ff7a7a' : v < 100 ? '#ffd47a' : '#9aff9a';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '20px 1fr 30px', alignItems: 'center', fontSize: 11, marginTop: 4 }}>
      <span>{label}</span>
      <div style={{ background: 'rgba(255,255,255,0.06)', height: 6, borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: colour }} />
      </div>
      <span style={{ textAlign: 'right', color: 'var(--dim)' }}>{v}</span>
    </div>
  );
}
