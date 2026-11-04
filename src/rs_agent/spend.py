"""Spend ledger: append-only, hash-chained JSONL of every compute cost (NEAR AI inference, BigQuery).

One file per network: <state dir>/spend-ledger.<network>.jsonl (state dir = $RS_AGENT_STATE_DIR or
~/.local/state/rs-agent; override the file with $RS_AGENT_SPEND_LEDGER). Each line is one cost:

  {"seq", "ts", "day" (UTC YYYY-MM-DD), "network", "order_id", "kind", "usd_micros" (int), "usd" (str),
   "note", "source", "meta", "prev_hash", "line_hash"}

The chain is the one rs-ledger uses: line_hash = sha256(canonical(body) + prev_hash), canonical = JSON
with sorted keys and no spaces, the first prev_hash = 64 zeros. Amounts are integer micro-USD (10^-6), so
sums are exact; inputs are rounded UP to the micro-dollar (costs are never under-counted).

A broken chain or an unreadable line makes the ledger untrustworthy: load() raises LedgerCorrupt and the
rules refuse every new job until the operator looks (a cap you can't sum is not a cap).
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import time
from decimal import ROUND_UP, Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Optional

GENESIS = "0" * 64
KINDS = ("inference", "bigquery")
ORDER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
MICROS = Decimal("0.000001")


class LedgerCorrupt(RuntimeError):
    pass


def canonical(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def line_hash(body: dict, prev_hash: str) -> str:
    return hashlib.sha256(canonical(body).encode("utf-8") + prev_hash.encode("ascii")).hexdigest()


def usd_to_micros(usd: Any) -> int:
    """'0.0125' / Decimal / int -> 12500. Rounds up to the micro-dollar. Rejects negatives, NaN, floats."""
    if isinstance(usd, float):
        raise ValueError("pass USD as a string or Decimal, not float")
    try:
        d = Decimal(str(usd).strip())
    except InvalidOperation:
        raise ValueError(f"not a USD amount: {usd!r}") from None
    if not d.is_finite() or d < 0:
        raise ValueError(f"USD amount must be >= 0, got {usd!r}")
    return int((d / MICROS).to_integral_value(rounding=ROUND_UP))


def fmt_usd(micros: int) -> str:
    return f"{Decimal(micros) * MICROS:.6f}"


def utc_day(ts: Optional[float] = None) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(time.time() if ts is None else ts))


def default_path(network: str) -> Path:
    if os.environ.get("RS_AGENT_SPEND_LEDGER"):
        return Path(os.environ["RS_AGENT_SPEND_LEDGER"])
    d = Path(os.environ.get("RS_AGENT_STATE_DIR", Path.home() / ".local/state/rs-agent"))
    return d / f"spend-ledger.{network}.jsonl"


class SpendLedger:
    def __init__(self, network: str, path: Optional[Path] = None):
        self.network = network
        self.path = Path(path) if path else default_path(network)

    # ---- read
    def load(self) -> list[dict]:
        if not self.path.exists():
            return []
        lines, prev = [], GENESIS
        for i, raw in enumerate(self.path.read_text(encoding="utf-8").splitlines(), 1):
            if not raw.strip():
                continue
            try:
                ln = json.loads(raw)
            except ValueError:
                raise LedgerCorrupt(f"{self.path}: line {i} is not JSON") from None
            body = {k: v for k, v in ln.items() if k not in ("prev_hash", "line_hash")}
            if ln.get("prev_hash") != prev or line_hash(body, prev) != ln.get("line_hash"):
                raise LedgerCorrupt(f"{self.path}: hash chain broken at line {i} (edited or truncated); "
                                    f"run bin/operator-rules verify-spend and restore the file before any new job")
            if ln.get("seq") != len(lines) or not isinstance(ln.get("usd_micros"), int) or ln["usd_micros"] < 0:
                raise LedgerCorrupt(f"{self.path}: line {i} has a bad seq or usd_micros")
            prev = ln["line_hash"]
            lines.append(ln)
        return lines

    def head(self) -> str:
        lines = self.load()
        return lines[-1]["line_hash"] if lines else GENESIS

    def day_total(self, day: Optional[str] = None, lines: Optional[list[dict]] = None) -> int:
        day = day or utc_day()
        return sum(l["usd_micros"] for l in (self.load() if lines is None else lines) if l["day"] == day)

    def order_total(self, order_id: str, lines: Optional[list[dict]] = None) -> int:
        return sum(l["usd_micros"] for l in (self.load() if lines is None else lines) if l["order_id"] == order_id)

    # ---- write
    def append(self, *, order_id: str, kind: str, usd: Any, note: str = "", source: str = "cli",
               meta: Optional[dict] = None, now: Optional[float] = None) -> dict:
        if kind not in KINDS:
            raise ValueError(f"kind must be one of {KINDS}, got {kind!r}")
        if not ORDER_RE.match(order_id or ""):
            raise ValueError(f"order id {order_id!r} must be 1-128 chars of [A-Za-z0-9._:-]")
        if len(note) > 500:
            raise ValueError("note too long (max 500 chars)")
        micros = usd_to_micros(usd)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        t = time.time() if now is None else now
        with open(self.path, "a+", encoding="utf-8") as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            try:
                lines = self.load()  # re-read under the lock: verifies the chain and gets the head
                prev = lines[-1]["line_hash"] if lines else GENESIS
                body = {"seq": len(lines), "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t)), "day": utc_day(t),
                        "network": self.network, "order_id": order_id, "kind": kind, "usd_micros": micros,
                        "usd": fmt_usd(micros), "note": note, "source": source, "meta": meta or {}}
                rec = {**body, "prev_hash": prev, "line_hash": line_hash(body, prev)}
                f.seek(0, os.SEEK_END)
                f.write(canonical(rec) + "\n")
                f.flush()
                os.fsync(f.fileno())
            finally:
                fcntl.flock(f, fcntl.LOCK_UN)
        os.chmod(self.path, 0o600)
        return rec
