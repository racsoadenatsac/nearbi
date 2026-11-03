"""Static guards applied to every query before it reaches BigQuery.

The NEAR public dataset does not require a partition filter, so one careless
query can scan terabytes. These checks enforce our rules:
  1. every query must bound block_date with a fixed literal date range;
  2. relative dates (CURRENT_DATE, NOW(), ...) are forbidden because they break
     reproducibility;
  3. the dry-run byte estimate must stay under a cap (enforced in run.py);
  4. ordinary queries are read-only; only stage/*.sql may write, and only with
     CREATE OR REPLACE TABLE `{stage}.<name>` into the pack's own stage dataset;
  5. non-SQL fetches (fetch/*.json) must use https, an allow-listed host, and fixed
     numeric time bounds, so a re-fetch returns the same closed data.
"""
import json
import re
from urllib.parse import parse_qs, urlparse

FIXED_RANGE = re.compile(
    r"block_date\s+BETWEEN\s+'(\d{4}-\d{2}-\d{2})'\s+AND\s+'(\d{4}-\d{2}-\d{2})'",
    re.IGNORECASE,
)
RELATIVE = re.compile(
    r"\b(CURRENT_DATE|CURRENT_TIMESTAMP|CURRENT_DATETIME|NOW|SYSDATE)\b", re.IGNORECASE
)
DATASET_REF = re.compile(r"crypto_near_mainnet_us\.(\w+)", re.IGNORECASE)
# queries that read only the pack's own stage tables may bound any date column (e.g. week)
ANY_FIXED_RANGE = re.compile(
    r"\b\w+\s+BETWEEN\s+(?:DATE\s+)?'(\d{4}-\d{2}-\d{2})'\s+AND\s+(?:DATE\s+)?'(\d{4}-\d{2}-\d{2})'",
    re.IGNORECASE,
)


WRITE_DDL = re.compile(
    r"\b(CREATE|INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|TRUNCATE|EXPORT|GRANT|REVOKE|CALL|EXECUTE)\b", re.IGNORECASE
)
STAGE_TARGET = re.compile(r"^\s*CREATE\s+OR\s+REPLACE\s+TABLE\s+`\{stage\}\.(\w+)`\s+AS\b", re.IGNORECASE | re.MULTILINE)

FETCH_HOSTS = {"api.binance.com", "data-api.binance.vision", "api.coingecko.com"}
# time-bound query parameters per host family; values must be fixed integers (epoch ms or s)
FETCH_BOUNDS = (("startTime", "endTime"), ("from", "to"))
RELATIVE_WORDS = re.compile(r"\b(now|today|latest|current)\b", re.IGNORECASE)


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
    if not ranges and not tables and "{stage}" in body:
        ranges = ANY_FIXED_RANGE.findall(body)
        if not ranges:
            raise GuardError("stage-only query needs a fixed <date column> BETWEEN '<date>' AND '<date>' window")
    if not ranges:
        raise GuardError("no fixed block_date range found")
    for start, end in ranges:
        if start > end:
            raise GuardError(f"inverted range {start}..{end}")
    return ranges[0]


def check_readonly(sql: str) -> tuple[str, str]:
    """Ordinary pack queries: the date-range rules plus no writes of any kind."""
    window = check(sql)
    m = WRITE_DDL.search(strip_comments(sql))
    if m:
        raise GuardError(f"{m.group(1).upper()} is not allowed in a read-only query (only stage/*.sql may write)")
    return window


def check_stage(sql: str, name: str) -> tuple[str, str]:
    """Stage queries: exactly one CREATE OR REPLACE TABLE `{stage}.<name>` AS SELECT ..."""
    window = check(sql)
    body = strip_comments(sql)
    targets = STAGE_TARGET.findall(body)
    if targets != [name]:
        raise GuardError(f"stage query must start with CREATE OR REPLACE TABLE `{{stage}}.{name}` AS (found {targets})")
    rest = STAGE_TARGET.sub("", body, count=1)
    m = WRITE_DDL.search(rest)
    if m:
        raise GuardError(f"stage query may contain one CREATE only; found extra {m.group(1).upper()}")
    return window


def render(sql: str, stage: str) -> str:
    """Substitute the stage dataset (`project.dataset`) into a query template."""
    if not re.fullmatch(r"[a-z][a-z0-9\-]{4,61}[a-z0-9]\.[A-Za-z_][A-Za-z0-9_]{0,1023}", stage):
        raise GuardError(f"bad stage dataset id {stage!r}")
    return sql.replace("{stage}", stage)


def check_fetch(spec: dict) -> list[str]:
    """Validate a fetch spec; return its ordered list of source URLs."""
    sources = spec.get("sources")
    if not isinstance(sources, list) or not sources:
        raise GuardError("fetch spec needs a non-empty 'sources' list")
    urls = []
    for src in sources:
        url = src.get("url", "") if isinstance(src, dict) else ""
        u = urlparse(url)
        if u.scheme != "https":
            raise GuardError(f"fetch must use https: {url!r}")
        if u.hostname not in FETCH_HOSTS:
            raise GuardError(f"host {u.hostname!r} not in allow-list {sorted(FETCH_HOSTS)}")
        if u.username or u.password or "key" in {k.lower() for k in parse_qs(u.query)}:
            raise GuardError("fetch URLs must not carry credentials or API keys")
        if RELATIVE_WORDS.search(url):
            raise GuardError(f"relative time word in fetch URL: {url!r}")
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        pair = next((p for p in FETCH_BOUNDS if p[0] in q and p[1] in q), None)
        if not pair:
            raise GuardError(f"fetch URL needs fixed time bounds ({FETCH_BOUNDS}): {url!r}")
        lo, hi = q[pair[0]], q[pair[1]]
        if not (lo.isdigit() and hi.isdigit()) or int(lo) >= int(hi):
            raise GuardError(f"fetch bounds must be increasing integers: {pair[0]}={lo} {pair[1]}={hi}")
        urls.append(url)
    return urls


def canonical_json(raw: bytes) -> bytes:
    """Stable bytes for a JSON payload: sorted keys, no whitespace variation."""
    return (json.dumps(json.loads(raw), sort_keys=True, separators=(",", ":")) + "\n").encode()
