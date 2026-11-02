"""Reproducibility runner.

Commands:
  run            dry-run + execute every query, write results/*.csv and manifest.json
  verify         re-run every query live and compare hashes with manifest.json
  verify-cached  re-hash the shipped results/*.csv against manifest.json (no GCP needed)
  charts         render charts/*.png from results/*.csv

Environment:
  GOOGLE_APPLICATION_CREDENTIALS  path to a service-account JSON (mounted read-only)
  BQ_PROJECT                      GCP project billed for the queries
  MAX_GB_PER_QUERY                dry-run cap in GB (default 25)
"""
import hashlib
import io
import warnings
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from guard import GuardError, check

# Results are small; the optional BigQuery Storage API adds nothing but a noisy warning.
warnings.filterwarnings("ignore", message="BigQuery Storage module not found")

ROOT = Path(os.environ.get("REPRO_ROOT", Path(__file__).resolve().parent.parent))
QUERIES = ROOT / "queries"
RESULTS = ROOT / "results"
CHARTS = ROOT / "charts"
MANIFEST = ROOT / "manifest.json"
MAX_GB = float(os.environ.get("MAX_GB_PER_QUERY", "25"))
USD_PER_TB = 6.25  # BigQuery on-demand list price


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


def load_queries():
    files = sorted(QUERIES.glob("*.sql"))
    if not files:
        sys.exit(f"no queries in {QUERIES}")
    return [(f.stem, f.read_text()) for f in files]


def client():
    from google.cloud import bigquery

    project = os.environ.get("BQ_PROJECT")
    if not project:
        sys.exit("BQ_PROJECT is not set (the GCP project that pays for queries)")
    return bigquery.Client(project=project)


def execute(bq, name, sql):
    from google.cloud import bigquery

    window = check(sql)
    dry = bq.query(sql, job_config=bigquery.QueryJobConfig(dry_run=True, use_query_cache=False))
    gb = dry.total_bytes_processed / 1e9
    usd = dry.total_bytes_processed / 1e12 * USD_PER_TB
    print(f"[{name}] window {window[0]}..{window[1]}  dry-run {gb:.2f} GB  ~${usd:.3f}")
    if gb > MAX_GB:
        raise GuardError(f"{name}: {gb:.2f} GB exceeds cap {MAX_GB} GB (set MAX_GB_PER_QUERY to raise)")
    # never serve from cache: a verify must really re-execute the query
    df = bq.query(sql, job_config=bigquery.QueryJobConfig(use_query_cache=False)).to_dataframe()
    return df, {"window": list(window), "bytes_processed": dry.total_bytes_processed}


def cmd_run():
    bq = client()
    RESULTS.mkdir(exist_ok=True)
    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "dataset": "bigquery-public-data.crypto_near_mainnet_us",
        "queries": {},
    }
    for name, sql in load_queries():
        df, meta = execute(bq, name, sql)
        data = canonical_csv(df)
        (RESULTS / f"{name}.csv").write_bytes(data)
        manifest["queries"][name] = {
            "sql_sha256": sha256(sql.encode()),
            "result_sha256": sha256(data),
            "rows": len(df),
            **meta,
        }
        print(f"[{name}] {len(df)} rows  sha256 {sha256(data)}")
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {MANIFEST.name}")


def compare(name, sql, data, expected) -> bool:
    ok_sql = sha256(sql.encode()) == expected["sql_sha256"]
    ok_res = sha256(data) == expected["result_sha256"]
    mark = "✅" if ok_sql and ok_res else "❌"
    detail = "" if ok_sql else " (query text changed)"
    print(f"{mark} {name}: result {sha256(data)[:16]}… expected {expected['result_sha256'][:16]}…{detail}")
    return ok_sql and ok_res


def cmd_verify(cached: bool):
    manifest = json.loads(MANIFEST.read_text())
    bq = None if cached else client()
    all_ok = True
    for name, sql in load_queries():
        expected = manifest["queries"].get(name)
        if not expected:
            print(f"❌ {name}: not in manifest")
            all_ok = False
            continue
        if cached:
            data = (RESULTS / f"{name}.csv").read_bytes()
        else:
            df, _ = execute(bq, name, sql)
            data = canonical_csv(df)
        all_ok &= compare(name, sql, data, expected)
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
        if cmd == "run":
            cmd_run()
        elif cmd == "verify":
            cmd_verify(cached=False)
        elif cmd == "verify-cached":
            cmd_verify(cached=True)
        elif cmd == "charts":
            cmd_charts()
        elif cmd == "check":
            for name, sql in load_queries():
                print(f"✅ {name}: window {check(sql)}")
        else:
            print(__doc__)
    except GuardError as e:
        sys.exit(f"GUARD BLOCKED: {e}")


if __name__ == "__main__":
    main()
