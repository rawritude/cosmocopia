'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS: Array<{ href: string; label: string; match: (path: string) => boolean }> = [
  { href: '/', label: 'home', match: (p) => p === '/' },
  { href: '/galaxy', label: 'galaxy', match: (p) => p.startsWith('/galaxy') },
  { href: '/conjunction', label: 'conjunction', match: (p) => p.startsWith('/conjunction') },
];

export default function TopNav() {
  const pathname = usePathname() || '/';
  return (
    <nav className="kit-tabs" aria-label="primary">
      {TABS.map((t) => (
        <Link
          key={t.label}
          href={t.href}
          className="kit-tab"
          data-active={t.match(pathname) ? 'true' : 'false'}
        >
          {t.label}
        </Link>
      ))}
      <span className="kit-tag">cosmocopia · testnet</span>
    </nav>
  );
}
