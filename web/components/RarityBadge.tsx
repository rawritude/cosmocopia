'use client';

import { computeRarity, tierColor, type Tier } from '@cosmocopia/art';

export type RarityBadgeProps = {
  dna: Uint8Array;
  coords?: { x: number; y: number };
  size?: 'sm' | 'md';
};

export default function RarityBadge({ dna, coords, size = 'sm' }: RarityBadgeProps) {
  const rarity = computeRarity({ dna, coords });
  const color = tierColor(rarity.tier);
  const tooltip = buildTooltip(rarity.tier, rarity.score, rarity.contributions);

  return (
    <span
      className={`rarityBadge rarityBadge--${size} rarityBadge--${rarity.tier.toLowerCase()}`}
      style={{
        // Color is set inline so it survives PNG screenshots etc.
        color,
        borderColor: color,
        boxShadow: tierGlow(color),
      }}
      title={tooltip}
    >
      {rarity.tier}
    </span>
  );
}

/// Tier glow shape matches --glow-primary / --glow-conjoin in globals.css,
/// just parameterized by the per-tier color so we don't need a CSS var per
/// tier.
export function tierGlow(color: string): string {
  return `0 0 12px ${alpha(color, 0.35)}`;
}

function buildTooltip(
  tier: Tier,
  score: number,
  contribs: Array<{ source: string; points: number; note?: string }>,
): string {
  const lines = [`${tier} · score ${score}`, ''];
  for (const c of contribs) {
    const sign = c.points >= 0 ? '+' : '';
    lines.push(`${sign}${c.points}  ${c.source}${c.note ? ` (${c.note})` : ''}`);
  }
  if (contribs.length === 0) lines.push('no rare traits detected');
  return lines.join('\n');
}

function alpha(hexColor: string, a: number): string {
  // Convert "#rrggbb" → "rgba(r,g,b,a)" so the glow always reads.
  const m = hexColor.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return hexColor;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
