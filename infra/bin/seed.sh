#!/bin/bash
# Seed the report catalog into DynamoDB with the app's own seed script (runs in node:22-slim).
# Short-lived SSO credentials are exported into the container's environment only (never written to disk).
# Usage: AWS_PROFILE=nearbi bin/seed.sh [app-dir]
set -euo pipefail
cd "$(dirname "$0")/.."
app="$(cd "${1:-../nearbi-app}" && pwd)"
table=$(tofu -chdir=tofu output -raw table_name)
eval "$(aws configure export-credentials --format env)"
docker run --rm -v "$app":/app -w /app \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
  -e AWS_REGION=us-east-1 -e TABLE_NAME="$table" \
  node:22-slim npx tsx src/seed.ts
