#!/usr/bin/env bash
# NearBI MAINNET helpers. Contains NO key material.
#
# The temporary deploy key (full access on nearbi.near, splitter.nearbi.near and,
# during the deploy, forwarder.nearbi.near) is read from the macOS Keychain at call
# time into a shell variable and handed to near-cli through a /dev/fd pipe: never
# written to disk, never on argv, never logged. Agent function-call keys are stored
# in the Keychain as nearbi-mainnet-fc-<account> (written through `security -i`
# on stdin, so the secret is not on argv either).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NEAR="$ROOT/.tools/bin/near"
NET="${NEARBI_MAINNET_NETWORK:-mainnet-fastnear}"
RPC="${NEARBI_MAINNET_RPC:-https://rpc.mainnet.fastnear.com}"
EXPLORER="https://nearblocks.io/txns"
DEPLOY_JSON="$ROOT/deploy/mainnet.json"

OWNER=nearbi.near
SPLITTER=splitter.nearbi.near
FORWARDER=forwarder.nearbi.near
CONTRIBUTORS=contributors.nearbi.near
TREASURY=nearbi.near
# Circle USDC on NEAR (native, 6 decimals)
USDC=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1
TEMP_PUB=ed25519:FvLoT3qgjGRKhsPvMVFtpuLyvKkY8QU6tSTw3DzoJKFZ
OPERATOR_PUB=ed25519:ECakcb9RVhPxbxkKyCWY4V2hY1RaP3TeffHLQrrzBS34
TEMP_KEYCHAIN_SERVICE=nearbi-mainnet-deploy
LOG="${NEARBI_MAINNET_LOG:-$HOME/.local/state/nearbi-mainnet/logs/nearbi-mainnet-deploy-$(date -u +%F).log}"
mkdir -p "$(dirname "$LOG")"
[ -x "$NEAR" ] || "$ROOT/bin/fetch-near-cli.sh"

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG" >&2; }
scrub() { grep -viE 'seed phrase|private.?key|secret|ed25519:[1-9A-HJ-NP-Za-km-z]{60,}' || true; }
die() { log "STOP: $*"; exit 1; }

rpc() {
  curl -fsS --retry 3 --retry-delay 2 -H 'content-type: application/json' "$RPC" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"rs\",\"method\":\"$1\",\"params\":$2}"
}
# account <id> -> "amount storage_usage code_hash" or MISSING
account() { rpc query "{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}" \
  | python3 -c 'import sys,json; r=json.load(sys.stdin).get("result")
print("MISSING" if not r else "%s %s %s" % (r["amount"], r["storage_usage"], r["code_hash"]))'; }
amount() { account "$1" | cut -d' ' -f1; }
code_hash() { account "$1" | cut -d' ' -f3; }
keys() { rpc query "{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$1\"}" \
  | python3 -c 'import sys,json; r=json.load(sys.stdin)["result"]; [print(k["public_key"], json.dumps(k["access_key"]["permission"])) for k in r["keys"]]'; }
view() {
  local a; a="$(printf '%s' "$3" | base64 | tr -d '\n')"
  rpc query "{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$a\"}" \
    | python3 -c 'import sys,json; r=json.load(sys.stdin)
if "error" in r or "error" in r.get("result",{}): sys.exit("view failed: %s" % json.dumps(r)[:400])
print(bytes(r["result"]["result"]).decode())'
}
near_fmt() { python3 -c 'import sys; print(f"{int(sys.argv[1])/1e24:.6f}")' "$1"; }
wasm_code_hash() { python3 - "$1" <<'PY'
import hashlib, sys
d = hashlib.sha256(open(sys.argv[1], "rb").read()).digest()
A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
n = int.from_bytes(d, "big"); s = ""
while n: n, r = divmod(n, 58); s = A[r] + s
print("1" * (len(d) - len(d.lstrip(b"\0"))) + s)
PY
}

# temp_signed <display|send> <near args up to and incl. "network-config $NET">
# Appends: sign-with-access-key-file /dev/fd/N <mode>. Output scrubbed + logged; sets NEAR_OUT.
temp_signed() {
  local mode="$1"; shift
  local sk rc=0 out
  sk="$(security find-generic-password -s "$TEMP_KEYCHAIN_SERVICE" -w)"
  out="$("$NEAR" "$@" sign-with-access-key-file \
        <(printf '{"public_key":"%s","private_key":"%s"}' "$TEMP_PUB" "$sk") "$mode" 2>&1)" || rc=$?
  sk=""; unset sk
  NEAR_OUT="$(printf '%s\n' "$out" | scrub)"; out=""
  { echo "---- near ${*} [$mode] rc=$rc"; printf '%s\n' "$NEAR_OUT"; } >> "$LOG"
  printf '%s\n' "$NEAR_OUT" | grep -E 'Transaction ID|Error|error|Gas burned|fee' | tail -8 >&2 || true
  return $rc
}
last_tx() { printf '%s\n' "$NEAR_OUT" | sed -n 's/.*Transaction ID: *\([1-9A-HJ-NP-Za-km-z]\{40,\}\).*/\1/p' | tail -1; }
# tx_ok <hash> <sender>: every receipt succeeded (else prints failures, returns 1)
tx_ok() {
  rpc EXPERIMENTAL_tx_status "{\"tx_hash\":\"$1\",\"sender_account_id\":\"$2\",\"wait_until\":\"FINAL\"}" | python3 -c '
import sys, json
r = json.load(sys.stdin)["result"]; bad = 0
for ro in [r["transaction_outcome"]] + r["receipts_outcome"]:
    st = ro["outcome"]["status"]
    if "Failure" in st: bad = 1; print("FAILURE", ro["outcome"]["executor_id"], json.dumps(st)[:400])
    for l in ro["outcome"]["logs"]: print("  log", ro["outcome"]["executor_id"], l[:300])
print("final status:", list(r["status"].keys())[0]); sys.exit(1 if (bad or "Failure" in r["status"]) else 0)' | tee -a "$LOG" >&2
}

# Keychain: store a NEAR secret key read from stdin (never argv) under nearbi-mainnet-fc-<account>.
keychain_put_fc() { # account  (secret on stdin)
  local sk; IFS= read -r sk
  printf 'add-generic-password -U -s "nearbi-mainnet-fc-%s" -a "%s" -l "NearBI mainnet FC key %s" -w "%s"\n' \
    "$1" "$1" "$1" "$sk" | security -i >/dev/null
  sk=""; unset sk
}
# keychain_fc_matches <account> <public key>: the stored secret's embedded public half equals <pub>
keychain_fc_matches() {
  security find-generic-password -s "nearbi-mainnet-fc-$1" -w | python3 -c '
import sys
A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58d(s):
    n = 0
    for c in s: n = n * 58 + A.index(c)
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return b"\0" * (len(s) - len(s.lstrip("1"))) + b
sk = sys.stdin.read().strip(); pub = sys.argv[1]
assert sk.startswith("ed25519:") and pub.startswith("ed25519:")
raw = b58d(sk[8:]); p = b58d(pub[8:])
sys.exit(0 if len(raw) == 64 and raw[32:] == p else 1)' "$2"
}
