#!/bin/bash
# Run node tooling inside Docker (node/npm are not installed on the host).
# Usage: bin/node.sh npm install | bin/node.sh npx vitest run | bin/node.sh npm run dev
set -euo pipefail
cd "$(dirname "$0")/.."
publish=()
[ "${PUBLISH_8787:-0}" = "1" ] && publish=(-p 127.0.0.1:8787:8787)
exec docker run --rm -i ${publish[@]+"${publish[@]}"} \
  -v "$PWD":/app -w /app \
  -e WRANGLER_SEND_METRICS=false \
  node:22-slim "$@"
