# Contract audit — D/R1/R2 dominance allele system

Commit: `9894698 feat(contract): D/R1/R2 dominance allele system`
Branch: `origin/dominance`
Scope: changes in `contracts/planet/src/dna.rs`, `contracts/planet/src/lib.rs`, `contracts/planet/src/test.rs`.
Build: `stellar contract build` succeeded; WASM = **40,058 bytes** (under 50 KB gate).
Tests: 36/36 pass.

---

## Critical
*(none)*

## High
*(none)*

## Medium

### M1. Same-round siblings have functionally identical latent trait alleles
**File:** `contracts/planet/src/dna.rs:82-91` (`latent_from_seed`)

If the admin calls `commit_genesis` twice with the same `observed_round`, both commitments resolve to the same `target_round`, which fetches the same drand seed. `latent_from_seed` derives R1 (bytes 0..8) and R2 (bytes 8..16) of the latent purely from `seed[8..24]`. `mix_token_id_into_latent` then stirs token_id into bytes 16..20 — which is the **reserved** region, **not** the R1/R2 trait bytes. Result: two same-round siblings carry **byte-identical R1 and R2 trait alleles** in their latent. Their descendants will pull from the same hidden pool, so a "diverse breeding stock" goal is undermined whenever the admin reuses an observed_round.

Same property exists for visible DNA (bytes 0..7 trait genes are also unstirred), but at least the visible salt bytes 18..21 differ. For latent the situation is worse because nothing about the breeding-relevant bytes differentiates same-round siblings.

**Suggested fix (minimal):**
```rust
// In latent_from_seed, after the for-loop, stir token_id into trait bytes too:
for i in 0..TRAIT_SLOTS {
    let id = token_id.to_le_bytes();
    out[LATENT_R1_OFFSET + i] ^= id[i & 3];
    out[LATENT_R2_OFFSET + i] ^= id[(i + 1) & 3];
}
```
Or rotate the seed-slice offsets by `token_id % 8` so two siblings on the same round end up reading different slices.

Also update the doc-comment on `latent_from_seed`: "siblings born on the same round get distinct latents" is currently false for the *trait* bytes that participate in dominance.

### M2. Mutation rate is ~3.1%, not the documented ~2%
**File:** `contracts/planet/src/dna.rs:170-173`

The doc-comment for `crossover_with_latent` states "A ~2% mutation chance XORs a random byte into the child's D" (line 121). The implementation `(rr[16+i] & 0x3F) < 2` triggers when the low 6 bits are 0 or 1, i.e. `2 / 64 = 3.125%` per trait — 50% above target. Across 8 trait slots, expected mutated traits per conjoin is `8 × 0.03125 = 0.25` vs. the documented `8 × 0.02 = 0.16`. Small but enough to skew long-run trait drift.

**Suggested fix:** change the threshold to match the doc, or update the doc to match the threshold.
```rust
// For ~1.6% (1/64):
if (rr[16 + i] & 0x3F) < 1 { ... }
// For ~3.1% (current): update doc-comment on line 121 to "~3%".
```

### M3. Legacy parents inject 0x00 trait bytes into 30% of contributions
**File:** `contracts/planet/src/lib.rs:345-354`, `contracts/planet/src/dna.rs:214-222`

`read_latent` returns 32 zero bytes for the 4 legacy testnet planets (`CAN2QTAW…PCPJ` cohort). In `sample_allele`, a legacy parent contributes `D` 70% of the time (good) and `0x00` 30% of the time (one of R1=0 or R2=0). 0x00 is a *valid* trait byte (class 0, surface 0, etc.), so children of legacy parents will randomly get "class 0 / surface 0" traits 15% of the time per slot per legacy parent. Not a security issue, but a **gameplay correctness edge case** — a child can spontaneously acquire a 0x00 trait its parents don't visibly have.

The audit prompt asked whether legacy descendants "carry usable recessives": yes — if only ONE parent is legacy, the child's R1 is 70% the legacy parent's D and 30% zero, and the child's R2 pool draws 2/4 from the legacy parent (so half the time R2 = 0) and 2/4 from the new parent (so half the time R2 = a real allele). So **new recessives can flow into the lineage**, but every legacy ancestor also injects zeros at meaningful rates.

**Suggested fix (minor, optional):** when reading a legacy parent's latent, fall back to "treat R1 = R2 = D" instead of zeros, so a legacy parent contributes its visible D 100% of the time:
```rust
// In reveal_conjoin, replace the read_latent calls with:
let latent_a = read_latent_or_visible(e, parent_a, &dna_a);
let latent_b = read_latent_or_visible(e, parent_b, &dna_b);
// where read_latent_or_visible returns a synthesized latent whose R1[i] = R2[i] = dna[i]
// when no Latent storage exists.
```
This keeps the dominance roll well-formed for legacy ancestors and stops the "spontaneous 0x00 trait" surprise.

### M4. Documented allele weights are 70/22/8 but actual weights are 69.92/21.88/8.20
**File:** `contracts/planet/src/dna.rs:212-222`

Thresholds 179 and 235 give:
- P(D) = 179/256 = 69.92%
- P(R1) = 56/256 = 21.88%
- P(R2) = 21/256 = 8.20%

Within rounding tolerance, but the doc-comment claims "70 / 22 / 8". For mathematically exact 70/22/8 the thresholds would be 179.2 / 235.52 (not integers). Recommend either:
- updating the doc-comment to read "70.0 / 21.9 / 8.2 (thresholds 179 / 235)" so it doesn't mislead future readers, or
- pick thresholds 179/236 for 69.92/22.27/7.81 if you prefer "≥22%".

Low severity-wise but flagged as Medium because the audit prompt explicitly asked to verify the math.

## Low

### L1. `rr[24]` is reused across R2 pool selection (slot 0) and rarity bit
**File:** `contracts/planet/src/dna.rs:166, 195`

For trait slot `i=0`, the R2 pool index reads `(rr[24] & 0x03)`. Two lines later, rarity reads `(rr[24] & 0x01)`. Bit 0 of `rr[24]` is consumed by **both**: it determines (a) whether the i=0 R2 picks from a recessive vs. a non-recessive slot in the pool, and (b) whether rarity gets the +1 bump. The two effects are weakly correlated, not statistically significant in practice, but it's an unnecessary entanglement.

**Suggested fix:** use a different byte for rarity, e.g. `rr[26]` (currently unused after `rr[25]` for affinity).
```rust
let rarity = (aa[IDX_AFFINITY_RARITY] & 0x0F)
    .max(bb[IDX_AFFINITY_RARITY] & 0x0F)
    .saturating_add(rr[26] & 0x01);
```

### L2. Mutation byte overlaps with parent-B allele selector
**File:** `contracts/planet/src/dna.rs:147, 172`

`rr[8+i]` is used as parent B's allele-selection roll (line 147) **and** as the mutation XOR value (line 172). The mutation gate itself uses `rr[16+i]` (independent), so whether mutation triggers is unbiased — but **what byte gets XORed** is biased toward the high range when parent B contributed R2 (since that requires `rr[8+i] >= 235`) and toward the low range when parent B contributed D (since that requires `rr[8+i] < 179`). Mutation already only happens ~3% of the time so the practical impact is tiny.

**Suggested fix:** mutate with a byte from a different region, e.g. `rr[24 + i % 8] ^ rr[16 + i]` or just `rr[(16+i+1) % 32]`. Cheaper option: leave as-is and add a comment acknowledging the correlation.

### L3. `latent_from_seed` doc-comment claims "independent from visible trait bytes" — partially false
**File:** `contracts/planet/src/dna.rs:78-81`

R1 byte 0 reads `s[8]`. In `from_seed` (visible DNA), `out[IDX_AFFINITY_RARITY] = s[8]`, so the **R1 class allele equals the publicly visible affinity_rarity byte**. R2 byte 4 reads `s[20]`, which `from_seed` copies into `out[IDX_RESERVED+2] = s[20]` (visible reserved/salt). So R1/R2 trait bytes are correlated with visible non-trait bytes.

Not a security issue — drand seeds are public so the latent isn't "secret" anyway, and `latent_of` is a public view. But the doc-comment's "independent" claim is misleading.

**Suggested fix:** rewrite the comment to: "Latent slices use seed bytes 8..16 and 16..24, independent from the *visible trait bytes* 0..7 but overlapping with visible affinity_rarity (s[8]), generation slot, and reserved salt. This is harmless because both visible DNA and latent are derived from the same drand-published seed."

### L4. Misleading test mock-auth fn_name "mint_genesis"
**File:** `contracts/planet/src/test.rs:362, 624`

The legacy method `mint_genesis` no longer exists (replaced by `commit_genesis` + `reveal_genesis`). Two tests still use `fn_name: "mint_genesis"` in their `MockAuth` arg. The tests still pass because the actual call (`try_commit_genesis`) fails the auth check regardless, but the mock arg is dead/wrong code. Update for clarity.

```rust
fn_name: "commit_genesis",
args: (bystander.clone(), 100u64, 0i32, 0i32).into_val(&f.env),
```

### L5. `genesis_writes_nonzero_latent` test asserts only R1 region, not R2
**File:** `contracts/planet/src/test.rs:636-649`

The test only asserts `latent[LATENT_R1_OFFSET + i] == 0xAB` for the 8 R1 trait bytes and `latent[LATENT_R2_OFFSET] == 0xAB` for just byte 0 of R2. It does not verify R2 bytes 1..7. Low-risk gap but the test name implies coverage of "nonzero latent" — strengthen to assert R2 bytes 1..7 as well.

## Informational

### I1. No `Latent` write happens on read paths — confirmed safe
**File:** `contracts/planet/src/lib.rs:441-456, 672-690`

`latent_of` is read-only and `extend_planet_ttl`'s conditional `has(&latent_key)` correctly avoids extending TTL for legacy planets. No path writes a latent without then extending its TTL (`reveal_genesis` at lines 237-244, `reveal_conjoin` at lines 358-365). Symmetrically, no path extends latent TTL without it existing. ✓

### I2. Transactions are atomic — no half-written child
**File:** `contracts/planet/src/lib.rs:340-365`

`reveal_conjoin` mints the child via `sequential_mint`, then writes DNA/Vitals/Coords (`write_planet`), then writes Latent, then writes vitals. If the latent write panicked, Soroban's atomic transaction model reverts the entire reveal including the mint. There is no path where a child has a DNA but no Latent. ✓

### I3. No grinding via latent independent of visible DNA
**File:** `contracts/planet/src/dna.rs:82-91`

Both `from_seed` and `latent_from_seed` derive from the same drand seed at `target_round`. The commit-reveal scheme pins `target_round = observed_round + LOOKAHEAD_ROUNDS` and forces a delay so the seed must have been generated *after* commit. Caller cannot grind the latent independently of the visible DNA. ✓

### I4. `mix_token_id_into_latent` does not affect trait alleles
**File:** `contracts/planet/src/dna.rs:237-244`

XOR is applied to bytes 16..20 (latent reserved region). R1 (bytes 0..8) and R2 (bytes 8..16) are untouched by the stir. Trait alleles are unaffected by token_id. ✓
(But see M1: this *also* means the stir does nothing for sibling-allele-uniqueness for the alleles that matter.)

### I5. No `dominance_emerged` event when a recessive expresses
**File:** `contracts/planet/src/lib.rs:382-396`

When a child's D-allele equals a parent's R1 or R2 (i.e. an inherited recessive surfaced), no dedicated event fires. Indexers would have to recompute by comparing parent latents to child visible DNA. Useful UX feature ("your planet inherited a rare gene from grandparent X!") but currently a gap. Not a bug.

Suggested future work — emit alongside `Born`:
```rust
// inside reveal_conjoin, after computing child_dna:
for i in 0..dna::TRAIT_SLOTS {
    let cd = child_dna.to_array()[i];
    let a_d = dna_a.to_array()[i];
    let b_d = dna_b.to_array()[i];
    let a_l = latent_a.to_array();
    let b_l = latent_b.to_array();
    if cd != a_d && cd != b_d
        && (cd == a_l[i] || cd == a_l[8+i] || cd == b_l[i] || cd == b_l[8+i]) {
        RecessiveEmerged { child: child_id, slot: i as u32, allele: cd }.publish(e);
    }
}
```
~600 bytes WASM cost estimate; under the 50 KB gate.

### I6. Frontend bindings need regeneration to expose `latent_of`
Out-of-scope per prompt, but flagged: `latent_of` is added to the contract surface but TypeScript bindings have not been regenerated yet. Frontend cannot currently fetch latents until bindings are rebuilt.

### I7. Legacy planet "upgrade path" is absent (by design, noted)
**File:** `contracts/planet/src/lib.rs:235-244`

There is no admin function to retroactively assign latents to the 4 legacy testnet planets. This is intentional per the doc-comment ("currently impossible") but means those 4 planets, and any of their descendants up to depth N where 50%^N of recessive slots are still zeros, will permanently underperform in the dominance system. Acceptable for testnet given small N, but for mainnet you may want a one-shot admin `seed_legacy_latent(id, latent)` callable only while a `legacy_window_open` flag is true.

### I8. Genesis `target_round` collision possible if admin reuses `observed_round`
**File:** `contracts/planet/src/lib.rs:194-215`

`commit_genesis` accepts any `observed_round` from the admin. If admin commits twice with the same value, both commitments target the same `target_round` and resolve to the same drand seed. Together with M1, this means same-round siblings have identical R1+R2 trait alleles. The admin should *not* do this, and in practice they bump observed_round per call, but the contract does not enforce monotonicity.

Suggested defense (cheap): track `LastObservedGenesisRound` in instance storage and require `observed_round > last`. Or just rely on operational discipline.

---

## Summary table

| Severity      | Count |
|---------------|-------|
| Critical      | 0     |
| High          | 0     |
| Medium        | 4     |
| Low           | 5     |
| Informational | 8     |
| **Total**     | **17**|

## Recommendation

**Safe to deploy to mainnet with caveats**, *provided* the following are addressed first:

1. **M1 (must-fix before mainnet)** — stir token_id into the latent trait bytes (or rotate seed-slice offsets per token_id) so same-round siblings have distinct R1/R2 alleles. Currently siblings minted at the same `target_round` are clones in the dominance pool.
2. **M2 or doc-fix** — reconcile the 2% vs. 3.1% mutation discrepancy. Either update the threshold or the comment; pick one and stick with it.
3. **M3 (consider)** — decide whether legacy parents should contribute "D-only" (synthesized latent of D=R1=R2=visible_byte) or current "D 70% / zero 30%". Current behavior leaks 0x00 trait bytes into descendant lineages at meaningful rates. Recommend the synthesized approach.
4. **I7 (recommended)** — add a one-shot admin migration to seed latents for the 4 legacy testnet planets *before* declaring the system "production". Even better, do this as part of the mainnet deploy and burn the migration function afterward.

Lows are stylistic / minor statistical noise and can ship without remediation. Informational items are observations and future-work candidates.

No critical or high-severity findings: no funds at risk, no replay vector, no auth bypass, no broken invariant. The commit-reveal anti-grinding protection extends correctly to the latent, the storage TTL is consistent, and the atomic-transaction guarantee prevents half-written children. WASM at 40,058 bytes leaves comfortable headroom under the 50 KB CI gate.
