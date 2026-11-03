#!/usr/bin/env python3
"""Build the NearBI public ledger from the splitter contract's NEP-297 events.

Pipeline (standard library only, Python 3.12):
  1. discover  every tx touching the splitter: FastNEAR tx API (account index, includes receipts and
               event logs), unioned with data/seed-txs.txt and the tx hashes already in data/ledger.jsonl
  2. resolve   each tx with NEAR RPC EXPERIMENTAL_tx_status (archival fallback). RPC is the source of truth;
               FastNEAR's copy of each splitter receipt is cross-checked (logs + block hash) when present
  3. normalize every `EVENT_JSON` log of standard `nearbi_splitter` from a *successful* splitter receipt
               into one ledger line, ordered by chain position, hash-chained (see verify_ledger.py)
  4. reconcile against get_stats() / get_config() / get_failed_payouts() at the same final block;
               any mismatch fails the build (after retries, to absorb indexer lag)
  5. write     out/ledger/{index.html, ledger.jsonl, ledger.json, verify_ledger.py} and data/ledger.jsonl

Append-only: the previous data/ledger.jsonl must be an exact prefix of the new one, else the build fails.
"""
import argparse
import base64
import datetime as dt
import html
import json
import os
import shutil
import string
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import verify_ledger as V  # noqa: E402

CFG = json.loads((ROOT / "config.json").read_text())
SPLITTER = CFG["splitter"]
DATA = ROOT / "data"
CACHE = DATA / "cache"
OUT = ROOT / "out" / "ledger"
UA = {"content-type": "application/json", "user-agent": "nearbi-ledger/0.1 (+https://nearbi.ai/ledger/)"}
STANDARD = "nearbi_splitter"
CUTOFF_BLOCKS = int(os.environ.get("LEDGER_CUTOFF_BLOCKS", "20"))  # let the indexer catch up with finality


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def post(url, payload, tries=4):
    last = None
    for n in range(tries):
        try:
            req = urllib.request.Request(url, json.dumps(payload).encode(), UA)
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (n + 1))
    raise RuntimeError("POST %s failed: %s" % (url, last))


def rpc(method, params, urls=None):
    last = None
    for url in urls or CFG["rpc"]:
        try:
            return V.rpc(url, method, params)
        except RuntimeError as e:
            last = e
    raise RuntimeError(str(last))


def view(account, method, args=None, block=None):
    params = {"request_type": "call_function", "account_id": account, "method_name": method,
              "args_base64": base64.b64encode(json.dumps(args or {}).encode()).decode(), "block_id": block}
    res = rpc("query", params)
    return json.loads(bytes(res["result"]).decode())


def cached(kind, key, fetch, keep):
    p = CACHE / kind / (key + ".json")
    if p.exists():
        return json.loads(p.read_text())
    val = fetch()
    if keep(val):
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(val))
    return val


# ---------------------------------------------------------------------------------------- discovery

def fastnear_account_txs(account):
    api = CFG["fastnear_tx_api"] + "/v0/account"
    out, token = [], None
    while True:
        body = {"account_id": account, "limit": 200}
        if token:
            body["resume_token"] = token
        res = post(api, body)
        out += res.get("account_txs", [])
        token = res.get("resume_token")
        if not token or not res.get("account_txs"):
            return out, res.get("txs_count")


def fastnear_txs(hashes):
    found = {}
    hashes = list(hashes)
    for i in range(0, len(hashes), 20):
        res = post(CFG["fastnear_tx_api"] + "/v0/transactions", {"tx_hashes": hashes[i:i + 20]})
        for t in res.get("transactions", []) or []:
            if t:
                found[t["transaction"]["hash"]] = t
    return found


def discover(prev_lines, allow_seed_only):
    sources = {}
    try:
        acc, count = fastnear_account_txs(SPLITTER)
        for t in acc:
            sources.setdefault(t["transaction_hash"], set()).add("fastnear")
        log("discover: fastnear lists %d txs (txs_count=%s)" % (len(acc), count))
        fast_ok = True
    except RuntimeError as e:
        if not allow_seed_only:
            raise
        log("discover: FastNEAR unavailable (%s); seed list + previous ledger only" % e)
        fast_ok = False
    seed = DATA / "seed-txs.txt"
    if seed.exists():
        for ln in seed.read_text().splitlines():
            h = ln.split("#")[0].strip()
            if h:
                sources.setdefault(h, set()).add("seed")
    for ln in prev_lines:
        sources.setdefault(ln["tx_hash"], set()).add("ledger")
    return sources, fast_ok


# ------------------------------------------------------------------------------------------ resolve

def rpc_tx(h, signer):
    def fetch():
        return rpc("EXPERIMENTAL_tx_status", {"tx_hash": h, "sender_account_id": signer or SPLITTER,
                                              "wait_until": "NONE"})
    return cached("tx", h, fetch, lambda r: r.get("final_execution_status") == "FINAL")


def block_header(bh):
    return cached("block", bh, lambda: rpc("block", {"block_id": bh})["header"], lambda r: True)


def ok_status(status):
    return any(k in status for k in ("SuccessValue", "SuccessReceiptId"))


def extract(h, tx, fast):
    """Yield raw ledger rows (no seq/hash yet) for every splitter event in a resolved tx."""
    fast_receipts = {}
    if fast:
        for r in fast.get("receipts", []):
            eo = r["execution_outcome"]
            fast_receipts[eo["id"]] = eo
    signer = tx["transaction"]["signer_id"]
    rows, problems = [], []
    for pos, o in enumerate(tx["receipts_outcome"]):
        out = o["outcome"]
        if out["executor_id"] != SPLITTER or not ok_status(out["status"]):
            continue
        evs = [(i, l) for i, l in enumerate(out["logs"]) if l.startswith("EVENT_JSON:")]
        if not evs:
            continue
        fr = fast_receipts.get(o["id"])
        if fast and fr is None:
            problems.append("tx %s receipt %s missing from FastNEAR" % (h, o["id"]))
        elif fr is not None and (fr["outcome"]["logs"] != out["logs"] or fr["block_hash"] != o["block_hash"]):
            problems.append("tx %s receipt %s: FastNEAR and RPC disagree" % (h, o["id"]))
        hdr = block_header(o["block_hash"])
        for i, raw in evs:
            ev = json.loads(raw[len("EVENT_JSON:"):])
            if ev.get("standard") != STANDARD:
                continue
            rows.append({"_sort": (hdr["height"], pos, i), "raw": raw, "ev": ev, "tx_hash": h, "signer": signer,
                         "receipt_id": o["id"], "log_index": i, "block": hdr["height"],
                         "block_hash": o["block_hash"], "ts_ns": str(hdr["timestamp_nanosec"])})
    return rows, problems


# -------------------------------------------------------------------------------------- normalize

def fmt_units(v, decimals):
    v = int(v)
    if decimals == 0:
        return str(v)
    s = str(abs(v)).rjust(decimals + 1, "0")
    return ("-" if v < 0 else "") + s[:-decimals] + "." + s[-decimals:]


class Tokens:
    def __init__(self, block):
        self.block, self.meta = block, {}

    def get(self, token):
        if token not in self.meta:
            self.meta[token] = cached("ft_metadata", token, lambda: view(token, "ft_metadata", block=self.block),
                                      lambda r: True)
        return self.meta[token]


def normalize(r, tokens):
    kind, d = r["ev"]["event"], r["ev"]["data"][0]
    ts = dt.datetime.fromtimestamp(int(r["ts_ns"]) // 10**9, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    token = d.get("token")
    amounts, accounts = {}, {"signer": r["signer"]}
    unit, decimals = None, 0
    if token:
        m = tokens.get(token)
        unit, decimals = m["symbol"], m["decimals"]
    if kind == "sale":
        amounts = {k: d[k] for k in ("amount", "contributors_amount", "treasury_amount")}
        accounts["payer"] = d["payer"]
    elif kind in ("payout", "payout_failed"):
        amounts = {"amount": d["amount"]}
        accounts["recipient"] = d["recipient"]
    elif kind == "refund_paused":
        amounts = {"amount": d["amount"]}
        accounts["payer"] = d["payer"]
    elif kind == "cost":
        amounts = {"amount": d["amount_usd_micros"]}
        unit, decimals = "USD", CFG["usd_decimals"]
    elif kind == "config_change":
        accounts["by"] = d["by"]
    return {
        "ts": ts, "ts_ns": r["ts_ns"], "block": r["block"], "block_hash": r["block_hash"],
        "tx_hash": r["tx_hash"], "receipt_id": r["receipt_id"], "log_index": r["log_index"],
        "signer": r["signer"], "kind": kind, "standard": r["ev"]["standard"], "version": r["ev"]["version"],
        "order_id": d.get("order_id"), "token": token, "unit": unit, "decimals": decimals,
        "amounts": {k: str(v) for k, v in amounts.items()},
        "display": {k: fmt_units(v, decimals) for k, v in amounts.items()},
        "accounts": accounts, "data": d, "raw": r["raw"],
        "explorer": CFG["explorer_tx"] + r["tx_hash"],
    }


def chain(bodies):
    out, prev = [], V.GENESIS
    for i, b in enumerate(bodies):
        b = dict(b, seq=i)
        ln = V.seal(b, prev)
        prev = ln["line_hash"]
        out.append(ln)
    return out


# -------------------------------------------------------------------------------------- reconcile

def init_split(sources, txs):
    """split_bps_contributors from the splitter's own `init` call, read from chain."""
    for h in sources:
        t = txs[h]["transaction"]
        if t["receiver_id"] != SPLITTER:
            continue
        for a in t["actions"]:
            fc = a.get("FunctionCall") if isinstance(a, dict) else None
            if fc and fc["method_name"] == "init":
                return int(json.loads(base64.b64decode(fc["args"]))["split_bps_contributors"]), h
    return None, None


def reconcile(lines, live_stats, config, failed_live, init_bps, init_tx, splitter_balances):
    checks = []

    def check(name, ok, detail):
        checks.append({"check": name, "ok": bool(ok), "detail": detail})

    cerr, head = V.check_chain(lines)
    check("hash chain", not cerr, "%d lines, head %s" % (len(lines), head) if not cerr else "; ".join(cerr))
    rerr = V.check_rows(lines)
    check("rows match raw events; split math per sale", not rerr, "; ".join(rerr) or "all sales: contributors = "
          "floor(amount*bps/10000), treasury = amount - contributors")

    totals, outstanding = V.totals(lines)
    fields = ("sales", "total_received", "contributors_amount", "treasury_amount", "pending_failed")
    live = {s["token"]: s for s in live_stats}
    for tok in sorted(set(live) | set(totals)):
        e, l = totals.get(tok, {}), live.get(tok, {})
        diffs = ["%s events=%s contract=%s" % (f, e.get(f, 0), l.get(f, 0)) for f in fields
                 if int(e.get(f, 0)) != int(l.get(f, 0))]
        check("totals == get_stats() [%s]" % tok, not diffs, "; ".join(diffs) or ", ".join(
            "%s=%s" % (f, e.get(f, 0)) for f in fields))
        paid = e.get("paid_contributors", 0) + e.get("paid_treasury", 0)
        check("payouts + pending == received [%s]" % tok, paid + e.get("pending_failed", 0) == e.get("total_received", 0),
              "contributors paid %s + treasury paid %s + pending %s vs received %s" % (
                  e.get("paid_contributors", 0), e.get("paid_treasury", 0), e.get("pending_failed", 0),
                  e.get("total_received", 0)))
        bal = splitter_balances.get(tok)
        if bal is not None and int(bal) != e.get("pending_failed", 0):
            checks.append({"check": "splitter balance == pending [%s]" % tok, "ok": True, "warn": True,
                           "detail": "WARNING balance %s vs pending %s (stray transfers?)" % (bal, e.get("pending_failed", 0))})

    # split in effect for every sale: init value, then config_change events, in chain order
    bps, bad = init_bps, []
    for ln in lines:
        if ln["kind"] == "config_change" and ln["data"]["field"] == "split_bps_contributors":
            bps = int(ln["data"]["value"])
        elif ln["kind"] == "sale":
            ev_bps = int(ln["data"]["split_bps_contributors"])
            if bps is None or ev_bps != bps:
                bad.append("%s used %s bps, configured %s" % (ln["order_id"], ev_bps, bps))
            amt = int(ln["amounts"]["amount"])
            if int(ln["amounts"]["contributors_amount"]) != V.split_amount(amt, bps or 0)[0]:
                bad.append("%s contributors_amount does not match configured split" % ln["order_id"])
    nsales = sum(1 for ln in lines if ln["kind"] == "sale")
    check("every sale used the configured split", not bad and init_bps is not None,
          "; ".join(bad) or "%d sales at %s bps (init tx %s, plus config_change events)" % (nsales, bps, init_tx))
    check("configured split == get_config()", bps == config["split_bps_contributors"],
          "events say %s bps, contract says %s bps" % (bps, config["split_bps_contributors"]))

    live_failed = {str(f["id"]): (f["token"], int(f["amount"])) for f in failed_live}
    check("outstanding failed payouts == get_failed_payouts()", live_failed == outstanding,
          "%d outstanding" % len(outstanding) if live_failed == outstanding else
          "events %s vs contract %s" % (outstanding, live_failed))
    return checks, totals


# ----------------------------------------------------------------------------------------- render

def esc(s):
    return html.escape("" if s is None else str(s), quote=True)


def acct(a):
    return '<a href="%s%s">%s</a>' % (CFG["explorer_account"], esc(a), esc(a)) if a else ""


def short(h, n=8):
    return h[:n] + "…" if h and len(h) > n + 1 else (h or "")


def describe(ln):
    d, disp, k = ln["data"], ln["display"], ln["kind"]
    if k == "sale":
        return "Order <code>%s</code> paid by %s: contributors %s, treasury %s (%s bps)" % (
            esc(d["order_id"]), acct(d["payer"]), disp["contributors_amount"], disp["treasury_amount"],
            d["split_bps_contributors"])
    if k == "payout":
        return "%s share of <code>%s</code> to %s" % (esc(d["role"]), esc(d["order_id"]), acct(d["recipient"]))
    if k == "payout_failed":
        return "<b>Failed</b> %s payout #%s of <code>%s</code> to %s (held, retryable)" % (
            esc(d["role"]), esc(d["id"]), esc(d["order_id"]), acct(d["recipient"]))
    if k == "payout_retry":
        return "Retry of failed payout #%s (<code>%s</code>)" % (esc(d["id"]), esc(d["order_id"]))
    if k == "cost":
        return "Cost <b>%s</b>, ref <code>%s</code>" % (esc(d["kind"]), esc(d["ref"]))
    if k == "report_anchor":
        return "Report <code>%s</code> manifest sha256 <code>%s</code>" % (esc(d["slug"]), esc(d["manifest_sha256"]))
    if k == "config_change":
        return "Config <code>%s</code> = <code>%s</code> by %s" % (esc(d["field"]), esc(json.dumps(d["value"])), acct(d["by"]))
    if k == "refund_paused":
        return "Refunded (paused) to %s" % acct(d["payer"])
    return esc(json.dumps(d))


def render(lines, doc):
    rows = []
    for ln in reversed(lines):
        amt = ln["display"].get("amount")
        amount = "%s %s" % (amt, esc(ln["unit"])) if amt is not None else ""
        rows.append(
            '<tr data-kind="%s"><td class="mono">%s</td><td><span class="k k-%s">%s</span></td><td class="num">%s</td>'
            '<td>%s</td><td class="mono"><a href="%s" title="%s">%s</a><br><span class="muted">block %s</span></td>'
            '<td><details><summary>raw</summary><pre>%s</pre><div class="muted small">receipt %s · log %s · line_hash %s</div>'
            '</details></td></tr>' % (
                esc(ln["kind"]), esc(ln["ts"].replace("T", " ").replace("Z", " UTC")), esc(ln["kind"]), esc(ln["kind"]),
                amount, describe(ln), esc(ln["explorer"]), esc(ln["tx_hash"]), esc(short(ln["tx_hash"], 10)),
                ln["block"], esc(ln["raw"]), esc(ln["receipt_id"]), ln["log_index"], esc(short(ln["line_hash"], 16))))
    t = doc["totals_display"]
    cfg = doc["config"]
    recon_ok = doc["reconciliation"]["ok"]
    checks = "".join('<li class="%s">%s <b>%s</b>: %s</li>' % (
        "warn" if c.get("warn") else ("ok" if c["ok"] else "bad"), "⚠️" if c.get("warn") else ("✅" if c["ok"] else "❌"),
        esc(c["check"]), esc(c["detail"])) for c in doc["reconciliation"]["checks"])
    live = "".join("<tr><td>%s</td>%s</tr>" % (acct(s["token"]), "".join(
        '<td class="num">%s</td>' % esc(s[f]) for f in ("sales", "total_received", "contributors_amount",
                                                        "treasury_amount", "pending_failed")))
        for s in doc["contract_stats"])
    tpl = string.Template((ROOT / "templates" / "index.html").read_text())
    return tpl.substitute(
        badge=esc(CFG["network_badge"]),
        updated=esc(doc["generated_at"].replace("T", " ").replace("Z", " UTC")),
        block=doc["as_of_block"],
        splitter=acct(SPLITTER),
        sales=t["sales"], gross=t["gross"], contributors=t["paid_contributors"], treasury=t["paid_treasury"],
        pending=t["pending_failed"], costs=t["costs_usd"], ncosts=t["cost_events"], anchors=t["reports_anchored"],
        unit=esc(t["unit"]),
        split="%g%% / %g%%" % (cfg["split_bps_contributors"] / 100, cfg["split_bps_treasury"] / 100),
        recon_class="ok" if recon_ok else "bad",
        recon_badge="✅ Reconciled with the contract" if recon_ok else "❌ Reconciliation FAILED",
        checks=checks, live_rows=live, rows="".join(rows) or '<tr><td colspan="6">No events yet.</td></tr>',
        nevents=len(lines), head=esc(doc["head_hash"]),
        owner=acct(cfg["owner"]), cfg_treasury=acct(cfg["treasury"]), cfg_contributors=acct(cfg["contributors"]),
        tokens=", ".join(acct(x) for x in cfg["accepted_tokens"]), paused="yes" if cfg["paused"] else "no",
        version=esc(cfg["version"]), bps=cfg["split_bps_contributors"], bps_t=cfg["split_bps_treasury"],
        site=esc(CFG["site_url"]), rpc=esc(CFG["rpc"][0]), splitter_id=esc(SPLITTER),
    )


# ------------------------------------------------------------------------------------------- main

def build_once(prev_lines, allow_seed_only):
    final = rpc("block", {"finality": "final"})["header"]["height"]
    H = final - CUTOFF_BLOCKS
    log("build: final block %d, ledger cutoff block %d" % (final, H))
    sources, fast_ok = discover(prev_lines, allow_seed_only)
    fast = fastnear_txs(sources.keys()) if fast_ok else {}
    txs, rows, problems = {}, [], []
    signers = {h: (fast[h]["transaction"]["signer_id"] if h in fast else None) for h in sources}
    for ln in prev_lines:
        signers[ln["tx_hash"]] = signers.get(ln["tx_hash"]) or ln["signer"]
    for h in sorted(sources):
        txs[h] = rpc_tx(h, signers.get(h))
        r, p = extract(h, txs[h], fast.get(h))
        rows += r
        problems += p
    rows = [r for r in rows if r["block"] <= H]
    rows.sort(key=lambda r: r["_sort"] + (r["tx_hash"],))
    tokens = Tokens(H)
    lines = chain([normalize(r, tokens) for r in rows])

    config = view(SPLITTER, "get_config", block=H)
    live_stats = view(SPLITTER, "get_stats", block=H)
    failed = view(SPLITTER, "get_failed_payouts", block=H)
    balances = {}
    for s in live_stats:
        balances[s["token"]] = view(s["token"], "ft_balance_of", {"account_id": SPLITTER}, block=H)
    init_bps, init_tx = init_split(sources, txs)
    checks, totals = reconcile(lines, live_stats, config, failed, init_bps, init_tx, balances)
    for p in problems:
        checks.append({"check": "FastNEAR cross-check", "ok": False, "detail": p})
    # append-only: the previously published ledger must be a prefix
    n = len(prev_lines)
    prefix_ok = lines[:n] == prev_lines
    checks.append({"check": "append-only (previous ledger is a prefix)", "ok": prefix_ok,
                   "detail": "%d previous lines kept, %d new" % (n, len(lines) - n) if prefix_ok else
                   "previous ledger.jsonl is not a prefix of the rebuilt one"})
    return H, lines, config, live_stats, failed, checks, totals, tokens


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--retries", type=int, default=int(os.environ.get("LEDGER_RETRIES", "5")))
    ap.add_argument("--allow-seed-only", action="store_true", help="build without FastNEAR (seed list + ledger)")
    ap.add_argument("--rebuild-chain", action="store_true", help="ignore data/ledger.jsonl (breaks append-only)")
    ap.add_argument("--prev", default=str(DATA / "ledger.jsonl"),
                    help="previously published ledger that must stay a prefix (default data/ledger.jsonl)")
    a = ap.parse_args()
    prev_path = Path(a.prev)
    prev = [] if a.rebuild_chain or not prev_path.exists() else \
        [json.loads(l) for l in prev_path.read_text().splitlines() if l.strip()]

    for attempt in range(1, a.retries + 1):
        H, lines, config, live_stats, failed, checks, totals, tokens = build_once(prev, a.allow_seed_only)
        ok = all(c["ok"] for c in checks)
        if ok or attempt == a.retries:
            break
        log("reconcile: mismatch on attempt %d/%d, retrying in 15s (indexer lag?)" % (attempt, a.retries))
        for c in checks:
            if not c["ok"]:
                log("  ❌ %s: %s" % (c["check"], c["detail"]))
        time.sleep(15)

    print("\nRECONCILIATION at block %d (%s)" % (H, SPLITTER))
    for c in checks:
        print("  %s %s: %s" % ("⚠️ " if c.get("warn") else ("✅" if c["ok"] else "❌"), c["check"], c["detail"]))
    print("RESULT: %s" % ("RECONCILED" if ok else "MISMATCH"))
    if not ok:
        return 1

    # display totals (single token today; per-token totals stay in ledger.json)
    tok = next(iter(totals), None)
    t = totals.get(tok, {})
    meta = tokens.get(tok) if tok else {"symbol": "", "decimals": 0}
    dec = meta["decimals"]
    costs = sum(int(ln["amounts"]["amount"]) for ln in lines if ln["kind"] == "cost")
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    doc = {
        "generated_at": now, "network": CFG["network"], "network_badge": CFG["network_badge"],
        "splitter": SPLITTER, "as_of_block": H, "head_hash": lines[-1]["line_hash"] if lines else V.GENESIS,
        "config": config, "contract_stats": live_stats, "failed_payouts": failed,
        "totals": {k: {f: str(v) for f, v in s.items() if f != "token"} for k, s in totals.items()},
        "totals_display": {
            "unit": meta["symbol"], "sales": t.get("sales", 0),
            "gross": fmt_units(t.get("total_received", 0), dec), "paid_contributors": fmt_units(t.get("paid_contributors", 0), dec),
            "paid_treasury": fmt_units(t.get("paid_treasury", 0), dec), "pending_failed": fmt_units(t.get("pending_failed", 0), dec),
            "costs_usd": fmt_units(costs, CFG["usd_decimals"]), "cost_events": sum(ln["kind"] == "cost" for ln in lines),
            "reports_anchored": sum(ln["kind"] == "report_anchor" for ln in lines)},
        "reconciliation": {"ok": ok, "block": H, "checks": checks},
        "events": lines,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    jsonl = "".join(json.dumps(ln, ensure_ascii=False, separators=(",", ":")) + "\n" for ln in lines)
    (OUT / "ledger.jsonl").write_text(jsonl)
    (DATA / "ledger.jsonl").write_text(jsonl)
    (OUT / "ledger.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1))
    shutil.copyfile(ROOT / "src" / "verify_ledger.py", OUT / "verify_ledger.py")
    (OUT / "index.html").write_text(render(lines, doc))
    print("wrote %s (%d events, head %s)" % (OUT, len(lines), doc["head_hash"][:16]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
