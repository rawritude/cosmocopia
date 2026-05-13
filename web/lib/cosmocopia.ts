// High-level read/write helpers for the deployed planet contract.

import { Client } from './planet-bindings/src/index';
import type { Vitals } from './planet-bindings/src/index';
import type { WalletState } from './wallet-context';

const RPC = process.env.NEXT_PUBLIC_STELLAR_RPC_URL!;
const PASSPHRASE = process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE!;
const CONTRACT = process.env.NEXT_PUBLIC_PLANET_CONTRACT!;

// Simulations need a valid funded G-key as the tx source so the RPC can fetch
// a sequence number. Audit High #4 flagged hardcoding the deployer here as a
// SPOF — long-term fix is to drop in a simulationAccountSequence override in
// the stellar-sdk, but for now we tolerate the dependency on this account
// existing on chain (it's the testnet deployer and will stay funded).
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
  owner?: string;
};

// ---------------------------------------------------------------------------
// `Result<T, E>` unwrap that fails loudly. Audit High #5 noted that the prior
// duck-typing on { value } would silently turn Err into undefined; we now
// dispatch on the tagged-union shape stellar-sdk uses and throw on Err.
// ---------------------------------------------------------------------------
function unwrapResult<T>(r: unknown): T {
  if (r && typeof r === 'object' && 'tag' in r) {
    const t = r as unknown as { tag: 'Ok' | 'Err'; values: unknown[] };
    if (t.tag === 'Ok') return (t.values?.[0]) as T;
    if (t.tag === 'Err') {
      throw new Error(`contract returned Err: ${JSON.stringify(t.values?.[0])}`);
    }
  }
  if (r && typeof r === 'object' && 'unwrap' in r && typeof (r as { unwrap: unknown }).unwrap === 'function') {
    return ((r as { unwrap: () => T }).unwrap)();
  }
  return r as T;
}

// ---------------------------------------------------------------------------
// Enumerable-backed listings (audit Informational #3 + scale concern). The
// contract now exposes total_supply / get_token_id / get_owner_token_id from
// the OZ NonFungibleEnumerable trait, so we no longer brute-force scan.
// ---------------------------------------------------------------------------

export async function totalSupply(): Promise<number> {
  const r = await readClient().total_supply();
  return Number(r.result);
}

export async function listAllPlanets(): Promise<Planet[]> {
  const client = readClient();
  const supply = Number((await client.total_supply()).result);
  if (supply === 0) return [];

  // Resolve token ids in parallel via the enumerable index.
  const ids = await Promise.all(
    Array.from({ length: supply }, (_, i) =>
      client.get_token_id({ index: i }).then((tx) => Number(tx.result)),
    ),
  );
  // Fetch planet detail + owner in parallel for each id.
  const planets = await Promise.all(ids.map(async (id) => {
    const planet = await getPlanet(id);
    if (!planet) return null;
    try {
      const r = await client.owner_of({ token_id: id });
      return { ...planet, owner: r.result as unknown as string };
    } catch {
      return planet;
    }
  }));
  return planets.filter((p): p is Planet => p !== null);
}

export async function listOwnedPlanets(address: string): Promise<Planet[]> {
  const client = readClient();
  let bal = 0;
  try {
    bal = Number((await client.balance({ account: address })).result);
  } catch {
    bal = 0;
  }
  if (bal === 0) return [];

  const ids = await Promise.all(
    Array.from({ length: bal }, (_, i) =>
      client
        .get_owner_token_id({ owner: address, index: i })
        .then((tx) => Number(tx.result)),
    ),
  );
  const planets = await Promise.all(ids.map((id) => getPlanet(id)));
  return planets.filter((p): p is Planet => p !== null);
}

export async function getPlanet(id: number): Promise<Planet | null> {
  const client = readClient();
  try {
    const [dnaTx, vitalsTx, coordsTx] = await Promise.all([
      client.dna_of({ id }),
      client.vitals_of({ id }),
      client.coords_of({ id }),
    ]);
    const dnaBuf = unwrapResult<Buffer | Uint8Array>(dnaTx.result);
    const vitals = unwrapResult<Vitals>(vitalsTx.result);
    const [x, y] = unwrapResult<readonly [number, number]>(coordsTx.result);
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

// ---------------------------------------------------------------------------
// Care + Conjoin write paths
// ---------------------------------------------------------------------------

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
  if (wallet.status !== 'connected') throw new Error('connect a wallet first');

  if (wallet.kind === 'passkey') {
    const { getPasskeyKit } = await import('./wallet-context');
    const kit = await getPasskeyKit();
    const client = new Client({
      contractId: CONTRACT,
      networkPassphrase: PASSPHRASE,
      rpcUrl: RPC,
      publicKey: kit.deployerPublicKey,
    });
    const tx = await client.care({ id, action });
    return extractHash(await kit.signAndSubmit(tx));
  }

  // Classic wallet (Freighter et al.)
  const swk = await import('@creit-tech/stellar-wallets-kit');
  const client = new Client({
    contractId: CONTRACT,
    networkPassphrase: PASSPHRASE,
    rpcUrl: RPC,
    publicKey: wallet.address,
    signTransaction: async (xdr: string) =>
      swk.StellarWalletsKit.signTransaction(xdr, {
        networkPassphrase: PASSPHRASE,
        address: wallet.address,
      }),
  });
  const tx = await client.care({ id, action });
  return extractHash(await tx.signAndSend());
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

const DRAND_CONTRACT = 'CAESC7SC5EW5P2P3IM5Q7E64ZNDATVSN5F57NTCH5E7GJRPDM76KF7QM';

/// Fetch the most recent drand round from the verifier. Used to pin a round
/// for mint_genesis / conjoin so the read footprint is deterministic.
export async function latestDrandRound(): Promise<bigint> {
  const sdk = await import('@stellar/stellar-sdk');
  const { Contract, TransactionBuilder, BASE_FEE, rpc } = sdk;
  const server = new rpc.Server(RPC, { allowHttp: false });
  const account = await server.getAccount(READ_SOURCE);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(new Contract(DRAND_CONTRACT).call('latest'))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if ('error' in sim && sim.error) {
    throw new Error(`drand latest() simulation failed: ${sim.error}`);
  }
  const result = (sim as any).result?.retval;
  if (!result) throw new Error('drand latest() returned nothing');
  const native = sdk.scValToNative(result);
  if (!Array.isArray(native)) throw new Error('unexpected drand result shape');
  const round = native[0];
  return typeof round === 'bigint' ? round : BigInt(round);
}

/// Conjoin two parents. Returns the tx hash. The new contract enforces
/// `to ∈ {owner_a, owner_b}` (audit High #1).
export async function submitConjoin(
  parentA: number,
  parentB: number,
  wallet: WalletState,
): Promise<string> {
  if (wallet.status !== 'connected') throw new Error('connect a wallet first');
  const round = await latestDrandRound();

  if (wallet.kind === 'passkey') {
    const { getPasskeyKit } = await import('./wallet-context');
    const kit = await getPasskeyKit();
    const client = new Client({
      contractId: CONTRACT,
      networkPassphrase: PASSPHRASE,
      rpcUrl: RPC,
      publicKey: kit.deployerPublicKey,
    });
    const tx = await client.conjoin({
      parent_a: parentA,
      parent_b: parentB,
      to: wallet.address,
      round,
    });
    return extractHash(await kit.signAndSubmit(tx));
  }

  const swk = await import('@creit-tech/stellar-wallets-kit');
  const client = new Client({
    contractId: CONTRACT,
    networkPassphrase: PASSPHRASE,
    rpcUrl: RPC,
    publicKey: wallet.address,
    signTransaction: async (xdr: string) =>
      swk.StellarWalletsKit.signTransaction(xdr, {
        networkPassphrase: PASSPHRASE,
        address: wallet.address,
      }),
  });
  const tx = await client.conjoin({
    parent_a: parentA,
    parent_b: parentB,
    to: wallet.address,
    round,
  });
  return extractHash(await tx.signAndSend());
}
