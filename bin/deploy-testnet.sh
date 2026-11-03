#!/usr/bin/env bash
# Idempotent TESTNET deployment of the NearBI splitter + mock USDC.
#
#   bin/build.sh            # reproducible WASM -> res/
#   bin/deploy-testnet.sh   # accounts, deploy, init, storage, function-call key
#
# Env: NEARBI_AGENT (default nearbi-agent.testnet), SPLIT_BPS (default 1000).
# Full-access keys: ~/.near-credentials/testnet/<account>.json (chmod 600).
# Agent function-call key: $FC_KEY_FILE (chmod 600). Nothing is written to the repo
# except deploy/testnet.json, which holds public data only.
source "$(dirname "$0")/lib.sh"
SPLIT_BPS="${SPLIT_BPS:-1000}"
SPLITTER_WASM="$ROOT/res/nearbi_splitter.wasm"
TOKEN_WASM="$ROOT/res/usdc_mock.wasm"
for w in "$SPLITTER_WASM" "$TOKEN_WASM"; do [ -f "$w" ] || { echo "missing $w; run bin/build.sh" >&2; exit 1; }; done
(cd "$ROOT/res" && shasum -a 256 -c nearbi_splitter.wasm.sha256 usdc_mock.wasm.sha256 >/dev/null) \
  || { echo "res/*.wasm does not match its .sha256" >&2; exit 1; }
umask 077
mkdir -p "$HOME/.near-credentials" && chmod 700 "$HOME/.near-credentials"
TXS=()

code_hash() {
  rpc query "{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("result",{}).get("code_hash",""))'
}
# NEAR code_hash = base58(sha256(wasm))
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

# 1. agent account (faucet sponsor)
if account_exists "$AGENT"; then
  log "$AGENT exists"
else
  log "creating $AGENT via testnet faucet"
  near_run account create-account sponsor-by-faucet-service "$AGENT" \
    autogenerate-new-keypair save-to-legacy-keychain network-config "$NETWORK" create
  TXS+=("create $AGENT $(last_tx)")
fi

# 2. sub-accounts, funded by the agent
create_sub() { # id amount
  if account_exists "$1"; then log "$1 exists"; return; fi
  log "creating $1 ($2)"
  near_run account create-account fund-myself "$1" "$2" autogenerate-new-keypair save-to-legacy-keychain \
    sign-as "$AGENT" network-config "$NETWORK" sign-with-legacy-keychain send
  TXS+=("create $1 $(last_tx)")
}
create_sub "$SPLITTER" "3.5 NEAR"
create_sub "$TOKEN" "2.5 NEAR"
create_sub "$TREASURY" "0.2 NEAR"
create_sub "$CONTRIBUTORS" "0.2 NEAR"

# 3. mock token
WANT_TOKEN_HASH="$(wasm_code_hash "$TOKEN_WASM")"
if [ "$(code_hash "$TOKEN")" = "$WANT_TOKEN_HASH" ]; then
  log "$TOKEN already deployed ($WANT_TOKEN_HASH)"
else
  [ "$(code_hash "$TOKEN")" = "11111111111111111111111111111111" ] \
    || { echo "$TOKEN has different code; refusing to redeploy (state is initialized)" >&2; exit 1; }
  log "deploying + init $TOKEN (6 decimals, supply 10,000,000 USDCm to $AGENT)"
  near_run contract deploy "$TOKEN" use-file "$TOKEN_WASM" with-init-call new \
    json-args "{\"owner_id\":\"$AGENT\",\"total_supply\":\"10000000000000\"}" \
    prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config "$NETWORK" sign-with-legacy-keychain send
  TXS+=("deploy $TOKEN $(last_tx)")
fi

# 4. splitter
WANT_SPLITTER_HASH="$(wasm_code_hash "$SPLITTER_WASM")"
if [ "$(code_hash "$SPLITTER")" = "$WANT_SPLITTER_HASH" ]; then
  log "$SPLITTER already deployed ($WANT_SPLITTER_HASH)"
else
  [ "$(code_hash "$SPLITTER")" = "11111111111111111111111111111111" ] \
    || { echo "$SPLITTER has different code; upgrade by hand (see README)" >&2; exit 1; }
  log "deploying + init $SPLITTER (split_bps_contributors=$SPLIT_BPS)"
  near_run contract deploy "$SPLITTER" use-file "$SPLITTER_WASM" with-init-call init \
    json-args "{\"owner\":\"$AGENT\",\"treasury\":\"$TREASURY\",\"contributors\":\"$CONTRIBUTORS\",\"split_bps_contributors\":$SPLIT_BPS,\"accepted_tokens\":[\"$TOKEN\"]}" \
    prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config "$NETWORK" sign-with-legacy-keychain send
  TXS+=("deploy $SPLITTER $(last_tx)")
fi

# 5. NEP-145 storage on the token for splitter + payout accounts
for who in "$SPLITTER" "$TREASURY" "$CONTRIBUTORS"; do
  if [ "$(view "$TOKEN" storage_balance_of "{\"account_id\":\"$who\"}")" != "null" ]; then
    log "$who registered on $TOKEN"; continue
  fi
  log "storage_deposit $who on $TOKEN"
  call "$AGENT" "$TOKEN" storage_deposit "{\"account_id\":\"$who\",\"registration_only\":true}" '0.0125 NEAR' '30 Tgas'
  TXS+=("storage $who $(last_tx)")
done

# 6. agent function-call key on the splitter: record_cost + anchor_report only
if [ -f "$FC_KEY_FILE" ]; then
  log "function-call key exists at $FC_KEY_FILE"
else
  log "adding function-call key on $SPLITTER (record_cost, anchor_report; allowance 0.25 NEAR)"
  mkdir -p "$(dirname "$FC_KEY_FILE")" && chmod 700 "$(dirname "$FC_KEY_FILE")"
  # print-to-terminal output is captured here and only the keypair goes to the file
  raw="$("$NEAR" account add-key "$SPLITTER" grant-function-call-access \
      --allowance '0.25 NEAR' --contract-account-id "$SPLITTER" --function-names 'record_cost, anchor_report' \
      autogenerate-new-keypair --signature-scheme ed25519 print-to-terminal \
      network-config "$NETWORK" sign-with-legacy-keychain send 2>&1)" || { echo "add-key failed" >&2; exit 1; }
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
' "$FC_KEY_FILE" "$SPLITTER" > "$ROOT/target-fc-tx.tmp"
  unset raw
  TXS+=("add-fc-key $SPLITTER $(cat "$ROOT/target-fc-tx.tmp")"); rm -f "$ROOT/target-fc-tx.tmp"
fi
FC_PUB="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["public_key"])' "$FC_KEY_FILE")"

# verify the key on chain really is function-call-scoped
rpc query "{\"request_type\":\"view_access_key\",\"finality\":\"final\",\"account_id\":\"$SPLITTER\",\"public_key\":\"$FC_PUB\"}" \
  | python3 -c '
import sys, json
p = json.load(sys.stdin)["result"]["permission"]
fc = p["FunctionCall"]
assert sorted(fc["method_names"]) == ["anchor_report", "record_cost"], fc
assert fc["receiver_id"] == sys.argv[1], fc
print("    on-chain permission OK:", json.dumps(fc))
' "$SPLITTER"

# 7. public deployment record
python3 - "$DEPLOY_JSON" <<PY
import json, sys, os
path = sys.argv[1]
old = json.load(open(path)) if os.path.exists(path) else {}
txs = old.get("txs", [])
for line in """$(printf '%s\n' "${TXS[@]+"${TXS[@]}"}")""".splitlines():
    if line.strip():
        kind, acct, h = (line.split() + ["", "", ""])[:3]
        txs.append({"step": kind, "account": acct, "tx": h, "explorer": f"$EXPLORER/{h}" if h else None})
rec = {
  "network": "$NETWORK",
  "agent": "$AGENT",
  "splitter": "$SPLITTER",
  "treasury": "$TREASURY",
  "contributors": "$CONTRIBUTORS",
  "token": "$TOKEN",
  "token_decimals": 6,
  "split_bps_contributors_at_init": $SPLIT_BPS,
  "splitter_code_hash": "$WANT_SPLITTER_HASH",
  "token_code_hash": "$WANT_TOKEN_HASH",
  "splitter_wasm_sha256": open("$ROOT/res/nearbi_splitter.wasm.sha256").read().split()[0],
  "token_wasm_sha256": open("$ROOT/res/usdc_mock.wasm.sha256").read().split()[0],
  "build_commit": open("$ROOT/res/BUILD_COMMIT").read().strip(),
  "agent_function_call_key": {"public_key": "$FC_PUB", "receiver_id": "$SPLITTER",
                              "method_names": ["record_cost", "anchor_report"], "allowance": "0.25 NEAR"},
  "txs": txs,
}
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump(rec, open(path, "w"), indent=2); open(path, "a").write("\n")
PY
chmod 644 "$DEPLOY_JSON"
log "config:"; view "$SPLITTER" get_config '{}' | python3 -m json.tool
log "deployment record: deploy/testnet.json"
