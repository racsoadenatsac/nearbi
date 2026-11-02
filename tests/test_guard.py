import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "repro"))
from guard import GuardError, canonical_json, check, check_fetch, check_readonly, check_stage, render  # noqa: E402

T = "`bigquery-public-data.crypto_near_mainnet_us.transactions`"


def blocked(sql):
    try:
        check(sql)
    except GuardError:
        return True
    return False


def test_fixed_range_passes():
    assert check(f"SELECT 1 FROM {T} WHERE block_date BETWEEN '2026-10-01' AND '2026-10-07'") == ("2026-10-01", "2026-10-07")


def test_missing_filter_blocked():
    assert blocked(f"SELECT COUNT(*) FROM {T}")


def test_relative_date_blocked():
    assert blocked(f"SELECT 1 FROM {T} WHERE block_date BETWEEN '2026-10-01' AND '2026-10-07' OR block_date = CURRENT_DATE()")


def test_filter_only_in_comment_blocked():
    assert blocked(f"-- block_date BETWEEN '2026-10-01' AND '2026-10-07'\nSELECT 1 FROM {T}")


def test_join_needs_filter_per_table():
    sql = (f"SELECT 1 FROM {T} t JOIN `bigquery-public-data.crypto_near_mainnet_us.receipt_actions` r "
           "ON TRUE WHERE t.block_date BETWEEN '2026-10-01' AND '2026-10-02'")
    assert blocked(sql)


def test_inverted_range_blocked():
    assert blocked(f"SELECT 1 FROM {T} WHERE block_date BETWEEN '2026-10-07' AND '2026-10-01'")


def test_shipped_queries_pass():
    for f in (Path(__file__).resolve().parent.parent / "queries").glob("*.sql"):
        check(f.read_text())


W = "WHERE block_date BETWEEN '2026-10-01' AND '2026-10-07'"


def raises(fn, *a):
    try:
        fn(*a)
    except GuardError:
        return True
    return False


def test_readonly_blocks_writes():
    assert raises(check_readonly, f"CREATE TABLE x.y AS SELECT 1 FROM {T} {W}")
    assert raises(check_readonly, f"SELECT 1 FROM {T} {W}; DELETE FROM x.y WHERE TRUE")
    assert check_readonly(f"SELECT update_reason FROM {T} {W}") == ("2026-10-01", "2026-10-07")


def test_stage_must_target_own_table():
    ok = f"CREATE OR REPLACE TABLE `{{stage}}.s1` AS SELECT 1 FROM {T} {W}"
    assert check_stage(ok, "s1") == ("2026-10-01", "2026-10-07")
    assert raises(check_stage, ok, "s2")                                   # name must match the file
    assert raises(check_stage, ok.replace("`{stage}.s1`", "`other.s1`"), "s1")  # only the stage dataset
    assert raises(check_stage, ok + "; DROP TABLE `{stage}.s0`", "s1")     # one statement only
    assert raises(check_stage, f"CREATE OR REPLACE TABLE `{{stage}}.s1` AS SELECT 1 FROM {T}", "s1")  # still date-bounded


def test_render_validates_dataset():
    assert render("SELECT * FROM `{stage}.t`", "my-proj-1.rs_stage") == "SELECT * FROM `my-proj-1.rs_stage.t`"
    assert raises(render, "x", "proj.ds`; DROP")


B = "https://api.binance.com/api/v3/klines?symbol=NEARUSDT&interval=1w"


def test_fetch_fixed_bounds():
    assert check_fetch({"sources": [{"url": B + "&startTime=1&endTime=2"}]}) == [B + "&startTime=1&endTime=2"]
    assert raises(check_fetch, {"sources": [{"url": B}]})                                   # no bounds
    assert raises(check_fetch, {"sources": [{"url": B + "&startTime=2&endTime=1"}]})        # inverted
    assert raises(check_fetch, {"sources": [{"url": B + "&startTime=now&endTime=2"}]})      # relative
    assert raises(check_fetch, {"sources": [{"url": B.replace("https", "http") + "&startTime=1&endTime=2"}]})
    assert raises(check_fetch, {"sources": [{"url": "https://evil.example/x?from=1&to=2"}]})  # host allow-list
    assert raises(check_fetch, {"sources": [{"url": B + "&startTime=1&endTime=2&key=abc"}]})  # no API keys
    assert raises(check_fetch, {"sources": []})


def test_canonical_json_is_stable():
    assert canonical_json(b'{"b": 1,  "a": [1, 2]}') == canonical_json(b'{"a":[1,2],"b":1}') == b'{"a":[1,2],"b":1}\n'


if __name__ == "__main__":
    fails = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            try:
                fn(); print(f"ok   {name}")
            except AssertionError:
                fails += 1; print(f"FAIL {name}")
    sys.exit(fails)
