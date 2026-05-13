// Tiny deterministic RNG seeded by an arbitrary byte buffer. We don't need
// crypto quality — only reproducibility from the same DNA.

export type Rng = {
  next: () => number;       // 0..1
  int: (n: number) => number; // 0..n-1
  pick: <T>(arr: readonly T[]) => T;
  chance: (p: number) => boolean;
};

export function seededRng(seed: Uint8Array): Rng {
  // FNV-1a 32 over the seed bytes.
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed[i];
    h = Math.imul(h, 0x01000193);
  }
  let s = h >>> 0;

  function step(): number {
    // mulberry32
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    next: step,
    int: (n: number) => Math.floor(step() * n),
    pick: <T>(arr: readonly T[]) => arr[Math.floor(step() * arr.length)],
    chance: (p: number) => step() < p,
  };
}
