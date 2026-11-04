"""splitter.record_cost: mirror a spend-ledger line onchain as a `cost` event (rs-ledger then publishes it).

record_cost(kind, amount_usd_micros, ref) is callable only by the splitter account itself, i.e. by its
function-call key (methods [record_cost, anchor_report], no deposit; rs-payments deploy/*.json):
  mainnet  key in the macOS Keychain item nearbi-mainnet-fc-splitter.nearbi.near
  testnet  the chmod-600 key file rs-payments/bin/deploy-testnet.sh created
The secret is read into this process only and handed to near-cli-rs through an anonymous pipe
(/dev/fd/N): never written to disk, never on argv, never printed.

Nothing is sent unless the caller asks (bin/record-cost --send); a dry-run of the exact call is always
printed first.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any, Optional

from . import egress
from . import forwarder as fw
from .rules import Config

PREPAID_GAS_TGAS = 30  # record_cost burns ~1.7 Tgas (testnet demo); 30 Tgas = 0.003 NEAR held from the allowance
MIN_ALLOWANCE_YOCTO = 3 * 10**21  # 0.003 NEAR, the hold for 30 Tgas
MIN_FREE_NEAR_YOCTO = 10**22  # 0.01 NEAR on the splitter account for gas
MAX_REF = 256  # splitter MAX_TEXT_LEN
KIND_MAX = 64
SLUG_MAX = 128  # splitter MAX_ORDER_ID_LEN (anchor_report slug)
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
PROXY_VARS = egress.PROXY_VARS


def near_cli_env() -> dict:
    """Environment for near-cli-rs: direct egress (rs_agent.egress.direct_env); NEAR RPC needs no proxied secret."""
    return egress.direct_env()


def build_ref(order_id: str, line_hash: str, note: str = "") -> str:
    ref = f"order:{order_id} spend:{line_hash[:16]}" + (f" {note}" if note else "")
    b = ref.encode("utf-8")[:MAX_REF]
    return b.decode("utf-8", errors="ignore")


def call_args(kind: str, usd_micros: int, ref: str) -> dict:
    if not kind or len(kind) > KIND_MAX or not ref or len(ref.encode()) > MAX_REF:
        raise ValueError("record_cost: kind 1-64 chars, ref 1-256 bytes")
    return {"kind": kind, "amount_usd_micros": str(int(usd_micros)), "ref": ref}


def anchor_args(slug: str, report_sha256: str) -> dict:
    if not slug or len(slug) > SLUG_MAX or not SHA256_RE.match(report_sha256 or ""):
        raise ValueError("anchor_report: slug 1-128 chars, sha256 = 64 lowercase hex")
    return {"slug": slug, "manifest_sha256": report_sha256}


def dry_run_text(cfg: Config, args: dict, sending: bool = False, method: str = "record_cost") -> str:
    n = cfg.net
    return "\n".join([
        f"DRY RUN onchain {method} ({cfg.network}{', REAL MONEY ACCOUNT' if cfg.network == 'mainnet' else ''}):",
        f"  receiver   {n['splitter']}",
        f"  method     {method}",
        f"  args       {json.dumps(args, separators=(',', ':'))}",
        f"  gas        {PREPAID_GAS_TGAS} Tgas, deposit 0 NEAR",
        f"  signer     {n['splitter']} with function-call key {n['splitter_fc_public_key']}",
        f"  key source " + (f"macOS Keychain {n['splitter_fc_secret']['keychain']} (read into memory only)" if "keychain" in n["splitter_fc_secret"]
                            else f"{n['splitter_fc_secret']['file']} (testnet, read into memory only)"),
        f"  near-cli   network-config {n['near_cli_network']}",
        "  sending now (--send)" if sending else "  not sent: rerun with --send to broadcast",
    ])


class SplitterSigner:
    def __init__(self, cfg: Config, near_cli: str):
        self.cfg, self.near = cfg, near_cli
        self.account = cfg.net["splitter"]
        self.public_key = cfg.net["splitter_fc_public_key"]

    def secret(self) -> str:
        src = self.cfg.net["splitter_fc_secret"]
        if "keychain" in src:
            p = subprocess.run(["security", "find-generic-password", "-s", src["keychain"], "-w"], capture_output=True, text=True)
            if p.returncode != 0:
                raise fw.Stop(fw.EXIT_ERROR, f"Keychain item {src['keychain']} not readable")
            return p.stdout.strip()
        try:
            d = json.loads(Path(src["file"]).read_text())
        except (OSError, ValueError):
            raise fw.Stop(fw.EXIT_ERROR, f"testnet key file {src['file']} not readable") from None
        if d.get("public_key") != self.public_key:
            raise fw.Stop(fw.EXIT_ERROR, f"{src['file']} is not the key {self.public_key}")
        return d.get("private_key", "")

    def key_matches(self) -> bool:
        sk = self.secret()
        try:
            if not sk.startswith("ed25519:"):
                return False
            raw = fw.b58decode(sk[8:])
            return len(raw) == 64 and raw[32:] == fw.b58decode(self.public_key[8:])
        finally:
            sk = ""  # noqa: F841

    def call(self, method: str, args: dict, broadcast: bool = True) -> tuple[int, str]:
        """near-cli-rs signs `method(args)`; broadcast=False ends in `display` (signed offline, never sent)."""
        r, w = os.pipe()
        try:
            sk = self.secret()
            os.write(w, json.dumps({"public_key": self.public_key, "private_key": sk}).encode())
            sk = ""  # noqa: F841
            os.close(w)
            w = -1
            cmd = [self.near, "contract", "call-function", "as-transaction", self.account, method, "json-args",
                   json.dumps(args, separators=(",", ":")), "prepaid-gas", f"{PREPAID_GAS_TGAS} Tgas", "attached-deposit", "0 NEAR",
                   "sign-as", self.account, "network-config", self.cfg.net["near_cli_network"],
                   "sign-with-access-key-file", f"/dev/fd/{r}", "send" if broadcast else "display"]
            p = subprocess.run(cmd, capture_output=True, text=True, pass_fds=(r,), timeout=180, env=near_cli_env())
            return p.returncode, fw.scrub(p.stdout + "\n" + p.stderr)
        finally:
            if w != -1:
                os.close(w)
            os.close(r)


def preflight(cfg: Config, rpc: Any, signer: SplitterSigner, method: str = "record_cost") -> None:
    """The onchain key must be a function-call key for `method` on the splitter, the local secret must be
    its private half, and the account must afford the gas."""
    acct = cfg.net["splitter"]
    ak = rpc.access_key(acct, signer.public_key)
    perm = (ak.get("permission") or {}).get("FunctionCall") or {}
    if perm.get("receiver_id") != acct or method not in (perm.get("method_names") or []):
        raise fw.Stop(fw.EXIT_ERROR, f"{acct} access key {signer.public_key} is not a {method} function-call key: {json.dumps(ak.get('permission'))[:200]}")
    if perm.get("allowance") is not None and int(perm["allowance"]) < MIN_ALLOWANCE_YOCTO:
        raise fw.Stop(fw.EXIT_TOPUP, f"{acct} function-call key allowance {int(perm['allowance']) / fw.YOCTO:.4f} NEAR < 0.003")
    free = fw.free_near(rpc.account(acct), rpc.storage_price())
    if free < MIN_FREE_NEAR_YOCTO:
        raise fw.Stop(fw.EXIT_TOPUP, f"top up {acct}: free NEAR {free / fw.YOCTO:.4f} < 0.01")
    if not signer.key_matches():
        raise fw.Stop(fw.EXIT_ERROR, f"the local secret for {acct} does not match {signer.public_key}")


def sign_check(cfg: Config, signer: SplitterSigner, method: str, args: dict) -> None:
    """Sign the exact call with near-cli-rs (nonce + block hash over NEAR RPC) and only display it: proves key,
    near-cli and its egress without broadcasting. The signed tx is checked in memory and discarded."""
    rc, out = signer.call(method, args, broadcast=False)
    blob = fw.signed_blob(out)
    if rc != 0 or blob is None:
        safe = fw.SIGNED_RE.sub(r"\1<signed tx withheld>", out)
        raise fw.Stop(fw.EXIT_ERROR, f"sign check: near-cli rc={rc}, no signed transaction:\n{safe[-800:]}")
    marker = (args.get("ref") or args.get("slug") or "").encode()
    ok = signer.public_key in out and signer.account.encode() in blob and method.encode() in blob and marker in blob
    blob = b""  # noqa: F841  (discard the signed tx)
    if not ok:
        raise fw.Stop(fw.EXIT_ERROR, "sign check: signed tx does not match the request")


def verify_cost_tx(tx: dict, splitter: str, args: dict) -> list[str]:
    problems = []
    if "Failure" in tx.get("status", {}):
        problems.append(f"tx failed: {json.dumps(tx['status'])[:300]}")
    ok = [e for x, e in fw.events(tx) if x == splitter and e.get("standard") == "nearbi_splitter" and e.get("event") == "cost"
          and any(d.get("kind") == args["kind"] and str(d.get("amount_usd_micros")) == args["amount_usd_micros"] and d.get("ref") == args["ref"]
                  for d in e.get("data", []))]
    if not ok:
        problems.append("no nearbi_splitter 'cost' event with these args")
    return problems


def send(cfg: Config, rpc: Any, signer: SplitterSigner, args: dict) -> str:
    preflight(cfg, rpc, signer)
    rc, out = signer.call("record_cost", args)
    m = re.findall(r"Transaction ID:\s*([1-9A-HJ-NP-Za-km-z]{40,})", out)
    if not m:
        raise fw.Stop(fw.EXIT_ERROR, f"near-cli rc={rc} without a tx hash:\n{out[-800:]}")
    tx_hash = m[-1]
    problems = verify_cost_tx(rpc.tx_final(tx_hash, cfg.net["splitter"]), cfg.net["splitter"], args)
    if problems:
        raise fw.Stop(fw.EXIT_ERROR, f"record_cost tx {tx_hash} did not verify: {'; '.join(problems)}")
    return tx_hash


def verify_anchor_tx(tx: dict, splitter: str, args: dict) -> list[str]:
    problems = []
    if "Failure" in tx.get("status", {}):
        problems.append(f"tx failed: {json.dumps(tx['status'])[:300]}")
    ok = [e for x, e in fw.events(tx) if x == splitter and e.get("standard") == "nearbi_splitter" and e.get("event") == "report_anchor"
          and any(d.get("slug") == args["slug"] and d.get("manifest_sha256") == args["manifest_sha256"] for d in e.get("data", []))]
    if not ok:
        problems.append("no nearbi_splitter 'report_anchor' event with these args")
    return problems


def send_anchor(cfg: Config, rpc: Any, signer: SplitterSigner, args: dict) -> str:
    """anchor_report(slug, manifest_sha256) with the splitter function-call key; verified like record_cost."""
    preflight(cfg, rpc, signer, "anchor_report")
    rc, out = signer.call("anchor_report", args)
    m = re.findall(r"Transaction ID:\s*([1-9A-HJ-NP-Za-km-z]{40,})", out)
    if not m:
        raise fw.Stop(fw.EXIT_ERROR, f"near-cli rc={rc} without a tx hash:\n{out[-800:]}")
    tx_hash = m[-1]
    problems = verify_anchor_tx(rpc.tx_final(tx_hash, cfg.net["splitter"]), cfg.net["splitter"], args)
    if problems:
        raise fw.Stop(fw.EXIT_ERROR, f"anchor_report tx {tx_hash} did not verify: {'; '.join(problems)}")
    return tx_hash


def anchor_journal_path(cfg: Config) -> Path:
    return fw.state_dir() / f"anchor-onchain.{cfg.network}.jsonl"


def anchored_tx(cfg: Config, slug: str, report_sha256: str) -> Optional[str]:
    p = anchor_journal_path(cfg)
    if not p.exists():
        return None
    for raw in p.read_text().splitlines():
        try:
            r = json.loads(raw)
        except ValueError:
            continue
        if r.get("slug") == slug and r.get("sha256") == report_sha256 and r.get("tx"):
            return r["tx"]
    return None


def anchor_journal(cfg: Config, **kw: Any) -> None:
    with open(anchor_journal_path(cfg), "a") as f:
        f.write(json.dumps(kw, sort_keys=True) + "\n")


def journal_path(cfg: Config) -> Path:
    return fw.state_dir() / f"record-cost-onchain.{cfg.network}.jsonl"


def sent_tx(cfg: Config, line_hash: str) -> Optional[str]:
    p = journal_path(cfg)
    if not p.exists():
        return None
    for raw in p.read_text().splitlines():
        try:
            r = json.loads(raw)
        except ValueError:
            continue
        if r.get("line_hash") == line_hash and r.get("tx"):
            return r["tx"]
    return None


def journal(cfg: Config, **kw: Any) -> None:
    with open(journal_path(cfg), "a") as f:
        f.write(json.dumps(kw, sort_keys=True) + "\n")
