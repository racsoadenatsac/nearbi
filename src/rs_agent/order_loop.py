"""Order loop: paid order -> report -> delivery -> onchain cost + anchor (ARCHITECTURE.md §3.4-3.5, §3.7).

One order is a JSON file in the order store (default $RS_AGENT_STATE_DIR/orders.<network>/<order_id>.json):

  awaiting_payment --(forwarder.get_order == forwarded, >= min price)--> paid
  paid --(write-report exit 0)--> delivered --(record_cost + anchor_report sent)--> done
  paid --(write-report exit 6, or no automatic fulfilment, or below min price)--> needs_human   (never delivered)

Payment is read from the chain, not trusted from the order file: the forwarder of config.yaml `network`
(forwarder-v2.nearbi-agent.testnet / forwarder.nearbi.near) must report the order `forwarded`, and the forwarded
amount must pass min_price_usd (+ settlement slippage). The same code path works on mainnet, where
forwarder-runner forwards the 1Click payment under its payment id.

Fulfilment maps product -> cached result pack + question (PRODUCTS); write-report does the paid NEAR AI
inference and books it in the network's spend ledger. Every decision point re-reads the rules: the loop's
config and every extra --kill-switch-config (the demo runs on a testnet config but still obeys the
operator's config.yaml kill switch).

Nothing here prints or stores key material; signing is done by bin/record-cost and onchain.SplitterSigner.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Optional

from . import forwarder as fw
from . import onchain, rules, spend

ROOT = Path(__file__).resolve().parent.parent.parent

EXIT_OK, EXIT_ERROR, EXIT_NEEDS_HUMAN, EXIT_REFUSED = 0, 1, 2, 5
WRITE_REPORT_FAILED = 6  # bin/write-report: paid, narrative failed the checks twice, nothing written
MAX_ERRORS = 2  # write-report errors (network, NEAR AI) before an order goes to a human

# product -> fulfilment. pack = rs-reports/reports/<pack>; question None = the pack's title.
# Only cached packs are automatic; anything that needs new queries goes to a human.
PRODUCTS: dict[str, dict[str, Any]] = {
    "quick_answer": {"kind": "report", "default_topic": "near-users-vs-bots",
                     "topics": {"near-users-vs-bots": {"pack": "near-users-vs-bots", "question": None},
                                "near-oct-cohort-retention": {"pack": "near-oct-cohort-retention", "question": None}}},
    "deep_dive": {"kind": "human", "why": "a deep dive needs new queries (no cached pack); a human scopes it"},
    "subscription": {"kind": "app", "why": "subscription access is granted by nearbi-app, not by a report"},
}
TOKENS = {"mainnet": fw.USDC, "testnet": "usdc-mock.nearbi-agent.testnet"}
STATUSES = ("awaiting_payment", "paid", "delivered", "done", "needs_human", "no_fulfilment")


class OrderError(ValueError):
    pass


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def atomic_write(path: Path, text: str, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


# ------------------------------------------------------------------------------------------ order store
class OrderStore:
    def __init__(self, root: Path):
        self.root = Path(root)

    @classmethod
    def default(cls, network: str) -> "OrderStore":
        return cls(fw.state_dir() / f"orders.{network}")

    def path(self, order_id: str) -> Path:
        if not spend.ORDER_RE.match(order_id or ""):
            raise OrderError(f"order id {order_id!r} must be 1-128 chars of [A-Za-z0-9._:-]")
        return self.root / f"{order_id}.json"

    def create(self, *, order_id: str, network: str, product: str, price_usd: Any, customer: str,
               topic: Optional[str] = None, question: Optional[str] = None, payment_tx: Optional[str] = None) -> dict:
        p = self.path(order_id)
        if p.exists():
            raise OrderError(f"order {order_id} already exists ({p})")
        order = {"order_id": order_id, "network": network, "product": product, "price_usd": str(Decimal(str(price_usd))),
                 "customer": customer, "topic": topic, "question": question, "payment_tx": payment_tx,
                 "created_at": now_iso(), "status": "awaiting_payment", "errors": 0, "history": []}
        self._event(order, "awaiting_payment", "order created")
        self.save(order)
        return order

    def load(self, order_id: str) -> dict:
        return json.loads(self.path(order_id).read_text())

    def save(self, order: dict) -> None:
        atomic_write(self.path(order["order_id"]), json.dumps(order, indent=2, sort_keys=True) + "\n", 0o600)

    def all(self) -> list[dict]:
        if not self.root.exists():
            return []
        return sorted((json.loads(p.read_text()) for p in self.root.glob("*.json")), key=lambda o: o["created_at"])

    @staticmethod
    def _event(order: dict, status: str, note: str, **extra: Any) -> None:
        order["status"] = status
        order["history"].append({"ts": now_iso(), "status": status, "note": note, **extra})

    def mark(self, order: dict, status: str, note: str, **extra: Any) -> None:
        assert status in STATUSES, status
        self._event(order, status, note, **extra)
        self.save(order)


# ------------------------------------------------------------------------------------------ fulfilment map
def fulfilment(order: dict, packs_root: Path) -> dict:
    """product (+ topic) -> {"kind": "report", pack, question} | {"kind": "human"|"app", why}. Raises OrderError
    for an unknown product or topic (the order then needs a human)."""
    prod = PRODUCTS.get(order.get("product") or "")
    if prod is None:
        raise OrderError(f"unknown product {order.get('product')!r}")
    if prod["kind"] != "report":
        return {"kind": prod["kind"], "why": prod["why"]}
    topic = order.get("topic") or prod["default_topic"]
    t = prod["topics"].get(topic)
    if t is None:
        raise OrderError(f"no cached pack for {order['product']} topic {topic!r} (known: {', '.join(sorted(prod['topics']))})")
    return {"kind": "report", "topic": topic, "pack": str(Path(packs_root) / t["pack"]), "question": t["question"]}


# ------------------------------------------------------------------------------------------ adapters
def subprocess_write_report(order_id: str, pack: str, question: Optional[str], out_dir: Path, cfg_path: Optional[str],
                            max_usd: str, emit: Callable[[str], None]) -> int:
    cmd = [sys.executable, str(ROOT / "bin/write-report"), "--order", order_id, "--pack", pack, "--out", str(out_dir),
           "--max-usd", max_usd]
    if question:
        cmd += ["--question", question]
    if cfg_path:
        cmd += ["--config", cfg_path]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for line in p.stdout:  # type: ignore[union-attr]
        emit("    " + fw.scrub(line.rstrip("\n")))
    return p.wait()


def subprocess_record_cost(seq: int, cfg_path: Optional[str], emit: Callable[[str], None]) -> int:
    cmd = [sys.executable, str(ROOT / "bin/record-cost"), "--from-line", str(seq), "--send"]
    if cfg_path:
        cmd += ["--config", cfg_path]
    p = subprocess.run(cmd, capture_output=True, text=True)
    for line in (p.stdout + p.stderr).splitlines():
        if line.strip() and not line.startswith("  ") and "DRY RUN" not in line:
            emit("    " + fw.scrub(line))
    return p.returncode


@dataclass
class Loop:
    """Dependencies are injectable so tests run with no network: get_order (forwarder view), write_report,
    record_cost, anchor (onchain)."""
    cfg_path: Optional[str] = None
    kill_switch_configs: tuple = ()
    store: Optional[OrderStore] = None
    inbox: Optional[Path] = None
    reports: Optional[Path] = None
    packs_root: Path = field(default_factory=lambda: Path(os.environ.get("RS_REPORTS_DIR") or ROOT.parent / "rs-reports") / "reports")
    onchain_mode: str = "send"  # send | dry-run | off
    max_usd: str = "0.25"
    emit: Callable[[str], None] = print
    get_order: Optional[Callable[[rules.Config, str], Optional[dict]]] = None
    write_report: Optional[Callable[..., int]] = None
    record_cost: Optional[Callable[[int, Optional[str], Callable], int]] = None
    anchor: Optional[Callable[[rules.Config, dict], str]] = None
    on_phase: Callable[[str], None] = lambda name: None

    # -- rules, re-read at every decision point
    def guard(self, action: str) -> rules.Config:
        cfg = rules.current(self.cfg_path)
        rules.require_active(cfg, action)
        for extra in self.kill_switch_configs:
            other = rules.current(extra)
            rules.require_active(other, f"{action} (operator kill switch in {extra})")
        return cfg

    def _store(self, cfg: rules.Config) -> OrderStore:
        return self.store or OrderStore.default(cfg.network)

    def _inbox(self, cfg: rules.Config) -> Path:
        return Path(self.inbox) if self.inbox else fw.state_dir() / f"inbox.{cfg.network}"

    def _reports(self, cfg: rules.Config) -> Path:
        return Path(self.reports) if self.reports else fw.state_dir() / "reports"

    # -- payment
    def _get_order(self, cfg: rules.Config, order_id: str) -> Optional[dict]:
        if self.get_order:
            return self.get_order(cfg, order_id)
        return fw.Rpc(cfg.net["rpc"]).view(cfg.net["forwarder"], "get_order", {"order_id": order_id})

    def check_payment(self, cfg: rules.Config, store: OrderStore, order: dict) -> bool:
        st = self._get_order(cfg, order["order_id"])
        if not st or st.get("status") != "forwarded":
            self.emit(f"  {order['order_id']}: not paid yet (forwarder get_order: {(st or {}).get('status', 'none')})")
            return False
        settled = str(st.get("forwarded_amount") or st.get("amount"))
        try:
            rules.check_min_price(cfg, order.get("product"), order.get("price_usd"), settled, order["order_id"])
        except rules.Refused as r:
            store.mark(order, "needs_human", f"paid but {r}; refund or fulfil by hand", settled_base=settled)
            self.emit(f"  ATTENTION {order['order_id']}: {r} -> needs_human")
            return False
        store.mark(order, "paid", f"{cfg.net['forwarder']} get_order = forwarded {int(settled) / 1e6:.6f} {TOKENS[cfg.network]}",
                   settled_base=settled, forwarder=cfg.net["forwarder"])
        order["settled_base"] = settled
        store.save(order)
        self.emit(f"  {order['order_id']}: PAID {int(settled) / 1e6:.6f} via {cfg.net['forwarder']} "
                  f"(>= ${cfg.min_price_usd.get(order.get('product') or 'subscription')} floor) -> paid")
        return True

    # -- fulfilment
    def fulfil(self, cfg: rules.Config, store: OrderStore, order: dict) -> Optional[dict]:
        try:
            f = fulfilment(order, self.packs_root)
        except OrderError as e:
            store.mark(order, "needs_human", str(e))
            self.emit(f"  ATTENTION {order['order_id']}: {e} -> needs_human")
            return None
        if f["kind"] == "human":
            store.mark(order, "needs_human", f["why"])
            self.emit(f"  ATTENTION {order['order_id']}: {f['why']} -> needs_human")
            return None
        if f["kind"] == "app":
            store.mark(order, "no_fulfilment", f["why"])
            self.emit(f"  {order['order_id']}: {f['why']}")
            return None
        self.guard(f"fulfilling {order['order_id']}")
        out = self._reports(cfg) / order["order_id"]
        self.emit(f"  {order['order_id']}: {order['product']} -> pack {Path(f['pack']).name}, question "
                  f"{f['question'] or '(the pack title)'}; write-report (paid NEAR AI inference, booked in {rules.ledger(cfg).path.name})")
        runner = self.write_report or subprocess_write_report
        rc = runner(order["order_id"], f["pack"], f["question"], out, self.cfg_path, self.max_usd, self.emit)
        if rc == 0:
            meta = json.loads((out / "meta.json").read_text())
            order["report"] = {"dir": str(out), "sha256": meta["report_sha256"], "claim": meta["claim"],
                               "cost_usd": meta["cost_usd"], "model": meta["model"], "pack": meta["pack"]["dir"],
                               "spend_lines": meta["spend_ledger"]["lines"]}
            store.save(order)
            return meta
        if rc == WRITE_REPORT_FAILED:
            store.mark(order, "needs_human", "write-report exit 6: the narrative failed the number/structure checks twice; "
                                             "inference was paid and booked, no report was written or delivered")
            self.emit(f"  ATTENTION {order['order_id']}: write-report exit 6 -> needs_human (not delivered)")
            return None
        if rc == EXIT_REFUSED:
            raise rules.Refused("write_report", f"write-report refused {order['order_id']} (exit 5; see its REFUSED line); order stays paid")
        order["errors"] = int(order.get("errors") or 0) + 1
        if order["errors"] >= MAX_ERRORS:
            store.mark(order, "needs_human", f"write-report failed {order['errors']} times (exit {rc})")
            self.emit(f"  ATTENTION {order['order_id']}: write-report failed {order['errors']}x -> needs_human")
        else:
            store.save(order)
            self.emit(f"  {order['order_id']}: write-report exit {rc}; retried on the next pass")
        return None

    # -- delivery ("customer inbox")
    def deliver(self, cfg: rules.Config, store: OrderStore, order: dict, meta: dict) -> Path:
        src = Path(order["report"]["dir"])
        report = src / "report.md"
        if sha256_file(report) != meta["report_sha256"]:
            raise OrderError(f"{report} does not match meta.json report_sha256; not delivering")
        pack = Path(meta["pack"]["dir"])
        manifest = json.loads((pack / "manifest.json").read_text())
        dest = self._inbox(cfg) / order["order_id"]
        if (dest / "report.md").exists():
            raise OrderError(f"{dest / 'report.md'} already delivered; never overwritten")
        files: list[tuple[str, Path]] = [("report.md", report), ("meta.json", src / "meta.json"), ("pack/manifest.json", pack / "manifest.json")]
        for q in sorted(meta["pack"]["results"]):
            files += [(f"pack/results/{q}.csv", pack / "results" / f"{q}.csv"), (f"pack/queries/{q}.sql", pack / "queries" / f"{q}.sql")]
        tmp = dest.parent / f".{order['order_id']}.partial"
        if tmp.exists():
            shutil.rmtree(tmp)
        sums = []
        for rel, p in files:
            t = tmp / rel
            t.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, t)
            sums.append((sha256_file(t), rel))
        want = {f"pack/results/{q}.csv": r["result_sha256"] for q, r in meta["pack"]["results"].items()}
        want.update({f"pack/queries/{q}.sql": r["sql_sha256"] for q, r in meta["pack"]["results"].items()})
        want["report.md"] = meta["report_sha256"]
        bad = [rel for h, rel in sums if rel in want and want[rel] != h]
        if bad:
            shutil.rmtree(tmp)
            raise OrderError(f"checksum mismatch in delivery copy: {bad}; not delivering")
        (tmp / "checksums.sha256").write_text("".join(f"{h}  {rel}\n" for h, rel in sums))
        receipt = {"order_id": order["order_id"], "product": order["product"], "customer": order["customer"],
                   "delivered_at": now_iso(), "network": cfg.network, "claim": meta["claim"],
                   "report_sha256": meta["report_sha256"], "pack": meta["pack"]["name"],
                   "pack_manifest_sha256": meta["pack"]["manifest_sha256"], "files": len(sums),
                   "inference_cost_usd": meta["cost_usd"], "model": meta["model"],
                   "dataset": manifest.get("dataset") or meta["pack"].get("dataset")}
        (tmp / "delivery.json").write_text(json.dumps(receipt, indent=2) + "\n")
        tmp.rename(dest)
        store.mark(order, "delivered", f"report.md + {len(sums) - 1} files + checksums.sha256 -> {dest}", inbox=str(dest))
        self.emit(f"  {order['order_id']}: DELIVERED {dest}/report.md (sha256 {meta['report_sha256'][:16]}…), "
                  f"{len(sums)} files checksummed, every pack hash matches manifest.json")
        return dest

    # -- onchain mirror
    def mirror_onchain(self, cfg: rules.Config, store: OrderStore, order: dict) -> dict:
        sl = rules.ledger(cfg)
        lines = [l for l in sl.load() if l["order_id"] == order["order_id"] and l["kind"] == "inference"]
        txs: dict = order.setdefault("onchain", {"record_cost": {}, "anchor": None})
        if self.onchain_mode == "off":
            return txs
        rc_fn = self.record_cost or subprocess_record_cost
        for l in lines:
            if txs["record_cost"].get(str(l["seq"])):
                continue
            if self.onchain_mode == "dry-run":
                args = onchain.call_args(l["kind"], l["usd_micros"], onchain.build_ref(l["order_id"], l["line_hash"], l.get("note", "")))
                self.emit("    " + onchain.dry_run_text(cfg, args).replace("\n", "\n    "))
                continue
            self.guard(f"sending record_cost for {order['order_id']}")
            rc = rc_fn(l["seq"], self.cfg_path, self.emit)
            tx = onchain.sent_tx(cfg, l["line_hash"])
            if rc != 0 or not tx:
                raise fw.Stop(rc or EXIT_ERROR, f"record-cost --from-line {l['seq']} --send exit {rc}")
            txs["record_cost"][str(l["seq"])] = tx
            store.save(order)
            self.emit(f"  record_cost {l['kind']} ${l['usd']} (spend seq {l['seq']} {l['line_hash'][:16]}): {cfg.net['explorer_tx']}{tx}")
        args = onchain.anchor_args(order["order_id"], order["report"]["sha256"])
        if self.onchain_mode == "dry-run":
            self.emit("    " + onchain.dry_run_text(cfg, args, method="anchor_report").replace("\n", "\n    "))
            return txs
        if not txs.get("anchor"):
            tx = onchain.anchored_tx(cfg, args["slug"], args["manifest_sha256"])
            if not tx:
                self.guard(f"anchoring {order['order_id']}")
                tx = (self.anchor or default_anchor)(cfg, args)
                onchain.anchor_journal(cfg, slug=args["slug"], sha256=args["manifest_sha256"], tx=tx, ts=now_iso())
            txs["anchor"] = tx
            self.emit(f"  anchor_report(slug={args['slug']}, sha256={args['manifest_sha256'][:16]}…): {cfg.net['explorer_tx']}{tx}")
        store.mark(order, "done", f"{len(txs['record_cost'])} record_cost + anchor_report onchain", onchain=txs)
        return txs

    # -- one pass
    def run_once(self, only: Optional[str] = None) -> int:
        """Process every open order (or just `only`). Returns an exit code (0 ok, 2 needs a human, 5 refused, 1 error)."""
        try:
            cfg = self.guard("running the order loop")
        except rules.Refused as r:
            self.emit(str(r))
            return EXIT_REFUSED
        store = self._store(cfg)
        orders = [store.load(only)] if only else store.all()
        human = error = False
        for order in orders:
            if order.get("network") != cfg.network:
                self.emit(f"  {order['order_id']}: order is for {order.get('network')}, loop runs on {cfg.network}; skipped")
                continue
            try:
                if order["status"] == "awaiting_payment":
                    self.on_phase("payment")
                    cfg = self.guard(f"checking payment of {order['order_id']}")
                    if not self.check_payment(cfg, store, order):
                        human = human or order["status"] == "needs_human"
                        continue
                if order["status"] == "paid":
                    self.on_phase("fulfil")
                    meta = self.fulfil(cfg, store, order)
                    if meta is None:
                        human = human or order["status"] == "needs_human"
                        continue
                    self.on_phase("deliver")
                    self.deliver(cfg, store, order, meta)
                if order["status"] == "delivered" and self.onchain_mode != "off":
                    self.on_phase("onchain")
                    self.mirror_onchain(cfg, store, order)
            except rules.Refused as r:
                self.emit(str(r))
                return EXIT_REFUSED
            except (OrderError, fw.Stop) as e:
                self.emit(f"  ERROR {order['order_id']}: {e}")
                error = True
        return EXIT_ERROR if error else EXIT_NEEDS_HUMAN if human else EXIT_OK


def default_anchor(cfg: rules.Config, args: dict) -> str:
    near = os.environ.get("NEAR_CLI") or str(ROOT.parent / "rs-payments/.tools/bin/near")
    return onchain.send_anchor(cfg, fw.Rpc(cfg.net["rpc"]), onchain.SplitterSigner(cfg, near), args)
