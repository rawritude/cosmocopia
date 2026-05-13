// High-level read/write helpers for the deployed planet contract.

import { Client } from './planet-bindings/src/index';
import type { Vitals } from './planet-bindings/src/index';
import type { WalletState } from './wallet-context';

const RPC = process.env.NEXT_PUBLIC_STELLAR_RPC_URL!;
const PASSPHRASE = process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE!;
const CONTRACT = process.env.NEXT_PUBLIC_PLANET_CONTRACT!;

// Simulations still need a real ed25519 G-key as the source so the RPC can
// fetch a sequence number. We use the deployer's account (already funded);
// this is a *read-only* fallback — it never signs anything.
const READ_SOURCE = 'GBVK7HKPHCELHPVFTJRMGRL5ROWQ4FOWTK4HC66SIGW5Y4ZBZP2OUR2Z';

let _readClient: Client | null = null;
export function readClient(): Client {
  if (!_readClient) {
    _readClient = new Client({
      contractId: CONTRACT,
      networkPassphrase: PASSPHRASE,
      rpcUrl: RPC,
      publicKey: READ_SOURCE,
      allowHttp: false,
    });
  }
  return _readClient;
}

export type Planet = {
  id: number;
  dna: Uint8Array;
  vitals: Vitals;
  coords: { x: number; y: number };
};

/// Scan token ids upward and collect those owned by `address`. With no
/// indexer in the project yet, this is a brute-force linear sweep — fine for
/// the testnet seed of a few dozen tokens.
export async function listOwnedPlanets(
  address: string,
  maxScan = 64,
): Promise<Planet[]> {
  const client = readClient();
  let bal = 0;
  try {
    const r = await client.balance({ account: address });
    bal = Number(r.result);
  } catch {
    bal = 0;
  }
  if (bal === 0) return [];

  const owned: Planet[] = [];
  let consecutiveMisses = 0;
  for (let id = 0; id < maxScan && owned.length < bal; id++) {
    let owner: string | null = null;
    try {
      const r = await client.owner_of({ token_id: id });
      owner = r.result as unknown as string;
      consecutiveMisses = 0;
    } catch {
      consecutiveMisses++;
      // Five misses in a row → assume we've walked past the live range.
      if (consecutiveMisses >= 5 && owned.length > 0) break;
      continue;
    }
    if (owner !== address) continue;
    const planet = await getPlanet(id);
    if (planet) owned.push(planet);
  }
  return owned;
}

export async function getPlanet(id: number): Promise<Planet | null> {
  const client = readClient();
  try {
    const [dnaTx, vitalsTx, coordsTx] = await Promise.all([
      client.dna_of({ id }),
      client.vitals_of({ id }),
      client.coords_of({ id }),
    ]);
    const dnaResult = dnaTx.result;
    const vitalsResult = vitalsTx.result;
    const dnaBuf = unwrapResult(dnaResult) as Buffer;
    const vitals = unwrapResult(vitalsResult) as Vitals;
    const [x, y] = coordsTx.result as unknown as [number, number];
    return {
      id,
      dna: new Uint8Array(dnaBuf),
      vitals,
      coords: { x, y },
    };
  } catch {
    return null;
  }
}

/// `Result<T>` from bindings is either `{ value: T }` (Ok) or `{ error: ... }`.
/// Unwrap or throw.
function unwrapResult<T>(r: unknown): T {
  if (r && typeof r === 'object' && 'value' in r) return (r as { value: T }).value;
  if (r && typeof r === 'object' && 'unwrap' in r) {
    return (r as { unwrap: () => T }).unwrap();
  }
  return r as T;
}

/// Care action codes — match the Care enum in contracts/planet/src/stats.rs.
export const CARE = {
  Warm: 0,
  Rain: 1,
  Tide: 2,
  Tend: 3,
  Reflect: 4,
} as const;
export type CareName = keyof typeof CARE;

/// Submit a care action for the connected wallet. Returns the tx hash.
///
/// - Classic (`G…`) wallets: build → sign via Wallets Kit → send via RPC.
/// - Passkey (`C…`) smart accounts: build with the kit's deployer key as the
///   fee-payer source → `kit.signAndSubmit` handles WebAuthn auth-entry
///   signing + re-simulation + fee-payer signature + submission.
export async function submitCare(
  id: number,
  action: number,
  wallet: WalletState,
): Promise<string> {
  if (wallet.status !== 'connected') {
    throw new Error('connect a wallet first');
  }

  if (wallet.kind === 'passkey') {
    const { getPasskeyKit } = await import('./wallet-context');
    const kit = await getPasskeyKit();
    const client = new Client({
      contractId: CONTRACT,
      networkPassphrase: PASSPHRASE,
      rpcUrl: RPC,
      // Smart account contract IDs (C…) aren't valid as tx sources; the kit's
      // deterministic deployer G-key is — the kit later swaps in its own fee
      // payer if needed via signAndSubmit.
      publicKey: kit.deployerPublicKey,
    });
    const tx = await client.care({ id, action });
    const result = await kit.signAndSubmit(tx);
    return extractHash(result);
  }

  // Classic wallet (Freighter et al.)
  const swk = await import('@creit-tech/stellar-wallets-kit');
  const client = new Client({
    contractId: CONTRACT,
    networkPassphrase: PASSPHRASE,
    rpcUrl: RPC,
    publicKey: wallet.address,
    signTransaction: async (xdr: string) => {
      return await swk.StellarWalletsKit.signTransaction(xdr, {
        networkPassphrase: PASSPHRASE,
        address: wallet.address,
      });
    },
  });

  const tx = await client.care({ id, action });
  const sent = await tx.signAndSend();
  return extractHash(sent);
}

function extractHash(result: unknown): string {
  const r = result as Record<string, any>;
  return String(
    r?.hash ??
    r?.sendTransactionResponse?.hash ??
    r?.getTransactionResponse?.txHash ??
    '',
  );
}
