'use client';

import { useState } from 'react';
import { useWallet, shortAddr } from '../lib/wallet-context';

export default function ConnectButton() {
  const { state, connectPasskey, connectClassic, disconnect } = useWallet();
  const [open, setOpen] = useState(false);

  if (state.status === 'connected') {
    return (
      <div className="walletChip">
        <span className="dot" aria-hidden />
        <span title={state.address}>{shortAddr(state.address)}</span>
        <span className="walletLabel">via {state.label}</span>
        <button className="secondary" onClick={disconnect}>disconnect</button>
      </div>
    );
  }

  return (
    <>
      <button onClick={() => setOpen(true)}>
        {state.status === 'connecting' ? `connecting (${state.kind})…` : 'connect'}
      </button>
      {open && (
        <div className="modalScrim" onClick={() => setOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>choose your wallet</h3>
            <p className="note">
              No keys to back up either way. Passkey signs with your device; the existing-wallet
              path uses whatever Stellar wallet you already trust.
            </p>

            <button
              className="option"
              onClick={async () => {
                setOpen(false);
                await connectPasskey();
              }}
            >
              <span className="optTitle">Continue with a passkey</span>
              <span className="optDesc">
                Sign with FaceID, TouchID or Windows Hello. Creates a smart account on testnet
                (gas-sponsored). Powered by{' '}
                <span className="kbd">smart-account-kit</span>.
              </span>
            </button>

            <button
              className="option"
              onClick={async () => {
                setOpen(false);
                await connectClassic();
              }}
            >
              <span className="optTitle">Connect an existing wallet</span>
              <span className="optDesc">
                Freighter, xBull, Albedo, Lobstr, Hana, WalletConnect, and more.
                Powered by <span className="kbd">@creit-tech/stellar-wallets-kit</span>.
              </span>
            </button>

            {state.status === 'error' && (
              <p className="errBox">
                <strong>error:</strong> {state.message}
              </p>
            )}

            <button className="secondary" onClick={() => setOpen(false)}>cancel</button>
          </div>
        </div>
      )}
    </>
  );
}
