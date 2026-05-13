#!/usr/bin/env bash
# Transfer one of the seeded planets to a smart-account address so a passkey
# user can take care actions against a planet they actually own.
#
# Usage:
#   bash scripts/transfer-planet.sh <TOKEN_ID> <RECIPIENT_C_ADDRESS> [IDENTITY_ALIAS]
#
# Example:
#   bash scripts/transfer-planet.sh 1 CABC...XYZ

set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <token_id> <recipient> [identity_alias]" >&2
  exit 1
fi

TOKEN_ID=$1
TO=$2
ID=${3:-cosmocopia-deployer}

FROM=$(stellar keys address "$ID")

# Pull the contract id from web/.env.local so this stays in sync with deploys.
PLANET=$(grep '^NEXT_PUBLIC_PLANET_CONTRACT=' web/.env.local | cut -d= -f2)
if [ -z "$PLANET" ]; then
  echo "no NEXT_PUBLIC_PLANET_CONTRACT in web/.env.local — run scripts/deploy-testnet.sh first" >&2
  exit 1
fi

echo "Transferring planet #$TOKEN_ID"
echo "  from: $FROM ($ID)"
echo "  to:   $TO"
echo "  via:  $PLANET"

stellar contract invoke \
  --id "$PLANET" \
  --source "$ID" \
  --network testnet \
  --send=yes \
  -- transfer \
  --from "$FROM" \
  --to "$TO" \
  --token_id "$TOKEN_ID" 2>&1 | tail -6
