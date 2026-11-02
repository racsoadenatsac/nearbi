#!/bin/bash
# Build the nearbi-app Lambda bundle with the app's own Docker wrapper (no host node).
# Usage: bin/build-app.sh [app-dir]   (default: ../nearbi-app)
set -euo pipefail
cd "$(dirname "$0")/.."
app="${1:-../nearbi-app}"
( cd "$app" && git describe --tags --always --dirty && bin/node.sh npm ci && bin/node.sh npm run build )
ls -l "$app/dist/lambda/index.mjs"
