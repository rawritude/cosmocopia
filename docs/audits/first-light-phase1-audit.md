# First Light Phase 1 Audit — branch `worktree-agent-adab0703e1091c049`

Scope: 4 commits on top of `2d36904` —
  - `9e970a4` feat(contract): claim_first_light + soulbound foundation
  - `04ef447` chore(web): regenerate planet-bindings
  - `628d23e` feat(web): First Light panel + SOULBOUND chip + submitFirstLight
  - `db13fd4` chore(scripts): deploy script wires native_token + burn_address

Spec: `docs/first-light.md` (Phase 1 = `claim_first_light` + `reveal_first_light` + soulbound storage + care watermark + UI ritual).

## CI gates (re-run independently)

| Gate | Result |
| --- | --- |
| `cargo fmt --all -- --check` | PASS |
| `cargo clippy --all-targets --workspace -- -D warnings` | PASS |
| `cargo test` | **61 passed / 0 failed** |
| `stellar contract build` | PASS — `planet.optimized.wasm` = **46,014 B (44.94 KB)** under the 50 KB cap |
| `npx tsc --noEmit` (web) | PASS |
| `npm run test` (web / vitest) | **30 passed / 0 failed** |
| `npm run build` (web / next) | PASS |

All green. Dev's claim of green CI confirmed.

---

## Critical

### C-1. Common-tier floor is NOT enforced — First Light can mint up to Mystic-tier planets
`contracts/planet/src/lib.rs:1291-1306` (clamp), `art/src/rarity.ts:34-129` (scorer)

The spec is explicit: "Common-tier floor — revealed DNA must never produce a Rare+ planet, no matter what the drand seed is." (`docs/first-light.md` rules table; audit prompt invariant #3.) The implementation only clamps **two** of the many DNA bytes that feed `computeRarity`:

1. `IDX_AFFINITY_RARITY` (byte 17) low nibble capped at `FIRST_LIGHT_RARITY_CAP = 4`. Scorer contribution `Math.floor(nibble / 5) = 0` ✓.
2. `IDX_CLASS` (byte 0) high nibble deflected away from mythic 14/15 → 6/7 (Jungle/Crystal, non-exotic) ✓.

Every other DNA byte that `computeRarity` reads — atmosphere (byte 2), feature (byte 3), aura (byte 5), moon count (byte 4), rings count (byte 1) — is left as raw seed bytes. The scorer adds points for:

| Source | Possible points (per scorer) | Trigger byte |
| --- | --- | --- |
| Generation = 0 (genesis, always true for First Light) | +3 | byte 16 (hardcoded 0) |
| Mythic atmosphere (aurora / sparkle / eclipse) | +4 | byte 2 |
| Atmosphere density ≥ 28 | +2 | byte 2 |
| Mythic feature (runes / blossoms / spires) | +4 | byte 3 |
| Feature intensity ≥ 14 | +2 | byte 3 |
| Mythic aura (aurora-aura / crown) | +5 | byte 5 |
| Aura intensity ≥ 28 | +2 | byte 5 |
| Rings (count − 2), cap 4 | up to +4 | byte 1 |
| Moons (count − 1), cap 3 | up to +3 | byte 4 |
| Combo "sovereign" (eclipse × crown) | +4 | bytes 2 + 5 |
| Combo "twin aurora" (aurora × aurora-aura) | +3 | bytes 2 + 5 |

Tier cutoffs: Rare ≥ 12, Epic ≥ 18, Legendary ≥ 24, Mystic ≥ 30.

**Concrete proof.** The existing test `first_light_tier_capped_at_common` (test.rs:1326) iterates seeds `[0x11, 0x33, 0x55, 0x77, 0x99, 0xBB, 0xDD, 0xFF]` but only asserts `rarity_nibble <= cap` and `class not in mythic_ids`. It never computes the actual rarity score. Seed `0xFF` (every DNA byte = 0xFF) yields:
- class 15 (Aether) → clamped to 7 (Crystal, no class points)
- byte 1 = 0xFF → 7 rings → +4 (capped)
- byte 2 = 0xFF → atmosphere idx 7 = `eclipse` (mythic) +4, density 31 +2
- byte 3 = 0xFF → feature idx 15 (out-of-bounds; JS returns `undefined`; no mythic bonus but density 15 ≥ 14 → +2)
- byte 4 = 0xFF → 7 moons → +3 (capped)
- byte 5 = 0xFF → aura idx 7 = `crown` (mythic) +5, intensity 31 +2
- combo `sovereign` (eclipse × crown) → +4
- G0 → +3

**Total: 31 → Mystic tier.** Even an "honest" mid-seed (say `0xE0`) easily clears the +12 Rare threshold via just the G0 (+3) baseline plus any 2 of {rings, moons, atm, feature, aura} bonuses.

This is the single most important spec violation in this branch. The whole point of the Common-tier floor is to defeat sybil grinding ("no grinding edge from spam-claiming" — spec rules table). With the current implementation, paying 10 XLM can land a Mystic, which is exactly the grinding edge the spec wanted to close.

**Recommendation.** Either:

1. **Clamp more bytes on-chain.** Force the atmosphere nibble to a non-rare set (e.g., `byte[2] >> 5` must be in `{0,1,2,3,5}` = `none/thin/thick/storm/toxic`); zero the rings nibble (`byte[1] & 0x07`); clamp moon count to ≤2 (`byte[4] >> 5` mod 3); deflect mythic feature indices `{8,9,10}` to a non-mythic safe set; deflect mythic aura indices `{5,7}` similarly. Pin G0's +3 by either changing the scorer to ignore G0 for First-Light-flagged planets, or by setting `IDX_GENERATION = 1` for FL planets (but that breaks the "genesis" meaning).
2. **Re-derive tier ON-CHAIN.** Mirror the scorer logic in the contract; reroll the seed (or pick from a Common-only deterministic palette) until the computed tier is Common. More expensive in WASM but matches the spec's "hard-capped" wording.
3. **Move tier enforcement to a pre-canned Common-DNA template** and let the seed only mutate the cosmetic-but-non-scoring bytes (palette, salt). This is the cleanest but most invasive — it constrains the visual variety of FL planets.

Option (1) is the smallest diff and probably sufficient. Add a regression test that, for a sweep of seed bytes (e.g., 0x00..0xFF in byte 0, and a randomized 256-seed fuzz across the full 32-byte space), computes `computeRarity` via a Rust port or via a TS-driven golden file and asserts `tier === 'Common'`.

This finding must land before merge. Until it does, the spec invariant is broken.

---

## High

### H-1. `first_light_tier_capped_at_common` test is misleading — passes without proving the invariant
`contracts/planet/src/test.rs:1326-1352`

The test name suggests it pins the Common-tier floor. The assertions only verify two of the many DNA bytes that feed the rarity scorer. A reviewer reading the test list assumes the floor is covered; in reality it is not (see C-1).

Recommendation: rename to `first_light_clamps_rarity_nibble_and_class` to accurately describe what it tests, and add a new test (the one C-1 mentions) that actually asserts the tier is Common for a seed sweep.

### H-2. "Push outward" coord fallback degrades to corner-spam after 4 keepers
`contracts/planet/src/lib.rs:1352-1365`

When the salt-derived random point falls **inside** Outer Dark (~54% chance per iteration with radius 60: `π·2500 / 121² ≈ 0.54`), the fallback picks one of exactly **four** corner coords: `(±60, ±60)`. Once those four corners are claimed (by the first 4 keepers whose initial hash fell inside the ring, distributed across the 4 quadrants), the fallback is dead — every subsequent inside-ring iteration immediately falls through to the next salt.

Practical impact:
- After 4 FL claims, every salt-i where the random point lands inside the ring is wasted compute (still bounded by the 16-salt budget).
- The expected number of useful salts for honest keepers drops from 16 to ~8 (only the half that lands outside the ring count).
- P(all 16 salts wasted) ≈ 0.5^16 ≈ 1.5e-5 in steady state. Each "wasted" claimer is silently penalized — they pay 10 XLM, then `reveal_first_light` reverts with `FirstLightCoordCollision`. Because `take_commitment` rolls back on revert, the commitment persists, but the keeper has no recourse to retry without a fresh commit (and re-paying — there is no salt parameter on the commit side).

Worse: a sub-finding the prompt asked to check — "could a malicious actor force unbounded retry?" — the answer is "no, the retry is bounded by `FIRST_LIGHT_RETRY_BUDGET = 16`, but a malicious actor with 16 sybil wallets × 10 XLM = 160 XLM could pre-claim every salt-N coord for a known target keeper" (since the target's address is public once known). The grief is bounded but real, and concentrated post-commit (so victims pay the 10 XLM before discovering the grief).

Recommendation: replace the corner-fallback with a proper retry over a true lattice walk — e.g., on inside-ring hit, push the point outward along the (x, y) vector by adding `+/- span` to whichever axis is closer to the inner radius bound. Better still, drop the corner-fallback entirely and rely solely on salt rotation; with only ~46% of iterations being "valid" coords, the expected first-success salt is still ≤3 on average. Also worth: raise `FIRST_LIGHT_RING_RADIUS` to give more lattice points (radius 100 → ~21,000 valid coords; radius 60 → ~6,700). The doc-comment at lib.rs:282 says "~120 distinct radial-60 lattice points" — that number is wrong by ~50×; please correct.

### H-3. Soulbound flag-set ordering — defensive re-check is correct, but commitment race is masked
`contracts/planet/src/lib.rs:510-516`

The `reveal_first_light` re-checks `FirstLightClaimed(keeper)` AFTER `take_commitment` consumes the commitment slot. If two commits race (two open commitments for the same keeper — possible per the dev's accepted "no second-commit gate" behavior, lib.rs:422-425) and both reveal back-to-back, the second one's `take_commitment` succeeds (different `commitment_id`), then the defensive check at 510 fires after the FIRST has already set the flag. So the second reveal `Err`s with `FirstLightAlreadyClaimed`.

This is **correct** behavior given the design choice. But the storage state after the second failure is subtly bad: the commitment was already consumed by `take_commitment`, and Soroban does roll back the consume on Err return (`?` propagates). Verify in tests that the commitment isn't lost when the defensive check fires.

There is currently **no test** for this race. The test `claim_first_light_one_shot_per_address` exercises the pre-commit gate, not the post-reveal gate. Recommendation: add a test that opens two commitments, reveals both, asserts the second `Err`s with the right error, and asserts neither leaves storage in an inconsistent state.

This is a "tests are missing" High rather than a known bug — the code path looks right to me, but the missing test is a blind spot.

### H-4. Soulbound bypass via `approve` + `transfer_from` — currently safe, but no defense in depth
`contracts/planet/src/lib.rs:1099-1114`

`transfer` and `transfer_from` both check `is_soulbound(e, token_id)` before delegating. Good. But the `NonFungibleToken` trait surface also exposes `approve` and `approve_for_all` (not overridden — defaults from the OZ trait). These mutate approval state without touching ownership. A keeper can `approve(operator, soulbound_token)` while soulbound; the operator can then attempt `transfer_from`, which will then revert.

Functionally this is safe: the actual transfer is gated. But it leaks soulbound semantics: a UI listening to `approve_for_all` events would think the token is transferable. Worse, if someone later adds a new `mint_to(spender, token_id)`-style entrypoint that reuses the approval state without re-checking soulbound, the leak becomes exploitable.

Recommendation: override `approve` and `approve_for_all` to either (a) reject when the specific token is soulbound (approve) or simply (b) document the leak and add an integration test asserting that `transfer_from` on an approved-but-soulbound token rejects. Option (a) is cleaner.

---

## Medium

### M-1. `FirstLightCommitted` event dropped silently — indexers can't filter First Light commits from genesis commits
`contracts/planet/src/lib.rs:233-240` (event def), commit body says "FirstLightCommitted event dropped in favor of the generic Committed"

The dev's judgment call: save ~200 bytes WASM by reusing the generic `Committed` event. The commit emits `Committed { committer: keeper, ... }` for a First Light claim and `Committed { committer: admin, ... }` for a genesis commit. Indexers downstream cannot distinguish these without re-reading storage for the commitment kind. The First Light reveal does fire a dedicated `FirstLightClaimedEvent`, so the reveal side is observable, but the commit side is opaque.

Spec lists `FirstLightClaimed(keeper, token_id, coord)` as a required event (`docs/first-light.md:240`). The reveal event matches that. So the spec-required event is present. The commit event being generic is a deliberate denormalization, not a violation, but worth flagging because future indexer work may want it back.

Recommendation: leave as-is if WASM bytes matter; document the indexer convention ("for first-light flows, filter on the reveal event") in the doc comment at lib.rs:228-232.

### M-2. `Error::NotAdmin` overloaded as "Uninitialized" for missing NativeToken / BurnAddress
`contracts/planet/src/lib.rs:451, 456`

```rust
let native: Address = e.storage().instance().get(&DataKey::NativeToken)
    .ok_or(Error::NotAdmin)?;
let burn: Address = e.storage().instance().get(&DataKey::BurnAddress)
    .ok_or(Error::NotAdmin)?;
```

The error here means "storage slot was never populated" — only possible if `__constructor` was not called. The user-visible error string `NotAdmin` is misleading and will confuse anyone debugging a deploy. Recommendation: add a dedicated `Error::Uninitialized` variant or panic with a clearer message.

### M-3. Soulbound auto-release on first call after threshold — UX delay is silent
`contracts/planet/src/lib.rs:1273-1280`

The release happens "next care call after the watermark crosses 7d". So a keeper who lets their planet sit for 8d (without calling care) will still see `is_soulbound: true` in views until they call care once. The chip's countdown will show "0d 0h" (or "timer met") for the entire 1d window. The web tooltip handles the "timer met" case (cosmocopia.ts:436-438) but the chip is still shown.

Recommendation: make the views (`is_soulbound_of`, `coords_of` etc.) project the release lazily when the watermark has crossed the threshold. Or, document the "release-on-next-care" contract in the chip tooltip ("timer met — call any care action to release"). Currently the docstring at the FL panel says "or send it through its first conjunction" which is Phase 3-only — Phase 1 should be "or call care once to confirm".

### M-4. `update_healthy_since` runs for ALL planets, not just soulbound
`contracts/planet/src/lib.rs:899, 1259-1284`

`care` calls `update_healthy_since` unconditionally. Non-soulbound planets accrue a `HealthySince` storage entry the first time they're cared for healthily. The release branch only triggers for soulbound planets, so this is functionally benign — but it's a per-token storage write that serves no purpose for ~99% of planets (only First Light planets are soulbound today).

Storage cost: 1 u32 slot per planet, written once and re-written every transition. At scale (10k planets), ~40 KB of dead storage. Recommendation: short-circuit when `!is_soulbound(e, id) && !p.has(&DataKey::HealthySince(id))`. Tradeoff: if Phase 2/3 ever wants to use HealthySince for non-soulbound semantics (e.g., a "healthy streak" badge), the short-circuit will need revisiting.

### M-5. `derive_first_light_coord` doc-comment "~120 distinct radial-60 lattice points" is wrong by ~50×
`contracts/planet/src/lib.rs:282`

The 121×121 lattice in `[-60, +60]²` has 14,641 points; the Outer-Dark subset (r² ≥ 2500) is ~6,787 points. The "~120" claim is off by a factor of ~50. This number is load-bearing in justifying the 16-salt retry budget. The real budget should be reconsidered against the corner-fallback issue (H-2).

Recommendation: fix the comment; once the corner-fallback is reworked (H-2), reconsider whether 16 retries is appropriate (probably plenty given the true lattice size).

---

## Low

### L-1. `SoulboundChip` uses hardcoded color literals, not design-system tokens
`web/components/SoulboundChip.tsx:32-42`

The chip inlines `background: 'rgba(255, 213, 79, 0.15)'`, `color: '#FFD54F'`, `border: '1px solid #FFD54F'`. The project's brutalist kit uses CSS variables (`var(--space-*)`, `var(--text-*)`) and class-based styling elsewhere. The chip should be a `.chip-soulbound` class in the stylesheet or use existing kit tokens.

### L-2. Deploy script defaults `BURN_ADDRESS` to the deployer
`scripts/deploy-testnet.sh:33`

```bash
BURN_ADDRESS="${BURN_ADDRESS:-$DEPLOYER}"
```

For testnet validation this is fine. For mainnet the default makes the "burn" actually a deployer-controlled wallet — the offering goes to the deployer. The spec is clear that the burn slice is "an offering to the cosmos" (vaporized value). Recommendation: change the default to a known burn address (e.g., the address with G... and all-zero strkey content) and require an explicit env var override for any other value. Add a `echo` warning if the burn address equals the deployer.

### L-3. `ConfigChanged` event drops the new address for `set_burn_address` / `set_native_token`
`contracts/planet/src/lib.rs:628-633, 647-651`

Both setters emit `ConfigChanged { key: <symbol>, value: 0 }` — the new address is lost. Indexers must read the view to learn the new value. (This is consistent with existing `set_admin` / `set_drand` so it's not a regression.)

Recommendation (optional): extend `ConfigChanged` with an `address: Option<Address>` so address-rotation events carry the new value. Or use a dedicated event per setter. Existing convention works if you accept indexer "follow with a view" calls.

### L-4. `submitFirstLight` polls with `sleep(3000)` and no max-wait / timeout
`web/lib/cosmocopia.ts:351-361`

The poll loop in `submitFirstLight` (and the older `submitConjoin`) waits forever for the ledger to catch up. If the RPC stalls or the reveal target round is far in the future, the UI hangs. Recommendation: bound the loop with a max-wait (e.g., 5 min) and surface a "took too long, retry later" error. Same fix applies to `submitConjoin`.

### L-5. Missing negative test: soulbound does NOT release at 6d 23h
The audit prompt explicitly asked for this. The existing test `soulbound_releases_after_7d_consistent_care` only tests the positive path (release at `SOULBOUND_RELEASE_LEDGERS + 1`). Add a sibling test that advances to `SOULBOUND_RELEASE_LEDGERS - 1` (one ledger short), calls care, and asserts `is_soulbound_of(id) == true`.

### L-6. Missing test: `care` on a non-soulbound (regular genesis) planet writes HealthySince cleanly
The audit prompt asked whether the watermark logic runs cleanly when the token was never soulbound. Currently no test covers this. With M-4 unaddressed, the path runs but writes a useless slot; a test should pin the behavior either way (it's a small storage commitment we may want to back away from).

### L-7. `derive_first_light_coord` rem_euclid math is correct, but the modspan comment is subtly off
`contracts/planet/src/lib.rs:1335-1337`

```rust
let modspan = (span as i64) * 2 + 1; // -span..=+span inclusive
let x = (raw_x as i64).rem_euclid(modspan) as i32 - span;
```

For `span = 60`, `modspan = 121`. `rem_euclid` returns `0..=120`. Subtracting `span = 60` yields `-60..=60` ✓. The comment matches. Just confirming the math.

### L-8. Population-of-pre-FL-planet returns 0 silently if the legacy planet has no latent
`contracts/planet/src/lib.rs:953-962`

The view returns 0 for any planet with a missing/zero latent. Not a Phase 1 regression — same behavior as before this branch. Worth pinning with a test if not already covered (the M-2 fix from the prior audit handles the breeding path; the read path still surfaces 0 for legacy reads).

### L-9. `clamp_first_light_dna` "deflects" mythic by `& 0b0111`, but the mapping isn't symmetric
`contracts/planet/src/lib.rs:1301-1304`

Mythic 14 (0b1110) → 6 (Jungle, base biome). Mythic 15 (0b1111) → 7 (Crystal, exotic). Wait — 7 is *not* in `EXOTIC_CLASS_IDS = {8..13}`, so no exotic bonus. Good. But the doc comment says "→ 6/7, i.e. Jungle/Crystal — still exotic but no longer mythic" — that's wrong; Crystal (7) is not in the exotic set. Either the comment is wrong, or the dev meant to land on an exotic class to preserve flavor. Recommend: fix the comment to accurately describe the mapping.

---

## Informational

### I-1. Two-commit-no-reveal lost-fee window is acknowledged in code
`contracts/planet/src/lib.rs:422-425`

The dev comment is explicit: "Repeated *commits* without a reveal are NOT blocked — that's a self-imposed user fee and the contract has no way to refund without a separate flow." This is intentional; recording for future reviewers.

### I-2. Frontend test coverage matches contract surface
`web/lib/cosmocopia.test.ts` (30 tests) covers the new `submitFirstLight` orchestration, `submitClaimFirstLight` / `submitRevealFirstLight` halves, `firstLightClaimed`, `isSoulbound`, `healthySinceOf`, `distributionPool`, and `soulboundTooltip` (4 sub-tests). The mocks correctly model the contract's view-shape including the `Result::Ok` tagged union.

### I-3. WASM size budget — 46,014 B / 50 KB = 92% used
Up from 44,471 B (pre-branch). Phase 1 added ~1.5 KB. With Phase 2+ on the way, watch the headroom. The dev's choice to drop a dedicated `FirstLightCommitted` event saved ~200 B per docstring.

### I-4. Soulbound release event is per-token, with `path` symbol
`contracts/planet/src/lib.rs:245-250`

`SoulboundReleased { id, path: "care" }`. The `path` symbol is `symbol_short!` — limited to 9 chars. "care" works; Phase 3's "conjoin" will fit. The topic vector `["soulbound_release"]` keeps the event indexable.

### I-5. Coord uniqueness check is per-coord, not per-keeper
`contracts/planet/src/lib.rs:534, 1343-1347`

`FirstLightCoord(x, y) -> bool` is written by every successful FL reveal. The check on line 1343 is `!storage.has(&DataKey::FirstLightCoord(x, y))`. This means a coord taken by a regular genesis mint (not via FL) does NOT block FL. In practice the deployer's genesis batch is at coords (0,0), (5,5), (-12,8), (30,-10) — all NOT in Outer Dark — so this doesn't actually collide. But: if Phase 2's `request_conjoin` ever produces children in Outer Dark, those won't be recorded in `FirstLightCoord`, so a future FL claim could land on the same coord. Pin the convention: either FL records ALL coord usage, or non-FL paths also write to `FirstLightCoord` (rename it to `OccupiedCoord`).

### I-6. `__constructor` no longer initializes `Soulbound`/`HealthySince` slots
Storage is sparse: those slots only exist for FL planets. Reads default to `false` / `0` correctly. No deploy migration needed for existing planets.

### I-7. Frontend `FirstLightPanel` correctly hides post-claim and on disconnect
`web/components/FirstLightPanel.tsx:73-75`

`return null` when `status.kind === 'done'` or `state.status !== 'connected'`. Behavior matches spec.

### I-8. `submitFirstLight` phase transitions mirror `submitConjoin`
`web/lib/cosmocopia.ts:337-368` (FL), `444-481` (conjoin). Same `committing → waiting → revealing → done` shape. ✓

### I-9. `soulboundTooltip` math is correct
`web/lib/cosmocopia.ts:424-443`, tests at 432-453. Correctly handles paused timer, in-progress countdown, and timer-met state. ✓

### I-10. `set_burn_address` / `set_native_token` are admin-gated
Both call `require_admin(e)?` + `admin.require_auth()`. ✓

### I-11. README and docs were not updated to reference First Light
The new contract surface (claim_first_light, reveal_first_light, is_soulbound_of, healthy_since_of, distribution_pool, burn_address, native_token, set_burn_address, set_native_token, FirstLightAlreadyClaimed/SoulboundLocked/FirstLightCoordCollision errors) is not reflected in README.md. The spec doc `docs/first-light.md` lives in the project but nobody reading the README would learn about Phase 1 from it.

Recommendation: bump README's "Contract surface" / "Open" sections; also add a note in `docs/audits/README` (if one exists) describing where Phase 1 lives.

### I-12. Constructor signature change requires fresh deploy
The added `native_token` and `burn_address` parameters mean existing testnet deploys must be re-deployed (cannot upgrade in place). The dev's commit message acknowledges this ("constructor extended ... a fresh deploy is the existing workflow"). The deploy script wires it correctly. Confirm with the testnet ops play that a fresh deploy is planned.

---

## Summary

| Severity | Count |
| --- | --- |
| Critical | **1** |
| High | **4** |
| Medium | **5** |
| Low | **9** |
| Informational | **12** |

The single Critical (C-1, Common-tier floor) is a hard spec violation. The Highs include a misleading test that masks the same issue (H-1), a coord-allocation degradation past 4 keepers (H-2), a missing race test (H-3), and a defense-in-depth gap on `approve` (H-4). The Mediums are correctness/UX concerns; none corrupt storage. The Lows are quality/test-coverage suggestions.

CI gates: all green. WASM size 46,014 B / 50 KB cap.

---

**Verdict: BLOCKED — `C-1` (Common-tier floor not enforced) and `H-1` (test that pretends to pin the invariant) must land before merge. `H-2` (coord-fallback degradation) is strongly recommended before merge but is bounded by the 10 XLM fee; if shipping under time pressure, accept it for testnet and gate it on a Phase 1.1 fix. `H-3` and `H-4` are tests/defense-in-depth and can land in the same follow-up commit.**

---

## Re-audit (round 2)

Scope: 4 additive fix-up commits on top of the original audit commit `212896a`:

- `b357db7` fix(contract): expand `clamp_first_light_dna` to enforce Common-tier floor (C-1)
- `e700922` test: replace misleading FL tier test with seed-sweep + frontend floor (H-1)
- `52b3c50` fix(contract): drop corner-fallback in `derive_first_light_coord` (H-2, M-5)
- `9abf635` fix(contract): polish — commit race test, approve gate, typed error, comments (H-3, H-4, M-2, L-9)

### Findings re-verified

**C-1 — CLOSED.** `clamp_first_light_dna` (lib.rs:1395–1452) now clamps every byte the rarity scorer reads:

- Rarity nibble (byte 17 low) ≤ 4 → `floor(/5)` contribution = 0
- Class nibble (byte 0 high): mythic 14/15 deflected via `& 0b0111` → 6/7 (Jungle/Crystal — neither mythic nor exotic) ✓
- Atmosphere idx (byte 2 high 3 bits): mythic {4, 6, 7} deflected via `& 0b011` → {0, 2, 3} (none/thick/storm, all outside RARE_ATMOSPHERES) ✓
- Atmosphere density (byte 2 low 5 bits) capped at 27 — cuts +2 ✓
- Feature idx (byte 3 high nibble): mythic {8, 9, 10} deflected → {0, 1, 2} ✓
- Feature intensity (byte 3 low nibble) capped at 13 — cuts +2 ✓
- Aura idx (byte 5 high 3 bits): mythic {5, 7} deflected via `& 0b011` → {1, 3} (halo/shadow, outside MYTHIC + RARE_AURAS) ✓
- Aura intensity (byte 5 low 5 bits) capped at 27 — cuts +2 ✓
- Moon count (byte 4 high 3 bits) capped at 1 → `min(3, max(0, 1-1)) = 0` ✓
- Ring count (byte 1 low 3 bits) capped at 2 → `min(4, max(0, 2-2)) = 0` ✓

Re-derived worst-case score (any seed, post-clamp, with First Light coords always in r² ≥ 10000 = Outer-Dark+rim):
- G0 generation (always for First Light): +3
- Class in EXOTIC_CLASS_IDS {8..=13} (NOT clamped by the deflector — only mythic 14/15 is): +2
- Feature idx = 11 (archipelago, RARE_FEATURES, NOT clamped since 11 ∉ {8,9,10}): +1
- Aura idx ∈ {4, 6} (pulse/static, RARE_AURAS, NOT clamped since {4,6} ∉ MYTHIC_AURA_IDS {5,7}): +1
- Location: First Light coords have r² ≥ 10000 → rim bonus: +1
- No combos trigger (would need mythic class or specific mythic atmosphere/aura)

**Worst case = 8 points** (G0 +3, exotic class +2, rare feature +1, rare aura +1, rim +1). Rare cutoff = 12. **Safe with 4 points of headroom.**

The dev's docstring claims "= 7" (lib.rs:1370). Off-by-one — it forgets the rim bonus that the strict r² ≥ 10000 gate always triggers. Non-blocking; the real worst-case 8 is still well below Rare 12.

Rust seed-sweep test (`first_light_dna_stays_common_across_seed_sweep`, test.rs:1326–1439): asserts byte-level post-clamp invariants for every seed `[s; 32]` with `s ∈ 0..=0xFF`. Because the clamp is per-byte-independent and the sweep exercises every value for every byte the clamp touches, this DOES prove the byte-level invariant across the full 32-byte seed space. Note: if a future clamp change introduces cross-byte logic, this sweep would need to evolve.

Frontend test (`web/lib/firstLightFloor.test.ts`): imports the actual `computeRarity` and runs it on a TypeScript mirror of the clamp for all 256 seeds. Asserts `tier === 'Common'` and `max score < 12`. Belt-and-suspenders coverage verified. Caveat: the test uses coords {42, 42} (r² = 3528 < 10000), so the +1 rim bonus is NOT exercised — the test's measured worst-case is 7 (matches the docstring claim), but the production worst-case is 8 (with rim). Since both are < 12, the assertion still holds; the gap is a test fidelity issue (see new finding N-2).

End-to-end integration test (`first_light_reveal_yields_clamped_dna`, test.rs:1442–1487) confirms the clamp is wired up at reveal time for 4 representative seeds.

**H-1 — CLOSED.** The misleading `first_light_tier_capped_at_common` is gone; the new sweep test pins the post-clamp invariant for every byte value across 256 seeds. The naming accurately reflects what it tests.

**H-2 — PARTIAL.** The corner-fallback is **truly gone** (lib.rs:1492–1494 comment confirms, code at 1497–1504 contains no fallback branch). The salt-rotation budget is still bounded (`for salt in 0..FIRST_LIGHT_RETRY_BUDGET = 16`). The new test `first_light_coord_in_outer_dark` confirms FL coords always land in Outer Dark (r² ≥ 2500). No other code path hardcodes radius 60.

However: the lattice math in the doc comments (lib.rs:279–295) is **materially wrong** — same blind-spot the original M-5 was supposed to fix. The comment claims "≈ 24_000 (≈ 60%) fall in Outer Dark" and "per-iteration success rate is roughly 60%". The code's actual acceptance gate is `r2 >= FIRST_LIGHT_RING_R2 = 10000`, which yields only **9,004** lattice points (22.3% of the 40,401 lattice). Per-iteration success ≈ 22%. P(all 16 salts fail) = 0.777^16 ≈ 1.8% in a no-collision steady state — about 1 in 50 honest claimers will exhaust their budget. Compare radius-60 original: 46% success, P(fail) ≈ 1.5e-5.

Verified empirically (Python: 40401 total, 9004 with r² ≥ 10000).

The audit's original H-2 recommendation envisioned "radius 100 → ~21,000 valid coords" assuming "valid" = Outer Dark (r² ≥ 2500, i.e., 32,576 points). The dev's stricter gate (r² ≥ FIRST_LIGHT_RING_R2 = 10000) pins FL coords to r ≥ 100, well into Outer Dark, but at the cost of 3.6× fewer valid coords. This is a tradeoff, not a bug — but the comment doesn't reflect it and the new finding N-1 flags it.

**H-3 — CLOSED.** New test `first_light_two_commits_one_reveal_wins` (test.rs:1660–1726) really exercises the race:
- Opens two distinct commitments for the same keeper (different `cid_a` / `cid_b`)
- Reveals the first → succeeds, sets `FirstLightClaimed(keeper)`
- Reveals the second → `Err(FirstLightAlreadyClaimed)` (the defensive check at lib.rs:556–562 fires AFTER `take_commitment`)
- Asserts: `cid_a` slot is gone (consumed), `cid_b` slot **persists** (Soroban rollback restored the `remove` when `?` propagated the Err)

The "dead-but-present storage" behavior is the actual on-chain semantics (verified by reading `take_commitment` at lib.rs:1240–1248: removes on Ok-path, rollback on Err). Test pins this explicitly.

**H-4 — CLOSED.** The `approve` override at lib.rs:1175–1186 checks `is_soulbound(e, token_id)` and panics with `Error::SoulboundLocked` for locked tokens. `approve_for_all` is intentionally left at the default with a clear rationale in the doc comment (lib.rs:1169–1174): it's an operator-level grant (owner-wide), not per-token, and the soulbound gate at `transfer`/`transfer_from` still applies. Verified there is no other entrypoint that consumes approval state without re-checking soulbound (`grep -n "Enumerable::\|Base::"` shows no other transfer-style methods). Two tests pin the path: `soulbound_blocks_approve` (rejects on soulbound) and `approve_works_for_non_soulbound` (regression guard for the happy path).

**M-2 — CLOSED.** New `Error::Uninitialized = 17` variant added (lib.rs:99) with a clear doc comment. Returned for both missing-slot lookups (`NativeToken` at lib.rs:497, `BurnAddress` at lib.rs:502). Test `first_light_uninitialized_native_token_errors_cleanly` (test.rs:1767–1790) simulates the missing slot and asserts the typed error. Error enum remains sequentially numbered 1..17, no collisions.

**M-5 — NOT CLOSED.** The lattice comment was supposed to be corrected. It is now wrong in a new way — see N-1. The comment now says "≈ 24_000 (≈ 60%) fall in Outer Dark", but the actual gate accepts only 9,004 points (22.3%). The "120 lattice points" claim is gone; in its place is a different wrong number.

**L-9 — CLOSED.** Comment at lib.rs:1403–1405 now accurately states the mapping (14→6 Jungle, 15→7 Crystal) and correctly notes "neither is in `EXOTIC_CLASS_IDS` (8..=13) so neither earns the +2 exotic bonus either."

### New findings

**N-1 (Medium) — `derive_first_light_coord` lattice comments are materially wrong; per-iteration success ~22%, not ~60%.** lib.rs:279–295 claims ≈24_000 valid points and ≈60% per-iteration success. Actual count under the code's `r2 >= FIRST_LIGHT_RING_R2 = 10000` gate is 9,004 points (22.3%). P(16 salts all fail) ≈ 1.8% per honest claimer — non-trivial for a paid (10 XLM) action. Two paths to close: (a) relax the gate to `r2 >= 2500` (the actual Outer-Dark threshold; would yield 32,576 valid points and ≈80% per-iteration success), or (b) keep the strict gate but rename `FIRST_LIGHT_RING_RADIUS` to `FIRST_LIGHT_MIN_RADIUS` (or similar) and update the comments to reflect the real numbers. This is M-5 still un-fixed in a different way.

**N-2 (Low) — `web/lib/firstLightFloor.test.ts` uses stale coords and a stale comment.** Comment line 92–93 says "(50 <= r <= ~85 in the ±60 clamp)" — should be `±100` and `r ∈ [100, ~141]`. Test coords `{42, 42}` (r² = 3528) don't trigger the +1 rim bonus that all production FL coords now get. The bound the test exercises (worst-case 7) is therefore an under-bound; production worst-case is 8 (still < 12 Rare cutoff, so the assertion `score < 12` still holds, but the test is no longer faithful to the production path).

**N-3 (Informational) — `clamp_first_light_dna` docstring (lib.rs:1370) claims worst-case = 7.** Actual worst-case under the production coord-gate (r² ≥ 10000 → +1 rim) is 8. Off-by-one. Non-blocking.

**N-4 (Informational) — Atmosphere deflection docstring is internally inconsistent.** lib.rs:1379 says mythic {4, 6, 7} → {0, 0, 3} (none/none/storm). The actual mapping under `& 0b011` is {4→0, 6→2, 7→3} = {0, 2, 3} (none/thick/storm). The inline comment at lib.rs:1412 has the correct mapping. Header comment should be updated for consistency.

### Regressions

- **WASM size: 46,276 B / 50 KB** (was 46,014 B). Phase 1 fix-up added 262 B. Still under the 50 KB cap with ~3.7 KB headroom. No sustainability concern at this rate.
- **Radius bump (60 → 100)**: no off-by-one with `galaxy::sector_of`. Outer Dark = r² ≥ 2500 (r ≥ 50); FL coords now r ≥ 100. FL coords are guaranteed in Outer Dark by transitivity. Verified `first_light_coord_in_outer_dark` test passes.
- **`approve` override**: no break in the OZ NonFungibleToken trait surface. Regression test `approve_works_for_non_soulbound` confirms the happy path still works.
- **256-seed sweep test**: completes in <0.01s (`cargo test` runs all 66 contract tests in 0.20s total). No CI threshold concern.
- **`Error::Uninitialized = 17`**: sequentially numbered, no collision with existing codes (1..16).

### CI gates (re-run)

| Gate | Result |
| --- | --- |
| `cargo fmt --all -- --check` | PASS |
| `cargo clippy --all-targets --workspace -- -D warnings` | PASS |
| `cargo test` | **66 passed / 0 failed** (was 61) |
| `stellar contract build` | PASS — `planet.optimized.wasm` = **46,276 B (45.19 KB)** under the 50 KB cap |
| `npx tsc --noEmit` (web) | PASS |
| `npm run test` (web / vitest) | **32 passed / 0 failed** (was 30) |
| `npm run build` (web / next) | PASS |

All green.

---

**Verdict: CLEARED PENDING — all 4 blocking findings (C-1, H-1, H-3, H-4) are closed; H-2 is functionally closed (corner-fallback gone, retry bounded, FL coords land in Outer Dark) but carries forward an unresolved comment-accuracy issue that morphs M-5 into a new Medium (N-1). N-1 is non-blocking for merge but should be addressed in a follow-up — either by relaxing the coord gate to the actual Outer-Dark threshold (recovering the ~80% per-iteration success the audit originally envisioned) or by correcting the comments to reflect the stricter gate the dev chose. N-2/N-3/N-4 are doc/test-fidelity issues, all non-blocking.**
