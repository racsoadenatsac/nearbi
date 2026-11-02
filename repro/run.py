"""Reproducibility runner.

Commands:
  stage          (optional) run stage/*.sql once: heavy raw scans written to small tables in
                 the pack's own BigQuery dataset ({stage}); every later query reads those
  run            dry-run + execute every queries/*.sql, write results/*.csv and manifest.json
  fetch          (optional) download fetch/*.json sources (public HTTP data, e.g. prices) to raw/
  analyze        (optional) run the pack's analysis.py: results/ + raw/ -> derived results/
  verify         re-run every query live (and re-fetch) and compare hashes with manifest.json
  verify-cached  offline: re-hash results/ and raw/, re-run analysis.py and compare
  charts         render charts/*.png from results/*.csv
  check          static guard check of every query and fetch spec (no GCP)

Environment:
  GOOGLE_APPLICATION_CREDENTIALS  path to a service-account JSON (mounted read-only)
  BQ_PROJECT                      GCP project billed for the queries
  MAX_GB_PER_QUERY                dry-run cap in GB for queries/*.sql (default 25)
  MAX_GB_PER_STAGE                dry-run cap in GB for stage/*.sql (default 500)
  BQ_STAGE_DATASET                dataset in BQ_PROJECT for stage tables (default rs_stage); created in the
                                  public dataset's location (us-east1 for NEAR) unless BQ_STAGE_LOCATION is set
  MAX_USD_TOTAL                   budget for everything recorded in the cost ledger (default: no cap).
                                  A step whose dry-run total would push the ledger over it is aborted
                                  before anything executes.
  COST_LEDGER                     cost ledger path (default $REPRO_ROOT/costs.jsonl)
  VERIFY_STAGE=1                  make `verify` also re-run the (expensive) stage queries
  STAGE_FORCE=1                   re-scan stage tables even when their query text is unchanged
"""
import hashlib
import io
import warnings
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from guard import GuardError, canonical_json, check, check_fetch, check_readonly, check_stage, render

# Results are small; the optional BigQuery Storage API adds nothing but a noisy warning.
warnings.filterwarnings("ignore", message="BigQuery Storage module not found")

ROOT = Path(os.environ.get("REPRO_ROOT", Path(__file__).resolve().parent.parent))
QUERIES = ROOT / "queries"
RESULTS = ROOT / "results"
CHARTS = ROOT / "charts"
MANIFEST = ROOT / "manifest.json"
STAGE = ROOT / "stage"
FETCH = ROOT / "fetch"
RAW = ROOT / "raw"
MAX_GB = float(os.environ.get("MAX_GB_PER_QUERY", "25"))
MAX_GB_STAGE = float(os.environ.get("MAX_GB_PER_STAGE", "500"))
MAX_USD_TOTAL = float(os.environ.get("MAX_USD_TOTAL", "inf"))
LEDGER = Path(os.environ.get("COST_LEDGER", ROOT / "costs.jsonl"))
USD_PER_TB = 6.25  # BigQuery on-demand list price


def usd(nbytes: float) -> float:
    return nbytes / 1e12 * USD_PER_TB


def ledger_total() -> float:
    """Bytes billed so far, from the append-only cost ledger."""
    if not LEDGER.exists():
        return 0.0
    return sum(json.loads(l)["bytes_billed"] for l in LEDGER.read_text().splitlines() if l.strip())


def ledger_add(step: str, name: str, bytes_billed: int, note: str = ""):
    rec = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "step": step, "name": name,
           "bytes_billed": int(bytes_billed), "usd": round(usd(bytes_billed), 4)}
    if note:
        rec["note"] = note
    with LEDGER.open("a") as fh:
        fh.write(json.dumps(rec) + "\n")


def budget_check(planned_bytes: float, what: str):
    """Abort before executing if the planned scans would push the ledger past MAX_USD_TOTAL."""
    spent = usd(ledger_total())
    planned = usd(planned_bytes)
    print(f"[budget] spent ${spent:.3f} + planned {what} ${planned:.3f} = ${spent + planned:.3f} (cap ${MAX_USD_TOTAL:g})")
    if spent + planned > MAX_USD_TOTAL:
        raise GuardError(f"budget: {what} would bring total to ${spent + planned:.3f}, over MAX_USD_TOTAL ${MAX_USD_TOTAL:g}")


def load_manifest() -> dict:
    return json.loads(MANIFEST.read_text()) if MANIFEST.exists() and MANIFEST.read_text().strip() else {}


def save_manifest(m: dict):
    m["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    m.setdefault("dataset", "bigquery-public-data.crypto_near_mainnet_us")
    MANIFEST.write_text(json.dumps(m, indent=2, sort_keys=False) + "\n")


def canonical_csv(df) -> bytes:
    """Deterministic CSV: stable column order, rows sorted, fixed number format."""
    df = df.copy()
    for col in df.columns:
        if str(df[col].dtype).startswith(("date", "dbdate")):
            df[col] = df[col].astype(str)
    df = df.sort_values(list(df.columns), kind="mergesort").reset_index(drop=True)
    buf = io.StringIO()
    df.to_csv(buf, index=False, lineterminator="\n", float_format="%.10g")
    return buf.getvalue().encode()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_queries(folder: Path = QUERIES, required: bool = True):
    files = sorted(folder.glob("*.sql")) if folder.exists() else []
    if not files and required:
        sys.exit(f"no queries in {folder}")
    return [(f.stem, f.read_text()) for f in files]


def stage_id() -> str:
    return f"{os.environ.get('BQ_PROJECT', 'project-unset')}.{os.environ.get('BQ_STAGE_DATASET', 'rs_stage')}"


def client():
    from google.cloud import bigquery

    project = os.environ.get("BQ_PROJECT")
    if not project:
        sys.exit("BQ_PROJECT is not set (the GCP project that pays for queries)")
    return bigquery.Client(project=project)


def dry_run(bq, name, sql, window, cap_gb):
    from google.cloud import bigquery

    dry = bq.query(sql, job_config=bigquery.QueryJobConfig(dry_run=True, use_query_cache=False))
    gb = dry.total_bytes_processed / 1e9
    print(f"[{name}] window {window[0]}..{window[1]}  dry-run {gb:.2f} GB  ~${usd(dry.total_bytes_processed):.3f}")
    if gb > cap_gb:
        raise GuardError(f"{name}: {gb:.2f} GB exceeds cap {cap_gb} GB (raise MAX_GB_PER_QUERY / MAX_GB_PER_STAGE)")
    return dry.total_bytes_processed


def plan(bq, items, cap_gb, step):
    """Guard + dry-run every query of a step, then check the whole step against the budget."""
    planned = []
    for name, sql, window in items:
        planned.append((name, sql, window, dry_run(bq, name, sql, window, cap_gb)))
    budget_check(sum(p[3] for p in planned), step)
    return planned


def execute(bq, name, sql, step):
    from google.cloud import bigquery

    # never serve from cache: a verify must really re-execute the query
    job = bq.query(sql, job_config=bigquery.QueryJobConfig(use_query_cache=False))
    job.result()
    ledger_add(step, name, job.total_bytes_billed or 0)
    return job


def read_items(bq):
    """queries/*.sql: read-only, rendered with the stage dataset."""
    items = []
    for name, tmpl in load_queries():
        window = check_readonly(tmpl)
        items.append((name, render(tmpl, stage_id()) if "{stage}" in tmpl else tmpl, window))
    return items


SOURCE_DATASET = "bigquery-public-data.crypto_near_mainnet_us"


def ensure_stage_dataset(bq):
    """Create the stage dataset in the same location as the public dataset (CTAS must not cross regions)."""
    from google.api_core.exceptions import NotFound
    from google.cloud import bigquery

    want = os.environ.get("BQ_STAGE_LOCATION") or bq.get_dataset(SOURCE_DATASET).location
    try:
        have = bq.get_dataset(stage_id()).location
    except NotFound:
        ds = bigquery.Dataset(stage_id())
        ds.location = want
        bq.create_dataset(ds)
        print(f"[stage] created dataset {stage_id()} in {want}")
        return
    if have.lower() != want.lower():
        raise GuardError(f"stage dataset {stage_id()} is in {have}, but the source data is in {want}; use another BQ_STAGE_DATASET")


def stage_is_current(bq, rec, tmpl, name) -> bool:
    """A stage table is reused when its query text is unchanged and the table still exists."""
    if os.environ.get("STAGE_FORCE") == "1" or not rec or rec.get("sql_sha256") != sha256(tmpl.encode()):
        return False
    from google.api_core.exceptions import NotFound

    try:
        bq.get_table(f"{stage_id()}.{name}")
        return True
    except NotFound:
        return False


def cmd_stage():
    from google.cloud import bigquery

    bq = client()
    tmpls = dict(load_queries(STAGE))
    manifest = load_manifest()
    manifest.setdefault("stage", {})
    ensure_stage_dataset(bq)
    items = []
    for name, tmpl in tmpls.items():
        window = check_stage(tmpl, name)
        if stage_is_current(bq, manifest["stage"].get(name), tmpl, name):
            print(f"[{name}] up to date (same query text, table exists): skipped; STAGE_FORCE=1 to re-scan")
            continue
        items.append((name, render(tmpl, stage_id()), window))
    if not items:
        print("[stage] nothing to do")
        return
    planned = plan(bq, items, MAX_GB_STAGE, "stage")
    for name, sql, window, nbytes in planned:
        job = execute(bq, name, sql, "stage")
        table = bq.get_table(f"{stage_id()}.{name}")
        manifest["stage"][name] = {
            "sql_sha256": sha256(tmpls[name].encode()),
            "window": list(window),
            "bytes_processed": nbytes,
            "bytes_billed": job.total_bytes_billed,
            "rows": table.num_rows,
            "executed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        print(f"[{name}] -> {{stage}}.{name}  {table.num_rows} rows  billed {job.total_bytes_billed / 1e9:.2f} GB")
        save_manifest(manifest)  # after every table, so a later failure keeps the record


def cmd_run():
    bq = client()
    RESULTS.mkdir(exist_ok=True)
    manifest = load_manifest()
    manifest["queries"] = {}
    tmpls = dict(load_queries())
    for name, sql, window, nbytes in plan(bq, read_items(bq), MAX_GB, "run"):
        df = execute(bq, name, sql, "run").to_dataframe()
        data = canonical_csv(df)
        (RESULTS / f"{name}.csv").write_bytes(data)
        manifest["queries"][name] = {
            "sql_sha256": sha256(tmpls[name].encode()),
            "result_sha256": sha256(data),
            "rows": len(df),
            "window": list(window),
            "bytes_processed": nbytes,
        }
        print(f"[{name}] {len(df)} rows  sha256 {sha256(data)}")
    save_manifest(manifest)
    print(f"wrote {MANIFEST.name}")


def load_fetches():
    files = sorted(FETCH.glob("*.json")) if FETCH.exists() else []
    return [(f.stem, f.read_text(), json.loads(f.read_text())) for f in files]


def http_get(url: str) -> bytes:
    import urllib.request

    req = urllib.request.Request(url, headers={"User-Agent": "rs-repro/0.3 (+research-shop)"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def fetch_one(spec, urls, prefer=None, get=http_get):
    """Try sources in order (or only the recorded one); return (url, canonical bytes)."""
    errors = []
    for url in ([prefer] if prefer else urls):
        try:
            return url, canonical_json(get(url))
        except Exception as e:  # network errors, bad JSON: try the next source
            errors.append(f"{url}: {type(e).__name__}: {e}")
            print(f"  ! {errors[-1]}")
    raise RuntimeError("all fetch sources failed:\n  " + "\n  ".join(errors))


def cmd_fetch():
    RAW.mkdir(exist_ok=True)
    manifest = load_manifest()
    manifest["fetches"] = {}
    for name, text, spec in load_fetches():
        urls = check_fetch(spec)
        url, data = fetch_one(spec, urls)
        (RAW / f"{name}.json").write_bytes(data)
        manifest["fetches"][name] = {
            "spec_sha256": sha256(text.encode()),
            "source": url,
            "sha256": sha256(data),
            "bytes": len(data),
            "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        print(f"[{name}] {len(data)} bytes from {url}\n  sha256 {sha256(data)}")
    save_manifest(manifest)


def run_analysis(out: Path):
    import runpy

    out.mkdir(parents=True, exist_ok=True)
    runpy.run_path(str(ROOT / "analysis.py"), run_name="__main__", init_globals={"ROOT": ROOT, "OUT": out})
    return {f.name: sha256(f.read_bytes()) for f in sorted(out.glob("*.csv"))}


def cmd_analyze():
    import shutil
    import tempfile

    if not (ROOT / "analysis.py").exists():
        sys.exit("no analysis.py in this pack")
    with tempfile.TemporaryDirectory() as tmp:
        hashes = run_analysis(Path(tmp))
        clash = set(hashes) & {f"{n}.csv" for n, _ in load_queries(required=False)}
        if clash:
            raise GuardError(f"analysis.py must not overwrite query results: {sorted(clash)}")
        for f in hashes:
            shutil.copyfile(Path(tmp) / f, RESULTS / f)
    manifest = load_manifest()
    manifest["derived"] = {"analysis_sha256": sha256((ROOT / "analysis.py").read_bytes()), "files": hashes}
    save_manifest(manifest)
    for f, h in hashes.items():
        print(f"[analysis] {f}  sha256 {h}")


def compare(name, sql, data, expected) -> bool:
    ok_sql = sha256(sql.encode()) == expected["sql_sha256"]
    ok_res = sha256(data) == expected["result_sha256"]
    mark = "✅" if ok_sql and ok_res else "❌"
    detail = "" if ok_sql else " (query text changed)"
    print(f"{mark} {name}: result {sha256(data)[:16]}… expected {expected['result_sha256'][:16]}…{detail}")
    return ok_sql and ok_res


def cmd_verify(cached: bool):
    import tempfile

    manifest = load_manifest()
    bq = None if cached else client()
    all_ok = True
    stage_rec = manifest.get("stage", {})
    stage_q = load_queries(STAGE, required=False)
    if stage_q:
        print(f"-- stage: {len(stage_q)} heavy queries")
        for name, tmpl in stage_q:
            rec = stage_rec.get(name)
            ok = bool(rec) and rec["sql_sha256"] == sha256(tmpl.encode())
            all_ok &= ok
            mark = "✅" if ok else "❌"
            info = f"{rec['rows']} rows, {rec['bytes_billed'] / 1e9:.1f} GB, ran {rec['executed_at']}" if rec else "not in manifest"
            print(f"{mark} {name}: query text matches manifest ({info})")
        if not cached and os.environ.get("VERIFY_STAGE") == "1":
            os.environ["STAGE_FORCE"] = "1"
            cmd_stage()
        else:
            print("   (stage tables are not re-scanned; their content is pinned by the fingerprint query, if any)")
    print("-- queries")
    tmpls = dict(load_queries())
    if cached:
        for name, tmpl in tmpls.items():
            expected = manifest.get("queries", {}).get(name)
            if not expected:
                print(f"❌ {name}: not in manifest"); all_ok = False; continue
            all_ok &= compare(name, tmpl, (RESULTS / f"{name}.csv").read_bytes(), expected)
    else:
        for name, sql, window, _ in plan(bq, read_items(bq), MAX_GB, "verify"):
            expected = manifest.get("queries", {}).get(name)
            if not expected:
                print(f"❌ {name}: not in manifest"); all_ok = False; continue
            data = canonical_csv(execute(bq, name, sql, "verify").to_dataframe())
            all_ok &= compare(name, tmpls[name], data, expected)
    fetches = load_fetches()
    if fetches:
        print("-- fetches")
        for name, text, spec in fetches:
            rec = manifest.get("fetches", {}).get(name)
            if not rec:
                print(f"❌ {name}: not in manifest"); all_ok = False; continue
            if cached:
                data = (RAW / f"{name}.json").read_bytes()
            else:
                check_fetch(spec)
                _, data = fetch_one(spec, [], prefer=rec["source"])
            ok = sha256(data) == rec["sha256"] and sha256(text.encode()) == rec["spec_sha256"]
            all_ok &= ok
            how = "re-hashed" if cached else f"re-fetched from {rec['source'].split('?')[0]}"
            print(f"{'✅' if ok else '❌'} {name}: {how} {sha256(data)[:16]}… expected {rec['sha256'][:16]}…")
    if (ROOT / "analysis.py").exists():
        print("-- analysis (re-run from results/ and raw/)")
        rec = manifest.get("derived", {})
        with tempfile.TemporaryDirectory() as tmp:
            got = run_analysis(Path(tmp))
        want = rec.get("files", {})
        same_code = rec.get("analysis_sha256") == sha256((ROOT / "analysis.py").read_bytes())
        if not same_code:
            print("❌ analysis.py changed since the manifest was written"); all_ok = False
        for f in sorted(set(got) | set(want)):
            shipped = (RESULTS / f).read_bytes() if (RESULTS / f).exists() else b""
            ok = got.get(f) == want.get(f) == sha256(shipped)
            all_ok &= ok
            print(f"{'✅' if ok else '❌'} {f}: {str(got.get(f))[:16]}… expected {str(want.get(f))[:16]}…")
    print("REPRODUCED ✅" if all_ok else "MISMATCH ❌")
    sys.exit(0 if all_ok else 1)


def cmd_charts():
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import pandas as pd

    import style

    style.apply()
    CHARTS.mkdir(exist_ok=True)
    custom = ROOT / "charts.py"
    if custom.exists():
        # A report pack can ship designed charts: charts.py reads results/ and writes charts/.
        import runpy

        runpy.run_path(str(custom), run_name="__main__", init_globals={"ROOT": ROOT})
        return
    for csv in sorted(RESULTS.glob("*.csv")):
        df = pd.read_csv(csv)
        x = df.columns[0]
        fig, axes = plt.subplots(len(df.columns) - 1, 1, figsize=(8, 2.6 * (len(df.columns) - 1)), sharex=True)
        axes = axes if hasattr(axes, "__len__") else [axes]
        for ax, col in zip(axes, df.columns[1:]):
            ax.bar(df[x], df[col])
            ax.set_ylabel(col)
        axes[-1].tick_params(axis="x", rotation=45)
        fig.suptitle(csv.stem)
        fig.tight_layout()
        out = CHARTS / f"{csv.stem}.png"
        fig.savefig(out, dpi=110)
        plt.close(fig)
        print(f"wrote {out.relative_to(ROOT)}")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
    try:
        if cmd == "stage":
            cmd_stage()
        elif cmd == "run":
            cmd_run()
        elif cmd == "fetch":
            cmd_fetch()
        elif cmd == "analyze":
            cmd_analyze()
        elif cmd == "verify":
            cmd_verify(cached=False)
        elif cmd == "verify-cached":
            cmd_verify(cached=True)
        elif cmd == "charts":
            cmd_charts()
        elif cmd == "check":
            for name, sql in load_queries(STAGE, required=False):
                print(f"✅ stage/{name}: window {check_stage(sql, name)}")
            for name, sql in load_queries():
                print(f"✅ {name}: window {check_readonly(sql)}")
            for name, _, spec in load_fetches():
                print(f"✅ fetch/{name}: {len(check_fetch(spec))} source(s)")
        else:
            print(__doc__)
    except GuardError as e:
        sys.exit(f"GUARD BLOCKED: {e}")


if __name__ == "__main__":
    main()
