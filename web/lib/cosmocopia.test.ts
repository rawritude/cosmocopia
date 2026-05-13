import { afterEach, describe, expect, it, vi } from 'vitest';

// ----- Mock the generated contract Client and the SDK before importing cosmocopia.ts.

const ownerMap = new Map<number, string>();
const dnaMap = new Map<number, Uint8Array>();
const balances = new Map<string, number>();
const coordsMap = new Map<number, [number, number]>();
const vitalsTemplate = {
  biomass: 128, gravity: 128, hydration: 128, last_ledger: 100, spirit: 160, temperature: 128,
};

vi.mock('./planet-bindings/src/index', () => {
  return {
    Client: class {
      constructor(public opts: any) {}
      async balance({ account }: { account: string }) {
        return { result: balances.get(account) ?? 0 };
      }
      async owner_of({ token_id }: { token_id: number }) {
        const o = ownerMap.get(token_id);
        if (!o) throw new Error(`unknown token ${token_id}`);
        return { result: o };
      }
      async dna_of({ id }: { id: number }) {
        const d = dnaMap.get(id);
        if (!d) throw new Error(`no dna ${id}`);
        return { result: { value: Buffer.from(d) } };
      }
      async vitals_of({ id }: { id: number }) {
        if (!ownerMap.has(id)) throw new Error(`no vitals ${id}`);
        return { result: { value: { ...vitalsTemplate } } };
      }
      async coords_of({ id }: { id: number }) {
        return { result: coordsMap.get(id) ?? [0, 0] };
      }
      async care(_args: any) {
        return {
          signAndSend: async () => ({ hash: 'TXHASH_CLASSIC' }),
        };
      }
      async conjoin(_args: any) {
        return {
          signAndSend: async () => ({ hash: 'TXHASH_CLASSIC_CONJOIN' }),
        };
      }
    },
  };
});

// Mock @creit-tech/stellar-wallets-kit so we never reach a real wallet modal.
vi.mock('@creit-tech/stellar-wallets-kit', () => ({
  StellarWalletsKit: {
    signTransaction: vi.fn(async () => ({ signedTxXdr: 'SIGNED' })),
  },
}));

// Mock the passkey path via the wallet-context export. The mock returns a kit
// whose signAndSubmit just echoes a hash so we can assert it ran.
vi.mock('./wallet-context', () => ({
  getPasskeyKit: vi.fn(async () => ({
    deployerPublicKey: 'GDEPLOYER_PUBLIC_KEY_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE',
    signAndSubmit: vi.fn(async () => ({ hash: 'TXHASH_PASSKEY' })),
  })),
}));

// Mock the @stellar/stellar-sdk used by latestDrandRound. We need a minimal
// surface that returns a [round, randomness] tuple from simulateTransaction.
vi.mock('@stellar/stellar-sdk', () => {
  class Contract {
    constructor(public id: string) {}
    call(_fn: string) { return { type: 'op' }; }
  }
  class TransactionBuilder {
    constructor(_acct: any, _opts: any) {}
    addOperation(_op: any) { return this; }
    setTimeout(_n: number) { return this; }
    build() { return { id: 'TX' }; }
  }
  const rpc = {
    Server: class {
      constructor(_url: string, _opts: any) {}
      async getAccount(_pk: string) { return { id: 'ACCT' }; }
      async simulateTransaction(_tx: any) {
        return { result: { retval: 'RETVAL' } };
      }
    },
  };
  return {
    Contract,
    TransactionBuilder,
    BASE_FEE: '100',
    rpc,
    Address: { fromString: () => ({}) },
    scValToNative: () => [12345n, new Uint8Array(32)],
  };
});

import * as cc from './cosmocopia';

afterEach(() => {
  ownerMap.clear();
  dnaMap.clear();
  balances.clear();
  coordsMap.clear();
  vi.clearAllMocks();
});

const OWNER = 'GBVK7HKPHCELHPVFTJRMGRL5ROWQ4FOWTK4HC66SIGW5Y4ZBZP2OUR2Z';
const OTHER = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';

describe('CARE enum', () => {
  it('codes match the contract Care::from_u32 ordering', () => {
    expect(cc.CARE.Warm).toBe(0);
    expect(cc.CARE.Rain).toBe(1);
    expect(cc.CARE.Tide).toBe(2);
    expect(cc.CARE.Tend).toBe(3);
    expect(cc.CARE.Reflect).toBe(4);
  });
});

describe('listOwnedPlanets', () => {
  it('returns empty list when balance is zero', async () => {
    balances.set(OWNER, 0);
    const list = await cc.listOwnedPlanets(OWNER);
    expect(list).toEqual([]);
  });

  it('filters by owner — only matching tokens come back', async () => {
    balances.set(OWNER, 2);
    ownerMap.set(0, OWNER);
    ownerMap.set(1, OTHER);
    ownerMap.set(2, OWNER);
    dnaMap.set(0, new Uint8Array(32).fill(0x11));
    dnaMap.set(2, new Uint8Array(32).fill(0x22));
    coordsMap.set(0, [0, 0]);
    coordsMap.set(2, [5, 5]);
    const list = await cc.listOwnedPlanets(OWNER);
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.id).sort()).toEqual([0, 2]);
  });

  it('terminates early after a run of missing token ids', async () => {
    balances.set(OWNER, 1);
    ownerMap.set(0, OWNER);
    dnaMap.set(0, new Uint8Array(32));
    coordsMap.set(0, [0, 0]);
    // ids 1..63 all miss; balance is already satisfied at 1.
    const list = await cc.listOwnedPlanets(OWNER, 64);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(0);
  });
});

describe('listAllPlanets', () => {
  it('walks every existing id regardless of owner, stopping after 5 consecutive misses', async () => {
    ownerMap.set(0, OWNER);
    ownerMap.set(1, OTHER);
    ownerMap.set(2, OWNER);
    // gap from id 3..7 should cap at 5 misses and stop
    for (let id = 0; id <= 2; id++) {
      dnaMap.set(id, new Uint8Array(32).fill(id));
      coordsMap.set(id, [id, id]);
    }
    const list = await cc.listAllPlanets(64);
    expect(list).toHaveLength(3);
    expect(list.map((p) => p.owner).sort()).toEqual([OTHER, OWNER, OWNER]);
  });
});

describe('getPlanet', () => {
  it('returns null for an unknown id rather than throwing', async () => {
    const p = await cc.getPlanet(999);
    expect(p).toBeNull();
  });

  it('hydrates a known planet with dna + vitals + coords', async () => {
    ownerMap.set(7, OWNER);
    dnaMap.set(7, new Uint8Array(32).fill(0xAB));
    coordsMap.set(7, [3, -4]);
    const p = await cc.getPlanet(7);
    expect(p).not.toBeNull();
    expect(p!.id).toBe(7);
    expect(p!.coords).toEqual({ x: 3, y: -4 });
    expect(p!.dna[0]).toBe(0xAB);
    expect(p!.vitals.temperature).toBe(128);
  });
});

describe('latestDrandRound', () => {
  it('returns a bigint from the verifier tuple', async () => {
    const round = await cc.latestDrandRound();
    expect(typeof round).toBe('bigint');
    expect(round).toBe(12345n);
  });
});

describe('submitCare wallet branching', () => {
  const classicState = {
    status: 'connected',
    kind: 'classic',
    address: OWNER,
    label: 'Freighter',
  } as const;

  const passkeyState = {
    status: 'connected',
    kind: 'passkey',
    address: 'CXYZSMARTACCOUNTCONTRACTID',
    label: 'Passkey',
  } as const;

  it('refuses when no wallet is connected', async () => {
    await expect(cc.submitCare(0, 0, { status: 'idle' } as any)).rejects.toThrow(/connect a wallet/i);
  });

  it('signs through Stellar Wallets Kit for classic wallets', async () => {
    const hash = await cc.submitCare(0, 0, classicState as any);
    expect(hash).toBe('TXHASH_CLASSIC');
    const swk = await import('@creit-tech/stellar-wallets-kit');
    expect(swk.StellarWalletsKit.signTransaction).toHaveBeenCalledTimes(1);
  });

  it('signs through Smart Account Kit for passkey wallets', async () => {
    const hash = await cc.submitCare(0, 0, passkeyState as any);
    expect(hash).toBe('TXHASH_PASSKEY');
    const wc = await import('./wallet-context');
    expect(wc.getPasskeyKit).toHaveBeenCalled();
  });
});

describe('submitConjoin', () => {
  it('refuses when not connected', async () => {
    await expect(cc.submitConjoin(0, 1, { status: 'idle' } as any)).rejects.toThrow(/connect a wallet/i);
  });

  it('fetches latest drand round then submits for classic wallets', async () => {
    const hash = await cc.submitConjoin(0, 1, {
      status: 'connected', kind: 'classic', address: OWNER, label: 'Freighter',
    } as any);
    expect(hash).toBe('TXHASH_CLASSIC_CONJOIN');
  });
});
