'use client';

import GalaxyMap from '../../components/GalaxyMap';
import ConnectButton from '../../components/ConnectButton';
import { WalletProvider } from '../../lib/wallet-context';

export default function GalaxyPage() {
  return (
    <WalletProvider>
      <main className="galaxy-page">
        <header className="galaxy-masthead">
          <div className="hero-mark">
            <div className="hero-title">
              <h1>galaxy</h1>
              <p className="hero-subtitle">
                every planet at its on-chain (x, y) · sectors shape stat drift &amp; conjunction cost
              </p>
            </div>
            <div style={{ marginLeft: 'auto' }}>
              <ConnectButton />
            </div>
          </div>
        </header>
        <GalaxyMap />
      </main>
    </WalletProvider>
  );
}
