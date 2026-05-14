# First Light — onboarding & first conjunction

This doc captures the design we landed on for how a new keeper acquires their first planet, learns the care loop, and graduates into the social mechanic of cross-owner conjunction.

It is a **design spec**, not yet implementation. Open knobs are called out explicitly at the bottom; everything else is settled.

---

## Player timeline

```
T+0       First Light: pay 10 XLM                  [commits to drand round R+10]
T+~40 s   reveal lands → first planet appears
            • Common-tier (hard-capped)
            • deterministic Outer-Dark coord
            • SOULBOUND
T+7 d     soulbound releases via care path (if vitals stayed healthy)
                              OR
T+anytime request_conjoin(starter, someone_elses_planet)
            → partner approves → child mints to requester
            → starter unsoulbounds in the same motion
            → keeper now owns 2 planets
```

A keeper's first acquisition is **deterministic and ritual**. Their second is **social and genetic**. The handoff from one to the other is the rite of passage the game is designed around.

---

## First Light — the initial mint

**Verb:** *claim First Light*. The lore: the planet was always out there in the dark; paying the fee opens your eye to the cosmos for the first time. (Real astronomical term for the inaugural observation made through a new telescope.)

**Contract entrypoint** (sketch):

```rust
fn claim_first_light(
    env: &Env,
    keeper: Address,
    observed_round: u64,
) -> CommitmentId;

fn reveal_first_light(env: &Env, id: CommitmentId) -> u32;  // returns token id
```

**Rules:**

| Rule | Value | Why |
| --- | --- | --- |
| Cost | **10 XLM**, payable at commit | Entry friction; sybil capital floor |
| Frequency | One-shot per `keeper` address | Sybil flattener |
| Coord | `hash(keeper) % outer_dark_lattice` | No agency, no inner-core squat |
| Sector | Outer Dark (forced) | Starters all spawn at the rim |
| Tier | **Common floor** (hard-capped) | No grinding edge from spam-claiming |
| Soulbound | Yes — see next section | Blocks sybil consolidation |
| DNA | Standard drand-derived via commit-reveal | Same anti-grinding as conjoin |

**Sybil math under 10 XLM:** 1000 sybil wallets = 10,000 XLM upfront for 1000 indistinguishable Common Outer-Dark planets that are also soulbound for the abuse window. Per-wallet payoff during soulbound period is zero. Combined with the distribution mechanic's activity gate (below), sybil ROI is negative in expectation.

---

## Soulbound rules

Starters are non-transferable and non-conjoinable until **one of**:

1. **Care path** — 7 days of consistent care: a `healthy_since_ledger` watermark stays continuous. Vitals must remain inside `[40, 220]` on all five axes from claim until release. Any drop out of band resets the watermark to the current ledger.
2. **Conjunction path** — one successful `request_conjoin` reveal where the starter was the requester's parent. The act of bringing a child into the cosmos with another keeper is itself the rite that unsoulbinds the parent.

There is **no bond/payment path** — paying to skip dilutes the meaning of the two real paths.

**Why only two paths:** every keeper graduates either by *playing alone for a week* or *making one friend*. These are the two things the game wants newcomers to actually do.

**Watermark check** (implementation note): on every `care` call, after applying delta, check:

```
if all five vitals in [40, 220]:
    if healthy_since_ledger == 0: healthy_since_ledger = now
    if now - healthy_since_ledger >= SOULBOUND_RELEASE_LEDGERS: clear soulbound
else:
    healthy_since_ledger = 0
```

`SOULBOUND_RELEASE_LEDGERS` ≈ 7 days converted to ledgers (Stellar ~5 s per ledger ⇒ ~120 960 ledgers).

---

## The 10 XLM split — burn + distribute

The fee splits two ways:

| Slice | Amount | Destination | Purpose |
| --- | --- | --- | --- |
| Offering | 5 XLM | Burn / sink address | Lore: "an offering to the cosmos." Keeps the ritual reading honest as a true cost, not a wealth-transfer scheme. |
| Tithe | 5 XLM | Distribution pool | Rewards active keepers; turns onboarding inflow into a flywheel that funds existing players' care work. |

**Why split rather than 100% distribute:** without a burn slice, First Light becomes pure wealth redistribution from new arrivals to old hands — invites the "no economy" critique cleanly. With the burn, the fee reads as a real cost where part of the value flows onward.

**Why not 100% burn:** would vaporize meaningful value while existing keepers' care work goes unrewarded. The distribution flywheel is genuinely aligned with the game's existing values (the loop *is* care).

---

## Distribution mechanic

**Eligibility (snapshot at First Light commit time):**

- Wallet owns ≥1 planet whose vitals are inside the healthy band `[40, 220]`
- Wallet has made ≥1 `care` call in the last 7 days

**Share weight:**

```
shares(wallet) = floor(sqrt(healthy_planet_count(wallet)))
```

| Healthy planets owned | Shares |
| --- | --- |
| 1 | 1 |
| 4 | 2 |
| 9 | 3 |
| 25 | 5 |
| 100 | 10 |

The square-root curve compresses whale concentration: a 100-planet keeper gets 10× a singleton, not 100×.

**Distribution flow (pull-based, snapshot-at-event):**

```
1. First Light commit lands → contract records:
   Distribution(epoch_id, amount = 5 XLM, total_shares = SNAPSHOT)
   For each eligible wallet: Allocation(epoch_id, wallet, shares)

2. Eligible keepers later call:
   claim_share(epoch_id) → pays out shares × (amount / total_shares)

3. After 30 days: unclaimed allocations are swept to the burn slice
   (completes the offering; prevents indefinite state bloat)
```

**Why pull, not push:** pushing N transfers in one mint transaction would explode gas as the keeper count grows. Pull-based means the mint cost stays O(1) and storage grows by one event per First Light.

**Storage cost:** each Distribution adds `O(eligible_keeper_count)` allocation records. If this becomes painful past ~1000 keepers, refactor to a Merkle-claim pattern (commit a root at distribution time; keepers claim with a path). Defer until needed.

---

## Cross-owner conjunction (Tier 0)

**Goal:** let any keeper request to conjoin one of their planets with one of another keeper's, opt-in for both sides, async.

**Entrypoints:**

```rust
fn request_conjoin(
    env: &Env,
    requester: Address,
    requester_planet: u32,
    target_planet: u32,
) -> RequestId;

fn approve_conjoin(env: &Env, id: RequestId, observed_round: u64);  // by target owner
fn decline_conjoin(env: &Env, id: RequestId);                       // by target owner
fn cancel_request(env: &Env, id: RequestId);                        // by requester
fn reveal_conjoin(env: &Env, id: RequestId) -> u32;                 // permissionless after delay
```

**Flow:**

1. Alice calls `request_conjoin(alice/#42, bob/#7)`. Contract stores `Request { requester: alice, parent_a: #42, parent_b: #7, target_owner: bob, status: Pending }`. Emits `ConjunctionRequested`.
2. Bob sees a notification on his planet card. He either `approve_conjoin(id, observed_round)` or `decline_conjoin(id)`.
3. On approve: contract checks `(#42, #7) not in SPENT_PAIRS`, stamps `commit_ledger`, sets `target_round = observed_round + 10`. Both parents lock from transfer until reveal.
4. After `MIN_REVEAL_DELAY_LEDGERS` (8 ledgers, ~40 s), anyone calls `reveal_conjoin(id)`. Standard commit-reveal derives child DNA + latent. **Child mints to Alice (the requester).** Pair added to `SPENT_PAIRS`. Locks release.

**Rate limits:**

- At most `K = 5` open inbound requests per target wallet (FIFO eviction beyond K — keeps inboxes manageable, prevents spam)
- At most `K = 5` open outbound requests per requester
- Per-pair re-request cooldown: after a `(A, B)` pair conjoins, neither owner can request the same pair again (enforced by `SPENT_PAIRS`)

**No Pact layer.** Bob does not earn a redemption right by approving. If he wants a planet from Alice's roster, he calls `request_conjoin` himself with his own pairing later. The reciprocity is informal — done via a UI "you helped X / X helped you" chip rendered from event logs, no contract state.

**Deferred (Tier 2):** the full Pact system — unilateral redemption rights, expiry, renounce — gets built only if observed behavior shows keepers getting stiffed.

---

## Spent pairs — one child per combination

**Global rule:** any specific `(planet_a_id, planet_b_id)` pair can produce at most one child, ever. The contract stores `SpentPair(min(a, b), max(a, b)) → true`.

**Implications:**

- Every conjunction is a unique cosmic event. No two keepers can summon the same pairing.
- Long-term partners run out of pairings as their rosters fill — natural diversity pressure on roster expansion.
- The check is `O(1)` storage lookup; the registry grows monotonically (one entry per conjunction).

**Where the check fires:** at `approve_conjoin` (reject early) and again at `reveal_conjoin` (defense in depth — somebody could have conjoined the same pair via a different path while this request was pending).

**Stand-alone:** this rule is independent of the Pact / Tier 0 design. It would apply to all conjunctions, including same-owner ones from the existing `conjoin` entrypoint. Worth deciding on its own merits; ship together with First Light to avoid retrofitting later.

---

## Abuse model — summary table

| Vector | Mitigation |
| --- | --- |
| Sybil mint farming | 10 XLM upfront × N wallets; Common-tier floor; deterministic Outer-Dark coord; soulbound window blocks consolidation |
| Sybil distribution farming | Activity gate (7-day care recency); sqrt weighting; soulbound starters don't count as healthy |
| Coord squatting (F5) | Closed by construction — starter coords are deterministic from address |
| Rarity grinding | Common-tier hard cap; commit-reveal anti-peek (already shipped) |
| Spam conjoin requests | 5-deep inbox cap with FIFO eviction; per-pair cooldown via SPENT_PAIRS |
| Front-running humans | No race to win — First Light is per-address one-shot; no shared finite supply |
| Reciprocity coercion | Approval is opt-in; no on-chain enforcement of "must reciprocate"; UI chip only |

---

## Contract surface — full diff vs. current state

**New entrypoints:**

- `claim_first_light(keeper, observed_round) -> CommitmentId` *(payable 10 XLM)*
- `reveal_first_light(id) -> u32`
- `claim_share(epoch_id)`
- `request_conjoin(requester, parent_a, parent_b) -> RequestId`
- `approve_conjoin(id, observed_round)`
- `decline_conjoin(id)`
- `cancel_request(id)`
- `reveal_conjoin(id) -> u32`

**New storage keys:**

- `FirstLightClaimed(Address) -> bool` — one-shot flag
- `Soulbound(u32) -> bool` — per-planet flag
- `HealthySince(u32) -> u32` — ledger watermark
- `Distribution(u64) -> { amount, total_shares, snapshot_ledger }`
- `Allocation(u64, Address) -> u32` — shares for an epoch
- `Request(u64) -> { requester, target_owner, parent_a, parent_b, status, commit_ledger, target_round }`
- `SpentPair(u32, u32) -> bool` — normalized (min, max)

**New events:**

- `FirstLightClaimed(keeper, token_id, coord)`
- `SoulboundReleased(token_id, path: care | conjoin)`
- `DistributionRecorded(epoch_id, amount, total_shares)`
- `DistributionClaimed(epoch_id, keeper, amount)`
- `ConjunctionRequested(request_id, requester, target_owner, parent_a, parent_b)`
- `ConjunctionApproved(request_id, target_round)`
- `ConjunctionDeclined(request_id)`
- `ConjunctionCancelled(request_id)`
- `PairSpent(parent_a, parent_b, child_id)`

**Modified entrypoints:**

- `care(...)` — additionally updates `HealthySince` watermark; checks for soulbound release at end.
- `conjoin(...)` (same-owner path) — additionally checks `SpentPair`; writes to it on success.

---

## UI surface

**Home view, new sections:**

```
+--------------------------------------------------------+
| FIRST LIGHT                                            |  ← shown only if !FirstLightClaimed
|  Your telescope is cold.                               |
|  10 XLM warms the mirror for one observation.          |
|  [ CLAIM FIRST LIGHT ]                                 |
+--------------------------------------------------------+
| YOUR PLANETS                                           |
|  [planet cards, with SOULBOUND chip if applicable]     |
+--------------------------------------------------------+
| REQUESTS                                               |
|  Inbound (X):  cards with [ APPROVE ] [ DECLINE ]      |
|  Outbound (Y): cards with [ CANCEL ]                   |
+--------------------------------------------------------+
| UNCLAIMED OFFERINGS                                    |  ← shown if any
|  3.2 XLM available across 4 epochs.                    |
|  [ CLAIM ALL ]                                         |
+--------------------------------------------------------+
```

**Planet card additions:**

- `SOULBOUND` chip with hover-detail: `"Releases in 4d 22h via care, or on first conjunction."`
- `[ REQUEST CONJUNCTION → ]` button (only on others' planet cards in galaxy view)

**Reciprocity chip (UI-only, derived from events):**

On a partner's planet card during a request flow:

```
.----------------------------------.
| ALICE                            |
| You helped them 2×               |
| They helped you 0×               |
'----------------------------------'
```

Pure event-log derivation. No on-chain state.

---

## Open knobs

These are not blockers — sensible defaults are above, but worth a second look before shipping:

1. **Care threshold for soulbound release.** Currently 7 days. Could be class-aware (harsh classes get a slightly easier threshold to compensate for higher decay).
2. **Distribution weighting curve.** Currently `floor(sqrt(N))`. Hard cap `min(N, 5)` is simpler; pure linear is more rewarding to whales. The curve is policy, not architecture.
3. **Distribution claim expiry.** Currently 30 days. Could be shorter (forces engagement) or longer (more forgiving).
4. **Request inbox depth K.** Currently 5. Tune based on observed request volume.
5. **Burn slice ratio.** Currently 5/5. Could be 7/3 (more burn) or 3/7 (more distribute). The split is the right knob to revisit if economics feel off.
6. **Reciprocity chip threshold.** Should the chip only render after N interactions? Worth UX testing.

---

## Out of scope (explicitly deferred)

- **Pact system** (unilateral redemption rights, expiry, renounce) — defer until observed reciprocity friction justifies it.
- **Echoes** (ambient claim-pool from others' conjunctions) — additive feature, ship later if onboarding inventory feels thin.
- **Care-earned propagation** (solo path to a second planet via stewardship) — additive, defer.
- **Vigil / adoption** of abandoned planets — requires existing abandoned inventory; revisit post-launch.
- **Cosmic events** (comets, supernovae) — flavor, defer.
- **Merkle-claim refactor for distributions** — only if storage cost becomes painful past ~1k keepers.

---

## Implementation phases

| Phase | Scope | Roughly |
| --- | --- | --- |
| 1 | `claim_first_light` + `reveal_first_light` + soulbound storage + care watermark + UI ritual | Contract + frontend, foundational |
| 2 | `SpentPair` registry + retrofit existing `conjoin` to check/write | Small contract patch; tests |
| 3 | `request_conjoin` / `approve` / `decline` / `cancel` / `reveal_conjoin` + soulbound release on conjoin path + REQUESTS UI panel | Largest single chunk |
| 4 | Distribution pool: snapshot at First Light, `claim_share`, UNCLAIMED OFFERINGS UI, 30-day sweep | Independent, can land in parallel with 3 |

Each phase ships independently; each adds value standalone. Phase 1 is the foundation everything else builds on.

---

## References

- README.md — current game shape, DNA layout, audit cycle
- docs/audits/ — closed and open audit findings (F5, F13 are the ones this design touches)
- MEMORY.md → project_roadmap.md — open audit-finding state
