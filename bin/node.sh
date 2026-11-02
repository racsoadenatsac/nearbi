#!/bin/bash
# Run node tooling inside Docker (node/npm are not installed on the host).
# Usage: bin/node.sh npm ci | bin/node.sh npm test | PUBLISH_8787=1 bin/node.sh env SESSION_SECRET=... ADMIN_TOKEN=... npm run dev
set -euo pipefail
cd "$(dirname "$0")/.."
publish=()
[ "${PUBLISH_8787:-0}" = "1" ] && publish=(-p 127.0.0.1:8787:8787)
exec docker run --rm -i ${publish[@]+"${publish[@]}"} \
  -v "$PWD":/app -w /app \
  node:22-slim "$@"
