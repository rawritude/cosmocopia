'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS: Array<{ href: string; label: string }> = [
  { href: '/', label: 'home' },
  { href: '/galaxy', label: 'galaxy' },
  { href: '/?conjoin=1', label: 'conjunction' },
];

export default function TopNav() {
  const pathname = usePathname() || '/';
  return (
    <nav className="kit-tabs" aria-label="primary">
      {TABS.map((t) => {
        // Conjunction is a soft-route — it lives on the home page but with a
        // hash so the OwnedPlanets panel can scroll itself into view + open
        // the conjoin picker. Home and Galaxy are real route matches.
        const isActive =
          t.href === '/galaxy'
            ? pathname.startsWith('/galaxy')
            : t.href === '/'
              ? pathname === '/'
              : false;
        return (
          <Link
            key={t.label}
            href={t.href}
            className="kit-tab"
            data-active={isActive ? 'true' : 'false'}
          >
            {t.label}
          </Link>
        );
      })}
      <span className="kit-tag">cosmocopia · testnet</span>
    </nav>
  );
}
