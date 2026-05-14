# Phase 2 SpentPair Audit — branch `worktree-agent-a985eba3fa450fd58`

Scope: 3 commits on top of `2d36904` —
  - `18bc79f` feat(contract): SpentPair registry + commit/reveal integration
  - `6dfcdf5` chore(web): regenerate bindings after PairAlreadySpent error
  - `c3d7a25` test: SpentPair behavior across commit/reveal/race paths

Spec: `docs/first-light.md` → "Spent pairs — one child per combination" section (on `feat/first-light-phase-1`, in PR #3). Phase 2 enforces the "one child per (parent_a, parent_b) pair, ever, across all keepers" invariant.

## CI gates (re-run independently)

| Gate | Result |
| --- | --- |
| `cargo fmt --all -- --check` | PASS |
| `cargo clippy --all-targets --workspace -- -D warnings` | PASS |
| `cargo test --workspace` | **54 passed / 0 failed** (6 new SpentPair tests included) |
| `stellar contract build --optimize` | PASS — `planet.wasm` = **41,196 B** (44 KB cap not approached) |
| `npx tsc --noEmit` (web) | PASS |
| `npm run test` (web / vitest) | **22 passed / 0 failed** |
| `npm run build` (web / next) | PASS |

All green. Dev's CI claims confirmed.

---

## Invariants verified

1. **Normalization is correct.** `normalize_pair(a, b)` returns `(min, max)` for every ordering of distinct `u32`s; the helper handles `a == b` sanely (returns `(a, a)`) but that case is unreachable in practice because `commit_conjoin` rejects `SameParent` before `is_pair_spent` is consulted, and `reveal_conjoin` only sees pairs that already passed that gate at commit time.
2. **Commit-time check returns `PairAlreadySpent`** (lib.rs:349) — typed, not generic.
3. **Reveal-time check returns the same `PairAlreadySpent`** (lib.rs:413) for indexer/UX consistency.
4. **`mark_pair_spent` is called AFTER `Enumerable::sequential_mint` + `write_planet` + latent write + vitals write + civ_tier write** (lib.rs:499). The only operations that follow it are infallible event publishes — there is no fallible call after `mark_pair_spent` that could partially abort a reveal mid-flight.
5. **Event shape matches spec.** `PairSpent { parent_a, parent_b, child_id }` with topic `"pair_spent"` (9 chars, under the `symbol_short!` 9-char limit). Test `pair_spent_event_emitted_on_first_conjoin` confirms the topic + data via `Event::to_xdr` round-trip.
6. **TTL is extended on write** — `mark_pair_spent` calls `extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO)` immediately after `set`. Snapshot diffs (e.g., `conjoin_writes_child_latent.1.json`) show `live_until: 518424` on the new SpentPair entry, matching the `TTL_EXTEND_TO = 518_400` constant.
7. **Same-parent self-conjoin is rejected upstream of SpentPair.** `commit_conjoin` checks `parent_a == parent_b` at lib.rs:342, *before* `is_pair_spent` at lib.rs:349.
8. **No other conjunction code paths exist.** Grep for `parent_a`/`parent_b`/`crossover_with_latent` shows `commit_conjoin`/`reveal_conjoin` are the only call sites; `claim_first_light` and `reveal_first_light` (Phase 1, separate branch) are single-keeper soulbound mints with no parents, no SpentPair interaction.
9. **Monotonic ID allocation** via `Enumerable::sequential_mint` (OpenZeppelin Stellar contracts) — burned planets cannot have their IDs reissued, so a SpentPair entry cannot accidentally "match" a future planet with the same id.
10. **Migrate / transfer / care do not touch SpentPair**, so ownership shuffling cannot invalidate the spent-pair record. The rule remains forever even across transfers (confirmed in lib.rs:593-604 for migrate; transfer is via the OZ NFT trait and only touches owner mapping).
11. **Cooldown prevents same-ledger double-commit on the same pair.** `check_cooldown` (lib.rs:970-985) rejects when `now.saturating_sub(last) < cooldown` and `commit_conjoin` writes `LastConjoin(parent_a)` *during* the first commit (lib.rs:376-381), so a second commit in the same ledger sees `now - last = 0 < DEFAULT_COOLDOWN(720)` → `OnCooldown`.
12. **Snapshot diffs are reasonable.** Spot-checked `conjoin_writes_child_latent.1.json` (SpentPair(0,1)=true added), `cooldown_of_view.1.json` (SpentPair added; cooldown_of_view does call `conjoin`), `legacy_parent_contributes_visible_population_not_zero.1.json` (also calls conjoin — entry expected). No SpentPair entry appears on snapshots for tests that never conjoin.

---

## High

### H-1. Error code 14 collides with Phase 1's `FirstLightAlreadyClaimed`
`contracts/planet/src/lib.rs:71`, `web/lib/planet-bindings/src/index.ts:55`

Phase 2 defines `Error::PairAlreadySpent = 14`. Phase 1 (open in PR #3 against `main`, on branch `feat/first-light-phase-1`) **already uses error code 14 for `FirstLightAlreadyClaimed`**, plus 15/16/17 for `SoulboundLocked`, `FirstLightCoordCollision`, and `Uninitialized` respectively.

Both branches will eventually merge to `main`. Whichever lands second will need to:
1. Renumber its new error code (most natural: Phase 2 → `PairAlreadySpent = 18`).
2. Update the `Errors` map in `web/lib/planet-bindings/src/index.ts` to match.
3. Update the test mock map in `web/lib/cosmocopia.test.ts` (which copies the bindings map).
4. Re-run `gen:bindings` post-deploy.

If the dev merges this branch unchanged on top of Phase 1, the Rust `#[contracterror]` macro will reject the duplicate discriminant at compile time — so this is **caught at build, not at runtime**. But it's a real source of merge friction and the dev's commit message claims "matches the next regen" — that claim is **only true if Phase 1 has not landed first**. The audit prompt explicitly flagged this check (`codes 14..=17 should be checked`), so it's the most important coordination issue.

**Recommendation.** Decide merge order with the Phase 1 PR owner. If Phase 1 merges first (likely, since it's the older PR), Phase 2 must renumber to `PairAlreadySpent = 18` and update both `index.ts` and `cosmocopia.test.ts`. Add a comment above the Error enum noting "if Phase 1's First Light errors landed first, this should be 18". Either way, the regen-after-deploy plan in the commit message is incomplete — it doesn't acknowledge the Phase 1 collision.

---

## Medium

### M-1. No test pins "mid-reveal abort does not leak a SpentPair entry"
`contracts/planet/src/test.rs` (missing test)

The audit prompt asked specifically: "Is there a test that proves `mark_pair_spent` is NOT called if the reveal aborts mid-flight (e.g., drand round not available)?" There isn't one. The defense is structural — `mark_pair_spent` is the **second-to-last** non-event statement in `reveal_conjoin`, so the only ways to abort after it are infallible (the four event publishes + the `RecessiveEmerged` loop, which is also infallible). But:

- `random_at` returning `Err(DrandUnavailable)` happens **before** `mark_pair_spent` (lib.rs:426 vs 499). Untested.
- `read_dna(e, parent_a)?` / `read_dna(e, parent_b)?` returning `UnknownPlanet` would abort before `mark_pair_spent`. Untested for the SpentPair side-effect (existing tests cover that the error fires, not that SpentPair stays clean).
- A future change that moves a fallible call below `mark_pair_spent` would silently break the invariant with no failing test to catch it.

This isn't a critical bug today — the structural argument holds — but it's a brittle property to leave un-pinned. The whole point of "one child per pair, ever" is that the side-effect is irreversible; a regression here would be especially painful to detect.

**Recommendation.** Add `reveal_conjoin_does_not_mark_spent_pair_if_drand_unavailable`: commit a conjoin, advance past the reveal delay but **before** the target drand round is registered in the mock, try to reveal, assert it errors with `DrandUnavailable`, then peek at `SpentPair(min, max)` via `env.as_contract` and assert it's still absent. Cheap test, pins a load-bearing invariant.

### M-2. Race-condition test is partially tautological — the actual race path is untested
`contracts/planet/src/test.rs:1278` (`reveal_conjoin_rejects_if_pair_spent_between_commit_and_reveal`)

The dev's own comment acknowledges this: "We can't easily commit twice (parents go on cooldown at commit), so we craft the race state directly: commit once, externally mark the pair spent, attempt to reveal." The test writes `SpentPair(min, max) = true` via `env.as_contract` and then asserts `reveal_conjoin` rejects with `PairAlreadySpent`. That's strictly weaker than "two real commits, first one reveals, second one's reveal rejects."

What the test proves: **the reveal-time check reads from `SpentPair` and returns `PairAlreadySpent` when the slot is set.** That's useful — without it a future refactor that drops the reveal-time check would still let the test pass against the commit-time check alone… wait, no, the test commits first, so the commit-time check has already passed; the test really does isolate the reveal-time check. OK, the test is more meaningful than I initially thought.

What it does NOT prove: that two real commit_conjoin calls on the same pair can actually race in practice. Cooldown blocks the same-owner case in the same ledger, but cross-owner cases (different owners each control one parent? — actually no, current `commit_conjoin` requires the same `to` to be one of the two parent owners, and cooldown on either parent blocks the other). The realistic race requires the cooldown window to have elapsed *between* the two commits, but the first commit's *reveal* is still pending. That is possible: commit at ledger N, second commit at ledger N+721 (cooldown=720), first reveal at N+722. The second commit would pass commit-time `is_pair_spent` (still false because first hasn't revealed), the first reveal fires `mark_pair_spent`, then second reveal needs the defense-in-depth check.

This is the actual production race. The dev's test is a fair *proxy* but doesn't drive the ledger forward to exercise it end-to-end. Given the LastConjoin is set at commit time, a stronger test would be:

```
commit (A,B)               // ledger N, LastConjoin(A)=N, LastConjoin(B)=N
advance ledger             // to N + 721 (past cooldown)
commit (A,B) again         // ledger N+721; commit-time is_pair_spent? false yet
advance ledger             // to N + 730 (past reveal delay for first)
reveal first commitment    // marks SpentPair(A,B)
reveal second commitment   // defense-in-depth must reject
```

The dev's "we can't easily commit twice" comment is incorrect — you absolutely can, you just have to advance the ledger past the cooldown between commits. The test as written still pins the SpentPair-driven reveal check, but the real-world race path is unexercised.

**Recommendation.** Replace or augment the test with the two-real-commits sequence above. This is the canonical case the defense-in-depth code is meant to handle; pinning it end-to-end is worth ~20 LOC.

### M-3. SpentPair entries have no ongoing TTL extension — "rule is forever" is conditional on TTL not lapsing
`contracts/planet/src/lib.rs:1015-1023` (`mark_pair_spent`)

The doc-comment on `DataKey::SpentPair` says "the rule is forever." The dev extends TTL **once on write** to `TTL_EXTEND_TO = 518_400 ledgers ≈ 30 days`. After that, the entry will be archived unless something refreshes it. Other persistent storage keys in this contract that should persist indefinitely (`Dna`, `Vitals`, `Coords`, `Latent`, `CivTier`) get refreshed in `care`, `migrate`, `transfer`, and *every view function* — so an actively-played planet stays alive. SpentPair has **no analogous refresh path**.

The realistic scenario: a pair (A, B) conjoins on day 0. The SpentPair(A, B) slot lives until day 30. The child of (A, B) keeps getting `care`'d and is alive forever. The parents A and B might be evicted (legacy planets), or kept alive by their owners. But the **SpentPair entry itself** is never touched again — no entrypoint reads it for any reason other than a new `commit_conjoin(A, B)` attempt, which is exactly what's supposed to never happen.

After ~30 days with no activity on that specific pair, `SpentPair(A, B)` enters the archived state. Soroban requires a `RestoreFootprint` op to bring it back (and a separate fee), but `is_pair_spent` uses `e.storage().persistent().has(&key)` — and on archived state, **`has` returns `false`** (an archived entry is not "in" the active set). So the rule silently lapses: `commit_conjoin(A, B)` at day 31+ will pass `is_pair_spent` and proceed to mint a second child for the same pair.

This is the **most consequential finding** in the audit. The "rule is forever" invariant is not actually forever; it's "forever, conditional on someone re-triggering the pair within 30 days, which won't happen because the whole point of the rule is that nobody can." Either:

- (a) Off-chain indexers must keep `extend` calls firing on stale SpentPair entries (out-of-band TTL extension, fragile, costs gas, requires running infrastructure).
- (b) The entries need a much longer initial TTL (Soroban allows up to ~6 months on persistent storage; not actually "forever").
- (c) The rule is enforced by an off-chain indexer-supplied check inside `commit_conjoin` (impossible — the contract is the source of truth).
- (d) Accept that the rule lapses after 30 days of pair-inactivity, and update the spec to say so. This significantly weakens the design — sybil grinders can simply wait 30 days for a juicy pair to "expire" off the registry, then reconjoin.

I'd flag this as **High severity** but the spec doc lives on the other branch and I can't directly confirm whether the design owner has thought about this. Provisionally classifying as **Medium** since (a) the immediate test suite green-lights the code, (b) the failure mode is dormant for 30 days, and (c) the fix is probably "add SpentPair to the public `extend(id)` flow or a dedicated `extend_pair(a, b)` keepalive entrypoint."

**Recommendation.** Either add an `extend_pair(a, b)` public entrypoint that refreshes the SpentPair TTL (so off-chain bots / motivated users can keep entries alive), OR document this in the spec and accept the 30-day lapse as a known limitation. The current code+doc combination silently lies about "forever."

---

## Low

### L-1. `mark_pair_spent` re-publishes the `PairSpent` event on idempotent re-marks
`contracts/planet/src/lib.rs:1015-1023`

The function's doc-comment says "Idempotent: re-marking the same pair just refreshes the TTL." That's true for the **storage** side — `set(&key, &true)` is a no-op when already `true`. But the function unconditionally calls `PairSpent { ... }.publish(e)` after the `set`, so if `mark_pair_spent` is ever called twice for the same pair (which the current code structure prevents, but a future refactor might allow), the event would fire twice. Off-chain indexers building "list of all spent pairs" from `PairSpent` events would either double-count or need to dedupe.

Today this is unreachable because the reveal-time `is_pair_spent` check (lib.rs:413) blocks the second reveal before `mark_pair_spent` runs. So it's defensive hygiene, not a bug.

**Recommendation.** Either (a) update the doc-comment to say "callers must ensure this is only called once per pair, enforced upstream by `is_pair_spent`", or (b) make the function actually idempotent by gating the `publish` on `!already_set`. (a) is the lower-effort and matches the existing structural guarantee.

### L-2. `Conjoin` event carries caller-order parents; `PairSpent` carries normalized — minor indexer confusion
`contracts/planet/src/lib.rs:509-515` (`Conjoin` event), `lib.rs:1019-1022` (`PairSpent` event)

The `Conjoin` event publishes `parent_a, parent_b` in the *caller-supplied* order (i.e., whichever order the user passed to `commit_conjoin`). The `PairSpent` event publishes `(min, max)` normalized. Both are emitted in the same reveal. An off-chain indexer that builds "which pair produced this child" by joining `Conjoin.child` → `(parent_a, parent_b)` will see caller-order; if it then asserts `(min, max)` against `PairSpent`, it must normalize on its side.

The dev's design comment on `PairSpent` says this is intentional: "Carries the *normalized* pair so off-chain indexers can cheaply look up 'has this pair already been conjoined?' without needing to remember the orientation the caller used at commit time." Fair enough. But the asymmetry should be called out in indexer docs (or `Conjoin` should also normalize — slight breaking change for anyone consuming it).

**Recommendation.** Document the orientation contract somewhere indexer-facing (probably `docs/events.md` if it exists, otherwise inline doc on the two events). Lowest-cost fix.

### L-3. Test for "(A, B) spent doesn't invalidate A" doesn't cover B too
`contracts/planet/src/test.rs:1233-1252` (`conjoin_different_pair_after_spent_pair_succeeds`)

The test verifies that after (A, B) is spent, (A, C) still succeeds. It doesn't verify that (B, D) also still succeeds — i.e., that spending (A, B) doesn't taint B. This is structurally guaranteed by the normalized-pair key (the rule is per-pair, not per-planet), but a symmetric test costs ~5 LOC and makes the per-pair-not-per-planet semantics maximally explicit.

**Recommendation.** Extend the test to also `conjoin(b, d, ...)` and assert success. Optional polish.

### L-4. Error code 14 in `cosmocopia.test.ts` is a duplicated literal, not a re-exported constant
`web/lib/cosmocopia.test.ts:33` (`14: { message: 'PairAlreadySpent' }`)

The frontend test hand-mirrors the entire `Errors` map of the bindings, including code 14. If the contract Errors enum is renumbered (e.g., per H-1 above), this test mock has to be updated in lockstep with `index.ts`. The test would otherwise silently green even after a renumber that breaks the actual runtime path.

**Recommendation.** Import `Errors` from the bindings at test time instead of redefining: `const { Errors } = await vi.importActual<...>('./planet-bindings/src/index');` then partial-override only the `Client`. Or accept the duplication and add a comment pointing at the source of truth.

### L-5. WASM size dropped, not flat
`contracts/target/wasm32v1-none/release/planet.wasm` — **41,196 B** vs Phase 1's audited 46,014 B (on the other branch).

Phase 2 is built on top of `2d36904` which doesn't include Phase 1's First Light code, so the size comparison isn't apples-to-apples. The dev's claim of "no measurable growth" is checking against the previous commit on *this* branch, not against Phase 1's number. Both branches will eventually merge; the combined WASM will be larger than either alone. Still well under the typical 64 KB Soroban budget.

**Recommendation.** Re-run the WASM size check on the eventual merged-with-Phase-1 build before the post-Phase-2 testnet deploy. No action required in this branch.

---

## Informational

### I-1. Error code 14 is an inline literal in the Rust enum, not a named constant
`contracts/planet/src/lib.rs:71` (`PairAlreadySpent = 14`)

Every other Error variant uses an inline `= N` literal too (lines 54-66), so this is consistent with the file's style. The audit prompt asked whether error codes should be named constants — given the file convention, applying that change here would be a stylistic change to a 13-variant existing enum, not a Phase 2 issue. Flagging only because the prompt explicitly asked.

**Recommendation.** Leave as-is. Style change, if desired, should be a separate housekeeping PR covering all 14 variants.

### I-2. `normalize_pair` is total but the (a == b) branch is dead code in practice
`contracts/planet/src/lib.rs:993-999`

`normalize_pair(a, a)` returns `(a, a)`. This is never reached because `SameParent` rejects upstream. Cheap to leave alone — but a `debug_assert_ne!(a, b, "SameParent should have rejected")` inside `is_pair_spent` / `mark_pair_spent` would catch any future code path that bypasses the upstream check. Optional.

### I-3. `is_pair_spent` does not extend SpentPair TTL on read
`contracts/planet/src/lib.rs:1003-1008`

Read-only check, by design. But the `extend_planet_ttl` pattern used elsewhere shows that view-style reads can opportunistically refresh TTL. Pairing this with M-3 above: if SpentPair entries were touched-on-read, popular pairs (the ones folks try to re-conjoin) would self-extend, partially closing the 30-day-lapse problem. Doesn't fully fix it (nobody is *supposed* to keep poking spent pairs), but it's a near-zero-cost mitigation.

**Recommendation.** Defer until M-3 is decided. If the spec accepts a TTL lapse, leave this alone; if it doesn't, refresh on read AND add a dedicated keepalive entrypoint.

---

## Verdict

CLEARED PENDING FIXES — H-1 (error code 14 collision with Phase 1's `FirstLightAlreadyClaimed`) must be resolved before merge to `main`, and M-3 (SpentPair TTL lapses after 30 days, silently breaking "rule is forever") should be discussed with the spec owner and either fixed or explicitly documented. M-1/M-2 are test-hygiene gaps that would be quick to close in this PR. Lows + Informationals are polish.

---

## Re-audit update — M-3 reclassified

After fact-check with current Stellar protocol docs, M-3 is **reclassified from Medium to Informational**.

Stellar testnet and mainnet both run Protocol 25 (as of Oct 2025 / Jan 2026). Per Protocol 23 (CAP-0066, "automatic restoration via InvokeHostFunctionOp"), archived persistent entries that appear in a transaction's footprint are auto-restored before contract execution. The Soroban CLI/SDK simulation populates the restore list automatically when it detects access to an archived entry. Critically:

> "A Soroban transaction that has a key to an archived Persistent entry in the footprint will fail immediately during the apply stage prior to contract execution."

This means there is **no path** for an attacker to make the contract see a previously-written SpentPair entry as `has() == false`:

1. Standard SDK flow: simulator includes restore in footprint; auto-restore brings the entry back; contract reads `true`; rule fires.
2. Custom footprint **with** archived key but **no** restore list: tx fails at apply stage, before contract code.
3. Custom footprint **omitting** the archived key entirely: tx fails on footprint mismatch when the contract attempts `has(SpentPair)`.

The "rule is forever" invariant holds in practice. The 30-day TTL is irrelevant to enforcement — only relevant to ongoing storage rent. No code change required.

Reference: https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/state-archival

---

## Re-audit (round 2)

Re-audit of fix commits `3e105bf` (H-1, L-1, L-4), `a3d9bda` (M-1, M-2, L-3), `b1d5f8b` (M-3 doc reclassification) on branch `worktree-agent-a985eba3fa450fd58`.

### Per-finding closure status

| ID  | Severity (orig) | Status | Notes |
|-----|-----------------|--------|-------|
| H-1 | High            | **Closed** | `PairAlreadySpent = 18` in `contracts/planet/src/lib.rs:72` with a coordination comment referencing Phase 1 PR #3's reserved range (14..=17). `web/lib/planet-bindings/src/index.ts:56` updated to key `18`. No discriminant duplicates in the Error enum (1..=13 plus 18). |
| M-1 | Medium          | **Closed** | `reveal_conjoin_does_not_mark_spent_pair_if_drand_unavailable` (`contracts/planet/src/test.rs:1391`) commits via `commit_conjoin`, clears the drand mock seed via the new `MockDrand::clear`, advances past `MIN_REVEAL_DELAY_LEDGERS`, asserts `Error::DrandUnavailable`, then verifies `SpentPair(lo,hi)` slot is absent via `env.as_contract` + `storage().persistent().has(...)`. Both halves of the assertion are present. |
| M-2 | Medium          | **Closed** | `reveal_conjoin_rejects_second_commit_after_real_race_with_first_reveal` (`contracts/planet/src/test.rs:1445`) drives the canonical sequence end-to-end via real `commit_conjoin` + `reveal_conjoin` entrypoints: commit (A,B) at N, advance to N+721 (past `DEFAULT_COOLDOWN`), commit (A,B) again, reveal first → marks SpentPair, advance, reveal second → `Error::PairAlreadySpent`. No `env.as_contract` shortcuts on the race itself. The pre-existing unit-level pin `reveal_conjoin_rejects_if_pair_spent_between_commit_and_reveal` (test.rs:1315) is retained as a focused regression guard — non-redundant given it isolates the reveal-time `is_pair_spent` gate from the commit-side gate. |
| M-3 | Medium → Informational | **Closed (reclassified)** | `b1d5f8b` appendix cites Protocol 25 (live on testnet + mainnet), CAP-0066 auto-restoration via `InvokeHostFunctionOp`, the "tx fails at apply stage prior to contract execution" semantic for archived keys in footprint without restore, and links the Stellar state-archival doc. Verdict logic stands: all attacker paths fail before contract code runs, so the "has() returns false for archived entry" exploit is not real on the live network. Commit subject line references "Protocol 23" (the CAP-0066 introduction protocol); body and audit body correctly cite Protocol 25 as the deployed version — accurate, just a minor cosmetic mismatch in the subject. |
| L-1 | Low             | **Closed** | `mark_pair_spent` doc-comment (`contracts/planet/src/lib.rs:1013-1019`) now explicitly distinguishes storage-write idempotency (`set(&key, &true)` is a no-op when already `true`) from event-publish non-idempotency (a second invocation would emit a duplicate `PairSpent`), and re-states that the reveal-time `is_pair_spent` check is the actual gate. Accurate. |
| L-3 | Low             | **Closed** | `conjoin_different_pair_after_spent_pair_succeeds` (test.rs:1282) now mints a fourth genesis planet D and asserts both `(A, C)` after `(A, B)` is spent AND `(B, D)` succeed, with cooldown advances between each. The per-pair-not-per-planet rule is pinned symmetrically. |
| L-4 | Low             | **Closed** | `web/lib/cosmocopia.test.ts` now uses `vi.importActual` to re-export the real `Errors` map from `./planet-bindings/src/index`, overriding only `Client`. The hand-rolled Errors literal is gone; future enum renumbers cannot silently desync the test mock. |

All Lows from the original audit not listed here (L-2, L-5) were already informational-level polish and were not part of the fix scope; they remain as-is and do not block merge.

### New findings

None. The L-4 refactor (replacing the hand-rolled mock with `vi.importActual`) did not break any existing web test — `npm run test` reports 22/22 passing, same count as pre-fix. No new code paths were introduced; the test changes (`MockDrand::clear`, M-1 + M-2 + extended L-3) are additive.

### CI gates

| Gate | Result |
|------|--------|
| `cargo fmt --all -- --check` (in `contracts/`) | PASS |
| `cargo clippy --workspace --all-targets -- -D warnings` | PASS |
| `cargo test --workspace` | PASS — 56 passed / 0 failed (was 54, +2 from M-1 + M-2 as predicted) |
| `stellar contract build` | PASS |
| `stellar contract build --optimize` (via `stellar contract optimize`) | PASS — `planet.optimized.wasm = 41,294 bytes` (matches claim exactly; +98 B over 41,196 B baseline due to L-1 doc-comment + coordination comment) |
| `tsc --noEmit` (in `web/`) | PASS |
| `npm run test` (in `web/`) | PASS — 22/22 (unchanged, as predicted) |
| `npm run build` (in `web/`) | PASS — all routes compiled |

### Verdict

CLEARED FOR MERGE — all findings closed
