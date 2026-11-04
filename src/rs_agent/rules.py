"""Operator rules: load + validate config.yaml and enforce it.

The operator owns config.yaml; the agent re-reads it at every decision point (Rules.current()), so an edit
takes effect at the next check. Every failure is fail-closed: a missing/invalid file, a broken spend
ledger, or an unreadable splitter config refuses the action, exactly like kill_switch: true.

Enforcement points (each raises Refused(rule, message); callers log the message and do not act):
  require_active(cfg, action)            kill_switch
  check_min_price(cfg, product, ...)     min_price_usd (+ settlement_slippage_pct)
  check_job(cfg, order, kind, estimate)  max_inference_usd_per_day, per_report_cost_cap_usd
  check_split(cfg, onchain_config)       revenue_split vs the splitter's get_config (alert on mismatch)
  require_network(cfg, network)          network
"""
from __future__ import annotations

import dataclasses
import json
import os
import re
from decimal import Decimal
from pathlib import Path
from typing import Any, Optional

from . import miniyaml, spend

ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_CONFIG = ROOT / "config.yaml"
SCHEMA_FILE = ROOT / "config.schema.json"
BPS = 10_000
MAX_CONTRIBUTORS_BPS = 5_000  # splitter contract bound (set_split / init require 0..=5000)

# Deployment facts (rs-payments/deploy/*.json), not operator choices.
NETWORKS: dict[str, dict[str, Any]] = {
    "mainnet": {
        "splitter": "splitter.nearbi.near",
        "forwarder": "forwarder.nearbi.near",
        "rpc": ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org"],
        "near_cli_network": "mainnet-fastnear",
        "explorer_tx": "https://nearblocks.io/txns/",
        "splitter_fc_public_key": "ed25519:HFbATpvL7pcDahRX6SFsRA4JSjUA1fGS9bDhEGnRDRZS",
        "splitter_fc_secret": {"keychain": "nearbi-mainnet-fc-splitter.nearbi.near"},
    },
    "testnet": {
        "splitter": "splitter-v2.nearbi-agent.testnet",
        "forwarder": "forwarder-v2.nearbi-agent.testnet",
        "rpc": ["https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org"],
        "near_cli_network": "testnet",
        "explorer_tx": "https://testnet.nearblocks.io/txns/",
        "splitter_fc_public_key": "ed25519:Hoc8EfTot4oWnWtreeBxvbBCbAjvnHdi3BQupDcpAxdp",
        # testnet only: the chmod-600 file rs-payments/bin/deploy-testnet.sh wrote; read into memory, never copied
        "splitter_fc_secret": {"file": str(Path.home() / ".near-credentials/nearbi-fc/splitter-v2.nearbi-agent.testnet.fc.json")},
    },
}

ACCOUNT_PATTERN = r"^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$"
_usd = {"type": "number", "minimum": 0, "maxDecimals": 6}
_pct = {"type": "number", "minimum": 0, "maximum": 100, "maxDecimals": 2}
_accounts = {"type": "object", "additionalProperties": False, "required": ["contributors", "treasury"],
             "properties": {"contributors": {"type": "string", "pattern": ACCOUNT_PATTERN},
                            "treasury": {"type": "string", "pattern": ACCOUNT_PATTERN}}}

# JSON Schema (draft 2020-12 subset; "maxDecimals" is our extension, checked here, ignored by editors).
SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://github.com/racsoadenatsac/rs-agent/config.schema.json",
    "title": "NearBI operator rules (config.yaml)",
    "type": "object",
    "additionalProperties": False,
    "required": ["version", "network", "kill_switch", "max_inference_usd_per_day", "per_report_cost_cap_usd",
                 "min_price_usd", "settlement_slippage_pct", "revenue_split"],
    "properties": {
        "version": {"type": "integer", "enum": [1]},
        "network": {"type": "string", "enum": ["mainnet", "testnet"]},
        "kill_switch": {"type": "boolean"},
        "max_inference_usd_per_day": _usd,
        "per_report_cost_cap_usd": _usd,
        "min_price_usd": {"type": "object", "minProperties": 1, "additionalProperties": False,
                          "properties": {p: {**_usd, "exclusiveMinimum": 0} for p in ("subscription", "quick_answer", "deep_dive")}},
        "settlement_slippage_pct": {"type": "number", "minimum": 0, "maximum": 10, "maxDecimals": 2},
        "revenue_split": {
            "type": "object", "additionalProperties": False, "required": ["contributors_pct", "treasury_pct", "accounts"],
            "properties": {
                "contributors_pct": {**_pct, "maximum": 50},
                "treasury_pct": _pct,
                "accounts": {"type": "object", "additionalProperties": False, "minProperties": 1,
                             "properties": {"mainnet": _accounts, "testnet": _accounts}},
            },
        },
    },
}


class ConfigError(ValueError):
    pass


class Refused(Exception):
    """An operator rule says no. `rule` names it (kill_switch, min_price, daily_cap, report_cap, split_mismatch,
    network, config, spend_ledger); str(e) is the operator-facing reason."""

    def __init__(self, rule: str, message: str):
        super().__init__(message)
        self.rule = rule

    def __str__(self) -> str:
        return f"REFUSED ({self.rule}): {self.args[0]}"


# ------------------------------------------------------------------------------------- validation
def _decimals(v: Any) -> int:
    e = Decimal(str(v)).normalize().as_tuple().exponent
    return max(0, -e) if isinstance(e, int) else 99


def validate(doc: Any, schema: dict = SCHEMA, path: str = "") -> list[str]:
    """Return every schema violation as 'path: message' (empty = valid)."""
    where = path or "(top level)"
    t = schema.get("type")
    errs: list[str] = []
    if t == "object":
        if not isinstance(doc, dict):
            return [f"{where}: must be a mapping, got {type(doc).__name__ if doc is not None else 'nothing'}"]
        props = schema.get("properties", {})
        for k in schema.get("required", []):
            if k not in doc:
                errs.append(f"{where}: missing required key '{k}'")
        if len(doc) < schema.get("minProperties", 0):
            errs.append(f"{where}: needs at least {schema['minProperties']} entr{'y' if schema['minProperties'] == 1 else 'ies'}")
        for k, v in doc.items():
            sub = f"{path}.{k}" if path else k
            if k in props:
                errs += validate(v, props[k], sub)
            elif schema.get("additionalProperties") is False:
                errs.append(f"{sub}: unknown key (allowed: {', '.join(props) or 'none'})")
        return errs
    if t == "boolean" and not isinstance(doc, bool):
        return [f"{where}: must be true or false, got {doc!r}"]
    if t == "integer" and (isinstance(doc, bool) or not isinstance(doc, int)):
        return [f"{where}: must be an integer, got {doc!r}"]
    if t == "number" and (isinstance(doc, bool) or not isinstance(doc, (int, Decimal))):
        return [f"{where}: must be a number, got {doc!r}"]
    if t == "string" and not isinstance(doc, str):
        return [f"{where}: must be a string, got {doc!r}"]
    if "enum" in schema and doc not in schema["enum"]:
        errs.append(f"{where}: must be one of {schema['enum']}, got {doc!r}")
    if "pattern" in schema and isinstance(doc, str) and not re.match(schema["pattern"], doc):
        errs.append(f"{where}: {doc!r} is not a valid NEAR account id")
    if t in ("number", "integer"):
        if "minimum" in schema and doc < schema["minimum"]:
            errs.append(f"{where}: must be >= {schema['minimum']}, got {doc}")
        if "exclusiveMinimum" in schema and doc <= schema["exclusiveMinimum"]:
            errs.append(f"{where}: must be > {schema['exclusiveMinimum']}, got {doc}")
        if "maximum" in schema and doc > schema["maximum"]:
            errs.append(f"{where}: must be <= {schema['maximum']}, got {doc}")
        if "maxDecimals" in schema and _decimals(doc) > schema["maxDecimals"]:
            errs.append(f"{where}: at most {schema['maxDecimals']} decimal places, got {doc}")
    return errs


@dataclasses.dataclass(frozen=True)
class Config:
    path: str
    network: str
    kill_switch: bool
    max_inference_usd_per_day: Decimal
    per_report_cost_cap_usd: Decimal
    min_price_usd: dict
    settlement_slippage_pct: Decimal
    contributors_bps: int
    treasury_bps: int
    contributors_account: str
    treasury_account: str

    @property
    def daily_cap_micros(self) -> int:
        return spend.usd_to_micros(self.max_inference_usd_per_day)

    @property
    def report_cap_micros(self) -> int:
        return spend.usd_to_micros(self.per_report_cost_cap_usd)

    @property
    def net(self) -> dict:
        return NETWORKS[self.network]


def parse(text: str, path: str = "config.yaml") -> Config:
    try:
        doc = miniyaml.loads(text)
    except miniyaml.ParseError as e:
        raise ConfigError(f"{path}: {e}") from None
    errs = validate(doc)
    if not errs:
        rs = doc["revenue_split"]
        c_bps, t_bps = int(Decimal(str(rs["contributors_pct"])) * 100), int(Decimal(str(rs["treasury_pct"])) * 100)
        if c_bps + t_bps != BPS:
            errs.append(f"revenue_split: contributors_pct + treasury_pct must be 100, got {rs['contributors_pct']} + {rs['treasury_pct']}")
        if c_bps > MAX_CONTRIBUTORS_BPS:
            errs.append("revenue_split.contributors_pct: the splitter contract caps it at 50")
        if doc["network"] not in rs["accounts"]:
            errs.append(f"revenue_split.accounts: no accounts for network '{doc['network']}'")
        if doc["per_report_cost_cap_usd"] > doc["max_inference_usd_per_day"]:
            errs.append("per_report_cost_cap_usd: larger than max_inference_usd_per_day (one report could never run)")
    if errs:
        raise ConfigError(f"{path} is invalid:\n  - " + "\n  - ".join(errs))
    acc = doc["revenue_split"]["accounts"][doc["network"]]
    return Config(
        path=path, network=doc["network"], kill_switch=doc["kill_switch"],
        max_inference_usd_per_day=Decimal(str(doc["max_inference_usd_per_day"])),
        per_report_cost_cap_usd=Decimal(str(doc["per_report_cost_cap_usd"])),
        min_price_usd={k: Decimal(str(v)) for k, v in doc["min_price_usd"].items()},
        settlement_slippage_pct=Decimal(str(doc["settlement_slippage_pct"])),
        contributors_bps=c_bps, treasury_bps=t_bps,
        contributors_account=acc["contributors"], treasury_account=acc["treasury"],
    )


def config_path() -> Path:
    return Path(os.environ.get("RS_AGENT_CONFIG") or DEFAULT_CONFIG)


def load(path: Optional[Path] = None) -> Config:
    p = Path(path) if path else config_path()
    try:
        text = p.read_text(encoding="utf-8")
    except OSError as e:
        raise ConfigError(f"cannot read {p}: {e.strerror}") from None
    return parse(text, str(p))


# ------------------------------------------------------------------------------------- enforcement
def current(path: Optional[Path] = None) -> Config:
    """Re-read config.yaml now. Any problem is a refusal (fail closed)."""
    try:
        return load(path)
    except ConfigError as e:
        raise Refused("config", f"{e}\n  -> treating this as kill_switch: true until config.yaml is fixed") from None


def require_active(cfg: Config, action: str) -> None:
    if cfg.kill_switch:
        raise Refused("kill_switch", f"kill_switch is true in {cfg.path}; not {action}. Set it to false to resume.")


def require_network(cfg: Config, network: str, what: str) -> None:
    if cfg.network != network:
        raise Refused("network", f"{what} acts on {network} only, but {cfg.path} says network: {cfg.network}")


def check_min_price(cfg: Config, product: Optional[str], price_usd: Any, settled_usdc_base: Optional[str] = None,
                    order_id: str = "") -> None:
    """product None = subscription (payments made before products existed). price_usd = the order's quoted
    price (PaymentRecord.amountUsd); settled_usdc_base = USDC base units (6 decimals) that actually arrived."""
    who = f"{order_id}: " if order_id else ""
    product = product or "subscription"
    if product not in cfg.min_price_usd:
        raise Refused("min_price", f"{who}product {product!r} has no min_price_usd in {cfg.path}; not fulfilling an unpriced product")
    floor = cfg.min_price_usd[product]
    if price_usd is None or isinstance(price_usd, bool):
        raise Refused("min_price", f"{who}no quoted price recorded for this {product} order")
    try:
        price = Decimal(str(price_usd))
    except ArithmeticError:
        raise Refused("min_price", f"{who}unreadable price {price_usd!r}") from None
    if not price.is_finite() or price < floor:
        raise Refused("min_price", f"{who}{product} priced ${price} is below the minimum ${floor}")
    if settled_usdc_base is not None:
        settled = Decimal(int(settled_usdc_base)) / Decimal(10**6)
        need = floor * (1 - cfg.settlement_slippage_pct / 100)
        if settled < need:
            raise Refused("min_price", f"{who}{product} settled {settled} USDC, below the minimum ${floor} "
                                       f"less {cfg.settlement_slippage_pct}% slippage (= {need.quantize(Decimal('0.000001'))})")


def ledger(cfg: Config) -> spend.SpendLedger:
    return spend.SpendLedger(cfg.network)


def check_job(cfg: Config, order_id: str, kind: str, estimate_usd: Any, sl: Optional[spend.SpendLedger] = None,
              day: Optional[str] = None) -> dict:
    """Authorize a new paid job (inference call, BigQuery query) before it starts. Returns the budget numbers."""
    require_active(cfg, f"starting a {kind} job")
    if kind not in spend.KINDS:
        raise Refused("config", f"unknown cost kind {kind!r}")
    est = spend.usd_to_micros(estimate_usd)
    sl = sl or ledger(cfg)
    try:
        lines = sl.load()
    except spend.LedgerCorrupt as e:
        raise Refused("spend_ledger", str(e)) from None
    day = day or spend.utc_day()
    today, so_far = sl.day_total(day, lines), sl.order_total(order_id, lines)
    out = {"estimate_micros": est, "today_micros": today, "daily_cap_micros": cfg.daily_cap_micros,
           "order_micros": so_far, "report_cap_micros": cfg.report_cap_micros, "day": day}
    if today + est > cfg.daily_cap_micros:
        raise Refused("daily_cap", f"{kind} job for {order_id} estimated ${spend.fmt_usd(est)} but only "
                                   f"${spend.fmt_usd(max(0, cfg.daily_cap_micros - today))} of today's ${cfg.max_inference_usd_per_day} "
                                   f"cap is left (spent ${spend.fmt_usd(today)} on {day} UTC); waiting for the next UTC day or a higher cap")
    if so_far + est > cfg.report_cap_micros:
        raise Refused("report_cap", f"{kind} job for {order_id} estimated ${spend.fmt_usd(est)} would take the order to "
                                    f"${spend.fmt_usd(so_far + est)}, over per_report_cost_cap_usd ${cfg.per_report_cost_cap_usd}; the order needs a human")
    return out


def check_split(cfg: Config, onchain: dict) -> None:
    """Compare config.yaml's revenue_split with the splitter's get_config(). Mismatch -> Refused with an ALERT."""
    want = {"split_bps_contributors": cfg.contributors_bps, "split_bps_treasury": cfg.treasury_bps,
            "contributors": cfg.contributors_account, "treasury": cfg.treasury_account}
    diffs = [f"{k}: config.yaml {v!r} != onchain {onchain.get(k)!r}" for k, v in want.items() if onchain.get(k) != v]
    if onchain.get("paused"):
        diffs.append("splitter is paused onchain")
    if diffs:
        raise Refused("split_mismatch", f"ALERT: {cfg.net['splitter']} does not match config.yaml revenue_split: "
                                        + "; ".join(diffs) + ". Not acting until the operator reconciles them.")


def fetch_split(cfg: Config, rpc: Any) -> dict:
    try:
        return rpc.view(cfg.net["splitter"], "get_config", {})
    except Exception as e:  # network, RPC error: fail closed
        raise Refused("split_mismatch", f"ALERT: could not read {cfg.net['splitter']}.get_config ({e}); not acting without the split check") from None


def summary(cfg: Config, sl: Optional[spend.SpendLedger] = None) -> list[str]:
    sl = sl or ledger(cfg)
    out = [f"config {cfg.path}: network={cfg.network} kill_switch={'ON (agent refuses to act)' if cfg.kill_switch else 'off'}",
           f"  min_price_usd: " + ", ".join(f"{k} ${v}" for k, v in cfg.min_price_usd.items()) + f" (settlement slippage {cfg.settlement_slippage_pct}%)",
           f"  revenue_split: contributors {cfg.contributors_bps / 100:g}% -> {cfg.contributors_account}, "
           f"treasury {cfg.treasury_bps / 100:g}% -> {cfg.treasury_account} (splitter {cfg.net['splitter']})",
           f"  per_report_cost_cap_usd ${cfg.per_report_cost_cap_usd}"]
    try:
        lines = sl.load()
        today = sl.day_total(lines=lines)
        cap = cfg.daily_cap_micros
        out.append(f"  spend today ({spend.utc_day()} UTC): ${spend.fmt_usd(today)} of ${cfg.max_inference_usd_per_day} cap "
                   f"(${spend.fmt_usd(max(0, cap - today))} left, {len([l for l in lines if l['day'] == spend.utc_day()])} cost lines; "
                   f"ledger {sl.path}, {len(lines)} lines total, head {lines[-1]['line_hash'][:16] if lines else 'genesis'})")
    except spend.LedgerCorrupt as e:
        out.append(f"  spend today: UNKNOWN, {e}")
    return out


def schema_json() -> str:
    return json.dumps(SCHEMA, indent=2) + "\n"
