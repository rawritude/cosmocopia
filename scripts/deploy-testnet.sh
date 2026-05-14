#!/usr/bin/env bash
# Deploy the Cosmocopia planet contract to Stellar testnet and seed a handful
# of genesis planets to the deployer address.
#
# Requirements:
#   - stellar CLI v25.2+
#   - a funded testnet identity (or pass `--fund` on first run)
#
# Usage:
#   bash scripts/deploy-testnet.sh [IDENTITY_ALIAS]
#
# After it runs, the deployed contract id is appended to web/.env.local.

set -euo pipefail

cd "$(dirname "$0")/.."

ID="${1:-cosmocopia-deployer}"
DRAND="CAESC7SC5EW5P2P3IM5Q7E64ZNDATVSN5F57NTCH5E7GJRPDM76KF7QM"
# Native XLM Stellar Asset Contract on testnet. Used by claim_first_light
# (Phase 1) to charge the 10-XLM observation fee. Override via env var if
# the contract id ever rotates.
NATIVE_TOKEN="${NATIVE_TOKEN:-CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC}"

if ! stellar keys address "$ID" > /dev/null 2>&1; then
  echo "Creating + funding new testnet identity: $ID"
  stellar keys generate --network testnet --fund "$ID"
fi
DEPLOYER=$(stellar keys address "$ID")
echo "Deployer: $DEPLOYER"
# First Light burns half its fee. Default sink: the deployer itself — flip
# this to a dedicated burn account or governance multisig once one exists.
BURN_ADDRESS="${BURN_ADDRESS:-$DEPLOYER}"

echo "--- build wasm ---"
(cd contracts && stellar contract build)

echo "--- deploy ---"
PLANET=$(stellar contract deploy \
  --wasm contracts/target/wasm32v1-none/release/planet.wasm \
  --source "$ID" \
  --network testnet \
  -- \
  --admin         "$DEPLOYER" \
  --drand         "$DRAND" \
  --uri           "ipfs://cosmocopia/" \
  --name          "Cosmocopia" \
  --symbol        "PLN" \
  --native_token  "$NATIVE_TOKEN" \
  --burn_address  "$BURN_ADDRESS" 2>&1 | tail -1)
echo "Planet contract: $PLANET"

# -----------------------------------------------------------------------------
# Commit-reveal seed: commit 4 genesis planets first, then sleep long enough
# for the reveal delay (8 ledgers ≈ 40 s) AND for the target drand rounds
# (observed + 10) to publish. 60 s is a safe margin.
# -----------------------------------------------------------------------------
echo "--- commit 4 genesis planets ---"
COMMIT_IDS=()
for coords in "0 0" "5 5" "-12 8" "30 -10"; do
  read -r x y <<<"$coords"
  OBSERVED=$(stellar contract invoke --id "$DRAND" --source "$ID" --network testnet -- latest \
    2>&1 | tail -1 | python3 -c "import sys,json; print(json.loads(sys.stdin.read())[0])")
  echo "  ($x, $y) observed_round=$OBSERVED"
  CID=$(stellar contract invoke --id "$PLANET" --source "$ID" --network testnet --send=yes -- \
    commit_genesis --to "$DEPLOYER" --observed_round "$OBSERVED" --x "$x" --y "$y" \
    2>&1 | grep -E "^[0-9]+" | tail -1)
  COMMIT_IDS+=("$CID")
  echo "    commitment_id=$CID"
done

echo "--- wait ~60s for reveal delay + drand publications ---"
sleep 60

echo "--- reveal all 4 commitments ---"
for CID in "${COMMIT_IDS[@]}"; do
  stellar contract invoke --id "$PLANET" --source "$ID" --network testnet --send=yes -- \
    reveal_genesis --commitment_id "$CID" 2>&1 | grep -E "token_id" | head -1
done

# Pin the contract id into the web env so the frontend can find it.
ENV=web/.env.local
if [ -f "$ENV" ]; then
  if grep -q "^NEXT_PUBLIC_PLANET_CONTRACT=" "$ENV"; then
    sed -i "s|^NEXT_PUBLIC_PLANET_CONTRACT=.*|NEXT_PUBLIC_PLANET_CONTRACT=$PLANET|" "$ENV"
  else
    echo "NEXT_PUBLIC_PLANET_CONTRACT=$PLANET" >> "$ENV"
  fi
  echo "Wrote NEXT_PUBLIC_PLANET_CONTRACT=$PLANET to $ENV"
fi

echo
echo "✅ Done. Contract on Stellar Expert:"
echo "   https://stellar.expert/explorer/testnet/contract/$PLANET"
