# Cosmocopia Game-Design Audit

Branch: `origin/dominance` @ `9894698`. Read-only review of the rarity scorer, the D/R1/R2 dominance crossover, the conjoin flow, and the frontend civ_tier derivation. Findings are tagged **Critical / High / Medium / Low / Informational**; the top-5 actions appear at the end.

---

## Rarity system

### F1. **High** — Tier curve regresses every generation; the distribution test under-asserts
- `art/src/rarity.ts:9-18`, `art/src/rarity.test.ts:201-204`
- Header comment promises "Common ~60%, Rare ~25%, Epic ~10%, Legendary ~3%, Mystic ~1%" but the test only enforces `Common ≥ 40%`, `Mystic ≤ 3%`, `Legendary ≤ 8%` — much weaker, and uniform-byte samples are not the actual mint distribution. Real mints always have `generation == 0` → free +3pts. The bonus does not flow to children, so gen-1+ planets have a permanently *lower* baseline. Across a long-lived game, the median rarity *falls* over time.
- Optimal long-term play becomes "hoard G0" because G0 alone is +3 and the rarity nibble grows monotonically (see F4); children of high-rarity G0 parents drift up slowly while losing the G0 stamp.
- Fix: drop G0 bonus to +1, or move it into a separate `Genesis` chip outside the rarity score. Re-tune cutoffs to {Mystic 32, Legendary 25, Epic 18, Rare 11}; tighten the distribution test to assert `Common ∈ [45%, 62%]`, `Rare ∈ [20%, 32%]`, `Epic ∈ [8%, 16%]`, `Legendary ∈ [1.5%, 4%]`, `Mystic ∈ [0.3%, 1.2%]` on post-mint-shape DNA (force `byte[16] = 0` in the sample).

### F2. **Medium** — Rings dominate "background" points; Class is the high-beam
- `art/src/rarity.ts:80-82`
- `ringsCount >= 5` adds +5 (probability ~37.5% since `& 0x07` gives 0..7 and 5/6/7 all qualify); `>= 3` adds +1 at ~62.5%. Compare crown aura +5 at 1/8 or Aether class +6 at 1/16. Rings is a near-mandatory background contributor, Class is the highbeam.
- Fix: weight on absolute count, not threshold. `ringsPoints = max(0, ringsCount - 2)` capped at 4; `moonPoints = max(0, moonCount - 1)`. Rare extremes stay valuable, mid-rolls stop over-contributing.

### F3. **Medium** — Combos are flavorful but invisible to breeders
- `art/src/rarity.ts:92-107`
- The five combos (Aether × aurora-aura, Hollow × eyes, sovereign, twin aurora, orbital wonder) each require a 1/16 × 1/8 = 1/128 joint roll. ~4-5% chance any combo fires on a random mint — appropriately rare.
- But combos read visible D only. A planet carrying Hollow as a hidden R1/R2 can never trigger the combo, so dominance and combos don't talk to each other.
- Fix: surface "you're one expression away from Hollow × eyes (4%/conjoin)" in the UI when recessives can produce it. Turns combos into breeding *targets* — the whole point of an Axie-style game (cf. F11).

### F4. **High** — Stored rarity nibble drifts monotonically up, saturates, then stops mattering
- `art/src/rarity.ts:84-87`, `contracts/planet/src/dna.rs:193-195`
- Crossover does `rarity = max(a.rarity, b.rarity) + (rr[24] & 1)` — children never *lose* relative to their best parent, and 50% gain +1. Across ~30 generations any actively-bred lineage pegs the nibble at 15. After saturation it's a flat +3 stamp — a "lineage age" marker masquerading as a rarity signal.
- The scorer quantizes `floor(nibble/5)` → 0/1/2/3 pts. Only three thresholds (5, 10, 15) matter — nibble 6 vs 9 are identical to the scorer. 4 bits of state for 4 levels.
- Fix — pick one: (a) decay the nibble (`max(a,b) - (rr[24]&1 == 0)`) so high-rarity lineages need maintaining; (b) linearize: `points = nibble / 4`; (c) repurpose entirely as a *recessive count* that ticks down each generation, making "old lineages with intact recessive ledger" uniquely valuable.

### F5. **Critical** — Inner-core squattable for free
- `art/src/rarity.ts:110-115`, `contracts/planet/src/lib.rs:194-216, 424-435`
- `commit_genesis` accepts arbitrary `(x, y)` with **zero uniqueness check and zero cost curve**. `migrate` is identical: any owner can teleport any planet anywhere for gas. Inner-core (r² ≤ 25 → 81 integer-lattice points) grants +5 rarity for life.
- Conjoin midpoint doesn't check collision either — you can stack 100 planets on `(0,0)`. The galaxy stops being a map; it becomes a column.
- Fix: enforce coord uniqueness via a `CoordsToken(x,y) → Option<token_id>` index, checked on mint/migrate/conjoin (or pick a nearby free cell on conjoin midpoint collision). Migrate fee scaled `0.1 + 50 / (1 + r²)` XLM — 50.1 to reach (0,0), trivial to reach the rim.

### F6. **Low** — Aurora archetype double-dips
- `art/src/rarity.ts:37,42,105-107`, `art/src/scene.ts:266`
- `aurora` atmo (+4) + `aurora-aura` (+5) + twin-aurora combo (+3) = +12 from a single visual theme, *plus* the aurora atmosphere gets bonus sky FX in the scene renderer. Crown/eclipse cluster scores similarly (+13) without the FX bonus.
- Fix: drop twin-aurora combo by 1pt, or require a third condition (e.g. `feature ∈ MYTHIC_FEATURES`).

---

## Conjoin mechanics (D/R1/R2 dominance)

### F7. **Medium** — Stated mutation rate is wrong — actual is ~1.5× higher
- `contracts/planet/src/dna.rs:171`
- Gate is `(rr[16+i] & 0x3F) < 2`: 2/64 = **3.125%** per trait, not "~2%" as the doc-comment says. Across 8 traits: P(any mutation) = 1 − (1 − 0.03125)^8 ≈ **22.4%**, not 15%.
- Fix: keep 3.125% per trait (22% per conjoin is the Axie/CryptoKitties sweet spot) but update the comment. Or tighten to `< 1` for ~1.5%/11.5% if 22% feels chaotic in playtests.

### F8. **Low** — Mutation XOR can be a no-op
- `contracts/planet/src/dna.rs:171-173`
- `final_d ^= rr[(8 + i) % DNA_LEN]` — when the random byte is 0, the "mutation" is a no-op. P(no-op | triggered) = 1/256.
- Fix: `if rr[(8+i) % DNA_LEN] == 0 { final_d ^= 0xFF }`.

### F9. **High** — Recessive R2 bleed is "uniform-from-4" — half-life ~1.7 generations
- `contracts/planet/src/dna.rs:160-166`
- `child_r2` is uniform from `{A.R1, A.R2, B.R1, B.R2}`. A specific grandparent recessive has ~12% per-generation carryforward; by gen 4 there is < 1% probability any specific G0 trait survives in the latent ledger.
- The README narrative ("your Hollow planet's eyes finally re-emerged in the 4th generation") *cannot actually happen* under current rules — by gen 2-3 the eyes are gone.
- Fix: weight the draw `[R1, R2, R2, R2]` so R2 sticks 50% of the time (R2 = "deep memory" slot). Half-life rises to ~3 generations, matching the narrative.

### F10. **Informational** — Expected conjoins to surface a specific R2 ≈ 25
- `contracts/planet/src/dna.rs:151-156, 214-222`
- P(specific R2 → child's visible D) = 0.08 (R2 weight) × 0.5 (swap bit) = **4%** per conjoin per parent carrying it. Expectation = 25 conjoins ≈ 25 hours at default cooldown. Reasonable depth, but invisible to the player (see F11) and racing against decay (F9).

### F11. **Critical** — No frontend reveal of recessives = breeding is blind
- `contracts/planet/src/lib.rs:450-456`
- The contract exposes `latent_of(id)`. Unless the frontend renders R1+R2 per trait, the player cannot pick pairs strategically. Axie's whole depth comes from breeders reading both visible and recessive cards. Without this surface, conjoin is RNG fan-fic.
- Fix: ship a "Genetic ledger" panel on the planet detail page — visible D + R1 + R2 per trait with class/feature/aura names. Frontend-only, contract already exposes the data.

### F12. **Low** — Cross-owner cooperation is blocked
- `contracts/planet/src/lib.rs:280-282`
- `to` must be one of the parent owners. Fine as anti-grief default (a user can't dump children on a victim). But it forecloses guild breeding, gifting to new players, and treasury preserves.
- Fix: add an opt-in flow that requires `to.require_auth()` to also sign — same anti-grief property (target consents), opens collab.

### F13. **High** — Cooldown is per-planet, enabling parallel-breeding grind
- `contracts/planet/src/lib.rs:298-303, 725-740`
- A whale with 100 planets can run 50 parallel conjoins per hour → 1,200 children/day. The 25-conjoin expected wait for a known R2 (F10) collapses to ~30 minutes of brute force.
- Fix: add a per-owner cap (`LastConjoinByOwner(addr) → ledger`, blocks Nth conjoin within `cooldown`). Pair-based cooldown also helps — `LastConjoin((min(a,b), max(a,b)))` so the same pair can't re-breed for 24h regardless of other partners.

### F14. **Informational** — No low-gen prestige tier
- `contracts/planet/src/dna.rs:185-188`
- Standard `gen = max(a,b) + 1` with no late-game incentive to value low-gen. Axie has "Pure" and "Origin" tiers that explicitly reward low-gen. Consider a `Pure` badge in the scorer for `generation ≤ 3 && parentMix indicates single-class lineage`.

---

## Care + civ_tier interplay

### F15. **High** — Civ_tier formula penalizes Crystal/Hollow/Void unfairly
- `art/src/scene.ts:38-46`, `contracts/planet/src/stats.rs:26-43`
- `deriveCivTier = (temp + biomass + spirit) / 3 / 51`. Class-blind formula vs class-coded decay:
  - **Crystal** decays biomass down `(0,0,1,-1,1)` — a healthy Crystal naturally trends low-biomass high-spirit; averaging flattens to mid.
  - **Void/Hollow** decay everything down — they can *never* reach Spacefaring.
  - **Bloom** `(0,0,0,+1,+1)` is gifted — a decayed Bloom still reads as high civ.
- Fix: per-class `civ_target = (T*, H*, G*, B*, S*)`. Compute civ_tier from `1 - Σ|v_i - target_i| / (5*255)`. Players who care correctly keep their planet near target; mis-care punishes. Makes "warming a Lava" narratively wrong, not just numerically wrong.

### F16. **Medium** — Care is 5 free buttons with no rotation pressure
- `contracts/planet/src/lib.rs:403-420`, `contracts/planet/src/stats.rs:112-149`
- One-shot deterministic effect, no cooldown on care itself, no resource. Optimal loop = "every hour, tap whichever button targets your most-decayed vital". FarmVille with gas.
- Fix — pick one: (a) **daily quota** — 5 care actions per planet per 24h (cheap, ~30 LOC); (b) **bigger cross-vital drains** so each care is a tradeoff; (c) **care streaks** — N right-class actions in a row unlock a bonus or tick the rarity nibble (F4-c).

### F17. **Informational** — Health gate is commit-only, not reveal
- `contracts/planet/src/lib.rs:289-294, 326-328`
- 40-second reveal window can't decay a planet meaningfully (decay is per-720-ledger period), so leave as-is. Re-checking would make conjoin flaky for free.

---

## General game-feel

### F18. **Informational** — Only 2 strategies are viable today
Currently rewarded:
1. **Genesis squatter** — mint to inner-core, +5 location + +3 G0 forever (wins on F1+F5).
2. **Nibble compounder** — breed any pair repeatedly, push nibble to 15 (wins on F4).

Currently broken:
- **Lineage breeder** — blocked by F9 (recessives bleed too fast) + F11 (no UI).
- **Civilization gardener** — blocked by F15 (class-blind formula) + F16 (care too cheap).
- **Sector specialist** — sector mechanics exist but there's no rarity recognition for "well-adapted to sector". A Lava planet at (0,0) and one in the Outer Dark score identically.

### F19. **Medium** — Conjoin tells no story; no lineage view
- The README narrative requires (a) recessives surviving N generations (F9), (b) revealed recessives (F11), and (c) a "trait history" view. None of (a)/(b)/(c) ships today.
- Fix: build a lineage tree from `Conjoin` events. Render trait-class transitions ("G0 Hollow → G1 Void [Hollow lost] → G2 Mist → G3 Hollow re-emerged from R2"). The tree itself is the narrative artifact.

---

## Top-5 recommended actions, ordered by impact-per-effort

1. **Render the recessive ledger in the frontend (F11)**. The contract already exposes `latent_of` — the UI just doesn't read it. ~2 days of frontend work and the entire breeding system gains a strategic surface. Without this, the dominance work isn't being *used*.

2. **Enforce coord uniqueness + a migrate fee curve (F5)**. Without it, the galaxy collapses to a stack on (0,0). Contract change is ~30 lines: a `CoordsToken(x,y) → Option<token_id>` index plus a check on mint/migrate, plus a fee tied to `1/(1+r²)`. Single highest-value contract change.

3. **Class-aware civ_tier (F15)**. Frontend-only — `deriveCivTier` becomes a per-class distance-from-target. Each class gets a one-line target vector. Unblocks the "civilization gardener" strategy and makes care feel meaningful per-class. ~half a day.

4. **Bias R2 toward sticky inheritance + fix mutation comment (F9 + F7)**. Two-line contract change to make the R2 pool weighted `[R1, R2, R2, R2]` (or similar). Recessive half-life jumps from ~1.7 to ~3 generations — now the "Hollow eyes re-emerge in gen 4" story is *possible*. Also fix the mutation-rate comment to say 3.125% per trait so future tuning is honest.

5. **Move G0 bonus out of the rarity score, retune cutoffs (F1)**. The G0 stamp is real prestige but folding it into the score warps the curve and punishes breeders. Render it as a separate `Genesis` chip on the card. Re-tune cutoffs to {32, 25, 18, 11} and tighten the distribution test. Removes the "long-game median rarity falls" pathology and frees combos (F3) to actually push a planet to Mystic.

Nice-to-haves that didn't make the top 5: pair-cooldown / per-owner conjoin cap (F13), care-quota (F16), lineage tree view (F19), Rings/Moons rebalance to absolute count (F2). All real wins, none as high impact-per-effort as the five above.

---

*Audit completed against `origin/dominance` @ `9894698`. Read-only; no source files modified.*
