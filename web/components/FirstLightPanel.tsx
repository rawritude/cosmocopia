'use client';

/// Onboarding panel shown to a connected wallet that hasn't yet claimed First
/// Light. Surfaces the brutalist call-to-action + drives the
/// commit→wait→reveal flow via `submitFirstLight`. Hides itself once the
/// keeper's `first_light_claimed` view returns true.

import { useCallback, useEffect, useState } from 'react';
import {
  firstLightClaimed,
  submitFirstLight,
  type FirstLightProgress,
} from '../lib/cosmocopia';
import { useWallet } from '../lib/wallet-context';

type Status =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'claimable' }
  | { kind: 'in-flight'; progress: FirstLightProgress }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

export default function FirstLightPanel({
  onClaimed,
}: {
  onClaimed?: () => void;
}) {
  const { state } = useWallet();
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  // Re-check `first_light_claimed` whenever the connected address changes.
  // Disconnecting collapses the panel; reconnecting kicks off a fresh check.
  useEffect(() => {
    if (state.status !== 'connected') {
      setStatus({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setStatus({ kind: 'checking' });
    firstLightClaimed(state.address)
      .then((claimed) => {
        if (cancelled) return;
        setStatus({ kind: claimed ? 'done' : 'claimable' });
      })
      .catch((e) => {
        if (cancelled) return;
        setStatus({ kind: 'error', message: e?.message ?? String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [state]);

  const handleClaim = useCallback(async () => {
    if (state.status !== 'connected') return;
    try {
      setStatus({
        kind: 'in-flight',
        progress: { phase: 'committing' },
      });
      await submitFirstLight(state, (progress) => {
        setStatus({ kind: 'in-flight', progress });
      });
      setStatus({ kind: 'done' });
      onClaimed?.();
    } catch (e: any) {
      setStatus({ kind: 'error', message: e?.message ?? String(e) });
    }
  }, [state, onClaimed]);

  // Hide entirely when there's nothing to do.
  if (state.status !== 'connected') return null;
  if (status.kind === 'checking' || status.kind === 'idle') return null;
  if (status.kind === 'done') return null;

  return (
    <div
      className="panel has-titlebar"
      style={{ marginBottom: 'var(--space-6)' }}
    >
      <div className="panel-titlebar">
        <span className="tb-title">first light</span>
        <span className="tb-stripes" />
      </div>
      <div className="panel-body">
        <p style={{ marginTop: 0, fontSize: 'var(--text-lg)' }}>
          Your telescope is cold. 10 XLM warms the mirror for one observation.
        </p>
        {status.kind === 'claimable' && (
          <button
            className="btn btn-primary"
            onClick={handleClaim}
            data-testid="first-light-claim"
          >
            CLAIM FIRST LIGHT
          </button>
        )}
        {status.kind === 'in-flight' && (
          <FirstLightProgressView progress={status.progress} />
        )}
        {status.kind === 'error' && (
          <>
            <p className="errBox" data-testid="first-light-error">
              {status.message}
            </p>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setStatus({ kind: 'claimable' })}
            >
              try again
            </button>
          </>
        )}
        <p
          className="note"
          style={{ marginTop: 'var(--space-3)', marginBottom: 0 }}
        >
          The first observation drops a Common-tier planet in the Outer Dark.
          It is <strong>soulbound</strong> until you keep it healthy for 7
          days, or send it through its first conjunction.
        </p>
      </div>
    </div>
  );
}

function FirstLightProgressView({
  progress,
}: {
  progress: FirstLightProgress;
}) {
  // Mirror the conjoin-page progress strip so the visual language is
  // consistent. Inline-styled because there is no shared component for it
  // yet — Phase 1's bar is intentionally minimal.
  let label: string;
  let pct: number;
  switch (progress.phase) {
    case 'committing':
      label = 'committing — debiting 10 XLM…';
      pct = 15;
      break;
    case 'waiting': {
      const remaining = Math.max(
        0,
        progress.revealAfterLedger - progress.currentLedger,
      );
      label = `waiting on drand · ${remaining} ledger${remaining === 1 ? '' : 's'} to reveal`;
      pct = 55;
      break;
    }
    case 'revealing':
      label = 'revealing — minting your planet…';
      pct = 90;
      break;
    case 'done':
      label = 'done';
      pct = 100;
      break;
  }
  return (
    <div data-testid="first-light-progress">
      <div className="vital">
        <span className="vital-glyph">●</span>
        <div className="vital-bar">
          <div
            className="vital-fill"
            data-state="good"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="vital-num">{pct}%</span>
      </div>
      <p className="note" style={{ marginTop: 'var(--space-2)' }}>
        {label}
      </p>
    </div>
  );
}
