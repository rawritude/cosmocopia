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

if ! stellar keys address "$ID" > /dev/null 2>&1; then
  echo "Creating + funding new testnet identity: $ID"
  stellar keys generate --network testnet --fund "$ID"
fi
DEPLOYER=$(stellar keys address "$ID")
echo "Deployer: $DEPLOYER"

echo "--- build wasm ---"
(cd contracts && stellar contract build)

echo "--- deploy ---"
PLANET=$(stellar contract deploy \
  --wasm contracts/target/wasm32v1-none/release/planet.wasm \
  --source "$ID" \
  --network testnet \
  -- \
  --admin   "$DEPLOYER" \
  --drand   "$DRAND" \
  --uri     "ipfs://cosmocopia/" \
  --name    "Cosmocopia" \
  --symbol  "PLN" 2>&1 | tail -1)
echo "Planet contract: $PLANET"

echo "--- seed 4 genesis planets ---"
for coords in "0 0" "5 5" "-12 8" "30 -10"; do
  read -r x y <<<"$coords"
  ROUND=$(stellar contract invoke --id "$DRAND" --source "$ID" --network testnet -- latest \
    2>&1 | tail -1 | python3 -c "import sys,json; print(json.loads(sys.stdin.read())[0])")
  echo "  ($x, $y) round=$ROUND"
  stellar contract invoke --id "$PLANET" --source "$ID" --network testnet --send=yes -- \
    mint_genesis --to "$DEPLOYER" --round "$ROUND" --x "$x" --y "$y" \
    2>&1 | grep -E "token_id" | head -1
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
