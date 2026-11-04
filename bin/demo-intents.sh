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
#
# Knobs for callers (rs-agent bin/demo); the defaults reproduce the recorded runs:
#   PRICE=<USDCm base units>  default 49000000
#   PAYER=<account>.testnet   who sends the plain ft_transfer (default oneclick-sim.<agent>); e.g. a demo
#                             customer standing in for the 1Click delivery (1Click has no testnet)
#   DRIP=always|auto          agent -> payer mock-USDC drip; auto = only if the payer holds < PRICE (default always)
#   QUICK=1                   skip the negative checks (double forward, set_agent), the config and key dumps
#   RESULT_JSON=<file>        write order, txs, balances, deltas and the split verdict as JSON
#   DEMO_T0=<epoch s>         step clock origin (default: this script's start)
source "$(dirname "$0")/lib.sh"
START=$(date +%s)
T0="${DEMO_T0:-$START}"
PRICE="${PRICE:-49000000}"          # 49.000000 USDCm
PAYER="${PAYER:-$ONECLICK_SIM}"
DRIP="${DRIP:-always}"
QUICK="${QUICK:-0}"
require_testnet "$PAYER"
ORDER_ID="${ORDER_ID:-intents-$(date -u +%Y%m%dT%H%M%SZ)}"
[ -f "$FWD_FC_KEY_FILE" ] || { echo "no forwarder function-call key at $FWD_FC_KEY_FILE; run bin/deploy-forwarder-testnet.sh" >&2; exit 1; }
declare -a LINKS=()
step() { printf '\n\033[1m[%3ss] %s\033[0m\n' "$(( $(date +%s) - T0 ))" "$*"; }
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
  for a in "$PAYER" "$FORWARDER" "$SPLITTER" "$CONTRIBUTORS" "$TREASURY"; do
    printf '%s=%s\n' "$a" "$(ft_balance "$a")"
  done
}
show() { while IFS='=' read -r a v; do printf '    %-48s %16s USDCm\n' "$a" "$(fmt_usdc "$v")"; done <<<"$1"; }

if [ "$DRIP" = auto ] && [ "$(ft_balance "$PAYER")" -ge "$PRICE" ]; then
  step "payer $PAYER already holds >= $(fmt_usdc "$PRICE") USDCm (no drip)"
else
  step "mock-USDC liquidity for the payer: $AGENT -> $PAYER $(fmt_usdc "$PRICE")"
  call "$AGENT" "$TOKEN" ft_transfer "{\"receiver_id\":\"$PAYER\",\"amount\":\"$PRICE\",\"memo\":\"testnet demo: payer liquidity\"}" '1 yoctoNEAR' '30 Tgas'
  record_tx "drip to payer" "$AGENT"
fi

BEFORE="$(balances)"
step "balances BEFORE"; show "$BEFORE"

step "1Click delivery (simulated): $PAYER plain ft_transfer $(fmt_usdc "$PRICE") -> $FORWARDER"
call "$PAYER" "$TOKEN" ft_transfer "{\"receiver_id\":\"$FORWARDER\",\"amount\":\"$PRICE\",\"memo\":\"order $ORDER_ID (simulated 1click delivery)\"}" '1 yoctoNEAR' '30 Tgas'
record_tx "1click plain ft_transfer" "$PAYER"
echo "    forwarder balance now $(fmt_usdc "$(ft_balance "$FORWARDER")") USDCm"

step "agent (function-call key [forward]) forward order_id=$ORDER_ID amount=$(fmt_usdc "$PRICE")"
fc_forward "{\"order_id\":\"$ORDER_ID\",\"amount\":\"$PRICE\"}"
record_tx "forward -> splitter" "$FORWARDER"

AFTER="$(balances)"
step "balances AFTER"; show "$AFTER"
python3 - "$BEFORE" "$AFTER" "$PRICE" "$BPS" "$PAYER" "$FORWARDER" "$SPLITTER" "$CONTRIBUTORS" "$TREASURY" <<'PY'
import sys
b = dict(l.split("=") for l in sys.argv[1].splitlines())
a = dict(l.split("=") for l in sys.argv[2].splitlines())
price, bps = int(sys.argv[3]), int(sys.argv[4])
oc, fw, spl, con, tre = sys.argv[5:10]
d = {k: int(a[k]) - int(b[k]) for k in a}
exp_c = price // 10000 * bps + (price % 10000) * bps // 10000
exp_t = price - exp_c
f = lambda v: f"{v/1e6:+.6f}"
print(f"    delta payer {f(d[oc])}  forwarder {f(d[fw])}  splitter {f(d[spl])}  contributors {f(d[con])}  treasury {f(d[tre])}")
ok = d[oc] == -price and d[fw] == 0 and d[spl] == 0 and d[con] == exp_c and d[tre] == exp_t
print(f"    expected contributors {exp_c/1e6:.6f} + treasury {exp_t/1e6:.6f} = {price/1e6:.6f}  ->", "SPLIT OK" if ok else "SPLIT MISMATCH")
sys.exit(0 if ok else 1)
PY

FWDED="$(view "$FORWARDER" is_forwarded "{\"order_id\":\"$ORDER_ID\"}")"
step "is_forwarded($ORDER_ID) = $FWDED"
[ "$FWDED" = "true" ] || { echo "order not marked forwarded" >&2; exit 1; }
view "$FORWARDER" get_order "{\"order_id\":\"$ORDER_ID\"}" | sed 's/^/    /'

if [ -n "${RESULT_JSON:-}" ]; then
  python3 - "$RESULT_JSON" "$ORDER_ID" "$PRICE" "$BPS" "$PAYER" "$FORWARDER" "$SPLITTER" "$CONTRIBUTORS" "$TREASURY" "$TOKEN" "$EXPLORER" "$BEFORE" "$AFTER" "${LINKS[@]}" <<'PY'
import json, sys
out, order, price, bps, payer, fwd, spl, con, tre, tok, explorer, before, after, *links = sys.argv[1:]
b = {k: int(v) for k, v in (l.split("=") for l in before.splitlines())}
a = {k: int(v) for k, v in (l.split("=") for l in after.splitlines())}
price, bps = int(price), int(bps)
exp_c = price // 10000 * bps + (price % 10000) * bps // 10000
d = {k: a[k] - b[k] for k in a}
txs = {l.split("|", 1)[0]: l.split("|", 1)[1] for l in links}
json.dump({"order_id": order, "price": str(price), "bps_contributors": bps, "token": tok, "payer": payer, "forwarder": fwd,
           "splitter": spl, "contributors": con, "treasury": tre, "explorer": explorer, "txs": txs,
           "before": {k: str(v) for k, v in b.items()}, "after": {k: str(v) for k, v in a.items()},
           "delta": {k: str(v) for k, v in d.items()},
           "expected": {"contributors": str(exp_c), "treasury": str(price - exp_c)},
           "split_ok": d[payer] == -price and d[fwd] == 0 and d[spl] == 0 and d[con] == exp_c and d[tre] == price - exp_c},
          open(out, "w"), indent=2)
PY
fi
if [ "$QUICK" = 1 ]; then
  END=$(date +%s)
  printf '\n  sale done in %ss (QUICK=1: negative checks skipped; a full bin/demo-intents.sh run shows them)\n' "$((END - START))"
  for l in "${LINKS[@]}"; do printf '  %-26s %s/%s\n' "${l%%|*}" "$EXPLORER" "${l##*|}"; done
  exit 0
fi

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
