#!/bin/bash
# Run tests/test_dynamo_local.py against DynamoDB Local (amazon/dynamodb-local in Docker, in-memory, 127.0.0.1 only).
# No AWS account is used: dummy credentials and --endpoint-url on every call.
set -euo pipefail
cd "$(dirname "$0")/.."
port="${DDB_LOCAL_PORT:-8765}"
docker rm -f rs-agent-ddb >/dev/null 2>&1 || true
docker run -d --rm --name rs-agent-ddb -p "127.0.0.1:$port:8000" amazon/dynamodb-local:latest -jar DynamoDBLocal.jar -inMemory >/dev/null
trap 'docker rm -f rs-agent-ddb >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 30); do
  curl --noproxy "*" -s -o /dev/null "http://127.0.0.1:$port" && break
  sleep 0.5
done
RS_AGENT_DDB_LOCAL="http://127.0.0.1:$port" python3 -m unittest tests.test_dynamo_local -v "$@"
