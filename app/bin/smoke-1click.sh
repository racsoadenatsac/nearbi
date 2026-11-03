#!/bin/bash
# Opt-in LIVE smoke test: real DRY quotes from the 1Click API (no deposit address, no funds, no keys).
# Not part of `npm test` (tests never touch the network).
#   bin/smoke-1click.sh             print quotes for $MONTHLY_PRICE_USD (default 49) from a few assets
#   bin/smoke-1click.sh --record    also rewrite test/fixtures/1click/*.json
# Optional env passed through by name only (values never appear on the command line):
#   SETTLEMENT_ASSET, SETTLEMENT_RECIPIENT, MONTHLY_PRICE_USD, ONECLICK_JWT, ONECLICK_BASE_URL
set -euo pipefail
cd "$(dirname "$0")/.."
envs=()
for v in SETTLEMENT_ASSET SETTLEMENT_RECIPIENT MONTHLY_PRICE_USD ONECLICK_JWT ONECLICK_BASE_URL; do
  [ -n "${!v:-}" ] && envs+=(-e "$v")
done
exec docker run --rm ${envs[@]+"${envs[@]}"} -v "$PWD":/app -w /app node:22-slim \
  node_modules/.bin/tsx scripts/smoke-1click.ts "$@"
