'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import PlanetSprite from '../components/PlanetSprite';
import Traits from '../components/Traits';
import ConnectButton from '../components/ConnectButton';
import FirstLightPanel from '../components/FirstLightPanel';
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

// A small mascot DNA for the hero glyph — Aether class + aurora aura.
const HERO_DNA = parseHex('f0059f00403fc0600000000000000000ff0000000000000000000000000000ff')!;

function PageInner() {
  const [hex, setHex] = useState(SHOWCASE_HEX[0]);
  const dna = useMemo(() => parseHex(hex), [hex]);

  return (
    <main className="page">
      <header className="hero-hud">
        <div className="hero-mark">
          <div className="hero-glyph">
            <PlanetSprite dna={HERO_DNA} scale={1} />
            <span className="hero-glyph-ring" aria-hidden />
          </div>
          <div className="hero-title">
            <h1>cosmocopia</h1>
            <p className="hero-subtitle">
              observing <span className="hero-em">testnet</span> · gen <span className="hero-em">0</span>
            </p>
          </div>
        </div>
        <div className="hero-telemetry">
          <div className="hero-stat">
            <div className="hero-stat-label">drand</div>
            <div className="hero-stat-value">live</div>
            <div className="hero-stat-hint">↑ verified</div>
          </div>
          <div className="hero-stat">
            <div className="hero-stat-label">classes</div>
            <div className="hero-stat-value">16</div>
            <div className="hero-stat-hint">d/r1/r2</div>
          </div>
          <div className="hero-stat">
            <div className="hero-stat-label">sectors</div>
            <div className="hero-stat-value">5</div>
            <div className="hero-stat-hint">core → rim</div>
          </div>
        </div>
        <div className="hero-strip">
          <div className="hero-strip-left">
            <p className="hero-subtitle" style={{ margin: 0 }}>
              Each planet is a 32-byte DNA blob with D/R1/R2 dominance — conjoin two
              and the child inherits per-trait via drand-verified randomness.
            </p>
          </div>
          <div className="hero-strip-right">
            <Link href="/galaxy" className="btn btn-secondary btn-sm">galaxy →</Link>
            <ConnectButton />
          </div>
        </div>
      </header>

      <FirstLightPanel />

      <OwnedPlanets />

      <div className="row" style={{ marginBottom: 'var(--space-8)' }}>
        <div className="panel has-titlebar" style={{ flex: '0 0 auto' }}>
          <div className="panel-titlebar">
            <span className="tb-title">tinker</span>
            <span className="tb-stripes" />
          </div>
          <div className="panel-body">
            {dna ? <PlanetSprite dna={dna} scale={4} /> : <div style={{ width: 256, height: 256, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--stardust)' }}>invalid hex</div>}
            <div style={{ marginTop: 'var(--space-3)', display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <button className="btn btn-primary btn-sm" onClick={() => setHex(dnaToHex(randomDna()))}>randomise</button>
              <button className="btn btn-secondary btn-sm" onClick={() => setHex(SHOWCASE_HEX[Math.floor(Math.random() * SHOWCASE_HEX.length)])}>showcase</button>
            </div>
            <div style={{ marginTop: 'var(--space-3)' }}>
              <input className="input" type="text" value={hex} onChange={(e) => setHex(e.target.value)} spellCheck={false} />
            </div>
          </div>
        </div>

        <div className="panel has-titlebar" style={{ flex: 1, minWidth: 240 }}>
          <div className="panel-titlebar">
            <span className="tb-title">traits</span>
            <span className="tb-stripes" />
          </div>
          <div className="panel-body">
            {dna ? <Traits dna={dna} /> : <div className="note">paste 32 bytes (64 hex chars) to see traits.</div>}
          </div>
        </div>
      </div>

      <div className="panel has-titlebar" style={{ marginBottom: 'var(--space-6)' }}>
        <div className="panel-titlebar">
          <span className="tb-title">genesis gallery</span>
          <span className="tb-stripes" />
        </div>
        <div className="panel-body">
          <p className="note" style={{ marginBottom: 'var(--space-3)' }}>
            Eight fixed-seed planets. In production these come from{' '}
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
        </div>
      </div>

      <div className="panel has-titlebar">
        <div className="panel-titlebar">
          <span className="tb-title">what&apos;s next</span>
          <span className="tb-stripes" />
        </div>
        <div className="panel-body">
          <ul className="note">
            <li>Wire passkey signing path through <code>smart-account-kit.executeAndSubmit</code> so the care/conjoin buttons work for smart accounts too.</li>
            <li>Galaxy map: a scrollable canvas at <code>(x, y)</code> coords with sector colouring.</li>
            <li>Conjunction page: pick two parents, preview speculative child art from a tentative drand round.</li>
            <li>Stat-aware art overlays (sickly haze when vitals fall outside the healthy band).</li>
          </ul>
        </div>
      </div>
    </main>
  );
}
