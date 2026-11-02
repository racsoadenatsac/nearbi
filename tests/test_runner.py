"""Offline tests for the runner: budget cap, fetch fallback, analysis determinism."""
import importlib
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "repro"))


def fresh_runner(root: Path, **env):
    os.environ["REPRO_ROOT"] = str(root)
    os.environ.pop("MAX_USD_TOTAL", None)
    os.environ.update(env)
    import run
    return importlib.reload(run)


def test_budget_blocks_over_cap():
    with tempfile.TemporaryDirectory() as d:
        run = fresh_runner(Path(d), MAX_USD_TOTAL="8")
        run.ledger_add("probe", "p", 1.0e12)            # $6.25 already spent
        run.budget_check(0.2e12, "ok step")            # +$1.25 -> $7.50: allowed
        try:
            run.budget_check(0.3e12, "big step")       # +$1.875 -> $8.125: blocked
            assert False, "should have been blocked"
        except run.GuardError:
            pass
        assert abs(run.ledger_total() - 1.0e12) < 1


def test_fetch_falls_back_to_next_source():
    with tempfile.TemporaryDirectory() as d:
        run = fresh_runner(Path(d))
        calls = []

        def fake_get(url):
            calls.append(url)
            if "binance" in url:
                raise OSError("451 unavailable")
            return b'{"z": 1, "a": 2}'

        url, data = run.fetch_one({}, ["https://api.binance.com/x", "https://api.coingecko.com/y"], get=fake_get)
        assert url.endswith("/y") and data == b'{"a":2,"z":1}\n' and len(calls) == 2


def test_analyze_and_verify_cached_roundtrip():
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        (root / "results").mkdir()
        (root / "queries").mkdir()
        (root / "queries" / "q.sql").write_text(
            "SELECT 1 FROM `bigquery-public-data.crypto_near_mainnet_us.transactions` "
            "WHERE block_date BETWEEN '2026-10-01' AND '2026-10-02'")
        (root / "results" / "q.csv").write_text("a\n1\n2\n")
        (root / "analysis.py").write_text(
            "import pandas as pd\n"
            "df = pd.read_csv(ROOT / 'results' / 'q.csv')\n"
            "pd.DataFrame({'total': [df.a.sum()]}).to_csv(OUT / 'a_total.csv', index=False)\n")
        run = fresh_runner(root)
        data = (root / "results" / "q.csv").read_bytes()
        run.save_manifest({"queries": {"q": {"sql_sha256": run.sha256((root / "queries" / "q.sql").read_bytes()),
                                             "result_sha256": run.sha256(data)}}})
        run.cmd_analyze()
        assert (root / "results" / "a_total.csv").read_text() == "total\n3\n"
        m = json.loads((root / "manifest.json").read_text())
        assert "a_total.csv" in m["derived"]["files"] and "q" in m["queries"]
        try:
            run.cmd_verify(cached=True)
        except SystemExit as e:
            assert e.code == 0
        (root / "results" / "a_total.csv").write_text("total\n4\n")   # tampered shipped file
        try:
            run.cmd_verify(cached=True)
        except SystemExit as e:
            assert e.code == 1


def test_stage_reuse_rules():
    with tempfile.TemporaryDirectory() as d:
        run = fresh_runner(Path(d))
        from google.api_core.exceptions import NotFound

        class BQ:
            def __init__(self, exists): self.exists = exists
            def get_table(self, ref):
                if not self.exists: raise NotFound(ref)
        q = "CREATE OR REPLACE TABLE `{stage}.s1` AS SELECT 1"
        rec = {"sql_sha256": run.sha256(q.encode())}
        assert run.stage_is_current(BQ(True), rec, q, "s1")              # unchanged + exists: reuse
        assert not run.stage_is_current(BQ(False), rec, q, "s1")         # table gone: re-scan
        assert not run.stage_is_current(BQ(True), rec, q + " ", "s1")    # query edited: re-scan
        assert not run.stage_is_current(BQ(True), None, q, "s1")         # never ran: scan
        os.environ["STAGE_FORCE"] = "1"
        assert not run.stage_is_current(BQ(True), rec, q, "s1")          # forced
        os.environ.pop("STAGE_FORCE")


if __name__ == "__main__":
    fails = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            try:
                fn(); print(f"ok   {name}")
            except Exception as e:
                fails += 1; print(f"FAIL {name}: {type(e).__name__} {e}")
    sys.exit(fails)
