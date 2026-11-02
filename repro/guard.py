"""Static guards applied to every query before it reaches BigQuery.

The NEAR public dataset does not require a partition filter, so one careless
query can scan terabytes. These checks enforce our rules:
  1. every query must bound block_date with a fixed literal date range;
  2. relative dates (CURRENT_DATE, NOW(), ...) are forbidden because they break
     reproducibility;
  3. the dry-run byte estimate must stay under a cap (enforced in run.py).
"""
import re

FIXED_RANGE = re.compile(
    r"block_date\s+BETWEEN\s+'(\d{4}-\d{2}-\d{2})'\s+AND\s+'(\d{4}-\d{2}-\d{2})'",
    re.IGNORECASE,
)
RELATIVE = re.compile(
    r"\b(CURRENT_DATE|CURRENT_TIMESTAMP|CURRENT_DATETIME|NOW|SYSDATE)\b", re.IGNORECASE
)
DATASET_REF = re.compile(r"crypto_near_mainnet_us\.(\w+)", re.IGNORECASE)


class GuardError(Exception):
    pass


def strip_comments(sql: str) -> str:
    return re.sub(r"--[^\n]*", "", sql)


def check(sql: str) -> tuple[str, str]:
    """Validate a query; return its (start, end) block_date window."""
    body = strip_comments(sql)
    if RELATIVE.search(body):
        raise GuardError("relative date function found; use fixed literal dates")
    tables = DATASET_REF.findall(body)
    ranges = FIXED_RANGE.findall(body)
    if tables and len(ranges) < len(tables):
        raise GuardError(
            f"{len(tables)} dataset table reference(s) but only {len(ranges)} fixed "
            "block_date BETWEEN '<date>' AND '<date>' filter(s); every table must be bounded"
        )
    if not ranges:
        raise GuardError("no fixed block_date range found")
    for start, end in ranges:
        if start > end:
            raise GuardError(f"inverted range {start}..{end}")
    return ranges[0]
