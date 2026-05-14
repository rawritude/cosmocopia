import { afterEach, describe, expect, it, vi } from 'vitest';

// ----- Mock the generated contract Client and the SDK before importing cosmocopia.ts.

const ownerMap = new Map<number, string>();
const dnaMap = new Map<number, Uint8Array>();
const balances = new Map<string, number>();
const coordsMap = new Map<number, [number, number]>();
const tokensInOrder: number[] = [];                            // global enumerable
const ownerTokens = new Map<string, number[]>();               // per-owner enumerable
const populationMap = new Map<number, number>();               // 0..5
const civTierMap = new Map<number, number>();                  // 0..4
const vitalsTemplate = {
  biomass: 128, gravity: 128, hydration: 128, last_ledger: 100, spirit: 160, temperature: 128,
};

// Helper: wrap a value as Result::Ok in the tagged-union shape stellar-sdk uses.
const ok = <T>(value: T) => ({ tag: 'Ok' as const, values: [value] });

vi.mock('./planet-bindings/src/index', () => {
  return {
    Client: class {
      constructor(public opts: any) {}
      async balance({ account }: { account: string }) {
        return { result: balances.get(account) ?? 0 };
      }
      async total_supply() {
        return { result: tokensInOrder.length };
      }
      async get_token_id({ index }: { index: number }) {
        return { result: tokensInOrder[index] };
      }
      async get_owner_token_id({ owner, index }: { owner: string; index: number }) {
        return { result: (ownerTokens.get(owner) ?? [])[index] };
      }
      async owner_of({ token_id }: { token_id: number }) {
        const o = ownerMap.get(token_id);
        if (!o) throw new Error(`unknown token ${token_id}`);
        return { result: o };
      }
      async dna_of({ id }: { id: number }) {
        const d = dnaMap.get(id);
        if (!d) throw new Error(`no dna ${id}`);
        return { result: ok(Buffer.from(d)) };
      }
      async vitals_of({ id }: { id: number }) {
        if (!ownerMap.has(id)) throw new Error(`no vitals ${id}`);
        return { result: ok({ ...vitalsTemplate }) };
      }
      async coords_of({ id }: { id: number }) {
        return { result: ok(coordsMap.get(id) ?? [0, 0]) };
      }
      async population_of({ id }: { id: number }) {
        if (!ownerMap.has(id)) throw new Error(`no pop ${id}`);
        return { result: ok(populationMap.get(id) ?? 0) };
      }
      async civ_tier_of({ id }: { id: number }) {
        if (!ownerMap.has(id)) throw new Error(`no civ ${id}`);
        return { result: ok(civTierMap.get(id) ?? 0) };
      }
      async care(_args: any) {
        return { signAndSend: async () => ({ hash: 'TXHASH_CLASSIC' }) };
      }
      async commit_conjoin(_args: any) {
        return { signAndSend: async () => ({ result: 42, hash: 'TXHASH_COMMIT' }) };
      }
      async reveal_conjoin(_args: any) {
        return { signAndSend: async () => ({ hash: 'TXHASH_REVEAL' }) };
      }
      async reveal_after(_args: any) {
        // Return Ok(0) — reveal-after-ledger == 0 means already revealable.
        return { result: { tag: 'Ok' as const, values: [0] } };
      }
      async commit_genesis(_args: any) {
        return { signAndSend: async () => ({ result: 1, hash: 'TXHASH_COMMIT_GENESIS' }) };
      }
      async reveal_genesis(_args: any) {
        return { signAndSend: async () => ({ hash: 'TXHASH_REVEAL_GENESIS' }) };
      }
    },
  };
});

vi.mock('@creit-tech/stellar-wallets-kit', () => ({
  StellarWalletsKit: { signTransaction: vi.fn(async () => ({ signedTxXdr: 'SIGNED' })) },
}));

vi.mock('./wallet-context', () => ({
  getPasskeyKit: vi.fn(async () => ({
    deployerPublicKey: 'GDEPLOYER_PUBLIC_KEY_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE',
    signAndSubmit: vi.fn(async () => ({ hash: 'TXHASH_PASSKEY' })),
  })),
}));

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
      async getLatestLedger() { return { sequence: 9_999_999 }; }
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
  tokensInOrder.length = 0;
  ownerTokens.clear();
  populationMap.clear();
  civTierMap.clear();
  vi.clearAllMocks();
});

const OWNER = 'GBVK7HKPHCELHPVFTJRMGRL5ROWQ4FOWTK4HC66SIGW5Y4ZBZP2OUR2Z';
const OTHER = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';

// Helper: register a planet across all mock maps in one call.
function seedPlanet(
  id: number,
  owner: string,
  x = 0,
  y = 0,
  dnaByte = 0x11,
  population?: number,
  civTier?: number,
) {
  ownerMap.set(id, owner);
  dnaMap.set(id, new Uint8Array(32).fill(dnaByte));
  coordsMap.set(id, [x, y]);
  tokensInOrder.push(id);
  const lst = ownerTokens.get(owner) ?? [];
  lst.push(id);
  ownerTokens.set(owner, lst);
  balances.set(owner, (balances.get(owner) ?? 0) + 1);
  if (typeof population === 'number') populationMap.set(id, population);
  if (typeof civTier === 'number') civTierMap.set(id, civTier);
}

describe('CARE enum', () => {
  it('codes match the contract Care::from_u32 ordering', () => {
    expect(cc.CARE.Warm).toBe(0);
    expect(cc.CARE.Rain).toBe(1);
    expect(cc.CARE.Tide).toBe(2);
    expect(cc.CARE.Tend).toBe(3);
    expect(cc.CARE.Reflect).toBe(4);
  });
});

describe('totalSupply', () => {
  it('returns current total', async () => {
    expect(await cc.totalSupply()).toBe(0);
    seedPlanet(0, OWNER);
    seedPlanet(1, OTHER);
    expect(await cc.totalSupply()).toBe(2);
  });
});

describe('listAllPlanets (enumerable-backed)', () => {
  it('returns empty when supply is 0', async () => {
    expect(await cc.listAllPlanets()).toEqual([]);
  });

  it('walks every token via get_token_id', async () => {
    seedPlanet(0, OWNER);
    seedPlanet(1, OTHER);
    seedPlanet(2, OWNER);
    const list = await cc.listAllPlanets();
    expect(list).toHaveLength(3);
    expect(list.map((p) => p.id).sort()).toEqual([0, 1, 2]);
  });

  it('attaches owner address to each planet', async () => {
    seedPlanet(0, OWNER);
    seedPlanet(1, OTHER);
    const list = await cc.listAllPlanets();
    const byId = new Map(list.map((p) => [p.id, p.owner]));
    expect(byId.get(0)).toBe(OWNER);
    expect(byId.get(1)).toBe(OTHER);
  });
});

describe('listOwnedPlanets (enumerable-backed)', () => {
  it('returns empty when balance is 0', async () => {
    expect(await cc.listOwnedPlanets(OWNER)).toEqual([]);
  });

  it('returns only planets owned by the address via get_owner_token_id', async () => {
    seedPlanet(0, OWNER, 0, 0);
    seedPlanet(1, OTHER, 5, 5);
    seedPlanet(2, OWNER, 10, 10);
    const list = await cc.listOwnedPlanets(OWNER);
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.id).sort()).toEqual([0, 2]);
  });
});

describe('getPlanet', () => {
  it('returns null for an unknown id rather than throwing', async () => {
    const p = await cc.getPlanet(999);
    expect(p).toBeNull();
  });

  it('hydrates a known planet with dna + vitals + coords', async () => {
    seedPlanet(7, OWNER, 3, -4, 0xAB);
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
    status: 'connected', kind: 'classic', address: OWNER, label: 'Freighter',
  } as const;
  const passkeyState = {
    status: 'connected', kind: 'passkey', address: 'CXYZSMARTACCOUNTCONTRACTID', label: 'Passkey',
  } as const;

  it('refuses when no wallet is connected', async () => {
    await expect(cc.submitCare(0, 0, { status: 'idle' } as any)).rejects.toThrow(/connect a wallet/i);
  });

  it('routes classic wallets through tx.signAndSend (distinct hash)', async () => {
    expect(await cc.submitCare(0, 0, classicState as any)).toBe('TXHASH_CLASSIC');
  });

  it('routes passkey wallets through SmartAccountKit.signAndSubmit', async () => {
    expect(await cc.submitCare(0, 0, passkeyState as any)).toBe('TXHASH_PASSKEY');
    const wc = await import('./wallet-context');
    expect(wc.getPasskeyKit).toHaveBeenCalled();
  });
});

describe('submitConjoin (commit-reveal)', () => {
  it('refuses when not connected', async () => {
    await expect(cc.submitConjoin(0, 1, { status: 'idle' } as any)).rejects.toThrow(/connect a wallet/i);
  });

  it('orchestrates commit → wait → reveal and returns the reveal tx hash', async () => {
    const phases: string[] = [];
    const wallet = { status: 'connected', kind: 'classic', address: OWNER, label: 'Freighter' } as any;
    const hash = await cc.submitConjoin(0, 1, wallet, (p) => phases.push(p.phase));
    expect(hash).toBe('TXHASH_REVEAL');
    // committing → waiting → revealing → done
    expect(phases[0]).toBe('committing');
    expect(phases).toContain('revealing');
    expect(phases.at(-1)).toBe('done');
  });

  it('exposes submitCommitConjoin / submitRevealConjoin as separate halves', async () => {
    const wallet = { status: 'connected', kind: 'classic', address: OWNER, label: 'Freighter' } as any;
    const id = await cc.submitCommitConjoin(0, 1, 42n, wallet);
    expect(typeof id).toBe('number');
    const hash = await cc.submitRevealConjoin(id, wallet);
    expect(hash).toBe('TXHASH_REVEAL');
  });
});

describe('on-chain population + civ_tier reads', () => {
  it('getPlanet pulls population + civTier alongside the existing views', async () => {
    seedPlanet(0, OWNER, 0, 0, 0x11, /* pop */ 4, /* civ */ 3);
    const p = await cc.getPlanet(0);
    expect(p).not.toBeNull();
    expect(p!.population).toBe(4);
    expect(p!.civTier).toBe(3);
  });

  it('getPlanet falls back to undefined when the contract calls error', async () => {
    seedPlanet(0, OWNER);
    const client = (await import('./planet-bindings/src/index')).Client;
    const origPop = (client.prototype as any).population_of;
    const origCiv = (client.prototype as any).civ_tier_of;
    (client.prototype as any).population_of = async () => { throw new Error('rpc down'); };
    (client.prototype as any).civ_tier_of = async () => { throw new Error('rpc down'); };
    try {
      const p = await cc.getPlanet(0);
      expect(p).not.toBeNull();
      // dna/vitals/coords still present:
      expect(p!.dna.length).toBe(32);
      expect(p!.coords).toEqual({ x: 0, y: 0 });
      // pop/civ silently undefined when contract calls explode:
      expect(p!.population).toBeUndefined();
      expect(p!.civTier).toBeUndefined();
    } finally {
      (client.prototype as any).population_of = origPop;
      (client.prototype as any).civ_tier_of = origCiv;
    }
  });

  it('populationOf + civTierOf standalone readers unwrap u32 Result::Ok', async () => {
    seedPlanet(7, OWNER, 0, 0, 0x11, 2, 4);
    expect(await cc.populationOf(7)).toBe(2);
    expect(await cc.civTierOf(7)).toBe(4);
  });
});

describe('unwrapResult shape handling (audit High #5)', () => {
  it('throws on Result::Err shape rather than silently returning undefined', async () => {
    // Override dna_of to return Err
    const errResult = { tag: 'Err' as const, values: [{ message: 'UnknownPlanet' }] };
    const client = (await import('./planet-bindings/src/index')).Client;
    const origDnaOf = (client.prototype as any).dna_of;
    (client.prototype as any).dna_of = async () => ({ result: errResult });
    try {
      // seedPlanet so vitals/coords still work then poison dna_of:
      seedPlanet(0, OWNER);
      const p = await cc.getPlanet(0);
      // getPlanet catches and returns null for any throw, including
      // unwrapResult's new Err handling.
      expect(p).toBeNull();
    } finally {
      (client.prototype as any).dna_of = origDnaOf;
    }
  });
});
