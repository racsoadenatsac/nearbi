"""Offline tests for the order loop (src/rs_agent/order_loop.py, bin/order-loop) and bin/demo's refusal.
No network: the forwarder view, write-report, record-cost and anchor_report are fakes injected into Loop;
the rules, order store, spend ledger, delivery and checksums are the real code."""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
os.environ.setdefault("RS_AGENT_STATE_DIR", tempfile.mkdtemp(prefix="rs-agent-test-"))

from rs_agent import onchain, order_loop as ol, rules  # noqa: E402

DEMO_YAML = (ROOT / "demo/config.testnet.yaml").read_text()
assert "kill_switch: false" in DEMO_YAML


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def make_pack(d: Path) -> Path:
    (d / "results").mkdir(parents=True)
    (d / "queries").mkdir()
    man = {"dataset": "test", "queries": {}}
    for q, res, sql in (("q1", "a,b\n1,2\n", "-- question: one?\nSELECT 1\n"), ("q2", "c\n3\n", "-- question: two?\nSELECT 2\n")):
        (d / "results" / f"{q}.csv").write_text(res)
        (d / "queries" / f"{q}.sql").write_text(sql)
        man["queries"][q] = {"result_sha256": sha(res.encode()), "sql_sha256": sha(sql.encode()), "rows": 1}
    (d / "manifest.json").write_text(json.dumps(man))
    return d


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="rs-ol-"))
        self.env = {k: os.environ.get(k) for k in ("RS_AGENT_STATE_DIR", "RS_AGENT_SPEND_LEDGER")}
        os.environ["RS_AGENT_STATE_DIR"] = str(self.tmp / "state")
        os.environ.pop("RS_AGENT_SPEND_LEDGER", None)
        self.cfg_path = self.tmp / "demo.yaml"
        self.op_path = self.tmp / "operator.yaml"
        self.cfg_path.write_text(DEMO_YAML)
        self.op_path.write_text((ROOT / "config.yaml").read_text().replace("kill_switch: true", "kill_switch: false"))
        self.packs = self.tmp / "packs"
        make_pack(self.packs / "near-users-vs-bots")
        self.store = ol.OrderStore(self.tmp / "orders")
        self.calls = {"get_order": 0, "write_report": [], "record_cost": [], "anchor": []}
        self.forwarded = {"status": "forwarded", "amount": "29000000", "forwarded_amount": "29000000"}
        self.wr_exit = 0
        self.log = []

    def tearDown(self):
        for k, v in self.env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def set_kill(self, path: Path, on: bool):
        t = path.read_text()
        path.write_text(t.replace("kill_switch: false", "kill_switch: true") if on else t.replace("kill_switch: true", "kill_switch: false"))

    # -- fakes
    def fake_get_order(self, cfg, order_id):
        self.calls["get_order"] += 1
        return self.forwarded

    def fake_write_report(self, order_id, pack, question, out_dir, cfg_path, max_usd, emit):
        self.calls["write_report"].append((order_id, pack, question))
        cfg = rules.current(cfg_path)
        line = rules.ledger(cfg).append(order_id=order_id, kind="inference", usd="0.002", note="fake", source="nearai")
        if self.wr_exit != 0:
            return self.wr_exit
        pack = Path(pack)
        man = json.loads((pack / "manifest.json").read_text())
        report = f"# Report {order_id}\n\n## Claim\n\n**Test claim.**\n".encode()
        out_dir.mkdir(parents=True, exist_ok=True)
        meta = {"report_sha256": sha(report), "claim": "Test claim.", "cost_usd": "0.002000", "model": "m",
                "pack": {"dir": str(pack), "name": pack.name, "manifest_sha256": sha((pack / "manifest.json").read_bytes()),
                         "results": {q: {"result_sha256": v["result_sha256"], "sql_sha256": v["sql_sha256"], "rows": 1}
                                     for q, v in man["queries"].items()}},
                "spend_ledger": {"lines": [line["line_hash"]]}}
        (out_dir / "meta.json").write_text(json.dumps(meta))
        (out_dir / "report.md").write_bytes(report)
        return 0

    def fake_record_cost(self, seq, cfg_path, emit):
        cfg = rules.current(cfg_path)
        line = [l for l in rules.ledger(cfg).load() if l["seq"] == seq][0]
        tx = f"COSTTX{seq}"
        onchain.journal(cfg, line_hash=line["line_hash"], seq=seq, tx=tx, args={})
        self.calls["record_cost"].append(seq)
        return 0

    def fake_anchor(self, cfg, args):
        self.calls["anchor"].append(args)
        return "ANCHORTX"

    def loop(self, **kw):
        base = dict(cfg_path=str(self.cfg_path), kill_switch_configs=(str(self.op_path),), store=self.store,
                    inbox=self.tmp / "inbox", reports=self.tmp / "reports", packs_root=self.packs, emit=self.log.append,
                    get_order=self.fake_get_order, write_report=self.fake_write_report, record_cost=self.fake_record_cost,
                    anchor=self.fake_anchor)
        base.update(kw)
        return ol.Loop(**base)

    def new(self, order_id="qa-1", product="quick_answer", price="29", topic=None):
        return self.store.create(order_id=order_id, network="testnet", product=product, price_usd=price, customer="c.testnet", topic=topic)


class Mapping(Base):
    def test_quick_answer_maps_to_the_cached_pack(self):
        f = ol.fulfilment({"product": "quick_answer"}, self.packs)
        self.assertEqual(f["kind"], "report")
        self.assertEqual(Path(f["pack"]).name, "near-users-vs-bots")
        self.assertIsNone(f["question"])  # the pack's own title
        self.assertEqual(ol.fulfilment({"product": "quick_answer", "topic": "near-users-vs-bots"}, self.packs)["pack"], f["pack"])

    def test_unknown_product_or_topic_and_non_cached_products(self):
        with self.assertRaises(ol.OrderError):
            ol.fulfilment({"product": "mystery"}, self.packs)
        with self.assertRaises(ol.OrderError):
            ol.fulfilment({"product": "quick_answer", "topic": "defi-tvl"}, self.packs)
        self.assertEqual(ol.fulfilment({"product": "deep_dive"}, self.packs)["kind"], "human")
        self.assertEqual(ol.fulfilment({"product": "subscription"}, self.packs)["kind"], "app")

    def test_default_packs_root_is_the_rs_reports_checkout(self):
        self.assertEqual(ol.Loop().packs_root.name, "reports")


class HappyPath(Base):
    def test_paid_order_is_written_delivered_and_mirrored_onchain(self):
        self.new()
        rc = self.loop().run_once()
        self.assertEqual(rc, ol.EXIT_OK, self.log)
        o = self.store.load("qa-1")
        self.assertEqual([h["status"] for h in o["history"]], ["awaiting_payment", "paid", "delivered", "done"])
        self.assertEqual(o["settled_base"], "29000000")
        self.assertEqual(len(self.calls["write_report"]), 1)
        self.assertTrue(self.calls["write_report"][0][1].endswith("near-users-vs-bots"))
        inbox = self.tmp / "inbox" / "qa-1"
        sums = dict(reversed(l.split("  ", 1)) for l in (inbox / "checksums.sha256").read_text().splitlines())
        self.assertEqual(set(sums), {"report.md", "meta.json", "pack/manifest.json", "pack/results/q1.csv", "pack/queries/q1.sql",
                                     "pack/results/q2.csv", "pack/queries/q2.sql"})
        for rel, h in sums.items():
            self.assertEqual(sha((inbox / rel).read_bytes()), h, rel)
        receipt = json.loads((inbox / "delivery.json").read_text())
        self.assertEqual(receipt["report_sha256"], sums["report.md"])
        self.assertEqual(self.calls["record_cost"], [0])
        self.assertEqual(self.calls["anchor"], [{"slug": "qa-1", "manifest_sha256": sums["report.md"]}])
        self.assertEqual(o["onchain"], {"record_cost": {"0": "COSTTX0"}, "anchor": "ANCHORTX"})

    def test_rerun_is_idempotent(self):
        self.new()
        self.loop().run_once()
        self.assertEqual(self.loop().run_once(), ol.EXIT_OK)
        self.assertEqual(len(self.calls["write_report"]), 1)
        self.assertEqual(len(self.calls["anchor"]), 1)

    def test_not_paid_yet_waits(self):
        self.new()
        self.forwarded = None
        self.assertEqual(self.loop().run_once(), ol.EXIT_OK)
        self.assertEqual(self.store.load("qa-1")["status"], "awaiting_payment")
        self.assertEqual(self.calls["write_report"], [])
        self.forwarded = {"status": "in_flight", "amount": "29000000"}
        self.loop().run_once()
        self.assertEqual(self.store.load("qa-1")["status"], "awaiting_payment")

    def test_onchain_dry_run_sends_nothing(self):
        self.new()
        self.assertEqual(self.loop(onchain_mode="dry-run").run_once(), ol.EXIT_OK)
        self.assertEqual(self.calls["record_cost"], [])
        self.assertEqual(self.calls["anchor"], [])
        self.assertEqual(self.store.load("qa-1")["status"], "delivered")
        self.assertTrue(any("DRY RUN onchain anchor_report" in l for l in self.log))


class NeedsHuman(Base):
    def test_write_report_exit_6_is_never_delivered(self):
        self.new()
        self.wr_exit = 6
        self.assertEqual(self.loop().run_once(), ol.EXIT_NEEDS_HUMAN)
        o = self.store.load("qa-1")
        self.assertEqual(o["status"], "needs_human")
        self.assertIn("exit 6", o["history"][-1]["note"])
        self.assertFalse((self.tmp / "inbox" / "qa-1").exists())
        self.assertEqual(self.calls["anchor"], [])
        self.assertEqual(self.calls["record_cost"], [])
        # the paid inference stays booked under the order
        cfg = rules.current(str(self.cfg_path))
        self.assertEqual(rules.ledger(cfg).order_total("qa-1"), 2000)
        # and a later pass never retries it
        self.assertEqual(self.loop().run_once(), ol.EXIT_OK)
        self.assertEqual(len(self.calls["write_report"]), 1)

    def test_payment_below_floor_needs_a_human(self):
        self.new()
        self.forwarded = {"status": "forwarded", "amount": "20000000", "forwarded_amount": "20000000"}
        self.assertEqual(self.loop().run_once(), ol.EXIT_NEEDS_HUMAN)
        o = self.store.load("qa-1")
        self.assertEqual(o["status"], "needs_human")
        self.assertIn("min_price", o["history"][-1]["note"])
        self.assertEqual(self.calls["write_report"], [])

    def test_deep_dive_and_unknown_topic_go_to_a_human(self):
        self.new("dd-1", product="deep_dive", price="499")
        self.new("qa-2", topic="defi-tvl")
        self.assertEqual(self.loop().run_once(), ol.EXIT_NEEDS_HUMAN)
        self.assertEqual(self.store.load("dd-1")["status"], "needs_human")
        self.assertEqual(self.store.load("qa-2")["status"], "needs_human")
        self.assertEqual(self.calls["write_report"], [])

    def test_two_write_report_errors_then_a_human(self):
        self.new()
        self.wr_exit = 1
        self.assertEqual(self.loop().run_once(), ol.EXIT_OK)
        self.assertEqual(self.store.load("qa-1")["status"], "paid")
        self.assertEqual(self.loop().run_once(), ol.EXIT_NEEDS_HUMAN)
        self.assertEqual(self.store.load("qa-1")["status"], "needs_human")

    def test_tampered_report_is_not_delivered(self):
        self.new()
        orig = self.fake_write_report

        def tamper(order_id, pack, question, out_dir, *a):
            rc = orig(order_id, pack, question, out_dir, *a)
            (out_dir / "report.md").write_text("changed after meta.json")
            return rc
        self.assertEqual(self.loop(write_report=tamper).run_once(), ol.EXIT_ERROR)
        self.assertEqual(self.store.load("qa-1")["status"], "paid")
        self.assertFalse((self.tmp / "inbox" / "qa-1").exists())


class KillSwitch(Base):
    def test_loop_config_kill_switch_refuses_before_anything(self):
        self.new()
        self.set_kill(self.cfg_path, True)
        self.assertEqual(self.loop().run_once(), ol.EXIT_REFUSED)
        self.assertEqual(self.calls["get_order"], 0)
        self.assertEqual(self.store.load("qa-1")["status"], "awaiting_payment")
        self.assertTrue(any("REFUSED (kill_switch)" in l for l in self.log))

    def test_operator_kill_switch_also_stops_the_demo_config(self):
        self.new()
        self.set_kill(self.op_path, True)
        self.assertEqual(self.loop().run_once(), ol.EXIT_REFUSED)
        self.assertEqual(self.calls["get_order"], 0)
        self.assertTrue(any("operator kill switch" in l for l in self.log))

    def test_kill_switch_flipped_after_payment_stops_fulfilment(self):
        self.new()

        def get_and_flip(cfg, order_id):
            self.set_kill(self.op_path, True)
            return self.forwarded
        self.assertEqual(self.loop(get_order=get_and_flip).run_once(), ol.EXIT_REFUSED)
        self.assertEqual(self.store.load("qa-1")["status"], "paid")
        self.assertEqual(self.calls["write_report"], [])

    def test_kill_switch_flipped_before_onchain_sends_nothing(self):
        self.new()
        orig = self.fake_write_report

        def write_and_flip(*a):
            rc = orig(*a)
            self.set_kill(self.op_path, True)
            return rc
        self.assertEqual(self.loop(write_report=write_and_flip).run_once(), ol.EXIT_REFUSED)
        self.assertEqual(self.store.load("qa-1")["status"], "delivered")
        self.assertEqual(self.calls["record_cost"], [])
        self.assertEqual(self.calls["anchor"], [])

    def test_write_report_refusal_keeps_the_order_paid(self):
        self.new()
        self.wr_exit = 5
        self.assertEqual(self.loop().run_once(), ol.EXIT_REFUSED)
        self.assertEqual(self.store.load("qa-1")["status"], "paid")


class Cli(Base):
    def run_cli(self, *args, env=None):
        e = dict(os.environ, RS_AGENT_STATE_DIR=str(self.tmp / "state"), **(env or {}))
        e.pop("NEAR_AI_CLOUD_API_KEY", None)
        return subprocess.run([sys.executable, *args], capture_output=True, text=True, env=e, timeout=60)

    def test_demo_refuses_when_the_operator_kill_switch_is_on(self):
        self.set_kill(self.op_path, True)
        p = self.run_cli(str(ROOT / "bin/demo"), "--no-publish", env={"RS_AGENT_CONFIG": str(self.op_path),
                                                                      "RS_AGENT_DEMO_CONFIG": str(self.cfg_path)})
        self.assertEqual(p.returncode, 5, p.stdout + p.stderr)
        self.assertIn("REFUSED (kill_switch)", p.stdout)
        self.assertNotIn("STEP 2/7", p.stdout)
        self.assertFalse((self.tmp / "state" / "orders.testnet").exists())

    def test_demo_refuses_an_invalid_operator_config(self):
        self.op_path.write_text("version: 1\nkill_swich: false\n")
        p = self.run_cli(str(ROOT / "bin/demo"), "--no-publish", env={"RS_AGENT_CONFIG": str(self.op_path),
                                                                      "RS_AGENT_DEMO_CONFIG": str(self.cfg_path)})
        self.assertEqual(p.returncode, 5, p.stdout + p.stderr)
        self.assertIn("REFUSED (config)", p.stdout)

    def test_demo_refuses_a_mainnet_demo_config(self):
        self.cfg_path.write_text(DEMO_YAML.replace("network: testnet", "network: mainnet"))
        p = self.run_cli(str(ROOT / "bin/demo"), "--no-publish", env={"RS_AGENT_CONFIG": str(self.op_path),
                                                                      "RS_AGENT_DEMO_CONFIG": str(self.cfg_path)})
        self.assertEqual(p.returncode, 5, p.stdout + p.stderr)
        self.assertIn("REFUSED (network)", p.stdout)

    def test_order_loop_cli_new_status_and_kill_switch(self):
        orders = str(self.tmp / "cli-orders")
        p = self.run_cli(str(ROOT / "bin/order-loop"), "--config", str(self.cfg_path), "--orders", orders, "new", "--order", "qa-cli",
                         "--product", "quick_answer", "--price", "29", "--customer", "c.testnet")
        self.assertEqual(p.returncode, 0, p.stderr)
        p = self.run_cli(str(ROOT / "bin/order-loop"), "--config", str(self.cfg_path), "--orders", orders, "new", "--order", "qa-low",
                         "--product", "quick_answer", "--price", "9", "--customer", "c.testnet")
        self.assertEqual(p.returncode, 5)
        self.assertIn("REFUSED (min_price)", p.stdout + p.stderr)
        p = self.run_cli(str(ROOT / "bin/order-loop"), "--config", str(self.cfg_path), "--orders", orders, "status")
        self.assertIn("awaiting_payment", p.stdout)
        self.set_kill(self.op_path, True)
        p = self.run_cli(str(ROOT / "bin/order-loop"), "--config", str(self.cfg_path), "--kill-switch-config", str(self.op_path),
                         "--orders", orders, "run")
        self.assertEqual(p.returncode, 5)
        self.assertIn("REFUSED (kill_switch)", p.stdout + p.stderr)


class NearCliEnv(unittest.TestCase):
    def test_proxy_vars_are_dropped_for_near_cli(self):
        old = dict(os.environ)
        try:
            os.environ.update(HTTPS_PROXY="http://u:p@127.0.0.1:1", HTTP_PROXY="http://u:p@127.0.0.1:1")
            os.environ.pop("RS_AGENT_NEAR_CLI_PROXY", None)
            env = onchain.near_cli_env()
            self.assertNotIn("HTTPS_PROXY", env)
            self.assertNotIn("HTTP_PROXY", env)
            os.environ["RS_AGENT_NEAR_CLI_PROXY"] = "1"
            self.assertIn("HTTPS_PROXY", onchain.near_cli_env())
        finally:
            os.environ.clear()
            os.environ.update(old)

    def test_anchor_args_and_verification(self):
        a = onchain.anchor_args("qa-1", "a" * 64)
        with self.assertRaises(ValueError):
            onchain.anchor_args("qa-1", "A" * 64)
        ev = 'EVENT_JSON:' + json.dumps({"standard": "nearbi_splitter", "event": "report_anchor", "data": [{"slug": "qa-1", "manifest_sha256": "a" * 64}]})
        tx = {"status": {"SuccessValue": ""}, "receipts_outcome": [{"outcome": {"executor_id": "s.testnet", "status": {"SuccessValue": ""}, "logs": [ev]}}]}
        self.assertEqual(onchain.verify_anchor_tx(tx, "s.testnet", a), [])
        self.assertTrue(onchain.verify_anchor_tx(tx, "other.testnet", a))
        self.assertTrue(onchain.verify_anchor_tx(tx, "s.testnet", onchain.anchor_args("qa-2", "a" * 64)))


if __name__ == "__main__":
    unittest.main()
