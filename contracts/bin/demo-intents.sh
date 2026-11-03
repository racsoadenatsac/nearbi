#!/usr/bin/env bash
# NEAR Intents 1Click settlement path on TESTNET (mock USDC, no real funds):
#   1. oneclick-sim.<agent> stands in for the 1Click/Verifier withdrawal: it gets
#      49 USDCm from the agent (its "liquidity"), then sends a PLAIN ft_transfer of
#      49.000000 to the forwarder, exactly what 1Click does with
#      SETTLEMENT_DELIVERY=transfer (no msg, no order id on chain)
#   2. the agent forwards it with its FUNCTION-CALL key (methods = [forward]):
#      forwarder.forward(order_id, 49000000) -> usdc-mock.ft_transfer_call(splitter, …)
#   3. the splitter splits in the same receipt chain: contributors 4.9, treasury 44.1
#   4. checks: exact deltas, is_forwarded, a second forward of the same order is
#      rejected by the contract, the key can't call set_agent
# Prints balances before/after, tx hashes, explorer links, events and the duration
# (fails if >= 120 s).
#   ORDER_ID=<id> bin/demo-intents.sh
source "$(dirname "$0")/lib.sh"
START=$(date +%s)
PRICE=49000000          # 49.000000 USDCm
ORDER_ID="${ORDER_ID:-intents-$(date -u +%Y%m%dT%H%M%SZ)}"
[ -f "$FWD_FC_KEY_FILE" ] || { echo "no forwarder function-call key at $FWD_FC_KEY_FILE; run bin/deploy-forwarder-testnet.sh" >&2; exit 1; }
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
fc_forward() { # json  (signed with the agent's function-call key on the forwarder)
  near_run contract call-function as-transaction "$FORWARDER" forward json-args "$1" \
    prepaid-gas '150 Tgas' attached-deposit '0 NEAR' sign-as "$FORWARDER" \
    network-config "$NETWORK" sign-with-access-key-file "$FWD_FC_KEY_FILE" send
}

FCFG="$(view "$FORWARDER" get_config '{}')"
read -r FSPL FTOK FPAUSED FDELAY <<<"$(printf '%s' "$FCFG" | python3 -c 'import sys,json; c=json.load(sys.stdin); print(c["splitter"], c["token"], c["paused"], c["change_delay_sec"])')"
[ "$FSPL" = "$SPLITTER" ] && [ "$FTOK" = "$TOKEN" ] || { echo "forwarder config mismatch: $FCFG" >&2; exit 1; }
BPS="$(view "$SPLITTER" get_config '{}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["split_bps_contributors"])')"
step "forwarder $FORWARDER -> splitter $FSPL (bps $BPS)  token $FTOK  paused=$FPAUSED  change_delay_sec=$FDELAY"

balances() {
  for a in "$ONECLICK_SIM" "$FORWARDER" "$SPLITTER" "$CONTRIBUTORS" "$TREASURY"; do
    printf '%s=%s\n' "$a" "$(ft_balance "$a")"
  done
}
show() { while IFS='=' read -r a v; do printf '    %-48s %16s USDCm\n' "$a" "$(fmt_usdc "$v")"; done <<<"$1"; }

step "mock-USDC liquidity for the simulated 1Click sender: $AGENT -> $ONECLICK_SIM 49.000000"
call "$AGENT" "$TOKEN" ft_transfer "{\"receiver_id\":\"$ONECLICK_SIM\",\"amount\":\"$PRICE\",\"memo\":\"testnet demo: 1click liquidity\"}" '1 yoctoNEAR' '30 Tgas'
record_tx "drip to 1click-sim" "$AGENT"

BEFORE="$(balances)"
step "balances BEFORE"; show "$BEFORE"

step "1Click delivery (simulated): $ONECLICK_SIM plain ft_transfer 49.000000 -> $FORWARDER"
call "$ONECLICK_SIM" "$TOKEN" ft_transfer "{\"receiver_id\":\"$FORWARDER\",\"amount\":\"$PRICE\",\"memo\":\"1click withdrawal (simulated)\"}" '1 yoctoNEAR' '30 Tgas'
record_tx "1click plain ft_transfer" "$ONECLICK_SIM"
echo "    forwarder balance now $(fmt_usdc "$(ft_balance "$FORWARDER")") USDCm"

step "agent (function-call key [forward]) forward order_id=$ORDER_ID amount=49.000000"
fc_forward "{\"order_id\":\"$ORDER_ID\",\"amount\":\"$PRICE\"}"
record_tx "forward -> splitter" "$FORWARDER"

AFTER="$(balances)"
step "balances AFTER"; show "$AFTER"
python3 - "$BEFORE" "$AFTER" "$PRICE" "$BPS" "$ONECLICK_SIM" "$FORWARDER" "$SPLITTER" "$CONTRIBUTORS" "$TREASURY" <<'PY'
import sys
b = dict(l.split("=") for l in sys.argv[1].splitlines())
a = dict(l.split("=") for l in sys.argv[2].splitlines())
price, bps = int(sys.argv[3]), int(sys.argv[4])
oc, fw, spl, con, tre = sys.argv[5:10]
d = {k: int(a[k]) - int(b[k]) for k in a}
exp_c = price // 10000 * bps + (price % 10000) * bps // 10000
exp_t = price - exp_c
f = lambda v: f"{v/1e6:+.6f}"
print(f"    delta 1click {f(d[oc])}  forwarder {f(d[fw])}  splitter {f(d[spl])}  contributors {f(d[con])}  treasury {f(d[tre])}")
ok = d[oc] == -price and d[fw] == 0 and d[spl] == 0 and d[con] == exp_c and d[tre] == exp_t
print(f"    expected contributors {exp_c/1e6:.6f} + treasury {exp_t/1e6:.6f} = {price/1e6:.6f}  ->", "SPLIT OK" if ok else "SPLIT MISMATCH")
sys.exit(0 if ok else 1)
PY

FWDED="$(view "$FORWARDER" is_forwarded "{\"order_id\":\"$ORDER_ID\"}")"
step "is_forwarded($ORDER_ID) = $FWDED"
[ "$FWDED" = "true" ] || { echo "order not marked forwarded" >&2; exit 1; }
view "$FORWARDER" get_order "{\"order_id\":\"$ORDER_ID\"}" | sed 's/^/    /'

step "agent forwards the same order again -> the contract must reject it"
if fc_forward "{\"order_id\":\"$ORDER_ID\",\"amount\":\"$PRICE\"}" 2>/dev/null; then
  echo "    !!! double forward SUCCEEDED" >&2; exit 1
else
  h="$(last_tx)"
  echo "    rejected: $(printf '%s\n' "$NEAR_OUT" | grep -oE "order already forwarded" | head -1)${h:+  (failed tx $EXPLORER/$h)}"
  [ -n "$h" ] && LINKS+=("double forward (fails)|$h")
fi

step "agent key tries set_agent -> must be rejected by the protocol"
if near_run contract call-function as-transaction "$FORWARDER" set_agent json-args "{\"agent\":\"$ONECLICK_SIM\"}" \
     prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$FORWARDER" \
     network-config "$NETWORK" sign-with-access-key-file "$FWD_FC_KEY_FILE" send 2>/dev/null; then
  echo "    !!! set_agent with the function-call key SUCCEEDED" >&2; exit 1
else
  echo "    rejected: $(printf '%s\n' "$NEAR_OUT" | grep -oiE "Transaction method name <[a-z_]+> isn't allowed by the access key|MethodNameMismatch" | head -1)"
fi

step "forwarder config"; view "$FORWARDER" get_config '{}' | python3 -m json.tool | sed 's/^/    /'
step "keys on $FORWARDER (a full-access key can still redeploy code; see README trust model)"
rpc query "{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$FORWARDER\"}" | python3 -c '
import sys, json
for k in json.load(sys.stdin)["result"]["keys"]:
    p = k["access_key"]["permission"]
    print("   ", k["public_key"][:20] + "…", "FullAccess" if p == "FullAccess" else "FunctionCall " + json.dumps(p["FunctionCall"]["method_names"]))
'

END=$(date +%s); DUR=$((END - START))
printf '\n\033[1mSUMMARY\033[0m  order %s  forwarder %s  duration %ss\n' "$ORDER_ID" "$FORWARDER" "$DUR"
for l in "${LINKS[@]}"; do printf '  %-26s %s/%s\n' "${l%%|*}" "$EXPLORER" "${l##*|}"; done
[ "$DUR" -lt 120 ] || { echo "demo took ${DUR}s (>120s)" >&2; exit 1; }
