#!/bin/bash
# Run the Repository contract against DynamoDB Local (amazon/dynamodb-local) in Docker. No AWS account needed.
set -euo pipefail
cd "$(dirname "$0")/.."
net=nearbi-ddb-test
docker network create "$net" >/dev/null 2>&1 || true
docker rm -f nearbi-ddb >/dev/null 2>&1 || true
docker run -d --rm --name nearbi-ddb --network "$net" amazon/dynamodb-local:latest -jar DynamoDBLocal.jar -inMemory >/dev/null
trap 'docker rm -f nearbi-ddb >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true' EXIT
sleep 3
docker run --rm --network "$net" -v "$PWD":/app -w /app -e DYNAMODB_ENDPOINT=http://nearbi-ddb:8000 \
  node:22-slim npx vitest run test/adapters/dynamo-local.test.ts "$@"
