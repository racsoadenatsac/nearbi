"""Report writer: the agent buys NEAR AI Cloud inference to write a report's narrative from cached query results.

ARCHITECTURE.md §3.4-3.5. One run = one order:

  1. load the result pack (manifest.json + results/*.csv + queries/*.sql) and verify every file's SHA-256
     against the manifest (a pack that doesn't hash is refused before anything is paid);
  2. check the operator rules for the worst case (kill switch, per-report cap, daily cap, and this tool's own
     --max-usd ceiling) BEFORE the first paid call; nearai.Client.chat re-checks before every call;
  3. prompt the model with structured data only (question, window, params, every result table as JSON) and ask
     for prose in the fixed Track 02 sections: Claim, Evidence for, Evidence against, What would change the
     conclusion. The Queries section is generated from the pack, never by the model;
  4. take the reply through nearai.text_of() (an empty/truncated paid reply raises EmptyCompletion);
  5. run the rs-reports number post-check (tools/check_numbers.py, rounding allowed): every number in the prose
     must be a result cell (or a cell rounded to the shown decimals) or a declared query param;
  6. on any failure (untraced numbers, missing sections, empty reply) regenerate ONCE with the problem fed back,
     then fail loudly: exit 6, nothing written;
  7. write report.md + meta.json (model, tokens, billed cost, spend-ledger line hashes, result hashes) atomically.

Every call is booked in the spend ledger under the order id by nearai.Client (kind=inference).
"""
from __future__ import annotations

import csv
import hashlib
import importlib.util
import json
import os
import re
import tempfile
import time
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Optional

from . import nearai, rules, spend

SECTIONS = ("Claim", "Evidence for", "Evidence against", "What would change the conclusion")
DEFAULT_MODEL = "anthropic/claude-haiku-5-5"
DEFAULT_MAX_TOKENS = 8000  # Haiku 5.5 spends hidden reasoning tokens (~3x the visible text in samples)
DEFAULT_MAX_USD = Decimal("1.00")
MAX_ATTEMPTS = 2  # first draft + at most one regeneration
MAX_ROWS_PER_TABLE = 200
EXIT_FAILED = 6

SYSTEM = """You are the analyst of a small onchain-data research shop. You write the narrative of a report from query \
results you are given as JSON. You never see the database; the results are the only facts you have.

Hard rules (a script checks every number you write; a single violation rejects the report):
- Every number you write must be copied from a result cell or from "params". You may add thousands separators \
(1036408 -> 1,036,408), add a % sign to a value that is already a percentage, and round a decimal cell to fewer \
decimals (93.03 -> 93.0 or 93). Nothing else.
- Never compute new numbers: no sums, differences, ratios, averages, multiples ("3x"), growth rates, ranks you \
had to count, or counts of rows. No "million"/"billion"/"k" abbreviations. No approximate numbers ("about 70k").
- Dates are fine in YYYY-MM-DD form. Write account ids in `backticks`.
- If the data cannot support a point, say so in words instead of inventing a figure.
- Cite the query id after each evidence item, like (q3).

Output: Markdown with exactly these four level-2 headings, in this order, and nothing before or after them:
## Claim
## Evidence for
## Evidence against
## What would change the conclusion

- Claim: the first line is one bold sentence that answers the question; then at most three plain sentences of nuance.
- Evidence for / Evidence against: numbered lists of 3-5 items, each starting with a bold one-line finding.
- What would change the conclusion: 2-4 bullets, each naming a concrete observation or query that would change it.
- No other headings, no tables, no code blocks, no Queries section (it is generated separately). Be precise and \
plain; no hype. Evidence against must be genuine counter-evidence or limits of the data, not a restatement."""


class PackError(ValueError):
    pass


class ReportFailed(RuntimeError):
    def __init__(self, message: str, attempts: list[dict]):
        super().__init__(message)
        self.attempts = attempts


# ----------------------------------------------------------------------------------- the result pack
def sha256_file(p: Path) -> str:
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def _front_matter(text: str) -> dict:
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    out = {}
    for line in (m.group(1).splitlines() if m else []):
        k, _, v = line.partition(":")
        out[k.strip()] = v.strip().strip('"')
    return out


def _sql_header(sql: str, key: str) -> Optional[str]:
    m = re.search(rf"^--\s*{key}:\s*(.+)$", sql, re.M)
    return m.group(1).strip() if m else None


def _cell(v: str) -> Any:
    try:
        return int(v) if re.fullmatch(r"-?\d+", v) else float(v) if re.fullmatch(r"-?\d+\.\d+", v) else v
    except ValueError:
        return v


def load_pack(path: Path) -> dict:
    """Read and hash-verify a cached result pack. Raises PackError (nothing paid) on any mismatch."""
    root = Path(path).expanduser().resolve()
    mf = root / "manifest.json"
    if not mf.exists():
        raise PackError(f"{root}: no manifest.json (not a result pack)")
    manifest = json.loads(mf.read_text())
    if not manifest.get("queries"):
        raise PackError(f"{mf}: no queries")
    fm = _front_matter((root / "REPORT.md").read_text()) if (root / "REPORT.md").exists() else {}
    queries = []
    for qid, rec in manifest["queries"].items():
        csv_p, sql_p = root / "results" / f"{qid}.csv", root / "queries" / f"{qid}.sql"
        if not csv_p.exists():
            raise PackError(f"{qid}: missing cached result {csv_p}")
        got = sha256_file(csv_p)
        if got != rec.get("result_sha256"):
            raise PackError(f"{qid}: result hash {got[:16]}… != manifest {str(rec.get('result_sha256'))[:16]}…; refusing a pack that doesn't verify")
        sql = sql_p.read_text() if sql_p.exists() else ""
        if sql and rec.get("sql_sha256") and sha256_file(sql_p) != rec["sql_sha256"]:
            raise PackError(f"{qid}: SQL hash != manifest sql_sha256; the cached result is not from this query")
        with csv_p.open(newline="") as fh:
            rows = list(csv.reader(fh))
        if not rows:
            raise PackError(f"{qid}: empty result file")
        if len(rows) - 1 > MAX_ROWS_PER_TABLE:
            raise PackError(f"{qid}: {len(rows) - 1} rows > {MAX_ROWS_PER_TABLE}; summarize it in SQL before writing prose")
        queries.append({"id": qid, "short": qid.split("_", 1)[0], "question": _sql_header(sql, "question") or qid,
                        "file": f"queries/{qid}.sql" if sql else None, "sql_sha256": rec.get("sql_sha256"),
                        "result_file": f"results/{qid}.csv", "result_sha256": got, "rows": len(rows) - 1,
                        "window": rec.get("window"), "columns": rows[0], "data": [[_cell(c) for c in r] for r in rows[1:]]})
    p = fm.get("params", "").strip("[]")
    return {"dir": str(root), "name": root.name, "dataset": manifest.get("dataset"), "manifest_sha256": sha256_file(mf),
            "title": fm.get("title") or manifest.get("title"), "window": fm.get("window"),
            "params": [x.strip() for x in p.split(",") if x.strip()], "queries": queries}


# ----------------------------------------------------------------------------------- prompt
def window_of(pack: dict) -> Optional[str]:
    if pack.get("window"):
        return pack["window"]
    ws = {tuple(q["window"]) for q in pack["queries"] if q.get("window")}
    return f"{min(w[0] for w in ws)} .. {max(w[1] for w in ws)}" if ws else None


def build_messages(pack: dict, question: str, params: list[str], previous: Optional[str] = None,
                   problems: Optional[list[str]] = None) -> list[dict]:
    data = {"question": question, "dataset": pack.get("dataset"), "window": window_of(pack), "params": params,
            "queries": [{"id": q["short"], "question": q["question"], "window": q.get("window"), "columns": q["columns"],
                         "rows": q["data"]} for q in pack["queries"]]}
    msgs = [{"role": "system", "content": SYSTEM},
            {"role": "user", "content": "Write the report narrative for this question from these results.\n\n```json\n"
                                        + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n```"}]
    if previous is not None:
        msgs.append({"role": "assistant", "content": previous})
        msgs.append({"role": "user", "content": "Your draft was rejected by the checker:\n- " + "\n- ".join(problems or ["(no detail)"])
                     + "\n\nRewrite the whole narrative with the same four headings. Remove or replace every rejected number with a "
                       "value copied from the results, or make the point in words. Do not introduce any other new numbers."})
    return msgs


# ----------------------------------------------------------------------------------- parse + render
def strip_preamble(text: str) -> tuple[str, str]:
    """Drop chatter before the first '## ' heading ("Here is the narrative:"). It is never shipped, so dropping it is
    safe and saves a paid regeneration. Returns (text, dropped)."""
    m = re.search(r"^##\s", text, re.M)
    return (text[m.start():], text[:m.start()].strip()) if m else (text, "")


_GROUP = re.compile(r"(?<![\w.,\-])(\d{5,})(?![\w\-]|[.,]\d)")


def group_thousands(body: str) -> str:
    """20446122 -> 20,446,122 outside `code` (the number check strips separators, so tracing is unchanged)."""
    parts = re.split(r"(`[^`]*`)", body)
    return "".join(p if p.startswith("`") else _GROUP.sub(lambda m: f"{int(m.group(1)):,}", p) for p in parts)


def parse_sections(text: str) -> dict:
    """Split the model's Markdown into the four sections. Raises ValueError naming what's wrong."""
    t = text.strip()
    t = re.sub(r"^```(?:markdown|md)?\s*\n(.*)\n```$", r"\1", t, flags=re.S).strip()
    t = re.sub(r"^#\s[^\n]*\n", "", t).strip()  # a stray H1 title
    parts = re.split(r"^##\s+(.+?)\s*$", t, flags=re.M)
    if parts[0].strip():
        raise ValueError("text before the first heading")
    heads = [h.strip().rstrip(":") for h in parts[1::2]]
    if [h.lower() for h in heads] != [s.lower() for s in SECTIONS]:
        raise ValueError(f"headings must be exactly {list(SECTIONS)} in order, got {heads}")
    out = {}
    for name, body in zip(SECTIONS, parts[2::2]):
        body = body.strip()
        if not body:
            raise ValueError(f"section {name!r} is empty")
        if re.search(r"^#{1,6}\s", body, re.M):
            raise ValueError(f"section {name!r} contains a sub-heading")
        if "```" in body:
            raise ValueError(f"section {name!r} contains a code block")
        out[name] = group_thousands(body)
    if not out["Claim"].lstrip().startswith("**"):
        raise ValueError("the Claim must start with one bold sentence")
    return out


def claim_line(sections: dict) -> str:
    m = re.match(r"\s*\*\*(.+?)\*\*", sections["Claim"], re.S)
    return " ".join((m.group(1) if m else sections["Claim"].splitlines()[0]).split())


def queries_section(pack: dict) -> str:
    rows = ["| id | question | file | rows | result SHA-256 |", "|---|---|---|---|---|"]
    for q in pack["queries"]:
        rows.append(f"| {q['short']} | {q['question'].replace('|', '/')} | `{q['file'] or '-'}` | {q['rows']} | `{q['result_sha256']}` |")
    return ("## Queries\n\n" + "\n".join(rows) + "\n\nEvery result above is a cached, canonical CSV from the pack; its SHA-256 "
            "is checked against the pack's `manifest.json` before the narrative is written. Every number in the sections "
            "above was checked against these results (rs-reports `tools/check_numbers.py`, rounding allowed).\n")


def render(pack: dict, question: str, params: list[str], sections: Optional[dict], order_id: str, model: str) -> str:
    fm = ["---", f"title: {json.dumps(question, ensure_ascii=False)}", f"order: {order_id}",
          f"window: {window_of(pack) or 'n/a'}", f"dataset: {pack.get('dataset') or 'n/a'}",
          f"params: [{', '.join(params)}]", f"narrative_model: {model}", f"pack: {pack['name']}", "---", ""]
    body = [f"# {question}", "",
            f"*Research Shop report · order `{order_id}` · narrative written by `{model}` on NEAR AI Cloud from the cached "
            f"results of pack `{pack['name']}`; every number traces to a result cell.*", ""]
    for name in SECTIONS:
        body += [f"## {name}", "", (sections or {}).get(name, ""), ""]
    return "\n".join(fm + body) + "\n" + queries_section(pack)


# ----------------------------------------------------------------------------------- number check (rs-reports)
def rs_reports_dir() -> Path:
    return Path(os.environ.get("RS_REPORTS_DIR") or Path(__file__).resolve().parents[3] / "rs-reports")


def load_checker():
    p = rs_reports_dir() / "tools" / "check_numbers.py"
    if not p.exists():
        raise PackError(f"number checker not found at {p}; set RS_REPORTS_DIR to the rs-reports checkout")
    spec = importlib.util.spec_from_file_location("rs_reports_check_numbers", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if not hasattr(mod, "check_text"):
        raise PackError(f"{p} has no check_text(); update rs-reports (>= tools-v0.3.0)")
    return mod


# ----------------------------------------------------------------------------------- the run
def write_report(*, order_id: str, pack_dir: Path, out_dir: Path, client: Any, question: Optional[str] = None,
                 model: str = DEFAULT_MODEL, max_tokens: int = DEFAULT_MAX_TOKENS, max_usd: Decimal = DEFAULT_MAX_USD,
                 extra_params: tuple = (), cfg_path: Optional[str] = None, force: bool = False,
                 log: Callable[[str], None] = print, temperature: float = 0.3) -> dict:
    """Generate, check and write one report. Returns meta. Raises rules.Refused (nothing paid), PackError
    (nothing paid), ReportFailed (paid, nothing written) or nearai errors."""
    if not spend.ORDER_RE.match(order_id or ""):
        raise ValueError("--order must be 1-128 chars of [A-Za-z0-9._:-]")
    out_dir = Path(out_dir).expanduser()
    if (out_dir / "report.md").exists() and not force:
        raise PackError(f"{out_dir / 'report.md'} already exists (a delivered report is never overwritten; --force to replace)")
    pack = load_pack(pack_dir)
    question = question or pack.get("title")
    if not question:
        raise PackError("the pack has no title; pass --question")
    params = list(pack["params"]) + [str(p) for p in extra_params]
    checker = load_checker()

    # the fixed parts (title, byline, Queries) must pass the checker on their own, or no draft ever could
    _, bad = checker.check_text(render(pack, question, params, None, order_id, model), Path(pack["dir"]), rounding=True)
    if bad:
        raise PackError(f"the report template itself has untraced numbers {[b[1] for b in bad]} (from the question?); "
                        "reword the question or declare them as params (--param)")

    # rules for the worst case, before any paid call: two attempts, the second carrying the first draft back
    cfg = rules.current(cfg_path)
    rules.require_active(cfg, "writing a report")
    first = build_messages(pack, question, params)
    retry_shape = build_messages(pack, question, params, previous="x" * (max_tokens * nearai.CHARS_PER_TOKEN), problems=["x" * 400])
    worst = client.estimate_usd(model, first, max_tokens) + client.estimate_usd(model, retry_shape, max_tokens)
    if worst > max_usd:
        raise rules.Refused("report_writer_max_usd", f"worst case ${worst} for {MAX_ATTEMPTS} attempts > --max-usd ${max_usd}; "
                                                     f"lower --max-tokens or raise --max-usd")
    budget = rules.check_job(cfg, order_id, "inference", worst)
    log(f"rules ok: worst case ${worst} ({MAX_ATTEMPTS} attempts × {model}, max_tokens {max_tokens}); today "
        f"${spend.fmt_usd(budget['today_micros'])} of ${spend.fmt_usd(budget['daily_cap_micros'])}, order "
        f"${spend.fmt_usd(budget['order_micros'])} of ${spend.fmt_usd(budget['report_cap_micros'])}")

    attempts, previous, problems, sections, report = [], None, None, None, None
    sl = rules.ledger(cfg)
    for n in range(1, MAX_ATTEMPTS + 1):
        msgs = build_messages(pack, question, params, previous, problems)
        t0 = time.time()
        resp = client.chat(order_id, msgs, model=model, max_tokens=max_tokens, temperature=temperature)
        cost, usage = resp.get("_rs_cost") or {}, resp.get("usage") or {}
        line = next((l for l in sl.load() if l["line_hash"] == cost.get("spend_line")), {})
        att = {"attempt": n, "model": model, "inference_id": (line.get("meta") or {}).get("inference_id"),
               "usage": {k: usage.get(k) for k in ("prompt_tokens", "completion_tokens", "total_tokens")},
               "cost_usd": cost.get("usd"), "cost_source": cost.get("source"), "spend_seq": line.get("seq"),
               "spend_line_hash": cost.get("spend_line"), "finish_reason": (resp.get("_rs_result") or {}).get("finish_reason"),
               "seconds": round(time.time() - t0, 1), "prompt_sha256": hashlib.sha256(json.dumps(msgs).encode()).hexdigest()}
        attempts.append(att)
        try:
            text = nearai.text_of(resp)
        except nearai.EmptyCompletion as e:
            att.update(outcome="empty", problem=str(e))
            log(f"attempt {n}: {e} (paid ${cost.get('usd')})")
            previous, problems = "(empty)", [f"your reply was empty or cut off ({e}); write the full narrative, more concisely"]
            continue
        text, dropped = strip_preamble(text)
        if dropped:
            att["dropped_preamble"] = dropped[:200]
        try:
            sections = parse_sections(text)
        except ValueError as e:
            att.update(outcome="bad_structure", problem=str(e))
            log(f"attempt {n}: structure rejected: {e}")
            previous, problems = text, [f"structure: {e}"]
            continue
        report = render(pack, question, params, sections, order_id, model)
        checked, bad = checker.check_text(report, Path(pack["dir"]), rounding=True)
        att.update(numbers_checked=checked, untraced=[b[1] for b in bad])
        if not bad:
            att["outcome"] = "ok"
            log(f"attempt {n}: number check ok ({checked} numbers traced); {att['usage']} ${cost.get('usd')} ({cost.get('source')})")
            break
        att["outcome"] = "untraced_numbers"
        log(f"attempt {n}: {len(bad)} untraced numbers of {checked}: {[b[1] for b in bad]}")
        previous = text
        problems = [f"{tok!r} does not appear in any result cell or param (line: {ctx!r})" for _, tok, ctx in bad]
        report = None
    total_micros = sum(spend.usd_to_micros(a["cost_usd"] or "0") for a in attempts)
    if report is None:
        raise ReportFailed(f"no report for {order_id}: {len(attempts)} attempts failed ({', '.join(a['outcome'] for a in attempts)}); "
                           f"paid ${spend.fmt_usd(total_micros)}; nothing written", attempts)

    meta = {"order_id": order_id, "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "question": question,
            "claim": claim_line(sections), "sections": list(SECTIONS) + ["Queries"], "model": model, "max_tokens": max_tokens,
            "temperature": temperature, "provider": nearai.BASE, "network": cfg.network,
            "pack": {"name": pack["name"], "dir": pack["dir"], "manifest_sha256": pack["manifest_sha256"], "dataset": pack.get("dataset"),
                     "params": params,
                     "results": {q["id"]: {"result_sha256": q["result_sha256"], "sql_sha256": q["sql_sha256"], "rows": q["rows"]}
                                 for q in pack["queries"]}},
            "number_check": {"tool": "rs-reports tools/check_numbers.py", "rounding": True,
                             "numbers_checked": attempts[-1]["numbers_checked"], "untraced": 0, "attempts_needed": len(attempts)},
            "attempts": attempts,
            "usage": {k: sum(int(a["usage"].get(k) or 0) for a in attempts) for k in ("prompt_tokens", "completion_tokens", "total_tokens")},
            "cost_usd": spend.fmt_usd(total_micros), "cost_sources": sorted({a["cost_source"] for a in attempts if a["cost_source"]}),
            "spend_ledger": {"path": str(sl.path), "lines": [a["spend_line_hash"] for a in attempts],
                             "order_total_usd": spend.fmt_usd(sl.order_total(order_id))},
            "report_sha256": hashlib.sha256(report.encode()).hexdigest()}
    out_dir.mkdir(parents=True, exist_ok=True)
    # meta first, report.md last: report.md existing means the run finished
    for name, content in (("meta.json", json.dumps(meta, indent=2) + "\n"), ("report.md", report)):
        fd, tmp = tempfile.mkstemp(prefix=f".{name}.", dir=out_dir)
        with os.fdopen(fd, "w") as f:
            f.write(content)
        os.chmod(tmp, 0o644)
        os.replace(tmp, out_dir / name)
    return meta
