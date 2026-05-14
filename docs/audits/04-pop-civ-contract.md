# Pop + civ_tier Audit — commit `0caf99b`

Scope: `contracts/planet/src/{dna,lib,stats,test}.rs`.
Build: `stellar contract build` produced `planet.wasm` at **44,471 bytes (43.4 KB)** — under the 50 KB gate (agent self-reported 44.5 KB; minor rounding/unit discrepancy, not a regression).
Validation: `cargo fmt -- --check` clean, `cargo clippy --workspace -- -D warnings` clean, `cargo test --workspace` → **47 passed / 0 failed**.

---

## Critical

*None.*

## High

*None.*

## Medium

### M-1. Entropy reuse between population gene and trait slot 7 is stronger than the comment admits
`contracts/planet/src/dna.rs:222-254`

The pop crossover reuses `rr[7]`, `rr[15]`, `rr[23]`, `rr[31]` and the in-line comment says this is "a slight reduction in independent entropy". In practice the overlap is more structural:

- `rr[7]` is parent A's `sample_allele` roll for trait slot 7 **and** for population — so when A's trait 7 picks D, A's population also picks D (same threshold lookup against the same byte).
- `rr[15]` same coupling for parent B's trait-7 / population.
- `rr[23]` — for trait 7 (`i=7`, `rr[16 + 7] = rr[23]`) the trait loop already uses high bit as swap and low 6 as mutation gate. The pop block uses the **same bits the same way**. So the pop swap bit is identical to trait 7's swap bit, and the pop mutation fires iff the trait-7 mutation also fires.
- `rr[31]` — trait 7's R2-pool index is `rr[24 + (7 % 8)] = rr[31] & 0x03`. The pop block uses the same `rr[31] & 0x03`. So the pop R2-pool slot equals the trait-7 R2-pool slot for every conjoin.

Why it matters: an observer who knows trait-slot-7's child outcome can fully predict the structural choices (which parent contributed, swap, mutation, R2 source) for the population gene. The alleles themselves come from different bytes (so values still differ), but the *correlation between decisions* is 1.0. For a no-stakes cosmetic gene this is benign; for a future single-trio gene parked at bytes 19/20/21 that reuses the same entropy convention by analogy, this footgun will grow. Either dedicate fresh entropy bytes now or document the coupling honestly.

Suggested fix:
```rust
// Use entropy untouched by the trait loop. rr consumes [0..8]=parent A samples,
// [8..16]=parent B samples, [16..24]=swap/mut, [24..32]=R2 pool indices.
// All 32 bytes are claimed. Drag in fresh entropy via a hash, or commit to a
// reduced-correlation model and update the comment to say so.
let contrib_a = sample_allele(al[base], al[base+1], al[base+2], rr[2].rotate_left(3));
// ... etc.
```
At minimum, change the source comment from "slight reduction in entropy" to "shares 4 entropy bytes 1:1 with trait slot 7's decisions".

### M-2. Legacy parents inject pop = 0 (Humanoid) into every conjoin
`contracts/planet/src/lib.rs:885-896`

`read_latent_for_breeding` synthesizes a latent for pre-dominance parents by copying visible D into R1/R2 for trait slots 0..7. **Bytes 16..32 are left zero.** So when a legacy parent conjoins:

- `al[LATENT_POP_D..=LATENT_POP_R2] = [0, 0, 0]`.
- `sample_allele(0, 0, 0, roll) = 0` for any roll.
- The legacy parent contributes pop allele 0 with probability 1.0.

If both parents are legacy, the child is always Humanoid. If one parent is legacy, the swap_bit gives the child a 50% chance of being forced to pop 0. This mirrors the M3-style issue that the audit fixed for trait slots. The agent's task description anticipated this ("That's the same M3-style 'legacy zero injection' behavior we accepted for traits; flag if it's worth synthesizing R1=R2=D for population too"). Recommendation: extend the synthesis to also seed pop alleles from a visible-DNA byte so legacy parents pass on something stable.

Suggested fix (drop into `read_latent_for_breeding` before the return):
```rust
// Pop gene fallback: derive a deterministic non-zero allele from visible DNA
// so legacy parents don't inject Humanoid (pop=0) into every descendant.
let pop_seed = d[dna::IDX_PALETTE_HUE]; // any stable visible byte
out[dna::LATENT_POP_D]  = pop_seed;
out[dna::LATENT_POP_R1] = pop_seed;
out[dna::LATENT_POP_R2] = pop_seed;
```
Without a fix, the legacy-parent population-loss bias should be documented and a test should pin the current behavior.

### M-3. Conjoin demotes child to tier 0 when a legacy parent participates
`contracts/planet/src/lib.rs:438-443`

`read_civ_tier` returns 0 for parents that predate the civ_tier feature. `child_tier = tier_a.min(tier_b)`. So any conjoin with a legacy parent always seeds the child at tier 0, even if the non-legacy parent is at tier 4. This is the natural fallthrough of "absent = 0" but is not pinned by a test and may surprise players.

Two reasonable resolutions:
1. Document the behavior and pin it with a test (`min(legacy=0, tier_4) == 0` → child = 0).
2. If you'd prefer legacy parents not penalize the lineage, change the seed rule to `max(tier_a, tier_b)` when one parent is legacy, or skip the absent side entirely.

Suggested test (whichever semantics you keep):
```rust
#[test]
fn conjoin_child_tier_with_legacy_parent_is_zero() {
    // strip CivTier(parent_a) before conjoin; assert civ_tier_of(child) == 0
}
```

---

## Low

### L-1. Pop modulo by 6 leaves a small uniformity bias
`contracts/planet/src/dna.rs:53`

`latent[16] % 6` over 256 byte values: pops 0..3 each get 43 byte values, pops 4..5 each get 42. Bias is ~0.6 percentage points per bucket — well below user-perceptible — but if you later add reward economics keyed on population, document it. No fix needed for cosmetic use today.

### L-2. `mix_token_id_into_latent` is effectively dead code for realistic token IDs
`contracts/planet/src/dna.rs:317-320`

The function now XORs only `id[3]` (the high byte of token_id LE) into byte 19. For all token IDs below 2^24 (16,777,216) `id[3] = 0`, so the call is a no-op. The function still exists, is still called from two sites, and adds bytecode for no benefit at current scale. Either inline the byte-19 stir into the two call sites and delete the helper, or document that it kicks in only when supply exceeds 16M. Bytecode cost is small but it's a misleading name.

### L-3. `read_civ_tier` narrows u32→u8 without a clamp
`contracts/planet/src/lib.rs:901-908`

`raw as u8` truncates silently if storage somehow holds a value > 255. Today all write sites cap at `target_u8 as u32` so this is sound, but if a future path ever wrote a wider value (e.g., a debug `set` from a migration), it'd wrap silently. Cost of a `min(raw, 4) as u8` is one instruction; pinpoints any future drift.

```rust
fn read_civ_tier(e: &Env, id: u32) -> u8 {
    let raw: u32 = e.storage().persistent().get(&DataKey::CivTier(id)).unwrap_or(0);
    core::cmp::min(raw, 4) as u8
}
```

### L-4. Commit message overstates mutation rate
The commit body says "~3% per the existing rate". The code (both trait loop and pop block) uses `(rr & 0x3F) < 1`, i.e. 1/64 ≈ 1.56%. Source comment at `dna.rs:210-211` is correct ("~1.56% chance (1/64)"). Update the commit message / PR description so reviewers don't get the wrong impression.

### L-5. Comment in `reveal_conjoin` says civ_tier "doesn't gift progress" but `min(a,b)` does
`contracts/planet/src/lib.rs:434-437`

> "A Spacefaring parent doesn't gift the child anything; care progress is earned per-planet."

But `min(tier_a, tier_b)` means two parents both at tier 4 produce a tier-4 child — i.e. a child that starts Spacefaring without any care. The comment scans as "child always starts at 0" which is not what the code does. Either:
- Reword: "Child starts at the lower of the two parents' tiers — a Spacefaring parent paired with a Primitive partner can't boost the child past Primitive."
- Or change the rule to `0` if you really meant no inheritance.

### L-6. `population_propagates_through_conjoin` test only pins the no-mutation no-swap path
`contracts/planet/src/test.rs:917-967`

The test sets `rb[7] = rb[15] = 100, swap_bit = 0, mutation gate failing, R2 pool index 0`. It asserts `child_pop_d == 0xAA`. That's correct but it only exercises the "both parents picked D, no swap, no mutation" branch. The dominance roll, swap, R2 pool, and mutation paths are unguarded by this test. Consider parameterizing with a few rand vectors covering swap_bit=1, R1 picks (roll in 179..235), R2 picks (roll ≥ 235), and the mutation branch.

---

## Informational

### I-1. Same-round genesis sibling pop differentiation
`contracts/planet/src/dna.rs:121-123`

`latent[16] = s[24] ^ id[0]`. For two siblings minted on the same drand round, `s[24]` is identical; their pop D bytes differ only in the low byte of token_id. For `token_id_a = 0, token_id_b = 256`, both have `id[0] = 0`, so `latent[16]` is identical and the expressed population matches. R1/R2 still differ (`id[1]` changes), so the gene pool isn't identical, but the **expressed** population type is. Realistic for a Soroban deployment? Sub-256 same-round mints is the realistic regime, so this is informational only. If you ever expect >256 mints in one round, fold all four `id` bytes into the pop trio.

### I-2. M1 fix coverage confirmed for pop bytes
The audit M1 stir at `latent_from_seed` (lines 109-115) only covers bytes 0..15 (trait slots). Bytes 16..18 get their own dedicated stir at lines 121-123 (`s[24] ^ id[0]` etc.) so same-round genesis siblings get distinct pop alleles — M1's intent is preserved for population. Confirmed by `genesis_writes_population_byte` plus the test fixture covering token_id 0.

### I-3. `civ_signal` class-table coverage
All 16 class values (0..15) hit a branch:
- 2/6/10 → biomass-thriving
- 3/9/11 → temperature-thriving
- 7/13 → low-hydration-thriving
- 8/14 → inverted biomass + low temp
- 1/4/12/15 → spirit-thriving
- 0/5 (Rocky, Desert) + default → balanced 5-way

`class_of` masks `& 0x0F` so the universe is exactly 0..=15. All branches sum to 100% so `w_pct(255, 100) = 255` is the max per-branch signal — every class can reach tier 4 from its thriving profile. F15 closes.

### I-4. Genesis pop test seed sanity
`genesis_writes_population_byte` uses seed `[0xAA; 32]`, token_id 0. `s[24] = 0xAA, id[0] = 0 → latent[16] = 0xAA`. `0xAA % 6 = 170 % 6 = 2`. Test assertion correct.

### I-5. `population_of_latent` returns u8 but the event publishes u32
The intermediate cast `as u32` (lib.rs:294, 454, 598) is required by `#[contractevent]` macro constraints. No data loss; just confirming the u8 → u32 widening is consistent across all three sites and matches the event schema.

### I-6. Civ-tier ratchet computed on post-care vitals
`care` evaluates `civ_signal(&updated, class)` *after* `apply_care`. The ratchet sees the immediate effect of the action — no one-turn lag. Confirmed at lib.rs:516-529.

### I-7. `CivTier` slot extended on every touch
`extend_planet_ttl` (lib.rs:836-841) extends `CivTier(id)` with a `has()` guard for legacy planets. Verified callers cover the touch surface: `care` (line 538), `migrate` (line 554), `dna_of` (line 565), `latent_of` (line 576), `vitals_of` (line 586), `population_of` (line 597), `civ_tier_of` (line 609), `coords_of` (line 616), `extend` (line 724), and `write_planet` (line 814). Good coverage.

### I-8. View `civ_tier_of` does not project demotion
Per spec ("return stored tier directly, no projection demotion"), `civ_tier_of` reads the stored u32 and returns it. No write side-effect from reads. The agent did not regress this into a view-as-write pattern. Confirmed lib.rs:606-611.

### I-9. `CivTierChanged` event fires only on actual ratchet
The event publish is inside the `if target > current` branch. No event on no-op care. Good.

### I-10. 47/47 tests pass, no flake detected
`cargo test --workspace` ran cleanly in a single invocation. The new tests pin: genesis pop byte (`0xAA → 2`), pop crossover D-branch, civ_tier=0 at genesis, ratchet to tier 4 on Bloom + Tend, class-aware Hollow inversion (decayed biomass → tier ≥ 3, peak biomass → tier < 4), legacy fallback, and unknown-planet error. Each test asserts a concrete pinned value; reverting the feature would fail the assertions, not just exercise dead paths.

### I-11. WASM size measured
`stellar contract build` → `target/wasm32v1-none/release/planet.wasm` = **44,471 bytes** (43.42 KB). Agent self-reported 44.5 KB; the small delta is either KiB-vs-KB or pre-strip vs post-strip. Either way, comfortably under the 50 KB gate.

### I-12. WASM ABI surface widens — testnet redeploy required
Two new public methods (`population_of`, `civ_tier_of`) and two new events (`PopulationExpressed`, `CivTierChanged`) — frontends that bind via SDK will need a redeploy + spec refresh. Agent's note that "testnet redeploy required to expose new views/events" is correct.

---

## Summary

| Severity      | Count |
| ------------- | ----- |
| Critical      | 0     |
| High          | 0     |
| Medium        | 3     |
| Low           | 6     |
| Informational | 12    |

**Recommendation: SAFE TO REDEPLOY TO TESTNET as-is.** The three Mediums are correctness/UX concerns worth tracking but none are exploitable, none corrupt storage, and none break the additive-storage invariant that protects legacy planets. M-1 (entropy correlation with trait slot 7) is a documentation honesty fix plus a future-proofing nudge — no behavioral change required for this redeploy. M-2 (legacy-parent pop=0 injection) and M-3 (legacy-parent civ_tier=0 demotion) are tied to the legacy parent population, which will shrink to zero as new planets dominate the corpus; address before mainnet but not blocking for testnet validation. All audit-pinned fixes from prior reviews (M1 sibling differentiation, M3 visible-D fallback, F9 sticky R2, view-as-write avoidance, TTL Critical #4) remain intact; none regressed. Cargo fmt / clippy / 47-test suite all green; WASM 43.4 KB / 50 KB.
