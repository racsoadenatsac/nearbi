#!/usr/bin/env bash
# Full NearBI sale loop on TESTNET (mock USDC, no real funds):
#   1. a fresh customer account is created via the testnet faucet
#   2. it registers on usdc-mock and receives 49 USDCm
#   3. it pays 49.000000 with ft_transfer_call + order_id -> splitter
#   4. the contract splits in the same call: contributors 4.9, treasury 44.1
#   5. the agent records an inference cost and anchors a report hash,
#      signing with its FUNCTION-CALL key (no full-access key involved)
#   6. the same key is shown to be rejected for set_split
# Prints balances before/after, tx hashes, explorer links, events, and the duration.
#   CUSTOMER=<existing>.testnet bin/demo.sh   # reuse a customer (skip faucet)
source "$(dirname "$0")/lib.sh"
START=$(date +%s)
PRICE=49000000          # 49.000000 USDCm
ORDER_ID="demo-$(date -u +%Y%m%dT%H%M%SZ)"
[ -f "$FC_KEY_FILE" ] || { echo "no function-call key at $FC_KEY_FILE; run bin/deploy-testnet.sh" >&2; exit 1; }
declare -a LINKS=()
step() { printf '\n\033[1m[%3ss] %s\033[0m\n' "$(( $(date +%s) - START ))" "$*"; }
record_tx() { # label signer
  local h; h="$(last_tx)"
  [ -n "$h" ] || { echo "no tx hash for $1" >&2; exit 1; }
  echo "    tx: $h"
  echo "    $EXPLORER/$h"
  LINKS+=("$1|$h")
  tx_events "$h" "$2"
}

CFG="$(view "$SPLITTER" get_config '{}')"
BPS="$(printf '%s' "$CFG" | python3 -c 'import sys,json; print(json.load(sys.stdin)["split_bps_contributors"])')"
step "splitter $SPLITTER  split_bps_contributors=$BPS  token=$TOKEN"

# 1. customer
if [ -z "${CUSTOMER:-}" ]; then
  CUSTOMER="nearbi-cust-$(date +%s).testnet"
  step "creating customer $CUSTOMER via faucet"
  near_run account create-account sponsor-by-faucet-service "$CUSTOMER" \
    autogenerate-new-keypair save-to-legacy-keychain network-config "$NETWORK" create
  record_tx "create customer" "$CUSTOMER"
fi
require_testnet "$CUSTOMER"

# 2. register + fund the customer with mock USDC
step "customer registers on $TOKEN"
if [ "$(view "$TOKEN" storage_balance_of "{\"account_id\":\"$CUSTOMER\"}")" = "null" ]; then
  call "$CUSTOMER" "$TOKEN" storage_deposit "{\"account_id\":\"$CUSTOMER\",\"registration_only\":true}" '0.0125 NEAR' '30 Tgas'
  record_tx "storage_deposit customer" "$CUSTOMER"
else
  echo "    already registered"
fi
step "mock-USDC drip: $AGENT -> $CUSTOMER 49.000000 USDCm"
call "$AGENT" "$TOKEN" ft_transfer "{\"receiver_id\":\"$CUSTOMER\",\"amount\":\"$PRICE\",\"memo\":\"testnet demo drip\"}" '1 yoctoNEAR' '30 Tgas'
record_tx "drip" "$AGENT"

balances() {
  for a in "$CUSTOMER" "$SPLITTER" "$CONTRIBUTORS" "$TREASURY"; do
    printf '%s=%s\n' "$a" "$(ft_balance "$a")"
  done
}
show() { while IFS='=' read -r a v; do printf '    %-48s %16s USDCm\n' "$a" "$(fmt_usdc "$v")"; done <<<"$1"; }
BEFORE="$(balances)"
step "balances BEFORE"; show "$BEFORE"

# 3. pay
step "customer pays 49.000000 USDCm: ft_transfer_call -> $SPLITTER  msg={\"order_id\":\"$ORDER_ID\"}"
call "$CUSTOMER" "$TOKEN" ft_transfer_call \
  "{\"receiver_id\":\"$SPLITTER\",\"amount\":\"$PRICE\",\"msg\":\"{\\\"order_id\\\":\\\"$ORDER_ID\\\"}\"}" \
  '1 yoctoNEAR' '150 Tgas'
record_tx "sale ft_transfer_call" "$CUSTOMER"
AFTER="$(balances)"
step "balances AFTER"; show "$AFTER"

python3 - "$BEFORE" "$AFTER" "$PRICE" "$BPS" "$CUSTOMER" "$SPLITTER" "$CONTRIBUTORS" "$TREASURY" <<'PY'
import sys
b = dict(l.split("=") for l in sys.argv[1].splitlines())
a = dict(l.split("=") for l in sys.argv[2].splitlines())
price, bps = int(sys.argv[3]), int(sys.argv[4])
cust, spl, con, tre = sys.argv[5:9]
d = {k: int(a[k]) - int(b[k]) for k in a}
exp_c = price // 10000 * bps + (price % 10000) * bps // 10000
exp_t = price - exp_c
f = lambda v: f"{v/1e6:+.6f}"
print(f"    delta customer {f(d[cust])}  contributors {f(d[con])}  treasury {f(d[tre])}  splitter {f(d[spl])}")
ok = d[cust] == -price and d[con] == exp_c and d[tre] == exp_t and d[spl] == 0
print(f"    expected contributors {exp_c/1e6:.6f} + treasury {exp_t/1e6:.6f} = {price/1e6:.6f}  ->", "SPLIT OK" if ok else "SPLIT MISMATCH")
sys.exit(0 if ok else 1)
PY

# 5. agent actions with the function-call key
fc_call() { # method json
  near_run contract call-function as-transaction "$SPLITTER" "$1" json-args "$2" \
    prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$SPLITTER" \
    network-config "$NETWORK" sign-with-access-key-file "$FC_KEY_FILE" send
}
step "agent (function-call key) record_cost inference 0.012500 USD"
fc_call record_cost "{\"kind\":\"inference\",\"amount_usd_micros\":\"12500\",\"ref\":\"nearai:$ORDER_ID\"}"
record_tx "record_cost" "$SPLITTER"

MANIFEST="$(printf '{"order_id":"%s","report":"demo-quick","queries":["q1.sql"],"results_sha256":["%s"]}' \
  "$ORDER_ID" "$(printf 'demo-result-%s' "$ORDER_ID" | shasum -a 256 | cut -d' ' -f1)")"
MANIFEST_SHA="$(printf '%s' "$MANIFEST" | shasum -a 256 | cut -d' ' -f1)"
step "agent (function-call key) anchor_report demo-quick sha256=$MANIFEST_SHA"
fc_call anchor_report "{\"slug\":\"$ORDER_ID\",\"manifest_sha256\":\"$MANIFEST_SHA\"}"
record_tx "anchor_report" "$SPLITTER"

# 6. negative check: the scoped key cannot administer the contract
step "agent key tries set_split(5000) -> must be rejected"
if fc_call set_split '{"split_bps_contributors":5000}' 2>/dev/null; then
  echo "    !!! set_split with the function-call key SUCCEEDED -- key scope is wrong" >&2; exit 1
else
  echo "    rejected: $(printf '%s\n' "$NEAR_OUT" | grep -oiE 'MethodNameMismatch[^,]*|method name[^.]*|DepositWithFunctionCall|not allowed[^.]*' | head -1)"
fi

step "stats"; view "$SPLITTER" get_stats '{}' | python3 -m json.tool | sed 's/^/    /'

END=$(date +%s); DUR=$((END - START))
printf '\n\033[1mSUMMARY\033[0m  order %s  customer %s  duration %ss\n' "$ORDER_ID" "$CUSTOMER" "$DUR"
for l in "${LINKS[@]}"; do printf '  %-26s %s/%s\n' "${l%%|*}" "$EXPLORER" "${l##*|}"; done
[ "$DUR" -lt 120 ] || { echo "demo took ${DUR}s (>120s)" >&2; exit 1; }
