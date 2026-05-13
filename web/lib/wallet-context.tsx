'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type WalletKind = 'passkey' | 'classic';

export type WalletState =
  | { status: 'idle' }
  | { status: 'connecting'; kind: WalletKind }
  | {
      status: 'connected';
      kind: WalletKind;
      address: string;        // For passkey: smart account contract id (C...). For classic: G... pubkey.
      label: string;          // Display name of the wallet
      credentialId?: string;  // passkey only
    }
  | { status: 'error'; message: string; kind?: WalletKind };

type Ctx = {
  state: WalletState;
  connectPasskey: () => Promise<void>;
  connectClassic: () => Promise<void>;
  disconnect: () => Promise<void>;
};

const WalletContext = createContext<Ctx | null>(null);

const RPC_URL = process.env.NEXT_PUBLIC_STELLAR_RPC_URL!;
const PASSPHRASE = process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE!;
const SAK_WASM_HASH = process.env.NEXT_PUBLIC_SAK_ACCOUNT_WASM_HASH!;
const SAK_WEBAUTHN = process.env.NEXT_PUBLIC_SAK_WEBAUTHN_VERIFIER!;

// Stellar Wallets Kit v2 is all static — init() lands once, then everything
// flows through static methods on the class.
let classicReady = false;
async function ensureClassicKit() {
  if (classicReady) return;
  // Top-level module classes live behind subpath exports.
  const [swk, freighter, xbull, albedo, lobstr, rabet, hana] = await Promise.all([
    import('@creit-tech/stellar-wallets-kit'),
    import('@creit-tech/stellar-wallets-kit/modules/freighter'),
    import('@creit-tech/stellar-wallets-kit/modules/xbull'),
    import('@creit-tech/stellar-wallets-kit/modules/albedo'),
    import('@creit-tech/stellar-wallets-kit/modules/lobstr'),
    import('@creit-tech/stellar-wallets-kit/modules/rabet'),
    import('@creit-tech/stellar-wallets-kit/modules/hana'),
  ]);
  swk.StellarWalletsKit.init({
    network: swk.Networks.TESTNET,
    modules: [
      new freighter.FreighterModule(),
      new xbull.xBullModule(),
      new albedo.AlbedoModule(),
      new lobstr.LobstrModule(),
      new rabet.RabetModule(),
      new hana.HanaModule(),
    ],
  });
  classicReady = true;
}

let passkeyKit: any = null;
export async function getPasskeyKit(): Promise<any> {
  if (passkeyKit) return passkeyKit;
  const { SmartAccountKit, IndexedDBStorage } = await import('smart-account-kit');
  passkeyKit = new SmartAccountKit({
    rpcUrl: RPC_URL,
    networkPassphrase: PASSPHRASE,
    accountWasmHash: SAK_WASM_HASH,
    webauthnVerifierAddress: SAK_WEBAUTHN,
    storage: new IndexedDBStorage(),
    rpName: 'Cosmocopia',
  });
  return passkeyKit;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WalletState>({ status: 'idle' });

  // On mount, try to silently restore a passkey session if one was stored.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const kit = await getPasskeyKit();
        const restored = await kit.connectWallet();
        if (cancelled) return;
        if (restored?.contractId) {
          setState({
            status: 'connected',
            kind: 'passkey',
            address: restored.contractId,
            label: 'Passkey',
            credentialId: restored.credentialId,
          });
        }
      } catch {
        // No session — leave idle.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const connectPasskey = useCallback(async () => {
    setState({ status: 'connecting', kind: 'passkey' });
    try {
      const kit = await getPasskeyKit();
      // Prompt biometrics + deploy the smart account on testnet (autoSubmit/autoFund).
      const { contractId, credentialId } = await kit.createWallet('Cosmocopia', 'cosmocopia-passkey', {
        autoSubmit: true,
        autoFund: true,
      });
      setState({
        status: 'connected',
        kind: 'passkey',
        address: contractId,
        label: 'Passkey',
        credentialId,
      });
    } catch (e: any) {
      setState({ status: 'error', message: e?.message ?? String(e), kind: 'passkey' });
    }
  }, []);

  const connectClassic = useCallback(async () => {
    setState({ status: 'connecting', kind: 'classic' });
    try {
      await ensureClassicKit();
      const swk = await import('@creit-tech/stellar-wallets-kit');
      const { address } = await swk.StellarWalletsKit.authModal();
      const label = swk.StellarWalletsKit.selectedModule?.productName ?? 'Wallet';
      setState({ status: 'connected', kind: 'classic', address, label });
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      // User-cancelled modal lands here; degrade to idle rather than error.
      if (/close|cancel/i.test(msg)) {
        setState({ status: 'idle' });
      } else {
        setState({ status: 'error', message: msg, kind: 'classic' });
      }
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      if (state.status === 'connected' && state.kind === 'passkey') {
        const kit = await getPasskeyKit();
        await kit.disconnect?.();
      }
      if (state.status === 'connected' && state.kind === 'classic') {
        const swk = await import('@creit-tech/stellar-wallets-kit');
        await swk.StellarWalletsKit.disconnect();
      }
    } finally {
      setState({ status: 'idle' });
    }
  }, [state]);

  const value = useMemo(
    () => ({ state, connectPasskey, connectClassic, disconnect }),
    [state, connectPasskey, connectClassic, disconnect],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet outside WalletProvider');
  return ctx;
}

export function shortAddr(addr: string) {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 5)}…${addr.slice(-4)}`;
}
