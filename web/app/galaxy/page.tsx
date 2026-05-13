'use client';

import Link from 'next/link';
import GalaxyMap from '../../components/GalaxyMap';
import { WalletProvider } from '../../lib/wallet-context';

export default function GalaxyPage() {
  return (
    <WalletProvider>
      <main className="page">
        <div className="hero">
          <h1>galaxy</h1>
          <span className="tag">
            every planet at its on-chain (x, y) · sectors shape stat drift &amp; conjunction cost
          </span>
          <span style={{ marginLeft: 'auto' }}>
            <Link href="/"><button className="secondary">← home</button></Link>
          </span>
        </div>
        <GalaxyMap />
      </main>
    </WalletProvider>
  );
}
