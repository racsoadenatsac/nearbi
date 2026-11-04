"""Forwarding agent: moves each settled NEAR Intents payment from forwarder.nearbi.near into
splitter.nearbi.near by calling forward(order_id=<payment id>, amount=<settled amountOut>).

Runs on the operator's Mac. The forwarder's function-call key (methods [forward] on
forwarder.nearbi.near, no deposit) is read from the macOS Keychain into process memory and handed to
near-cli through an anonymous pipe (/dev/fd/N): it is never written to disk, never on argv, never logged.

Stdlib only (Python 3.9+). External tools: `aws` (SSO profile `nearbi`), `security`, near-cli-rs.
See README.md for the full procedure, exit codes and limits.
"""
from __future__ import annotations

import base64
import dataclasses
import fcntl
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Optional

from . import egress, rules

# ------------------------------------------------------------------------------------------ constants
FORWARDER = "forwarder.nearbi.near"
SPLITTER = "splitter.nearbi.near"
USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
USDC_ASSET = "nep141:" + USDC
FC_PUBLIC_KEY = "ed25519:5xFkgAW74jxwq8FFJPR14hfnKfM3q2HxXkJ4BwwsQwSi"
KEYCHAIN_SERVICE = "nearbi-mainnet-fc-" + FORWARDER
TABLE = "nearbi"
REGION = "us-east-1"
ONECLICK = "https://1click.chaindefuser.com/v0"
RPCS = ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org"]
NEAR_NETWORK = "mainnet-fastnear"  # near-cli-rs network-config name
PREPAID_GAS_TGAS = 150  # contract minimum 130
YOCTO = 10**24
MIN_FREE_NEAR_YOCTO = 16 * 10**22  # 0.16 NEAR: the 0.15 NEAR gas hold per call + margin
MIN_ALLOWANCE_YOCTO = 15 * 10**22  # allowance must cover prepaid gas x 1e9 (the hold)
ORDER_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

EXIT_OK, EXIT_ERROR, EXIT_ATTENTION, EXIT_SSO, EXIT_TOPUP, EXIT_REFUSED = 0, 1, 2, 3, 4, 5  # 5 = an operator rule (config.yaml) refused


class Stop(Exception):
    """Abort the whole run (preflight failure, SSO expired, top-up needed)."""

    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


class Skip(Exception):
    """Leave one queue entry for later (or for a human); the run continues with the next one."""

    def __init__(self, message: str, attention: bool = False):
        super().__init__(message)
        self.attention = attention


def state_dir() -> Path:
    d = Path(os.environ.get("RS_AGENT_STATE_DIR", Path.home() / ".local/state/rs-agent"))
    d.mkdir(parents=True, exist_ok=True, mode=0o700)
    return d


def log(msg: str) -> None:
    print(f"[{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}] {msg}", flush=True)


SECRET_RE = re.compile(r"ed25519:[1-9A-HJ-NP-Za-km-z]{60,}|private_key|secret_key|seed phrase", re.I)


def scrub(text: str) -> str:
    return "\n".join(l for l in text.splitlines() if not SECRET_RE.search(l))


def b58decode(s: str) -> bytes:
    n = 0
    for c in s:
        n = n * 58 + B58.index(c)
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return b"\0" * (len(s) - len(s.lstrip("1"))) + raw


# ------------------------------------------------------------------------------------------ adapters
class Rpc:
    def __init__(self, urls: list[str] = RPCS):
        self.urls = urls

    def call(self, method: str, params: Any) -> Any:
        body = json.dumps({"jsonrpc": "2.0", "id": "rs-agent", "method": method, "params": params}).encode()
        last: Exception | None = None
        for url in self.urls:
            for attempt in range(3):
                try:
                    req = urllib.request.Request(url, body, {"content-type": "application/json"})
                    with urllib.request.urlopen(req, timeout=30) as r:
                        out = json.load(r)
                    if "error" in out:
                        raise RuntimeError(f"rpc {method}: {json.dumps(out['error'])[:300]}")
                    return out["result"]
                except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                    last = e
                    time.sleep(1 + attempt)
        raise RuntimeError(f"rpc {method} unreachable: {last}")

    def view(self, account: str, method: str, args: dict) -> Any:
        r = self.call("query", {"request_type": "call_function", "finality": "final", "account_id": account,
                                "method_name": method, "args_base64": base64.b64encode(json.dumps(args).encode()).decode()})
        if "error" in r:
            raise RuntimeError(f"view {account}.{method}: {r['error'][:300]}")
        return json.loads(bytes(r["result"]).decode())

    def account(self, account: str) -> dict:
        return self.call("query", {"request_type": "view_account", "finality": "final", "account_id": account})

    def access_key(self, account: str, public_key: str) -> dict:
        return self.call("query", {"request_type": "view_access_key", "finality": "final", "account_id": account, "public_key": public_key})

    def storage_price(self) -> int:
        cfg = self.call("EXPERIMENTAL_protocol_config", {"finality": "final"})
        return int(cfg["runtime_config"]["storage_amount_per_byte"])

    def tx_final(self, tx_hash: str, sender: str) -> dict:
        return self.call("EXPERIMENTAL_tx_status", {"tx_hash": tx_hash, "sender_account_id": sender, "wait_until": "FINAL"})


class Dynamo:
    """DynamoDB through the aws CLI (operator SSO profile). Read: FWDQ queue + PAY# items. Write: mark forwarded."""

    def __init__(self, profile: str = "nearbi", table: str = TABLE, region: str = REGION):
        # direct egress: DynamoDB/STS need no proxied secret (rs_agent.egress)
        self.env = egress.direct_env(AWS_PROFILE=profile, AWS_REGION=region, AWS_PAGER="")
        self.table = table

    def _aws(self, *args: str) -> Any:
        p = subprocess.run(["aws", "dynamodb", *args, "--table-name", self.table, "--output", "json"],
                           capture_output=True, text=True, env=self.env, timeout=60)
        if p.returncode != 0:
            err = p.stderr.strip()
            if re.search(r"Token has expired|SSO session|sso.*(expired|login)|UnauthorizedSSOToken|refresh failed|ExpiredToken", err, re.I):
                raise Stop(EXIT_SSO, "SSO expired")
            if "ConditionalCheckFailedException" in err:
                raise ConditionFailed(err[:300])
            raise RuntimeError(f"aws dynamodb {args[0]}: {err[:400]}")
        return json.loads(p.stdout) if p.stdout.strip() else {}

    def check_sso(self) -> None:
        p = subprocess.run(["aws", "sts", "get-caller-identity", "--output", "json"], capture_output=True, text=True, env=self.env, timeout=60)
        if p.returncode != 0:
            raise Stop(EXIT_SSO, "SSO expired")

    def forward_queue(self) -> list[dict]:
        out = self._aws("query", "--key-condition-expression", "PK = :pk",
                        "--expression-attribute-values", json.dumps({":pk": {"S": "FWDQ"}}), "--consistent-read")
        return [unmarshal(i) for i in out.get("Items", [])]

    def payment(self, pid: str) -> Optional[dict]:
        out = self._aws("get-item", "--key", json.dumps({"PK": {"S": f"PAY#{pid}"}, "SK": {"S": "PAYMENT"}}), "--consistent-read")
        return unmarshal(out["Item"]) if out.get("Item") else None

    def mark_forwarded(self, pid: str, tx: str, amount: str, now: int) -> bool:
        """Conditional: never overwrites an existing forwardedTx. Returns False if it was already set."""
        try:
            self._aws("update-item", "--key", json.dumps({"PK": {"S": f"PAY#{pid}"}, "SK": {"S": "PAYMENT"}}),
                      "--update-expression", "SET forwardedTx = :tx, forwardedAt = :at, forwardedAmount = :amt",
                      "--condition-expression", "attribute_exists(PK) AND attribute_not_exists(forwardedTx)",
                      "--expression-attribute-values", json.dumps({":tx": {"S": tx}, ":at": {"N": str(now)}, ":amt": {"S": amount}}))
            return True
        except ConditionFailed:
            return False

    def dequeue(self, pid: str) -> None:
        self._aws("delete-item", "--key", json.dumps({"PK": {"S": "FWDQ"}, "SK": {"S": f"PAY#{pid}"}}))


class ConditionFailed(Exception):
    pass


def unmarshal(item: dict) -> dict:
    def v(x: dict) -> Any:
        (t, val), = x.items()
        if t == "S":
            return val
        if t == "N":
            return int(val) if re.fullmatch(r"-?\d+", val) else float(val)
        if t == "NULL":
            return None
        if t == "BOOL":
            return val
        if t == "M":
            return {k: v(y) for k, y in val.items()}
        if t == "L":
            return [v(y) for y in val]
        return val
    return {k: v(x) for k, x in item.items()}


class OneClick:
    def __init__(self, base: str = ONECLICK):
        self.base = base

    def status(self, deposit_address: str, memo: Optional[str] = None) -> dict:
        q = f"depositAddress={urllib.parse.quote(deposit_address)}" + (f"&depositMemo={urllib.parse.quote(memo)}" if memo else "")
        req = urllib.request.Request(f"{self.base}/status?{q}", headers={"accept": "application/json", "user-agent": "rs-agent/forwarder-runner"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            raise Skip(f"1Click /status HTTP {e.code}; retry later") from None
        except (urllib.error.URLError, TimeoutError) as e:
            raise Skip(f"1Click unreachable ({e}); retry later") from None



class Signer:
    """Calls forward() with the Keychain-held function-call key via near-cli-rs. The secret only exists in
    this process and in the pipe near-cli reads once."""

    def __init__(self, near_cli: str):
        self.near = near_cli

    def secret(self) -> str:
        p = subprocess.run(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], capture_output=True, text=True)
        if p.returncode != 0:
            raise Stop(EXIT_ERROR, f"Keychain item {KEYCHAIN_SERVICE} not readable")
        return p.stdout.strip()

    def key_matches(self) -> bool:
        sk = self.secret()
        try:
            if not sk.startswith("ed25519:"):
                return False
            raw = b58decode(sk[8:])
            return len(raw) == 64 and raw[32:] == b58decode(FC_PUBLIC_KEY[8:])
        finally:
            sk = ""  # noqa: F841

    def forward_cmd(self, order_id: str, amount: str, fd: int, broadcast: bool = True) -> list[str]:
        """near-cli-rs argv for forward(); broadcast=False ends in `display` (sign offline, print, never send)."""
        args = json.dumps({"order_id": order_id, "amount": amount}, separators=(",", ":"))
        return [self.near, "contract", "call-function", "as-transaction", FORWARDER, "forward", "json-args", args,
                "prepaid-gas", f"{PREPAID_GAS_TGAS} Tgas", "attached-deposit", "0 NEAR", "sign-as", FORWARDER,
                "network-config", NEAR_NETWORK, "sign-with-access-key-file", f"/dev/fd/{fd}", "send" if broadcast else "display"]

    def forward(self, order_id: str, amount: str, broadcast: bool = True) -> tuple[int, str]:
        r, w = os.pipe()
        try:
            sk = self.secret()
            os.write(w, json.dumps({"public_key": FC_PUBLIC_KEY, "private_key": sk}).encode())
            sk = ""  # noqa: F841
            os.close(w)
            w = -1
            cmd = self.forward_cmd(order_id, amount, r, broadcast)
            # direct egress: near-cli-rs rejects the gateway proxy CA (UnknownIssuer); NEAR RPC needs no proxied secret
            p = subprocess.run(cmd, capture_output=True, text=True, pass_fds=(r,), timeout=180, env=egress.direct_env())
            return p.returncode, scrub(p.stdout + "\n" + p.stderr)
        finally:
            if w != -1:
                os.close(w)
            os.close(r)


# ------------------------------------------------------------------------------------------ checks (pure)
@dataclasses.dataclass
class Plan:
    order_id: str
    amount: str
    retry: bool = False


def validate_entry(entry: dict, pay: Optional[dict]) -> str:
    """Queue entry + payment record -> amount to forward (base units). Raises Skip on anything unexpected."""
    pid = entry.get("paymentId", "")
    if not ORDER_ID_RE.match(pid):
        raise Skip(f"queue entry with malformed paymentId {pid!r}", attention=True)
    if pay is None:
        raise Skip(f"{pid}: payment record missing", attention=True)
    checks = [
        (pay.get("mode") == "live", f"mode is {pay.get('mode')!r}, not live"),
        (pay.get("status") == "paid", f"payment status is {pay.get('status')!r}, not paid"),
        (pay.get("intentsStatus") == "SUCCESS", f"intentsStatus is {pay.get('intentsStatus')!r}, not SUCCESS"),
        (pay.get("recipient") == FORWARDER and entry.get("recipient") == FORWARDER, f"recipient is {pay.get('recipient')!r}, not {FORWARDER}"),
        (pay.get("destinationAsset") == USDC_ASSET and entry.get("destinationAsset") == USDC_ASSET, f"asset is {pay.get('destinationAsset')!r}, not USDC"),
        (pay.get("depositAddress") and pay.get("depositAddress") == entry.get("depositAddress"), "deposit address differs between queue and payment"),
    ]
    for ok, why in checks:
        if not ok:
            raise Skip(f"{pid}: {why}", attention=True)
    amount = entry.get("amount")
    if amount is None or not re.fullmatch(r"[1-9]\d{0,30}", str(amount)):
        raise Skip(f"{pid}: no settled amountOut recorded (1Click did not report one); forward by hand with --order/--amount after checking the delivery", attention=True)
    if str(pay.get("settledAmountOut")) != str(amount):
        raise Skip(f"{pid}: queue amount {amount} != payment settledAmountOut {pay.get('settledAmountOut')}", attention=True)
    if pay.get("amountOut") and int(amount) < int(pay["amountOut"]):
        raise Skip(f"{pid}: settled {amount} is below the quoted amountOut {pay['amountOut']}", attention=True)
    return str(amount)


def check_oneclick(st: dict, pay: dict, amount: str) -> None:
    pid = pay["id"]
    qr = (st.get("quoteResponse") or {}).get("quoteRequest") or {}
    q = (st.get("quoteResponse") or {}).get("quote") or {}
    out = (st.get("swapDetails") or {}).get("amountOut")
    if st.get("status") != "SUCCESS":
        raise Skip(f"{pid}: 1Click now says {st.get('status')!r}, not SUCCESS", attention=True)
    if qr.get("recipient") != FORWARDER or qr.get("destinationAsset") != USDC_ASSET:
        raise Skip(f"{pid}: 1Click quote recipient/asset is {qr.get('recipient')}/{qr.get('destinationAsset')}", attention=True)
    if q.get("depositAddress") and q["depositAddress"] != pay.get("depositAddress"):
        raise Skip(f"{pid}: 1Click deposit address differs", attention=True)
    if str(out) != amount:
        raise Skip(f"{pid}: 1Click settled amountOut {out} != {amount}", attention=True)


def free_near(acct: dict, storage_price: int) -> int:
    return int(acct["amount"]) - int(acct["storage_usage"]) * storage_price


def events(tx: dict) -> list[tuple[str, dict]]:
    """(executor, EVENT_JSON) from successful receipts only."""
    out = []
    for ro in tx.get("receipts_outcome", []):
        o = ro["outcome"]
        if "Failure" in o["status"]:
            continue
        for line in o["logs"]:
            if line.startswith("EVENT_JSON:"):
                try:
                    out.append((o["executor_id"], json.loads(line[len("EVENT_JSON:"):])))
                except ValueError:
                    pass
    return out


def verify_forward_tx(tx: dict, order_id: str, amount: str) -> list[str]:
    """Return the problems with a final forward tx (empty list = forwarded + sale events present and consistent)."""
    problems = []
    if "Failure" in tx.get("status", {}):
        problems.append(f"tx failed: {json.dumps(tx['status'])[:300]}")
    ev = events(tx)
    fwd = [e for x, e in ev if x == FORWARDER and e.get("standard") == "nearbi_forwarder" and e.get("event") == "forwarded"
           and any(d.get("order_id") == order_id and str(d.get("amount")) == amount for d in e.get("data", []))]
    sale = [e for x, e in ev if x == SPLITTER and e.get("standard") == "nearbi_splitter" and e.get("event") == "sale"
            and any(d.get("order_id") == order_id and str(d.get("amount")) == amount and d.get("token") == USDC for d in e.get("data", []))]
    failed = [e for x, e in ev if x == FORWARDER and e.get("event") == "forward_failed"]
    if failed:
        problems.append(f"forward_failed event: {json.dumps(failed)[:300]} (funds are back in the forwarder; order is retryable)")
    if not fwd:
        problems.append("no nearbi_forwarder 'forwarded' event for this order/amount")
    if not sale:
        problems.append("no nearbi_splitter 'sale' event for this order/amount")
    return problems


# ------------------------------------------------------------------------------------------ runner
class Runner:
    def __init__(self, rpc: Rpc, db: Dynamo, oneclick: OneClick, signer: Signer, dry_run: bool = False,
                 now: Callable[[], int] = lambda: int(time.time()), config_path: Optional[str] = None):
        self.rpc, self.db, self.oneclick, self.signer, self.dry_run, self.now = rpc, db, oneclick, signer, dry_run, now
        self.journal = state_dir() / "forwarder-journal.jsonl"
        self.config_path = config_path

    # --- operator rules (config.yaml), re-read at every check
    def rules_gate(self, action: str) -> "rules.Config":
        """Re-read config.yaml; refuse (Stop EXIT_REFUSED) on kill switch, wrong network or a bad file."""
        try:
            cfg = rules.current(self.config_path)
            rules.require_network(cfg, "mainnet", "forwarder-runner")
            rules.require_active(cfg, action)
            return cfg
        except rules.Refused as r:
            self.record(event="refused", rule=r.rule, reason=r.args[0])
            raise Stop(EXIT_REFUSED, str(r)) from None

    def record(self, **kw: Any) -> None:
        with open(self.journal, "a") as f:
            f.write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **kw}, sort_keys=True) + "\n")

    # --- preflight (once per run)
    def preflight(self) -> dict:
        self.db.check_sso()
        cfg = self.rpc.view(FORWARDER, "get_config", {})
        if cfg.get("splitter") != SPLITTER or cfg.get("token") != USDC or cfg.get("agent") != FORWARDER:
            raise Stop(EXIT_ERROR, f"forwarder config unexpected: splitter={cfg.get('splitter')} token={cfg.get('token')} agent={cfg.get('agent')}")
        if cfg.get("pending_change"):
            log(f"WARNING: forwarder has a pending timelocked change: {json.dumps(cfg['pending_change'])}")
        if cfg.get("paused"):
            raise Stop(EXIT_ERROR, "forwarder is paused (owner action); not forwarding")
        scfg = self.rpc.view(SPLITTER, "get_config", {})
        if USDC not in scfg.get("accepted_tokens", []) or scfg.get("paused"):
            raise Stop(EXIT_ERROR, f"splitter not accepting USDC (paused={scfg.get('paused')})")
        try:
            rules.check_split(rules.current(self.config_path), scfg)
        except rules.Refused as r:
            self.record(event="refused", rule=r.rule, reason=r.args[0])
            raise Stop(EXIT_REFUSED, str(r)) from None
        ak = self.rpc.access_key(FORWARDER, FC_PUBLIC_KEY)
        perm = ak.get("permission", {}).get("FunctionCall") or {}
        if perm.get("receiver_id") != FORWARDER or perm.get("method_names") != ["forward"]:
            raise Stop(EXIT_ERROR, f"forwarder access key permission unexpected: {json.dumps(ak.get('permission'))[:200]}")
        if not self.signer.key_matches():
            raise Stop(EXIT_ERROR, f"Keychain {KEYCHAIN_SERVICE} does not hold the secret for {FC_PUBLIC_KEY}")
        acct = self.rpc.account(FORWARDER)
        free = free_near(acct, self.rpc.storage_price())
        allowance = int(perm.get("allowance") or 0) if perm.get("allowance") is not None else None
        usdc = int(self.rpc.view(USDC, "ft_balance_of", {"account_id": FORWARDER}))
        return {"config": cfg, "free_near": free, "allowance": allowance, "usdc": usdc}

    def gas_ok(self) -> None:
        acct = self.rpc.account(FORWARDER)
        free = free_near(acct, self.rpc.storage_price())
        if free < MIN_FREE_NEAR_YOCTO:
            raise Stop(EXIT_TOPUP, f"top up {FORWARDER}: free NEAR {free / YOCTO:.4f} < 0.16 (each forward holds 0.15 NEAR of gas). "
                                   f"Send e.g. 0.5 NEAR to {FORWARDER} from any account; no key needed.")
        ak = self.rpc.access_key(FORWARDER, FC_PUBLIC_KEY)
        allowance = (ak.get("permission", {}).get("FunctionCall") or {}).get("allowance")
        if allowance is not None and int(allowance) < MIN_ALLOWANCE_YOCTO:
            raise Stop(EXIT_TOPUP, f"the forwarder function-call key's allowance is {int(allowance) / YOCTO:.4f} NEAR < 0.15 and cannot be refilled "
                                   f"(the account is locked). Owner fix: nearbi.near calls set_agent(<new agent account>) on {FORWARDER}; see rs-payments README §8.")

    # --- one order
    def process(self, entry: dict, manual: bool = False) -> str:
        pid = entry["paymentId"]
        pay = self.db.payment(pid) if ORDER_ID_RE.match(pid) else None
        if pay and pay.get("forwardedTx"):
            log(f"{pid}: already marked forwarded ({pay['forwardedTx']}); removing from the queue")
            if not self.dry_run:
                self.db.dequeue(pid)
            return "already-done"
        amount = validate_entry(entry, pay)
        assert pay is not None
        cfg = self.rules_gate(f"forwarding {pid}")
        try:
            rules.check_min_price(cfg, pay.get("product"), pay.get("amountUsd"), amount, order_id=pid)
        except rules.Refused as r:
            self.record(event="refused", rule=r.rule, order_id=pid, reason=r.args[0])
            raise Skip(str(r), attention=True) from None
        check_oneclick(self.oneclick.status(pay["depositAddress"], pay.get("depositMemo")), pay, amount)

        order = self.rpc.view(FORWARDER, "get_order", {"order_id": pid})
        retry = False
        if order is not None:
            st = order.get("status")
            if st == "forwarded":
                return self.recover(pid, str(order.get("forwarded_amount")))
            if st == "in_flight":
                raise Skip(f"{pid}: forward already in flight onchain; retry next run")
            if st == "retryable":
                if str(order.get("unused")) != amount:
                    raise Skip(f"{pid}: retryable onchain with unused {order.get('unused')} != {amount}", attention=True)
                retry = True
                log(f"{pid}: retrying a failed forward (attempt {int(order.get('attempts', 1)) + 1})")
        if self.rpc.view(FORWARDER, "is_forwarded", {"order_id": pid}):
            raise Skip(f"{pid}: is_forwarded=true", attention=True)

        bal = int(self.rpc.view(USDC, "ft_balance_of", {"account_id": FORWARDER}))
        if bal < int(amount):
            raise Skip(f"{pid}: forwarder USDC balance {bal} < {amount}; the 1Click delivery hasn't landed (or was already forwarded); retry later", attention=manual)
        self.gas_ok()

        if self.dry_run:
            log(f"{pid}: DRY RUN, would call forward(order_id={pid}, amount={amount}) [balance {bal}]")
            return "dry-run"

        self.rules_gate(f"forwarding {pid}")  # last check right before signing
        log(f"{pid}: forward(order_id={pid}, amount={amount}) {'(retry) ' if retry else ''}signing with the Keychain FC key")
        self.record(event="forward_sent", order_id=pid, amount=amount)
        rc, out = self.signer.forward(pid, amount)
        m = re.findall(r"Transaction ID:\s*([1-9A-HJ-NP-Za-km-z]{40,})", out)
        tx_hash = m[-1] if m else None
        if not tx_hash:
            self.record(event="forward_no_tx", order_id=pid, amount=amount, rc=rc, out=out[-800:])
            raise Stop(EXIT_ERROR, f"{pid}: near-cli returned rc={rc} without a tx hash; check is_forwarded/get_order before rerunning:\n{out[-800:]}")
        tx = self.rpc.tx_final(tx_hash, FORWARDER)
        problems = verify_forward_tx(tx, pid, amount)
        if problems or not self.rpc.view(FORWARDER, "is_forwarded", {"order_id": pid}):
            self.record(event="forward_problem", order_id=pid, amount=amount, tx=tx_hash, problems=problems)
            raise Skip(f"{pid}: forward tx {tx_hash} did not complete cleanly: {'; '.join(problems) or 'is_forwarded=false'}", attention=True)
        self.record(event="forwarded", order_id=pid, amount=amount, tx=tx_hash)
        if not self.db.mark_forwarded(pid, tx_hash, amount, self.now()):
            log(f"{pid}: forwardedTx was already set in DynamoDB (concurrent runner?)")
        self.db.dequeue(pid)
        log(f"{pid}: forwarded {int(amount) / 1e6:.6f} USDC into {SPLITTER}; tx {tx_hash} https://nearblocks.io/txns/{tx_hash}")
        return "forwarded"

    def sign_check(self, order_id: Optional[str] = None, amount: str = "1") -> str:
        """Exercise the real signing path short of broadcast: rules gate + preflight, then near-cli-rs signs
        forward(<fresh random order id>, 1) with the Keychain key, fetching nonce and block hash over NEAR RPC, and
        ends in `display` (never `send`). The signed transaction is checked in memory and discarded, never printed."""
        import uuid
        self.rules_gate("sign check")
        self.preflight()
        oid = order_id or str(uuid.uuid4())
        assert self.signer.forward_cmd(oid, amount, 0, broadcast=False)[-1] == "display"
        rc, out = self.signer.forward(oid, amount, broadcast=False)
        blob = signed_blob(out)
        safe = SIGNED_RE.sub(r"\1<signed tx withheld>", out)
        if rc != 0 or blob is None:
            raise Stop(EXIT_ERROR, f"sign check: near-cli rc={rc}, no signed transaction:\n{safe[-800:]}")
        problems = [w for w, ok in (("public key", FC_PUBLIC_KEY in out), ("signer/receiver", FORWARDER.encode() in blob),
                                    ("method", b"forward" in blob), ("order id", oid.encode() in blob)) if not ok]
        blob = b""  # noqa: F841  (discard the signed tx)
        if problems:
            raise Stop(EXIT_ERROR, f"sign check: signed tx does not match the request ({', '.join(problems)})")
        return oid

    def journal_tx(self, pid: str) -> Optional[str]:
        """Last tx hash this machine recorded for a forward of `pid` (forwarded or forward_problem)."""
        if not self.journal.exists():
            return None
        tx = None
        for line in self.journal.read_text().splitlines():
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get("order_id") == pid and r.get("tx"):
                tx = r["tx"]
        return tx

    def recover(self, pid: str, forwarded_amount: str) -> str:
        """Onchain the order is forwarded but DynamoDB doesn't know (e.g. the runner died after sending).
        Mark it only if a journaled tx verifies; otherwise a human has to look."""
        tx_hash = self.journal_tx(pid)
        if not tx_hash:
            raise Skip(f"{pid}: onchain forwarded ({forwarded_amount}) but no tx in {self.journal}; find the forward tx on nearblocks and mark forwardedTx by hand", attention=True)
        problems = verify_forward_tx(self.rpc.tx_final(tx_hash, FORWARDER), pid, forwarded_amount)
        if problems:
            raise Skip(f"{pid}: onchain forwarded but journaled tx {tx_hash} doesn't verify: {'; '.join(problems)}", attention=True)
        if self.dry_run:
            log(f"{pid}: DRY RUN, would mark forwardedTx={tx_hash} (recovered from the journal)")
            return "dry-run"
        self.db.mark_forwarded(pid, tx_hash, forwarded_amount, self.now())
        self.db.dequeue(pid)
        log(f"{pid}: recovered: forwarded by {tx_hash}, marked in DynamoDB")
        return "recovered"

    def run_once(self, manual: Optional[dict] = None) -> int:
        lock = open(state_dir() / "forwarder-runner.lock", "w")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log("another forwarder-runner is running; exiting")
            return EXIT_OK
        try:
            self.rules_gate("forwarding")
            pre = self.preflight()
            log(f"preflight ok: {FORWARDER} -> {SPLITTER}, USDC balance {pre['usdc'] / 1e6:.6f}, free NEAR {pre['free_near'] / YOCTO:.4f}, "
                f"FC allowance {('%.4f' % (pre['allowance'] / YOCTO)) if pre['allowance'] is not None else 'unlimited'} NEAR, "
                f"forwarded so far {pre['config'].get('forwarded_count')} ({int(pre['config'].get('forwarded_total', 0)) / 1e6:.6f} USDC)")
            if pre["free_near"] < MIN_FREE_NEAR_YOCTO:
                log(f"WARNING: top up {FORWARDER}: free NEAR {pre['free_near'] / YOCTO:.4f} < 0.16; forwards will be refused")
            entries = [manual] if manual else self.db.forward_queue()
            if not entries:
                log("nothing to forward (FWDQ queue empty)")
                return EXIT_OK
            attention = 0
            for e in sorted(entries, key=lambda x: (x.get("enqueuedAt", 0), x.get("paymentId", ""))):
                try:
                    r = self.process(e, manual=bool(manual))
                    log(f"{e.get('paymentId')}: {r}")
                except Skip as s:
                    attention += 1 if s.attention else 0
                    log(f"{'ATTENTION' if s.attention else 'skip'}: {s}")
            # Per-order compute costs are booked by bin/record-cost and the NEAR AI client (spend ledger + splitter.record_cost).
            return EXIT_ATTENTION if attention else EXIT_OK
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
            lock.close()


SIGNED_RE = re.compile(r"(Signed transaction \(serialized as base64\):[^\S\n]*\n\s*)([A-Za-z0-9+/=]{40,})")


def signed_blob(out: str) -> Optional[bytes]:
    """The borsh bytes of the signed transaction near-cli `display` printed, or None."""
    m = SIGNED_RE.search(out)
    if not m:
        return None
    try:
        return base64.b64decode(m.group(2), validate=True)
    except ValueError:
        return None


def manual_entry(db: Dynamo, order_id: str, amount: str) -> dict:
    pay = db.payment(order_id) if ORDER_ID_RE.match(order_id) else None
    if not pay:
        raise Stop(EXIT_ERROR, f"payment {order_id} not found")
    if not re.fullmatch(r"[1-9]\d{0,30}", amount):
        raise Stop(EXIT_ERROR, "--amount must be a positive integer in USDC base units (6 decimals)")
    if str(pay.get("settledAmountOut") or "") not in ("", amount):
        raise Stop(EXIT_ERROR, f"--amount {amount} != recorded settledAmountOut {pay.get('settledAmountOut')}")
    # A manual forward still goes through every check (1Click SUCCESS with this exact amountOut, balance, gas).
    pay = {**pay, "settledAmountOut": amount}
    db_payment = db.payment
    db.payment = lambda pid: pay if pid == order_id else db_payment(pid)  # type: ignore[assignment]
    return {"paymentId": order_id, "amount": amount, "recipient": pay.get("recipient"), "destinationAsset": pay.get("destinationAsset"),
            "depositAddress": pay.get("depositAddress"), "enqueuedAt": 0}
