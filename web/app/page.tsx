'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import PlanetSprite from '../components/PlanetSprite';
import Traits from '../components/Traits';
import ConnectButton from '../components/ConnectButton';
import OwnedPlanets from '../components/OwnedPlanets';
import { WalletProvider } from '../lib/wallet-context';
import { dnaToHex } from '@cosmocopia/art';

function randomDna(): Uint8Array {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return a;
}

function parseHex(input: string): Uint8Array | null {
  const clean = input.replace(/^0x/, '').trim();
  if (!/^[0-9a-f]{64}$/i.test(clean)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// A handful of seeds chosen to span the class space.
const SHOWCASE_HEX = [
  '03291a61abc0a22b833ff80e3e969fb00560add1addc06da12d2b342f651f701',
  '4400aa01ff77b34520a05a8a7f0f0e0d010203040506070809000a0b0c0d0e1f',
  '88ff00ee44661102334455667788990a0b0c0d0e0f10111213140000ffff5555',
  '22bb77c0091afe6f5b443322112233445566778899aabbccddee123456789abc',
  'ab11223344556677aabbccddeeff0011223344556677aabbccddeeff00112233',
  'f0e0d0c0b0a0908070605040302010ff112233445566778899aabbccddeeff00',
  '5577aaeeccbb88dd1133557799bbddff020406080a0c0e10121416181a1c1e20',
  '9911bb44ddee5577aa3322110011223344556677889900112233445566778899',
];

export default function Page() {
  return (
    <WalletProvider>
      <PageInner />
    </WalletProvider>
  );
}

function PageInner() {
  const [hex, setHex] = useState(SHOWCASE_HEX[0]);
  const dna = useMemo(() => parseHex(hex), [hex]);

  return (
    <main className="page">
      <div className="hero">
        <h1>cosmocopia</h1>
        <span className="tag">tiny pixel worlds, on stellar testnet</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <Link href="/galaxy"><button className="secondary">galaxy →</button></Link>
          <ConnectButton />
        </span>
      </div>
      <p className="sub">
        Each planet is a 32-byte DNA string rendered programmatically.
        Conjoin two and the child inherits a per-byte crossover of their genes,
        with mutations driven by drand-verified randomness.
      </p>

      <OwnedPlanets />

      <div className="row" style={{ marginBottom: 32 }}>
        <div className="panel" style={{ flex: '0 0 auto' }}>
          <h2>tinker</h2>
          {dna ? <PlanetSprite dna={dna} scale={4} /> : <div style={{ width: 256, height: 256, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dim)' }}>invalid hex</div>}
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button onClick={() => setHex(dnaToHex(randomDna()))}>randomise</button>
            <button className="secondary" onClick={() => setHex(SHOWCASE_HEX[Math.floor(Math.random() * SHOWCASE_HEX.length)])}>showcase</button>
          </div>
          <div style={{ marginTop: 12 }}>
            <input type="text" value={hex} onChange={(e) => setHex(e.target.value)} spellCheck={false} />
          </div>
        </div>

        <div className="panel" style={{ flex: 1, minWidth: 240 }}>
          <h2>traits</h2>
          {dna ? <Traits dna={dna} /> : <div className="note">paste 32 bytes (64 hex chars) to see traits.</div>}
        </div>
      </div>

      <h2 style={{ marginBottom: 12 }}>genesis gallery</h2>
      <p className="note">
        Eight fixed-seed planets. In production these would come from{' '}
        <code>mint_genesis</code> calls fed by{' '}
        <a href="https://github.com/kaankacar/Drand-Relay" target="_blank">Drand-Relay</a>{' '}
        verified randomness.
      </p>
      <div className="gallery">
        {SHOWCASE_HEX.map((h) => {
          const d = parseHex(h)!;
          return (
            <div key={h} className="card">
              <PlanetSprite dna={d} scale={3} />
              <div className="name">{h.slice(0, 12)}…</div>
            </div>
          );
        })}
      </div>

      <h2 style={{ marginTop: 40 }}>what&apos;s next</h2>
      <ul className="note">
        <li>Wire passkey signing path through <code>smart-account-kit.executeAndSubmit</code> so the care/conjoin buttons work for smart accounts too.</li>
        <li>Galaxy map: a scrollable canvas at <code>(x, y)</code> coords with sector colouring.</li>
        <li>Conjunction page: pick two parents, preview speculative child art from a tentative drand round.</li>
        <li>Stat-aware art overlays (sickly haze when vitals fall outside the healthy band).</li>
      </ul>
    </main>
  );
}
