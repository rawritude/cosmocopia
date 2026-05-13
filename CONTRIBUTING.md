# Contributing to Cosmocopia

Quick setup:

```bash
git clone https://github.com/rawritude/cosmocopia
cd cosmocopia
npm install                                # workspace deps
cp web/.env.example web/.env.local         # public testnet defaults
```

## Layout

- `contracts/` — Soroban Rust workspace (single `planet` contract).
- `art/` — deterministic pixel-art renderer (TS, no on-chain deps).
- `web/` — Next.js 15 frontend with dual wallet support.
- `scripts/` — deploy & ops helpers.

## Working on the contract

```bash
cd contracts
cargo fmt --all -- --check          # style
cargo clippy --all-targets --workspace -- -D warnings
cargo test --workspace              # 17 tests
stellar contract build              # wasm output in target/wasm32v1-none/release/
```

To deploy your own copy of the contract to testnet and seed a few genesis planets:

```bash
bash scripts/deploy-testnet.sh
```

The script writes the new `NEXT_PUBLIC_PLANET_CONTRACT` into `web/.env.local`.
After redeploy, regenerate the TS bindings the frontend uses:

```bash
npm run gen:bindings
```

## Working on the frontend

```bash
npm --workspace @cosmocopia/web run dev    # localhost:3030 with turbopack
npm --workspace @cosmocopia/web run test   # vitest, 13 tests
npm --workspace @cosmocopia/web run build  # production build
```

`?view=<G-address>` previews any address's gallery without connecting a wallet — handy for screenshots and demos.

## Working on the art renderer

```bash
npm --workspace @cosmocopia/art run test                            # determinism tests
npm --workspace @cosmocopia/art run render -- random out.png 4     # one-off render
```

The `Dna` parser in `art/src/dna.ts` must match the byte layout in `contracts/planet/src/dna.rs` exactly. Any contract change touching DNA layout needs a paired TS update.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and on PRs:

- contract: fmt --check, clippy -D warnings, cargo test, stellar contract build, wasm-size guard (<50 KB)
- web: art tests, vitest, bindings typecheck, next build

PRs should be green before merge.

## Conventions

- Commits: present tense, scope-prefixed (`feat(web):`, `test(contract):`, `chore:`, `fix:`).
- One commit per logical change. Avoid `wip:` commits on `main`.
- Don't commit `web/.env.local` — it's gitignored. Public testnet defaults belong in `web/.env.example`.

## Releasing

- Tag with `vX.Y.Z`.
- A redeploy of the contract is required for any ABI-changing PR; remember to bump bindings + `NEXT_PUBLIC_PLANET_CONTRACT`.
