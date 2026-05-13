# Cosmocopia

> Tiny pixel-art worlds, on-chain on Stellar. Conjoin two planets — get a new one. Care for them or they wither.

![Cosmocopia](docs/screenshot.png)

*Live read from the testnet contract — the top "preview" row shows four planets minted via the **commit-reveal flow** on testnet. Per-card vitals bars come from `vitals_of` on chain. Below that, the tinker panel renders any 32-byte DNA you paste, and the genesis gallery shows fixed-seed showcase planets that span the class space.*

Cosmocopia is an Axie-style collection-of-creatures project, but instead of monsters they are **planets**: each a 96×96 pixel art world programmatically rendered from on-chain DNA, born from drand-verified randomness on Stellar/Soroban.

The deliberate non-goal: no game / no PvP / no economy beyond mint + conjoin + care. The fun lives in the genetics, the art, and the galaxy map.

## The big ideas

### Planets
A planet is a Soroban NFT with two pieces of state:

- **DNA** — 32 immutable bytes, set at mint, drives every visual trait.
- **Vitals** — 5 mutable stats that decay over ledger time and respond to interactions.

### Conjunction (the breeding mechanic, renamed)
The astronomical term for "two bodies meeting in the sky" is a **conjunction**. We use it as our verb:

> *Conjoin* two planets, and at the next drand round a third planet is **conceived**.

Two parents → child whose DNA is a per-byte crossover of theirs, with a small mutation rate driven by drand randomness. Stats are averaged with noise. Cooldowns and a small XLM fee keep it interesting.

### Care
Planets are not idle. Each has five vitals (0–255):

| Vital | Decays from | Restored by |
| --- | --- | --- |
| Temperature | Cold sectors, ice/void classes | `warm` (sun ritual) |
| Hydration | Lava class, desert sectors | `rain` (cloud seeding) |
| Gravity | Long quiet stretches | `tide` (gravity pulse) |
| Biomass | Inactivity, void class | `tend` (gardening) |
| Spirit | Isolation in the galaxy | `reflect`, nearby neighbors |

Stats outside `[40, 220]` reduce conjunction success and add a "sickly" aura overlay to the rendered art. Care recipe differs by class — watering a Lava planet hurts it.

### Galaxy

![Galaxy map](docs/galaxy.png)

*The `/galaxy` page is a live 2D map of every minted planet at its on-chain `(x, y)`. Concentric dashed rings mark the five sectors; the same `r²` thresholds drive [`stats::project`](contracts/planet/src/stats.rs) so a planet's location actually shapes its decay. Pan with drag, zoom with the wheel, click a planet for stats + DNA + owner.*

Each planet has `(x, y)` coordinates in an integer grid. The grid is partitioned into five **sectors** that each apply stat drift modifiers (boundaries are `r²` thresholds — integer math, no sqrt — see [`galaxy::sector_of`](contracts/planet/src/galaxy.rs)):

| Sector | `r <` | Drift on (temp, hydro, gravity, biomass, spirit) per period |
| --- | --- | --- |
| *Inner Core* | 5 | (+1, −1, +2, 0, 0) — high gravity, slow decay |
| *Habitable Belt* | 15 | (0, 0, 0, +1, +1) — neutral, social bonus |
| *Asteroid Field* | 30 | (0, −1, +1, −2, 0) — biomass↓ |
| *Frontier* | 50 | (−1, 0, 0, −1, +2) — spirit↑ from isolation |
| *Outer Dark* | ∞ | (−2, −1, −1, −1, −1) — harsh, exotic |

Distance between two parents sets the **conjunction cost** (not yet implemented — see roadmap) and, indirectly, the mutation rate. Two neighbours yield cheap, conservative children; opposites yield expensive, exotic ones.

Three additional sector ideas (*Nebula*, *Singularity*, *Edge*) are in the roadmap but not in the current contract — adding them is a one-line table extension in `stats.rs` plus a threshold in `galaxy.rs`.

## DNA layout (32 bytes)

```
0   class_gene    high nibble = class (16 classes) | low nibble = dominance map
1   surface_gene  high = pattern (striped/spotted/swirled/cracked/smooth/...) | low = rings (0-15)
2   atmosphere_gene  none/thin/thick/storm/aurora/toxic/sparkle/eclipse/halo + density
3   feature_gene  craters/oceans/mountains/forests/cities/eyes/volcanoes/runes/blossoms
4   moon_gene     count (0-4) + style + tilt
5   aura_gene     none/halo/glow/shadow/pulse/aurora/static + intensity
6   palette_hue   base hue (0-255 ≈ 0-360°)
7   palette_meta  scheme (mono/analogous/complementary/triadic/split) + sat + lum
8-11 parent_mix   parent DNA XOR-mixed (lineage signature)
12-15 birth_round drand round at mint (u32 BE) — also reproducible seed
16   generation   0 for genesis, parent_max + 1 otherwise
17   affinity_rarity  affinity (solar/lunar/void/storm) | rarity bits
18-31 reserved    14 bytes of headroom for future traits & uniqueness salt
```

16 classes: `Rocky, Gas, Ocean, Lava, Ice, Desert, Jungle, Crystal, Void, Forge, Bloom, Cinder, Mist, Quartz, Hollow, Aether`.

## Architecture

```
cosmocopia/
├── contracts/                  # Soroban Rust workspace
│   ├── Cargo.toml              # workspace + pinned OpenZeppelin stellar-* crates
│   └── planet/                 # One contract — all the logic
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs          # NonFungibleToken impl + entrypoints
│           ├── dna.rs          # DNA encoding/decoding + crossover
│           ├── stats.rs        # vitals + decay + care
│           ├── galaxy.rs       # coords + sector lookup + distance
│           └── drand.rs        # cross-contract client for Drand-Relay verifier
├── art/                        # Deterministic pixel-art renderer (pure TS)
│   └── src/
│       ├── dna.ts              # 32-byte parser matching contract layout
│       ├── palette.ts          # HSL palette schemes
│       ├── layers/             # core, surface, atmosphere, rings, features, moons, aura
│       └── render.ts           # Compose layers → ImageData / PNG
├── web/                        # Next.js dApp
│   └── src/
│       ├── app/                # galaxy / planet / conjunction pages
│       ├── lib/stellar.ts      # Wallets Kit + contract bindings
│       └── components/Planet.tsx
├── scripts/
│   ├── deploy.sh               # build + deploy contract to testnet
│   └── mint-genesis.sh         # admin batch-mint of seed planets
└── README.md
```

## External dependencies

- **Drand-Relay** ([kaankacar/Drand-Relay](https://github.com/kaankacar/Drand-Relay)) — testnet verifier `CAESC7SC5EW5P2P3IM5Q7E64ZNDATVSN5F57NTCH5E7GJRPDM76KF7QM`. Used as the source of fair, externally-verifiable randomness for every mint and conjunction.
- **OpenZeppelin stellar-contracts** ([repo](https://github.com/OpenZeppelin/stellar-contracts)) — `stellar-tokens::non_fungible` for the NFT base, `stellar-access::ownable` for admin gating, `stellar-macros` for `#[only_owner]`.
- **OpenZeppelin Contracts Wizard** — used to seed the initial NFT shell (Stellar tab on wizard.openzeppelin.com or the `@openzeppelin/wizard-stellar` npm package).
- **Smart Account Kit** ([kalepail/smart-account-kit](https://github.com/kalepail/smart-account-kit), published on npm as `smart-account-kit`) — passkey-based smart wallets. Testnet WASM hash `8537b8166c0078440a5324c12f6db48d6340d157c306a54c5ea81405abcc2611`, WebAuthn verifier `CCMR63YE5T7MPWREF3PC5XNTTGXFSB4GYUGUIT5POHP2UGCS65TBIUUU`.
- **Stellar Wallets Kit** ([Creit-Tech/Stellar-Wallets-Kit](https://github.com/Creit-Tech/Stellar-Wallets-Kit), JSR package `@creit-tech/stellar-wallets-kit`) — modal adapter for Freighter, xBull, Albedo, Lobstr, Rabet, Hana, etc.

## Mint flow: commit-reveal

Every mint and conjunction is a **two-step commit-reveal** so the caller cannot peek the random seed before submitting:

1. **Commit** — caller supplies `observed_round` (the latest drand round they can see). Contract stores `target_round = observed_round + 10` and stamps `commit_ledger = now`. Emits a `Committed` event with the commitment id.
2. **Wait** — `MIN_REVEAL_DELAY_LEDGERS = 8` ledgers (~40 s, ~13 drand rounds).
3. **Reveal** — anyone can call `reveal_genesis(id)` / `reveal_conjoin(id)`. Contract verifies the delay elapsed, fetches `drand.get(target_round)`, computes the DNA, mints, deletes the commitment.

Because the reveal delay (13 drand rounds) is strictly larger than the lookahead (10 rounds), the target round's randomness is provably published *after* the commit landed — there is no round whose seed the user could have inspected at commit time to pick a favorable child. Lying about `observed_round` doesn't help: the reveal-time ledger gap is independent of the caller's claim.

`submitConjoin` on the frontend orchestrates this in one call:

```
committing → waiting (polls reveal_after) → revealing → done
```

Pass an `onProgress` callback to surface phase to the UI; `submitCommitConjoin` and `submitRevealConjoin` are also exported as separate halves if you need to defer the reveal.

## Sign-in

The frontend offers both paths side-by-side. Users pick at connect time:

- **Continue with a passkey** — Smart Account Kit deploys a smart-account contract on testnet, gas-sponsored, signed via WebAuthn. No extension needed; works on iOS/macOS/Android/Windows Hello. Returns a `C...` contract address as the signing identity.
- **Connect an existing wallet** — Stellar Wallets Kit's auth modal lists installed wallets. Returns a `G...` public key as the signing identity.

Either identity is passed to the planet contract as the `to:` / owner address. Configure via `web/.env.local`.

### Trying the passkey flow end-to-end

For a passkey-owned smart account to actually *do* anything on chain, it needs to own a planet first (the contract's `care`/`conjoin` calls require the planet's owner to authorize). The seeded planets all start owned by the deployer. To hand one over:

```bash
# 1. Connect with a passkey at http://localhost:3030 → note the C... contract address
# 2. Transfer one of the genesis planets to that address:
bash scripts/transfer-planet.sh 1 CXXXXXXX...
# 3. Refresh the page → your gallery now includes that planet → click a care button.
```

The care button triggers a WebAuthn prompt; on confirmation, Smart Account Kit signs the auth entry, re-simulates, and submits.

## Live deployment

Contract: [`CB2YFH74ZJDTWELOVK4JYL5LP4A6LCTPSDTDWIFDUDERXV2TPZ7UCKDK`](https://stellar.expert/explorer/testnet/contract/CB2YFH74ZJDTWELOVK4JYL5LP4A6LCTPSDTDWIFDUDERXV2TPZ7UCKDK) on Stellar testnet. Carries the D/R1/R2 dominance allele system, audit fixes M1-M4, the `RecessiveEmerged` event, and game-audit F2/F9.

Tests: **40 contract** (Rust, soroban-sdk testutils) + **17 frontend** (Vitest, mocked Client + wallet kits) + **43 art renderer** (Node test runner, deterministic + trait→pixel propagation + rarity scorer + scene composer). All green in CI.

## Roadmap

- [x] Repo scaffold + design
- [x] Soroban workspace + planet contract
- [x] Contract unit tests (29 — DNA crossover, auth gates, cooldown, healthy gate, commit-reveal flow)
- [x] Pixel-art TS renderer (16 tests covering layout parity + trait→pixel propagation)
- [x] Next.js frontend with dual-wallet sign-in
- [x] Galaxy map at `/galaxy`
- [x] Testnet deploy script + genesis seeding
- [x] **Commit-reveal mint** — anti-grinding two-step flow with strict reveal-delay guarantee
- [x] **NonFungibleEnumerable** — `total_supply` / `get_token_id` / `get_owner_token_id`, no more brute-force scanning
- [x] **TTL extensions** on care/migrate/views/transfer (closes silent data loss after 30 d)
- [x] **Admin/drand rotation** (`set_admin`, `set_drand`) + `ConfigChanged` event
- [x] Security audit (multi-page, surfaced 24 findings; 12 closed in code, others tracked)
- [x] CI — fmt, clippy, cargo test, art tests, vitest, web build, wasm size guard
- [ ] Stat-aware art overlays (sickly / blooming)
- [ ] Indexer-backed listing (events → Postgres) so the frontend scales past ~1k tokens
- [ ] Smart-account-kit `executeAndSubmit` for cross-owner conjoin (currently single-owner only)
- [ ] Mainnet deployment
