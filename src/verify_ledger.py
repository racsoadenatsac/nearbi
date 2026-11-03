#!/usr/bin/env python3
"""Verify the NearBI public ledger (ledger.jsonl). Python 3.8+, standard library only.

    python3 verify_ledger.py ledger.jsonl            # offline: hash chain + per-sale split math + totals
    python3 verify_ledger.py ledger.jsonl --rpc      # also re-fetch every event from NEAR RPC and compare
                                                     # raw logs, block hashes, timestamps and get_stats()

The network (mainnet: splitter.nearbi.near + forwarder.nearbi.near; testnet: splitter.nearbi-agent.testnet)
is inferred from the explorer links in the file; override with --network.

Hash chain: each line is a JSON object with `prev_hash` and `line_hash`.
    body      = the line without `prev_hash` and `line_hash`
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    line_hash = sha256( canonical.encode("utf-8") + prev_hash.encode("ascii") ).hexdigest()
The first line's prev_hash is 64 zeros; every later line's prev_hash is the previous line_hash.
"""
import argparse
import hashlib
import json
import sys
import time
import urllib.request

GENESIS = "0" * 64
BPS = 10_000
EXPLORER = "https://testnet.nearblocks.io/txns/"  # testnet (kept for compatibility)
NETWORKS = {
    "mainnet": {"explorer": "https://nearblocks.io/txns/", "splitter": "splitter.nearbi.near",
                "forwarder": "forwarder.nearbi.near",
                "rpc": ["https://rpc.mainnet.fastnear.com", "https://archival-rpc.mainnet.fastnear.com"]},
    "testnet": {"explorer": EXPLORER, "splitter": "splitter.nearbi-agent.testnet", "forwarder": None,
                "rpc": ["https://rpc.testnet.near.org", "https://archival-rpc.testnet.near.org"]},
}
SPLITTER_STANDARD, FORWARDER_STANDARD = "nearbi_splitter", "nearbi_forwarder"


def infer_network(lines):
    for ln in lines:
        if str(ln.get("explorer", "")).startswith(NETWORKS["mainnet"]["explorer"]):
            return "mainnet"
        if str(ln.get("explorer", "")).startswith(EXPLORER):
            return "testnet"
    return "mainnet"


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def line_hash(body, prev_hash):
    return hashlib.sha256(canonical(body).encode("utf-8") + prev_hash.encode("ascii")).hexdigest()


def seal(body, prev_hash):
    """Return a copy of `body` with prev_hash and line_hash set."""
    body = {k: v for k, v in body.items() if k not in ("prev_hash", "line_hash")}
    h = line_hash(body, prev_hash)
    out = dict(body)
    out["prev_hash"] = prev_hash
    out["line_hash"] = h
    return out


def split_amount(amount, bps):
    """Same integer math as the splitter contract (floor, no dust)."""
    q, r = divmod(amount, BPS)
    c = q * bps + (r * bps) // BPS
    return c, amount - c


def parse_event(raw):
    if not raw.startswith("EVENT_JSON:"):
        raise ValueError("raw is not an EVENT_JSON log")
    ev = json.loads(raw[len("EVENT_JSON:"):])
    return ev["event"], ev["data"][0], ev


def check_chain(lines):
    errors = []
    prev = GENESIS
    for i, ln in enumerate(lines):
        if ln.get("prev_hash") != prev:
            errors.append("line %d: prev_hash %s != expected %s" % (i + 1, ln.get("prev_hash"), prev))
        body = {k: v for k, v in ln.items() if k not in ("prev_hash", "line_hash")}
        h = line_hash(body, ln.get("prev_hash", ""))
        if h != ln.get("line_hash"):
            errors.append("line %d: line_hash mismatch (computed %s)" % (i + 1, h))
        if ln.get("seq") != i:
            errors.append("line %d: seq %r != %d" % (i + 1, ln.get("seq"), i))
        prev = ln.get("line_hash", "")
    return errors, prev


def check_rows(lines, explorer=None):
    """Each row must agree with its own raw event; every sale must follow the split math."""
    explorer = explorer or NETWORKS[infer_network(lines)]["explorer"]
    errors = []
    seen = set()
    for i, ln in enumerate(lines):
        key = (ln["receipt_id"], ln["log_index"])
        if key in seen:
            errors.append("line %d: duplicate event %s" % (i + 1, key))
        seen.add(key)
        kind, data, ev = parse_event(ln["raw"])
        if ev.get("standard") != ln.get("standard", SPLITTER_STANDARD):
            errors.append("line %d: standard %s != raw event %s" % (i + 1, ln.get("standard"), ev.get("standard")))
        if kind != ln["kind"]:
            errors.append("line %d: kind %s != raw event %s" % (i + 1, ln["kind"], kind))
        if ln.get("data") != data:
            errors.append("line %d: data differs from raw event" % (i + 1))
        for k, v in (ln.get("amounts") or {}).items():
            src = data.get("amount_usd_micros") if (kind == "cost" and k == "amount") else data.get(k)
            if str(src) != v:
                errors.append("line %d: amounts.%s=%s differs from raw event (%s)" % (i + 1, k, v, src))
        if ln.get("order_id") != data.get("order_id") or ln.get("token") != data.get("token"):
            errors.append("line %d: order_id/token differ from raw event" % (i + 1))
        if ln.get("explorer") != explorer + ln["tx_hash"]:
            errors.append("line %d: explorer link does not point at its tx" % (i + 1))
        if kind == "sale" and ev.get("standard") == SPLITTER_STANDARD:
            amt = int(data["amount"])
            c, t = split_amount(amt, int(data["split_bps_contributors"]))
            if (c, t) != (int(data["contributors_amount"]), int(data["treasury_amount"])):
                errors.append("line %d: sale %s split %s/%s != expected %d/%d" % (
                    i + 1, data["order_id"], data["contributors_amount"], data["treasury_amount"], c, t))
    return errors


def totals(lines):
    """Per-token totals in the same shape as the contract's get_stats()."""
    stats = {}
    failed = {}  # failure id -> amount, while outstanding
    for ln in lines:
        kind, d, ev = parse_event(ln["raw"])
        if ev.get("standard") != SPLITTER_STANDARD:
            continue  # forwarder events don't move splitter totals
        tok = d.get("token")
        if kind in ("sale", "payout", "payout_failed"):
            s = stats.setdefault(tok, {"token": tok, "sales": 0, "total_received": 0, "contributors_amount": 0,
                                       "treasury_amount": 0, "pending_failed": 0, "paid_contributors": 0,
                                       "paid_treasury": 0})
        if kind == "sale":
            s["sales"] += 1
            s["total_received"] += int(d["amount"])
            s["contributors_amount"] += int(d["contributors_amount"])
            s["treasury_amount"] += int(d["treasury_amount"])
        elif kind == "payout":
            s["paid_" + d["role"].lower()] += int(d["amount"])
        elif kind == "payout_failed":
            s["pending_failed"] += int(d["amount"])
            failed[str(d["id"])] = (tok, int(d["amount"]))
        elif kind == "payout_retry":
            tok2, amt = failed.pop(str(d["id"]))
            stats[tok2]["pending_failed"] -= amt
    return stats, failed


def rpc(url, method, params, tries=4):
    body = json.dumps({"jsonrpc": "2.0", "id": "verify", "method": method, "params": params}).encode()
    last = None
    for n in range(tries):
        try:
            req = urllib.request.Request(url, body, {"content-type": "application/json",
                                                     "user-agent": "nearbi-ledger-verify/0.1"})
            with urllib.request.urlopen(req, timeout=30) as r:
                out = json.load(r)
            if "error" in out:
                raise RuntimeError(json.dumps(out["error"])[:400])
            return out["result"]
        except Exception as e:  # noqa: BLE001 (retry any transport error)
            last = e
            time.sleep(1.5 * (n + 1))
    raise RuntimeError("%s %s failed: %s" % (method, url, last))


def view(url, account, method, args=None, block=None):
    params = {"request_type": "call_function", "account_id": account, "method_name": method,
              "args_base64": __import__("base64").b64encode(json.dumps(args or {}).encode()).decode()}
    if block is None:
        params["finality"] = "final"
    else:
        params["block_id"] = block
    res = rpc(url, "query", params)
    return json.loads(bytes(res["result"]).decode())


def check_rpc(lines, rpc_urls, splitter, forwarder=None):
    """Re-fetch every tx and block from NEAR RPC; raw logs must match byte for byte."""
    errors = []
    txs = {}
    blocks = {}
    for ln in lines:
        h = ln["tx_hash"]
        if h not in txs:
            res = None
            for url in rpc_urls:
                try:
                    res = rpc(url, "EXPERIMENTAL_tx_status", {"tx_hash": h, "sender_account_id": ln["signer"],
                                                              "wait_until": "NONE"})
                    break
                except RuntimeError as e:
                    last = e
            if res is None:
                errors.append("tx %s: not found on any RPC (%s)" % (h, last))
                txs[h] = {}
                continue
            txs[h] = {o["id"]: o for o in res["receipts_outcome"]}
        o = txs[h].get(ln["receipt_id"])
        if o is None:
            errors.append("line %d: receipt %s not in tx %s" % (ln["seq"] + 1, ln["receipt_id"], h))
            continue
        out = o["outcome"]
        logs = out["logs"]
        want = forwarder if ln.get("standard") == FORWARDER_STANDARD else splitter
        if out["executor_id"] != want:
            errors.append("line %d: receipt executed by %s, not %s" % (ln["seq"] + 1, out["executor_id"], want))
        if not any(k in out["status"] for k in ("SuccessValue", "SuccessReceiptId")):
            errors.append("line %d: receipt did not succeed" % (ln["seq"] + 1))
        if ln["log_index"] >= len(logs) or logs[ln["log_index"]] != ln["raw"]:
            errors.append("line %d: raw log differs from chain" % (ln["seq"] + 1))
        if o["block_hash"] != ln["block_hash"]:
            errors.append("line %d: block hash differs from chain" % (ln["seq"] + 1))
        bh = ln["block_hash"]
        if bh not in blocks:
            hdr = None
            for url in rpc_urls:
                try:
                    hdr = rpc(url, "block", {"block_id": bh})["header"]
                    break
                except RuntimeError:
                    pass
            blocks[bh] = hdr
        hdr = blocks[bh]
        if hdr and (hdr["height"] != ln["block"] or str(hdr["timestamp_nanosec"]) != ln["ts_ns"]):
            errors.append("line %d: block height/timestamp differs from chain" % (ln["seq"] + 1))
    return errors


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ledger", help="path to ledger.jsonl")
    ap.add_argument("--rpc", action="store_true", help="also re-check every event and get_stats() against NEAR RPC")
    ap.add_argument("--rpc-url", action="append", default=None,
                    help="RPC endpoint(s), tried in order (default: the network's RPC + archival)")
    ap.add_argument("--network", choices=sorted(NETWORKS), help="default: inferred from the file's explorer links")
    ap.add_argument("--splitter", help="default: the network's splitter")
    a = ap.parse_args(argv)

    with open(a.ledger, encoding="utf-8") as f:
        lines = [json.loads(l) for l in f if l.strip()]
    net = NETWORKS[a.network or infer_network(lines)]
    rpc_urls = a.rpc_url or net["rpc"]
    a.splitter = a.splitter or net["splitter"]
    print("network: %s (%s%s)" % (a.network or infer_network(lines), a.splitter,
                                  " + " + net["forwarder"] if net["forwarder"] else ""))
    errors, head = check_chain(lines)
    print("hash chain: %d lines, head %s ... %s" % (len(lines), head[:16], "OK" if not errors else "BROKEN"))
    row_err = check_rows(lines, net["explorer"])
    print("rows vs raw events + split math: %s" % ("OK" if not row_err else "%d problems" % len(row_err)))
    errors += row_err
    stats, outstanding = totals(lines)
    for tok, s in sorted(stats.items()):
        print("totals %s: sales=%d received=%d contributors=%d treasury=%d pending_failed=%d" % (
            tok, s["sales"], s["total_received"], s["contributors_amount"], s["treasury_amount"], s["pending_failed"]))
        paid = s["paid_contributors"] + s["paid_treasury"] + s["pending_failed"]
        if paid != s["total_received"]:
            errors.append("%s: payouts %d + pending %d != received %d" % (
                tok, s["paid_contributors"] + s["paid_treasury"], s["pending_failed"], s["total_received"]))

    if a.rpc:
        rerr = check_rpc(lines, rpc_urls, a.splitter, net["forwarder"])
        print("rpc re-check of %d events: %s" % (len(lines), "OK" if not rerr else "%d problems" % len(rerr)))
        errors += rerr
        last_block = max((ln["block"] for ln in lines), default=None)
        if last_block is not None:
            live = view(rpc_urls[0], a.splitter, "get_stats")
            for v in live:
                s = stats.get(v["token"], {})
                same = all(int(v[k]) == s.get(k, 0) for k in
                           ("sales", "total_received", "contributors_amount", "treasury_amount", "pending_failed"))
                print("get_stats() now %s: sales=%s received=%s -> %s" % (
                    v["token"], v["sales"], v["total_received"],
                    "matches ledger" if same else "differs (contract has activity newer than this ledger file?)"))

    for e in errors:
        print("FAIL " + e)
    print("RESULT: %s" % ("OK" if not errors else "FAILED (%d)" % len(errors)))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
