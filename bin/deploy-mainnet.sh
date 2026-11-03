#!/usr/bin/env bash
# NearBI MAINNET deployment: splitter.nearbi.near + forwarder.nearbi.near.
# Run one step at a time and read the output before the next one:
#
#   bin/deploy-mainnet.sh preflight     # read-only: protocol, WASM hashes/imports, balances, keys
#   bin/deploy-mainnet.sh splitter      # deploy+init splitter.nearbi.near (one tx); STOPs with the shortfall if underfunded
#   bin/deploy-mainnet.sh forwarder     # create forwarder.nearbi.near (storage + buffer), deploy+init
#   bin/deploy-mainnet.sh storage       # USDC storage_deposit: splitter, forwarder, contributors, nearbi.near
#   bin/deploy-mainnet.sh fc-keys       # agent function-call keys (secrets -> macOS Keychain)
#   bin/deploy-mainnet.sh verify        # code_hash == local WASM, get_config, key permissions
#   bin/deploy-mainnet.sh lock          # DELETE every full-access key on splitter + forwarder
#   bin/deploy-mainnet.sh record        # write deploy/mainnet.json (public data only)
#
# Every write is signed with the temporary deploy key from the Keychain (see lib-mainnet.sh).
# Any unexpected state stops the script. No USDC is moved.
source "$(dirname "$0")/lib-mainnet.sh"
SPLITTER_WASM="$ROOT/res/nearbi_splitter.wasm"
FORWARDER_WASM="$ROOT/res/nearbi_forwarder.wasm"
EMPTY=11111111111111111111111111111111
YOCTO_PER_BYTE=10000000000000000000          # 1e19 (storage_amount_per_byte)
SPLITTER_BUFFER=${SPLITTER_BUFFER:-50000000000000000000000}    # 0.05 NEAR: agent gas + failed-payout records
FORWARDER_BUFFER=${FORWARDER_BUFFER:-100000000000000000000000} # 0.1 NEAR: forward gas, order records, 1-yocto deposits
STATE_ALLOWANCE=${STATE_ALLOWANCE:-3000}     # bytes: contract state after init + one FC key, rounded up
OWNER_RESERVE=${OWNER_RESERVE:-50000000000000000000000}        # keep >= 0.05 NEAR on nearbi.near for fees
INIT_GAS_TGAS=${INIT_GAS_TGAS:-20}         # init burns ~1.9 Tgas (sandbox, protocol 86); prepaid gas is RESERVED from the
                                             # balance while the receipt runs, so 100 Tgas made a 2.148 NEAR splitter fail
# Mainnet reserved the deploy+init receipt's gas at 1e9 yocto/gas (10x the 1e8 burn price) during
# execution: derived from the LackBalanceForState of tx 3apoJELRBxjajcxHV3SFWGd3dtsKUmjpUUxzy8vaTwhD
# to the byte (see README "Protocol compatibility"). Measured post-init storage, protocol-86 sandbox:
# splitter 205977 B, forwarder 183224 B (wasm + 182 B account + ~350/230 B state).
RESERVE_GAS_PRICE=${RESERVE_GAS_PRICE:-1000000000}
TXREC="${TXREC:-$HOME/.local/state/nearbi-mainnet/txs-v2.tsv}"  # step<TAB>account<TAB>hash (public)
mkdir -p "$(dirname "$TXREC")"
SPL_ARGS="{\"owner\":\"$OWNER\",\"treasury\":\"$TREASURY\",\"contributors\":\"$CONTRIBUTORS\",\"split_bps_contributors\":1000,\"accepted_tokens\":[\"$USDC\"]}"
FWD_ARGS="{\"owner\":\"$OWNER\",\"splitter\":\"$SPLITTER\",\"token\":\"$USDC\",\"agent\":\"$FORWARDER\",\"change_delay_sec\":\"86400\"}"

rec_tx() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$TXREC"; log "$1 $2 tx $3  $EXPLORER/$3"; }

need() { # need <account> <yocto required>: STOP with the exact shortfall
  local have; have="$(amount "$1")"
  python3 -c 'import sys; h,n=int(sys.argv[1]),int(sys.argv[2]); sys.exit(0 if h>=n else 1)' "$have" "$2" \
    || die "$1 has $(near_fmt "$have") NEAR, needs $(near_fmt "$2") NEAR: shortfall $(near_fmt "$(python3 -c 'import sys;print(int(sys.argv[2])-int(sys.argv[1]))' "$have" "$2")") NEAR"
}
wasm_ok() {
  (cd "$ROOT/res" && shasum -a 256 -c nearbi_splitter.wasm.sha256 nearbi_forwarder.wasm.sha256 >/dev/null) \
    || die "res/*.wasm does not match .sha256"
  python3 -I "$ROOT/bin/wasm-imports.py" --deny "$ROOT/bin/denied-imports-protocol-86.txt" \
    "$SPLITTER_WASM" "$FORWARDER_WASM" >/dev/null || die "WASM imports a host function mainnet lacks"
}
protocol_ok() {
  local p; p="$(rpc status '[]' | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["protocol_version"])')"
  log "mainnet protocol_version $p"
  [ "$p" -ge 86 ] || die "unexpected protocol $p"
  rpc EXPERIMENTAL_protocol_config '{"finality":"final"}' | python3 -c '
import sys, json
w = json.load(sys.stdin)["result"]["runtime_config"]["wasm_config"]
need = {"global_contract_host_fns", "gas_key_host_fns"}
print("    wasm_config:", {k: w[k] for k in sorted(need | {"universal_accounts", "sha3_host_fns", "ml_dsa_verify_host_fn"})})
sys.exit(0 if all(w[k] for k in need) else 1)' >&2 || die "protocol config lacks host fns our WASM imports"
}
storage_need() { # wasm -> yocto for wasm + account + state allowance + buffer
  python3 -c 'import os,sys; print((os.path.getsize(sys.argv[1]) + 182 + int(sys.argv[2])) * int(sys.argv[3]) + int(sys.argv[4]))' \
    "$1" "$STATE_ALLOWANCE" "$YOCTO_PER_BYTE" "$2"
}
# deploy_reserve <wasm> <args> -> yocto held from the signer while deploy+init(prepaid INIT_GAS) runs
deploy_reserve() {
  rpc EXPERIMENTAL_protocol_config '{"finality":"final"}' | python3 -c '
import sys, json, os
f = json.load(sys.stdin)["result"]["runtime_config"]["transaction_costs"]; a = f["action_creation_config"]
W = os.path.getsize(sys.argv[1]); n = len(sys.argv[2]) + len("init")
send = f["action_receipt_creation_config"]["send_sir"] + a["deploy_contract_cost"]["send_sir"] + a["deploy_contract_cost_per_byte"]["send_sir"] * W \
     + a["function_call_cost"]["send_sir"] + a["function_call_cost_per_byte"]["send_sir"] * n
exe = f["action_receipt_creation_config"]["execution"] + a["deploy_contract_cost"]["execution"] + a["deploy_contract_cost_per_byte"]["execution"] * W \
    + a["function_call_cost"]["execution"] + a["function_call_cost_per_byte"]["execution"] * n
price = int(sys.argv[4])
print((send + exe + int(sys.argv[3]) * 10**12) * price)' "$1" "$2" "$INIT_GAS_TGAS" "$RESERVE_GAS_PRICE"
}
# afford_deploy <account> <wasm> <args>: STOP with the exact shortfall if balance < reserve + storage
afford_deploy() {
  local res st need
  res="$(deploy_reserve "$2" "$3")"
  st="$(python3 -c 'import os,sys; print((os.path.getsize(sys.argv[1]) + 182 + 1000) * int(sys.argv[2]))' "$2" "$YOCTO_PER_BYTE")"
  need="$(python3 -c 'import sys; print(int(sys.argv[1]) + int(sys.argv[2]))' "$res" "$st")"
  log "$1: deploy+init with ${INIT_GAS_TGAS} Tgas reserves $(near_fmt "$res") NEAR + storage $(near_fmt "$st") NEAR = $(near_fmt "$need") NEAR; has $(near_fmt "$(amount "$1")")"
  need "$1" "$need"
}
only_keys() { # only_keys <account> <expected sorted pubkeys...>
  local acct="$1"; shift
  local got; got="$(keys "$acct" | cut -d' ' -f1 | sort | tr '\n' ' ')"
  local want; want="$(printf '%s\n' "$@" | sort | tr '\n' ' ')"
  [ "$got" = "$want" ] || die "$acct keys are [$got], expected [$want]"
}
fc_pub() { security find-generic-password -s "nearbi-mainnet-fc-$1" -a "$1" 2>/dev/null | sed -n 's/.*"icmt"<blob>="\(ed25519:[1-9A-HJ-NP-Za-km-z]*\)".*/\1/p'; }

case "${1:-}" in
preflight)
  wasm_ok; protocol_ok
  for a in "$OWNER" "$SPLITTER" "$CONTRIBUTORS" "$FORWARDER"; do
    log "$a: $(account "$a")"; [ "$(account "$a")" = MISSING ] || keys "$a" | sed 's/^/    /' >&2
  done
  log "splitter needs $(near_fmt "$(storage_need "$SPLITTER_WASM" "$SPLITTER_BUFFER")") NEAR (wasm $(wc -c < "$SPLITTER_WASM") B), has $(near_fmt "$(amount "$SPLITTER")")"
  log "forwarder needs $(near_fmt "$(storage_need "$FORWARDER_WASM" "$FORWARDER_BUFFER")") NEAR (wasm $(wc -c < "$FORWARDER_WASM") B)"
  log "splitter deploy+init reserve at ${INIT_GAS_TGAS} Tgas: $(near_fmt "$(deploy_reserve "$SPLITTER_WASM" "$SPL_ARGS")") NEAR; available after reserve $(python3 -c 'import sys; print(f"{(int(sys.argv[1])-int(sys.argv[2]))/1e24:.6f}")' "$(amount "$SPLITTER")" "$(deploy_reserve "$SPLITTER_WASM" "$SPL_ARGS")") NEAR vs post-init storage ~2.059770 NEAR"
  log "local code hashes: splitter $(wasm_code_hash "$SPLITTER_WASM")  forwarder $(wasm_code_hash "$FORWARDER_WASM")"
  ;;

splitter)
  wasm_ok; protocol_ok
  WANT="$(wasm_code_hash "$SPLITTER_WASM")"
  [ "$(code_hash "$SPLITTER")" = "$WANT" ] && { log "$SPLITTER already has $WANT"; exit 0; }
  [ "$(code_hash "$SPLITTER")" = "$EMPTY" ] || die "$SPLITTER has unexpected code $(code_hash "$SPLITTER")"
  only_keys "$SPLITTER" "$TEMP_PUB"
  ARGS="$SPL_ARGS"
  afford_deploy "$SPLITTER" "$SPLITTER_WASM" "$ARGS"
  log "deploy+init $SPLITTER code_hash $WANT args $ARGS"
  temp_signed send contract deploy "$SPLITTER" use-file "$SPLITTER_WASM" with-init-call init \
    json-args "$ARGS" prepaid-gas "$INIT_GAS_TGAS Tgas" attached-deposit '0 NEAR' network-config "$NET" \
    || die "splitter deploy+init failed (tx $(last_tx)); state rolled back"
  H="$(last_tx)"; tx_ok "$H" "$SPLITTER" || die "deploy tx has failures"; rec_tx deploy-init "$SPLITTER" "$H"
  [ "$(code_hash "$SPLITTER")" = "$WANT" ] || die "on-chain code_hash $(code_hash "$SPLITTER") != $WANT"
  view "$SPLITTER" get_config '{}' | python3 -m json.tool >&2
  log "$SPLITTER: $(account "$SPLITTER")"
  ;;

forwarder)
  wasm_ok
  WANT="$(wasm_code_hash "$FORWARDER_WASM")"
  [ "$(code_hash "$SPLITTER")" = "$(wasm_code_hash "$SPLITTER_WASM")" ] || die "deploy the splitter first"
  if [ "$(account "$FORWARDER")" = MISSING ]; then
    FUND="$(storage_need "$FORWARDER_WASM" "$FORWARDER_BUFFER")"
    FUND="$(python3 -c 'import sys; u=10**21; print(-(-int(sys.argv[1]) // u) * u)' "$FUND")"
    need "$OWNER" "$(python3 -c 'import sys; print(int(sys.argv[1]) + int(sys.argv[2]))' "$FUND" "$OWNER_RESERVE")"
    log "create $FORWARDER with $(near_fmt "$FUND") NEAR, temp deploy key (deleted in 'lock')"
    temp_signed send account create-account fund-myself "$FORWARDER" "$(near_fmt "$FUND") NEAR" \
      use-manually-provided-public-key "$TEMP_PUB" sign-as "$OWNER" network-config "$NET"
    H="$(last_tx)"; tx_ok "$H" "$OWNER" || die "create failed"; rec_tx create "$FORWARDER" "$H"
  fi
  [ "$(code_hash "$FORWARDER")" = "$WANT" ] && { log "$FORWARDER already has $WANT"; exit 0; }
  [ "$(code_hash "$FORWARDER")" = "$EMPTY" ] || die "$FORWARDER has unexpected code"
  only_keys "$FORWARDER" "$TEMP_PUB"
  ARGS="$FWD_ARGS"
  afford_deploy "$FORWARDER" "$FORWARDER_WASM" "$ARGS"
  log "deploy+init $FORWARDER code_hash $WANT args $ARGS"
  temp_signed send contract deploy "$FORWARDER" use-file "$FORWARDER_WASM" with-init-call init \
    json-args "$ARGS" prepaid-gas "$INIT_GAS_TGAS Tgas" attached-deposit '0 NEAR' network-config "$NET" \
    || die "forwarder deploy+init failed (tx $(last_tx))"
  H="$(last_tx)"; tx_ok "$H" "$FORWARDER" || die "deploy tx has failures"; rec_tx deploy-init "$FORWARDER" "$H"
  [ "$(code_hash "$FORWARDER")" = "$WANT" ] || die "on-chain code_hash != $WANT"
  view "$FORWARDER" get_config '{}' | python3 -m json.tool >&2
  log "$FORWARDER: $(account "$FORWARDER")"
  ;;

storage)
  MIN="$(view "$USDC" storage_balance_bounds '{}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["min"])')"
  for who in "$SPLITTER" "$FORWARDER" "$CONTRIBUTORS" "$OWNER"; do
    if [ "$(view "$USDC" storage_balance_of "{\"account_id\":\"$who\"}")" != null ]; then log "$who registered on USDC"; continue; fi
    need "$OWNER" "$(python3 -c 'import sys; print(int(sys.argv[1]) + 10**21)' "$MIN")"
    log "USDC storage_deposit $who ($(near_fmt "$MIN") NEAR, registration_only)"
    temp_signed send contract call-function as-transaction "$USDC" storage_deposit \
      json-args "{\"account_id\":\"$who\",\"registration_only\":true}" prepaid-gas '30 Tgas' \
      attached-deposit "$(near_fmt "$MIN") NEAR" sign-as "$OWNER" network-config "$NET"
    H="$(last_tx)"; tx_ok "$H" "$OWNER" || die "storage_deposit $who failed"; rec_tx storage "$who" "$H"
    [ "$(view "$USDC" storage_balance_of "{\"account_id\":\"$who\"}")" != null ] || die "$who still unregistered"
  done
  ;;

fc-keys)
  add_fc() { # account methods(csv) allowance
    local acct="$1" methods="$2" allowance="$3" pub
    pub="$(fc_pub "$acct")"
    if [ -n "$pub" ] && keys "$acct" | grep -q "^$pub "; then log "FC key $pub already on $acct"; return; fi
    if [ -z "$pub" ]; then
      # 1) generate the keypair WITHOUT broadcasting (display), keep it in memory only
      local sk out
      out="$(security find-generic-password -s "$TEMP_KEYCHAIN_SERVICE" -w | {
        IFS= read -r t; "$NEAR" account add-key "$acct" grant-function-call-access \
          --allowance "$allowance" --contract-account-id "$acct" --function-names "$methods" \
          autogenerate-new-keypair --signature-scheme ed25519 print-to-terminal network-config "$NET" \
          sign-with-access-key-file <(printf '{"public_key":"%s","private_key":"%s"}' "$TEMP_PUB" "$t") display 2>&1; t=""; })"
      pub="$(printf '%s' "$out" | python3 -c 'import sys,re; m=re.search(r"Access key info.*?Public Key:\s*(ed25519:[1-9A-HJ-NP-Za-km-z]+)", sys.stdin.read(), re.S); print(m.group(1) if m else "")')"
      sk="$(printf '%s' "$out" | python3 -c 'import sys,re; m=re.search(r"Access key info.*?SECRET KEYPAIR:\s*(ed25519:[1-9A-HJ-NP-Za-km-z]+)", sys.stdin.read(), re.S); print(m.group(1) if m else "")')"
      out=""
      [ -n "$pub" ] && [ -n "$sk" ] && [ "$pub" != "$TEMP_PUB" ] || { sk=""; die "could not parse generated keypair for $acct (nothing broadcast)"; }
      # 2) store in the Keychain (stdin, not argv); the public key goes in the comment for lookup
      printf 'add-generic-password -U -s "nearbi-mainnet-fc-%s" -a "%s" -l "NearBI mainnet FC key %s" -j "%s" -w "%s"\n' \
        "$acct" "$acct" "$acct" "$pub" "$sk" | security -i >/dev/null
      sk=""; unset sk
      keychain_fc_matches "$acct" "$pub" || die "Keychain copy of the $acct FC key does not match $pub"
      [ "$(fc_pub "$acct")" = "$pub" ] || die "Keychain lookup for $acct returns a different public key"
      log "generated FC key $pub for $acct, stored in Keychain nearbi-mainnet-fc-$acct"
    fi
    # 3) broadcast add-key with the stored public key
    temp_signed send account add-key "$acct" grant-function-call-access \
      --allowance "$allowance" --contract-account-id "$acct" --function-names "$methods" \
      use-manually-provided-public-key "$pub" network-config "$NET"
    local h; h="$(last_tx)"; tx_ok "$h" "$acct" || die "add-key $acct failed"; rec_tx add-fc-key "$acct" "$h"
    rpc query "{\"request_type\":\"view_access_key\",\"finality\":\"final\",\"account_id\":\"$acct\",\"public_key\":\"$pub\"}" \
      | python3 -c 'import sys,json; fc=json.load(sys.stdin)["result"]["permission"]["FunctionCall"]; print("    on-chain:", json.dumps(fc))' >&2
  }
  add_fc "$SPLITTER" "record_cost, anchor_report" "0.25 NEAR"
  add_fc "$FORWARDER" "forward" "0.25 NEAR"
  ;;

verify)
  for pair in "$SPLITTER:$SPLITTER_WASM" "$FORWARDER:$FORWARDER_WASM"; do
    a="${pair%%:*}"; w="${pair#*:}"
    [ "$(code_hash "$a")" = "$(wasm_code_hash "$w")" ] || die "$a code_hash mismatch"
    log "$a code_hash $(code_hash "$a") == base58(sha256 $(basename "$w"))"
    view "$a" get_config '{}' | python3 -m json.tool >&2
    keys "$a" | sed 's/^/    key /' >&2
  done
  view "$SPLITTER" get_config '{}' | python3 -c '
import sys, json; c = json.load(sys.stdin)
assert c["owner"] == "nearbi.near" and c["treasury"] == "nearbi.near" and c["contributors"] == "contributors.nearbi.near", c
assert c["split_bps_contributors"] == 1000 and c["accepted_tokens"] == [sys.argv[1]] and not c["paused"], c
print("    splitter config OK")' "$USDC" >&2
  view "$FORWARDER" get_config '{}' | python3 -c '
import sys, json; c = json.load(sys.stdin)
assert c["owner"] == "nearbi.near" and c["splitter"] == "splitter.nearbi.near" and c["token"] == sys.argv[1], c
assert c["agent"] == "forwarder.nearbi.near" and str(c["change_delay_sec"]) == "86400" and not c["paused"], c
print("    forwarder config OK")' "$USDC" >&2
  ;;

lock)
  for a in "$SPLITTER" "$FORWARDER"; do
    fc="$(fc_pub "$a")"; [ -n "$fc" ] || die "no FC key recorded for $a"
    keys "$a" | grep -q "^$fc .*FunctionCall" || die "FC key $fc not on $a; refusing to lock"
    for k in $(keys "$a" | grep '"FullAccess"' | cut -d' ' -f1); do
      [ "$k" = "$TEMP_PUB" ] || die "$a has an unexpected full-access key $k"
      log "DELETE full-access key $k on $a"
      temp_signed send account delete-keys "$a" public-keys "$k" network-config "$NET"
      H="$(last_tx)"; tx_ok "$H" "$a" || die "delete-key $a failed"; rec_tx delete-full-access-key "$a" "$H"
    done
    only_keys "$a" "$fc"
    keys "$a" | grep -q '"FullAccess"' && die "$a still has a full-access key"
    log "$a: only FC key $fc remains"; keys "$a" | sed 's/^/    /' >&2
  done
  ;;

*) sed -n 2,14p "$0"; exit 1 ;;
esac
