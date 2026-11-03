#!/usr/bin/env bash
# Shared helpers for testnet scripts. TESTNET ONLY: every call pins
# `network-config testnet`, and require_testnet refuses anything else.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NEAR="$ROOT/.tools/bin/near"
NETWORK=testnet
RPC="${NEAR_TESTNET_RPC:-https://rpc.testnet.fastnear.com}"
EXPLORER="https://testnet.nearblocks.io/txns"
CREDS="$HOME/.near-credentials/$NETWORK"
# public deployment record (no keys) -- committed
DEPLOY_JSON="$ROOT/deploy/testnet.json"

AGENT="${NEARBI_AGENT:-nearbi-agent.testnet}"
SPLITTER="splitter.$AGENT"
TREASURY="treasury.$AGENT"
CONTRIBUTORS="contributors.$AGENT"
TOKEN="usdc-mock.$AGENT"
# where the agent's function-call key lives (outside the repo, chmod 600)
FC_KEY_FILE="${NEARBI_FC_KEY_FILE:-$HOME/.near-credentials/nearbi-fc/$SPLITTER.fc.json}"

require_testnet() {
  for a in "$@"; do
    case "$a" in *.testnet) ;; *) echo "refusing non-testnet account: $a" >&2; exit 1 ;; esac
  done
}
require_testnet "$AGENT"

[ -x "$NEAR" ] || "$ROOT/bin/fetch-near-cli.sh"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }

# Run near-cli-rs, never echo key material. Captures output in $NEAR_OUT.
near_run() {
  local out rc=0
  out="$("$NEAR" "$@" 2>&1)" || rc=$?
  NEAR_OUT="$(printf '%s\n' "$out" | grep -viE 'seed phrase|private.?key|secret|ed25519:[1-9A-HJ-NP-Za-km-z]{60,}')"
  if [ $rc -ne 0 ]; then
    printf '%s\n' "$NEAR_OUT" | tail -25 >&2
    return $rc
  fi
}

# Extract the tx hash from the last near_run output.
last_tx() { printf '%s\n' "$NEAR_OUT" | sed -n 's/.*Transaction ID: *\([1-9A-HJ-NP-Za-km-z]\{40,\}\).*/\1/p' | tail -1; }

rpc() {
  curl -fsS --retry 3 --retry-delay 1 -H 'content-type: application/json' "$RPC" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"rs\",\"method\":\"$1\",\"params\":$2}"
}

account_exists() {
  rpc query "{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}" \
    | python3 -c 'import sys,json; sys.exit(0 if "result" in json.load(sys.stdin) else 1)'
}

# view <contract> <method> <json-args>  -> prints JSON result
view() {
  local args_b64
  args_b64="$(printf '%s' "$3" | base64 | tr -d '\n')"
  rpc query "{\"request_type\":\"call_function\",\"finality\":\"optimistic\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$args_b64\"}" \
    | python3 -c 'import sys,json; r=json.load(sys.stdin); 
if "error" in r or "error" in r.get("result",{}): sys.exit("view failed: %s" % json.dumps(r)[:400])
print(bytes(r["result"]["result"]).decode())'
}

ft_balance() { view "$TOKEN" ft_balance_of "{\"account_id\":\"$1\"}" | tr -d '"'; }

# call <signer> <contract> <method> <json> <deposit> [gas]  (full-access key from legacy keychain)
call() {
  near_run contract call-function as-transaction "$2" "$3" json-args "$4" \
    prepaid-gas "${6:-100 Tgas}" attached-deposit "$5" \
    sign-as "$1" network-config "$NETWORK" sign-with-legacy-keychain send
}

# Print NEP-297 events (all receipts) of a tx.
tx_events() {
  rpc EXPERIMENTAL_tx_status "{\"tx_hash\":\"$1\",\"sender_account_id\":\"$2\",\"wait_until\":\"FINAL\"}" \
    | python3 -c '
import sys, json
r = json.load(sys.stdin)["result"]
for ro in r["receipts_outcome"]:
    for l in ro["outcome"]["logs"]:
        if l.startswith("EVENT_JSON:"):
            e = json.loads(l[len("EVENT_JSON:"):])
            print("   ", ro["outcome"]["executor_id"], "|", e["standard"], e["event"], json.dumps(e.get("data")))
    st = ro["outcome"]["status"]
    if "Failure" in st:
        print("    FAILURE in", ro["outcome"]["executor_id"], json.dumps(st)[:300])
'
}

fmt_usdc() { python3 -c "import sys; v=int(sys.argv[1]); print(f'{v//10**6}.{v%10**6:06d}')" "$1"; }
