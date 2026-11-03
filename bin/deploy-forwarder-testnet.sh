#!/usr/bin/env bash
# Idempotent TESTNET deployment of the NearBI settlement forwarder.
# Requires the splitter + usdc-mock from bin/deploy-testnet.sh.
#
#   bin/build.sh                    # reproducible WASM -> res/
#   bin/deploy-forwarder-testnet.sh
#
# Creates forwarder.<agent> (contract) and oneclick-sim.<agent> (stands in for
# the 1Click/Verifier sender in bin/demo-intents.sh), deploys + inits the
# forwarder (owner = agent, splitter, token = usdc-mock, agent = the forwarder
# account itself, i.e. its function-call key), storage-registers both on the
# token, adds the agent function-call key limited to [forward] and writes the
# "forwarder" section of deploy/testnet.json (public data only).
#
# Env: FWD_CHANGE_DELAY_SEC (default 0 on testnet so the demo can show a
# change; the contract default and the mainnet setting is 86400).
source "$(dirname "$0")/lib.sh"
FWD_CHANGE_DELAY_SEC="${FWD_CHANGE_DELAY_SEC:-0}"
FWD_WASM="$ROOT/res/nearbi_forwarder.wasm"
[ -f "$FWD_WASM" ] || { echo "missing $FWD_WASM; run bin/build.sh" >&2; exit 1; }
(cd "$ROOT/res" && shasum -a 256 -c nearbi_forwarder.wasm.sha256 >/dev/null) \
  || { echo "res/nearbi_forwarder.wasm does not match its .sha256" >&2; exit 1; }
require_testnet "$FORWARDER" "$ONECLICK_SIM"
for a in "$SPLITTER" "$TOKEN"; do account_exists "$a" || { echo "$a missing; run bin/deploy-testnet.sh" >&2; exit 1; }; done
umask 077
TXS=()

code_hash() {
  rpc query "{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("result",{}).get("code_hash",""))'
}
wasm_code_hash() {
  python3 - "$1" <<'PY'
import hashlib, sys
d = hashlib.sha256(open(sys.argv[1], "rb").read()).digest()
A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
n = int.from_bytes(d, "big"); s = ""
while n: n, r = divmod(n, 58); s = A[r] + s
print("1" * (len(d) - len(d.lstrip(b"\0"))) + s)
PY
}

# 1. accounts, funded by the agent. The WASM (~185 KB) needs ~1.9 NEAR of storage.
create_sub() { # id amount
  if account_exists "$1"; then log "$1 exists"; return; fi
  log "creating $1 ($2)"
  near_run account create-account fund-myself "$1" "$2" autogenerate-new-keypair save-to-legacy-keychain \
    sign-as "$AGENT" network-config "$NETWORK" sign-with-legacy-keychain send
  TXS+=("create $1 $(last_tx)")
}
create_sub "$FORWARDER" "2.3 NEAR"
create_sub "$ONECLICK_SIM" "0.1 NEAR"
chmod 600 "$CREDS/$FORWARDER.json" "$CREDS/$ONECLICK_SIM.json" 2>/dev/null || true
find "$CREDS/$FORWARDER" "$CREDS/$ONECLICK_SIM" -type f -exec chmod 600 {} + 2>/dev/null || true

# 2. forwarder contract
WANT_HASH="$(wasm_code_hash "$FWD_WASM")"
HAVE_HASH="$(code_hash "$FORWARDER")"
if [ "$HAVE_HASH" = "$WANT_HASH" ]; then
  log "$FORWARDER already deployed ($WANT_HASH)"
else
  [ "$HAVE_HASH" = "11111111111111111111111111111111" ] \
    || { echo "$FORWARDER has different code ($HAVE_HASH); refusing to redeploy" >&2; exit 1; }
  log "deploying + init $FORWARDER (splitter=$SPLITTER token=$TOKEN change_delay_sec=$FWD_CHANGE_DELAY_SEC)"
  near_run contract deploy "$FORWARDER" use-file "$FWD_WASM" with-init-call init \
    json-args "{\"owner\":\"$AGENT\",\"splitter\":\"$SPLITTER\",\"token\":\"$TOKEN\",\"agent\":\"$FORWARDER\",\"change_delay_sec\":\"$FWD_CHANGE_DELAY_SEC\"}" \
    prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config "$NETWORK" sign-with-legacy-keychain send
  TXS+=("deploy $FORWARDER $(last_tx)")
fi

# 3. NEP-145 storage on the token (a plain ft_transfer to an unregistered account fails)
for who in "$FORWARDER" "$ONECLICK_SIM"; do
  if [ "$(view "$TOKEN" storage_balance_of "{\"account_id\":\"$who\"}")" != "null" ]; then
    log "$who registered on $TOKEN"; continue
  fi
  log "storage_deposit $who on $TOKEN"
  call "$AGENT" "$TOKEN" storage_deposit "{\"account_id\":\"$who\",\"registration_only\":true}" '0.0125 NEAR' '30 Tgas'
  TXS+=("storage $who $(last_tx)")
done

# 4. agent function-call key on the forwarder: [forward] only
if [ -f "$FWD_FC_KEY_FILE" ]; then
  log "function-call key exists at $FWD_FC_KEY_FILE"
else
  log "adding function-call key on $FORWARDER (forward; allowance 0.5 NEAR)"
  mkdir -p "$(dirname "$FWD_FC_KEY_FILE")" && chmod 700 "$(dirname "$FWD_FC_KEY_FILE")"
  raw="$("$NEAR" account add-key "$FORWARDER" grant-function-call-access \
      --allowance '0.5 NEAR' --contract-account-id "$FORWARDER" --function-names 'forward' \
      autogenerate-new-keypair --signature-scheme ed25519 print-to-terminal \
      network-config "$NETWORK" sign-with-legacy-keychain send 2>&1)" || { echo "add-key failed" >&2; exit 1; }
  TXF="$(mktemp)"
  printf '%s' "$raw" | python3 -c '
import sys, re, json, os
t = sys.stdin.read()
pub = re.search(r"Public key[^:]*:\s*(ed25519:[1-9A-HJ-NP-Za-km-z]+)", t, re.I)
sec = re.search(r"(?:SECRET KEYPAIR|Secret key|Private key)[^:]*:\s*(ed25519:[1-9A-HJ-NP-Za-km-z]+)", t, re.I)
tx = re.search(r"Transaction ID:\s*([1-9A-HJ-NP-Za-km-z]{40,})", t)
if not (pub and sec): sys.exit("could not parse generated keypair (key NOT saved)")
path, acct = sys.argv[1], sys.argv[2]
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump({"account_id": acct, "public_key": pub.group(1), "private_key": sec.group(1)}, f)
print(tx.group(1) if tx else "")
' "$FWD_FC_KEY_FILE" "$FORWARDER" > "$TXF"
  unset raw
  TXS+=("add-fc-key $FORWARDER $(cat "$TXF")"); rm -f "$TXF"
fi
FC_PUB="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["public_key"])' "$FWD_FC_KEY_FILE")"
rpc query "{\"request_type\":\"view_access_key\",\"finality\":\"final\",\"account_id\":\"$FORWARDER\",\"public_key\":\"$FC_PUB\"}" \
  | python3 -c '
import sys, json
p = json.load(sys.stdin)["result"]["permission"]
fc = p["FunctionCall"]
assert fc["method_names"] == ["forward"], fc
assert fc["receiver_id"] == sys.argv[1], fc
print("    on-chain permission OK:", json.dumps(fc))
' "$FORWARDER"

# 5. public deployment record: deploy/testnet.json "forwarder" section
python3 - "$DEPLOY_JSON" <<PY
import json, sys, os
path = sys.argv[1]
rec = json.load(open(path)) if os.path.exists(path) else {}
old = rec.get("forwarder", {})
txs = old.get("txs", [])
for line in """$(printf '%s\n' "${TXS[@]+"${TXS[@]}"}")""".splitlines():
    if line.strip():
        kind, acct, h = (line.split() + ["", "", ""])[:3]
        txs.append({"step": kind, "account": acct, "tx": h, "explorer": f"$EXPLORER/{h}" if h else None})
rec["forwarder"] = {
  "contract": "$FORWARDER",
  "owner": "$AGENT",
  "splitter": "$SPLITTER",
  "token": "$TOKEN",
  "agent": "$FORWARDER",
  "change_delay_sec_at_init": int("$FWD_CHANGE_DELAY_SEC"),
  "oneclick_simulator": "$ONECLICK_SIM",
  "code_hash": "$WANT_HASH",
  "wasm_sha256": open("$ROOT/res/nearbi_forwarder.wasm.sha256").read().split()[0],
  "build_commit": open("$ROOT/res/BUILD_COMMIT").read().strip(),
  "agent_function_call_key": {"public_key": "$FC_PUB", "receiver_id": "$FORWARDER",
                              "method_names": ["forward"], "allowance": "0.5 NEAR"},
  "txs": txs,
}
json.dump(rec, open(path, "w"), indent=2); open(path, "a").write("\n")
PY
chmod 644 "$DEPLOY_JSON"
log "config:"; view "$FORWARDER" get_config '{}' | python3 -m json.tool
log "deployment record: $DEPLOY_JSON (forwarder)"
