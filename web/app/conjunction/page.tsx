'use client';

import { useEffect, useState } from 'react';
import PlanetSprite from '../../components/PlanetSprite';
import RarityBadge from '../../components/RarityBadge';
import ConnectButton from '../../components/ConnectButton';
import {
  listOwnedPlanets,
  submitConjoin,
  type ConjoinProgress,
  type Planet,
} from '../../lib/cosmocopia';
import { WalletProvider, useWallet } from '../../lib/wallet-context';

export default function ConjunctionPage() {
  return (
    <WalletProvider>
      <ConjunctionInner />
    </WalletProvider>
  );
}

function ConjunctionInner() {
  const { state } = useWallet();
  const [planets, setPlanets] = useState<Planet[] | null>(null);
  const [previewAddr, setPreviewAddr] = useState<string | null>(null);
  const [parentA, setParentA] = useState<Planet | null>(null);
  const [parentB, setParentB] = useState<Planet | null>(null);
  const [progress, setProgress] = useState<ConjoinProgress | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [conjoining, setConjoining] = useState(false);

  useEffect(() => {
    setPreviewAddr(new URLSearchParams(window.location.search).get('view'));
  }, []);

  const effectiveAddress =
    state.status === 'connected' ? state.address : previewAddr;
  const isReadOnly = state.status !== 'connected';

  useEffect(() => {
    if (!effectiveAddress) { setPlanets(null); return; }
    listOwnedPlanets(effectiveAddress).then(setPlanets).catch((e) =>
      setErr(e?.message ?? String(e)));
  }, [effectiveAddress]);

  async function doConjoin() {
    if (!parentA || !parentB || state.status !== 'connected') return;
    setConjoining(true);
    setErr(null);
    setProgress({ phase: 'committing' });
    try {
      await submitConjoin(parentA.id, parentB.id, state, setProgress);
      // Refresh owned planets to surface the new child.
      const fresh = await listOwnedPlanets(effectiveAddress!);
      setPlanets(fresh);
      setParentA(null);
      setParentB(null);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setConjoining(false);
    }
  }

  const ready = parentA && parentB && parentA.id !== parentB.id && !isReadOnly;

  return (
    <main className="page">
      <header className="hero-hud">
        <div className="hero-mark">
          <div className="hero-title">
            <h1>conjunction</h1>
            <p className="hero-subtitle">
              two parents · one child · per-trait <span className="hero-em">D / R1 / R2</span> roll
            </p>
          </div>
        </div>
        <div className="hero-strip">
          <div className="hero-strip-left">
            <p className="hero-subtitle" style={{ margin: 0 }}>
              Pick two of your planets. Their alleles meet via the contract&apos;s
              dominance roll, mutation gate, and a drand-verified random seed.
            </p>
          </div>
          <div className="hero-strip-right">
            <ConnectButton />
          </div>
        </div>
      </header>

      <div className="conjoin-grid">
        <ParentSlot
          slot="a"
          planet={parentA}
          onPick={(p) => setParentA(p)}
          onClear={() => setParentA(null)}
        />
        <div className="conjoin-op">+</div>
        <ParentSlot
          slot="b"
          planet={parentB}
          onPick={(p) => setParentB(p)}
          onClear={() => setParentB(null)}
        />
        <div className="conjoin-op">=</div>
        <div className="conjoin-slot conjoin-child">
          <div className="card-titlebar">
            <span style={{ flexShrink: 0 }}>child</span>
            <span className="tb-stripes" />
            <span style={{ flexShrink: 0, color: 'var(--stardust)' }}>preview</span>
          </div>
          <div className="slot-body">
            <p className="hero-subtitle" style={{ textAlign: 'center', margin: 0 }}>
              {parentA && parentB
                ? `midpoint (${Math.floor((parentA.coords.x + parentB.coords.x) / 2)}, ${Math.floor((parentA.coords.y + parentB.coords.y) / 2)})`
                : 'pick two parents'}
            </p>
            <p className="note" style={{ marginTop: 'var(--space-3)', textAlign: 'center' }}>
              {parentA && parentB
                ? 'child art is sealed until reveal — the random seed is fetched from drand at commit + 10 rounds.'
                : 'an unknown world awaits'}
            </p>
          </div>
        </div>
      </div>

      <div className="panel has-titlebar" style={{ marginBottom: 'var(--space-6)' }}>
        <div className="panel-titlebar">
          <span className="tb-title">commit-reveal</span>
          <span className="tb-stripes" />
        </div>
        <div className="panel-body">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
            <button
              className="btn btn-primary"
              disabled={!ready || conjoining}
              onClick={doConjoin}
            >
              {conjoining ? phaseLabel(progress) : 'conjoin'}
            </button>
            {ready && !conjoining && (
              <span className="note" style={{ margin: 0 }}>
                will take ~40 s · commit → wait 8 ledgers → reveal
              </span>
            )}
            {isReadOnly && (
              <span className="note" style={{ margin: 0 }}>connect a wallet to conjoin.</span>
            )}
          </div>
          {progress && (
            <div className="note">
              phase: <code>{progress.phase}</code>
              {progress.phase === 'waiting' && (
                <> · ledger {progress.currentLedger} / {progress.revealAfterLedger}</>
              )}
              {progress.phase === 'done' && (
                <> · tx <code>{progress.childTxHash.slice(0, 12)}…</code></>
              )}
            </div>
          )}
          {err && <p className="errBox">{err}</p>}
        </div>
      </div>

      <div className="panel has-titlebar">
        <div className="panel-titlebar">
          <span className="tb-title">{isReadOnly ? 'preview' : 'your candidates'}</span>
          <span className="tb-stripes" />
        </div>
        <div className="panel-body">
          {planets === null && !err && <p className="note">loading…</p>}
          {planets && planets.length === 0 && (
            <p className="note">no planets at this address — mint one or get one transferred to you.</p>
          )}
          {planets && planets.length > 0 && (
            <p className="note" style={{ marginBottom: 'var(--space-3)' }}>
              click a planet to slot it into <code>a</code>; click another for <code>b</code>.
              clicking an already-slotted planet clears it.
            </p>
          )}
          <div className="gallery">
            {(planets ?? []).map((p) => {
              const slotted =
                parentA?.id === p.id ? 'a' :
                parentB?.id === p.id ? 'b' :
                null;
              return (
                <div
                  key={p.id}
                  className={`card has-titlebar pickable ${slotted ? 'picked' : ''}`}
                  onClick={() => {
                    if (slotted === 'a') setParentA(null);
                    else if (slotted === 'b') setParentB(null);
                    else if (!parentA) setParentA(p);
                    else if (!parentB) setParentB(p);
                    else setParentA(p); // sliding window
                  }}
                >
                  <div className="card-titlebar">
                    <span style={{ flexShrink: 0 }}>#{p.id}</span>
                    <span className="tb-stripes" />
                    <span style={{ flexShrink: 0, color: 'var(--stardust)' }}>
                      {slotted ? slotted.toUpperCase() : `(${p.coords.x}, ${p.coords.y})`}
                    </span>
                  </div>
                  <div style={{ padding: 'var(--space-3)', textAlign: 'center', position: 'relative' }}>
                    <PlanetSprite dna={p.dna} scale={2} coords={p.coords} />
                    <span className="rarityRow"><RarityBadge dna={p.dna} coords={p.coords} size="sm" /></span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </main>
  );
}

function ParentSlot({
  slot, planet, onClear,
}: {
  slot: 'a' | 'b';
  planet: Planet | null;
  onPick: (p: Planet) => void;
  onClear: () => void;
}) {
  if (!planet) {
    return (
      <div className="conjoin-slot empty">
        <p className="hero-subtitle" style={{ textAlign: 'center', margin: 0 }}>
          parent <span className="hero-em">{slot.toUpperCase()}</span>
        </p>
        <p className="note" style={{ textAlign: 'center', marginTop: 'var(--space-2)' }}>
          pick from the gallery below
        </p>
      </div>
    );
  }
  return (
    <div className="conjoin-slot" onClick={onClear} style={{ cursor: 'pointer' }}>
      <div className="card-titlebar">
        <span style={{ flexShrink: 0 }}>parent {slot}</span>
        <span className="tb-stripes" />
        <span style={{ flexShrink: 0, color: 'var(--stardust)' }}>#{planet.id}</span>
      </div>
      <div className="slot-body">
        <PlanetSprite dna={planet.dna} scale={3} coords={planet.coords} />
        <p className="hero-subtitle" style={{ marginTop: 'var(--space-2)' }}>
          ({planet.coords.x}, {planet.coords.y})
        </p>
        <RarityBadge dna={planet.dna} coords={planet.coords} size="md" />
      </div>
    </div>
  );
}

function phaseLabel(p: ConjoinProgress | null) {
  if (!p) return 'conjoining…';
  switch (p.phase) {
    case 'committing': return 'committing…';
    case 'waiting': return `waiting (${p.revealAfterLedger - p.currentLedger} ledgers)…`;
    case 'revealing': return 'revealing…';
    case 'done': return 'done!';
  }
}
