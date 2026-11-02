import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "repro"))
from guard import GuardError, check  # noqa: E402

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


if __name__ == "__main__":
    fails = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            try:
                fn(); print(f"ok   {name}")
            except AssertionError:
                fails += 1; print(f"FAIL {name}")
    sys.exit(fails)
