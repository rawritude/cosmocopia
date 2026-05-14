'use client';

/// A small "SOULBOUND" chip rendered on planet cards whose `soulbound` bit
/// is true. Hover detail surfaces the remaining countdown to release via
/// 7-day consistent care. The tooltip text is built by
/// `soulboundTooltip(...)` in `lib/cosmocopia.ts` so it's testable from a
/// non-DOM environment.

import { soulboundTooltip } from '../lib/cosmocopia';

export type SoulboundChipProps = {
  /// Token's `healthy_since_of` value. 0 ⇒ planet is not currently in the
  /// healthy band and the countdown is paused.
  healthySince: number;
  /// Current ledger seq, used to compute the remaining window. Caller can
  /// pass the most recent ledger they've seen — exact-second precision
  /// isn't important for the hover detail.
  currentLedger?: number;
};

export default function SoulboundChip({
  healthySince,
  currentLedger,
}: SoulboundChipProps) {
  const tooltip = soulboundTooltip(healthySince, currentLedger);
  return (
    <span
      className="soulboundChip"
      title={tooltip}
      data-testid="soulbound-chip"
      style={{
        fontFamily: 'var(--font-mono, monospace)',
        fontSize: '0.65rem',
        padding: '2px 6px',
        borderRadius: '2px',
        background: 'rgba(255, 213, 79, 0.15)',
        color: '#FFD54F',
        border: '1px solid #FFD54F',
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        cursor: 'help',
      }}
    >
      Soulbound
    </span>
  );
}
