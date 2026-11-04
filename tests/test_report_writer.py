"""Offline tests for bin/write-report (src/rs_agent/report_writer.py). No network: NEAR AI Cloud is a scripted fake
behind the real nearai.Client, so the rules checks and the spend-ledger booking are the real code paths.
Needs the rs-reports checkout next to this repo (or $RS_REPORTS_DIR) for tools/check_numbers.py."""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
os.environ.setdefault("RS_AGENT_STATE_DIR", tempfile.mkdtemp(prefix="rs-agent-test-"))
os.environ.pop("NEAR_AI_CLOUD_API_KEY", None)

from rs_agent import nearai, report_writer as rw, rules, spend  # noqa: E402

BASE_YAML = (ROOT / "config.yaml").read_text().replace("kill_switch: true", "kill_switch: false")
MODEL = rw.DEFAULT_MODEL
ORDER = "demo-report-test"

GOOD = """## Claim

**A handful of signers sends most transactions.** Light users are most signers but little volume.

## Evidence for

1. **90 signers produced 80.7% of transactions** (20,446,122). (q1)
2. **795,727 light signers (93%) sent 8.9% of transactions.** (q1)

## Evidence against

1. **Relayers sign for many users**, so `relay.near` with 7,429,693 transactions may be many people. (q2)

## What would change the conclusion

- Decoding relayed actions to count the end users behind each relayer.
"""
BAD = GOOD.replace("(20,446,122)", "(about 20.4 million, 3x the rest)")


def make_pack(d: Path, tamper: bool = False) -> Path:
    files = {"q1_buckets": ("bucket,signers,tx,pct_signers,pct_tx\nlight,795727,2252049,93.03,8.9\nindustrial,90,20446122,0.01,80.7\n",
                            "-- name: q1_buckets\n-- question: How are signers split by activity?\nSELECT 1 WHERE block_date BETWEEN '2026-09-08' AND '2026-10-07'\n"),
             "q2_top": ("signer_account_id,tx,active_days\nrelay.near,7429693,30\n",
                        "-- name: q2_top\n-- question: Who are the busiest signers?\nSELECT 2 WHERE block_date BETWEEN '2026-09-08' AND '2026-10-07'\n")}
    (d / "results").mkdir(parents=True)
    (d / "queries").mkdir()
    man = {"dataset": "bigquery-public-data.crypto_near_mainnet_us", "queries": {}}
    for q, (res, sql) in files.items():
        (d / "results" / f"{q}.csv").write_text(res)
        (d / "queries" / f"{q}.sql").write_text(sql)
        man["queries"][q] = {"sql_sha256": hashlib.sha256(sql.encode()).hexdigest(), "result_sha256": hashlib.sha256(res.encode()).hexdigest(),
                             "rows": res.count("\n") - 1, "window": ["2026-09-08", "2026-10-07"]}
    (d / "manifest.json").write_text(json.dumps(man))
    (d / "REPORT.md").write_text('---\ntitle: "Real users or bots?"\nparams: [30]\n---\n\n# old prose that must never reach the model\n')
    if tamper:
        (d / "results" / "q2_top.csv").write_text("signer_account_id,tx,active_days\nrelay.near,9999999,30\n")
    return d


class FakeCloud:
    """Scripted NEAR AI Cloud: model list, chat replies from a queue, billing costs."""

    def __init__(self, replies, finish="stop", billed=123_000):
        self.replies, self.finish, self.billed = list(replies), finish, billed
        self.chat_bodies, self.n = [], 0

    def __call__(self, method, url, headers, body, timeout):
        if url.endswith("/model/list?limit=500"):
            return 200, {}, json.dumps({"models": [{"modelId": MODEL, "inputCostPerToken": {"amount": 100, "scale": 9, "currency": "USD"},
                                                    "outputCostPerToken": {"amount": 500, "scale": 9, "currency": "USD"}}]}).encode()
        if url.endswith("/chat/completions"):
            self.n += 1
            self.chat_bodies.append(json.loads(body))
            content = self.replies.pop(0)
            fin = self.finish if not isinstance(content, tuple) else content[1]
            content = content[0] if isinstance(content, tuple) else content
            return 200, {"inference-id": f"inf-{self.n}"}, json.dumps({
                "choices": [{"message": {"role": "assistant", "content": content}, "finish_reason": fin}],
                "usage": {"prompt_tokens": 2000, "completion_tokens": 600, "total_tokens": 2600}}).encode()
        if url.endswith("/billing/costs"):
            rid = json.loads(body)["requestIds"][0]
            return 200, {}, json.dumps({"requests": [{"requestId": rid, "costNanoUsd": self.billed}]}).encode()
        raise AssertionError(url)


def no_http(*a):
    raise AssertionError("no HTTP call expected before the rules pass")


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="rs-rw-"))
        self.cfg = self.dir / "config.yaml"
        self.cfg.write_text(BASE_YAML)
        os.environ["RS_AGENT_SPEND_LEDGER"] = str(self.dir / "spend.jsonl")
        os.environ[nearai.KEY_ENV] = "sentinel-not-a-real-key"
        self.pack = make_pack(self.dir / "pack")
        self.out = self.dir / "out"
        self.logs = []

    def tearDown(self):
        os.environ.pop("RS_AGENT_SPEND_LEDGER", None)
        os.environ.pop(nearai.KEY_ENV, None)

    def ledger(self):
        return spend.SpendLedger("mainnet", self.dir / "spend.jsonl").load()

    def run_writer(self, http, **kw):
        client = nearai.Client(str(self.cfg), http=http, sleep=lambda s: None)
        return rw.write_report(order_id=kw.pop("order_id", ORDER), pack_dir=self.pack, out_dir=self.out, client=client,
                               cfg_path=str(self.cfg), log=self.logs.append, **kw)


# ----------------------------------------------------------------------------------- pack + prompt
class PackAndPrompt(Base):
    def test_pack_loads_and_verifies(self):
        p = rw.load_pack(self.pack)
        self.assertEqual([q["short"] for q in p["queries"]], ["q1", "q2"])
        self.assertEqual(p["title"], "Real users or bots?")
        self.assertEqual(p["params"], ["30"])
        self.assertEqual(p["queries"][0]["question"], "How are signers split by activity?")
        self.assertEqual(p["queries"][0]["data"][0], ["light", 795727, 2252049, 93.03, 8.9])

    def test_tampered_result_is_refused_before_any_call(self):
        tampered = make_pack(self.dir / "tampered", tamper=True)
        with self.assertRaisesRegex(rw.PackError, "result hash"):
            rw.write_report(order_id=ORDER, pack_dir=tampered, out_dir=self.out, client=nearai.Client(str(self.cfg), http=no_http),
                            cfg_path=str(self.cfg), log=self.logs.append)

    def test_prompt_is_structured_data_only(self):
        p = rw.load_pack(self.pack)
        m = rw.build_messages(p, "Q?", ["30"])
        self.assertEqual([x["role"] for x in m], ["system", "user"])
        self.assertIn("Never compute new numbers", m[0]["content"])
        for h in rw.SECTIONS:
            self.assertIn(f"## {h}", m[0]["content"])
        payload = json.loads(m[1]["content"].split("```json\n", 1)[1].rsplit("\n```", 1)[0])
        self.assertEqual(payload["question"], "Q?")
        self.assertEqual(payload["params"], ["30"])
        self.assertEqual(payload["queries"][1], {"id": "q2", "question": "Who are the busiest signers?", "window": ["2026-09-08", "2026-10-07"],
                                                 "columns": ["signer_account_id", "tx", "active_days"], "rows": [["relay.near", 7429693, 30]]})
        self.assertNotIn("old prose", json.dumps(m))  # the pack's existing narrative never reaches the model

    def test_retry_prompt_feeds_back_the_offending_numbers(self):
        m = rw.build_messages(rw.load_pack(self.pack), "Q?", [], previous="draft", problems=["'20.4' does not appear"])
        self.assertEqual([x["role"] for x in m], ["system", "user", "assistant", "user"])
        self.assertEqual(m[2]["content"], "draft")
        self.assertIn("'20.4' does not appear", m[3]["content"])

    def test_parse_sections(self):
        s = rw.parse_sections("```markdown\n# Title\n\n" + GOOD + "```")
        self.assertEqual(list(s), list(rw.SECTIONS))
        self.assertEqual(rw.claim_line(s), "A handful of signers sends most transactions.")
        for bad in (GOOD.replace("## Evidence against", "## Counter-evidence"), GOOD + "\n## Queries\n\nx",
                    GOOD.replace("**A handful", "A handful"), GOOD.replace("- Decoding", "### Sub\n- Decoding")):
            with self.assertRaises(ValueError):
                rw.parse_sections(bad)

    def test_preamble_dropped_and_thousands_grouped(self):
        text, dropped = rw.strip_preamble("Here is the narrative:\n\n" + GOOD)
        self.assertEqual(dropped, "Here is the narrative:")
        s = rw.parse_sections(text.replace("(20,446,122)", "(20446122)"))
        self.assertIn("(20,446,122)", s["Evidence for"])
        self.assertEqual(rw.group_thousands("`acct12345678.near` 2026-10-01 1036408 93.03 12345.6"), "`acct12345678.near` 2026-10-01 1,036,408 93.03 12345.6")

    def test_preamble_costs_no_regeneration(self):
        cloud = FakeCloud(["Sure! Here it is.\n\n" + GOOD])
        meta = self.run_writer(cloud)
        self.assertEqual((cloud.n, meta["attempts"][0]["dropped_preamble"]), (1, "Sure! Here it is."))
        self.assertNotIn("Sure!", (self.out / "report.md").read_text())

    def test_queries_section_comes_from_the_pack(self):
        p = rw.load_pack(self.pack)
        r = rw.render(p, "Q?", ["30"], rw.parse_sections(GOOD), ORDER, MODEL)
        q = r.split("## Queries", 1)[1]
        self.assertIn(p["queries"][1]["result_sha256"], q)
        self.assertIn("`queries/q2_top.sql`", q)
        self.assertEqual([l for l in r.splitlines() if l.startswith("## ")], [f"## {h}" for h in rw.SECTIONS] + ["## Queries"])


# ----------------------------------------------------------------------------------- number check paths
class NumberCheck(Base):
    def test_pass_writes_report_and_books_cost_under_the_order(self):
        cloud = FakeCloud([GOOD])
        meta = self.run_writer(cloud)
        report = (self.out / "report.md").read_text()
        self.assertIn("**A handful of signers sends most transactions.**", report)
        self.assertEqual(cloud.n, 1)
        lines = self.ledger()
        self.assertEqual([(l["order_id"], l["kind"], l["usd"], l["meta"]["cost_source"]) for l in lines],
                         [(ORDER, "inference", "0.000123", "billing")])
        disk = json.loads((self.out / "meta.json").read_text())
        self.assertEqual(disk, meta)
        self.assertEqual(meta["spend_ledger"]["lines"], [lines[0]["line_hash"]])
        self.assertEqual(meta["cost_usd"], "0.000123")
        self.assertEqual(meta["usage"], {"prompt_tokens": 2000, "completion_tokens": 600, "total_tokens": 2600})
        self.assertEqual(meta["number_check"]["untraced"], 0)
        self.assertGreater(meta["number_check"]["numbers_checked"], 5)
        self.assertEqual(meta["pack"]["results"]["q2_top"]["result_sha256"], rw.sha256_file(self.pack / "results/q2_top.csv"))
        self.assertEqual(meta["report_sha256"], hashlib.sha256(report.encode()).hexdigest())
        self.assertEqual(meta["attempts"][0]["inference_id"], "inf-1")
        self.assertEqual(cloud.chat_bodies[0]["model"], MODEL)

    def test_rounded_cells_pass(self):
        self.assertIn("(93%)", GOOD)  # 93.03 rounded
        self.run_writer(FakeCloud([GOOD]))
        self.assertTrue((self.out / "report.md").exists())

    def test_fail_then_regenerate_with_feedback(self):
        cloud = FakeCloud([BAD, GOOD])
        meta = self.run_writer(cloud)
        self.assertEqual(cloud.n, 2)
        retry = cloud.chat_bodies[1]["messages"]
        self.assertEqual(retry[2], {"role": "assistant", "content": BAD})
        self.assertIn("'20.4'", retry[3]["content"])
        self.assertIn("'3x'", retry[3]["content"])
        self.assertEqual([a["outcome"] for a in meta["attempts"]], ["untraced_numbers", "ok"])
        self.assertEqual(meta["attempts"][0]["untraced"], ["20.4", "3x"])
        self.assertEqual(len(self.ledger()), 2)
        self.assertEqual(meta["cost_usd"], "0.000246")
        self.assertEqual(meta["spend_ledger"]["lines"], [l["line_hash"] for l in self.ledger()])

    def test_fail_twice_fails_loudly_and_writes_nothing(self):
        cloud = FakeCloud([BAD, BAD])
        with self.assertRaises(rw.ReportFailed) as cm:
            self.run_writer(cloud)
        self.assertEqual(cloud.n, 2)  # at most one regeneration
        self.assertEqual([a["outcome"] for a in cm.exception.attempts], ["untraced_numbers", "untraced_numbers"])
        self.assertFalse((self.out / "report.md").exists())
        self.assertFalse((self.out / "meta.json").exists())
        self.assertEqual([l["order_id"] for l in self.ledger()], [ORDER, ORDER])  # both paid calls still booked

    def test_bad_structure_regenerates(self):
        cloud = FakeCloud([GOOD.replace("## Evidence against", "## Caveats"), GOOD])
        meta = self.run_writer(cloud)
        self.assertEqual([a["outcome"] for a in meta["attempts"]], ["bad_structure", "ok"])
        self.assertIn("structure:", cloud.chat_bodies[1]["messages"][3]["content"])


# ----------------------------------------------------------------------------------- empty completions
class Empty(Base):
    def test_empty_then_ok(self):
        cloud = FakeCloud([("", "length"), GOOD])
        meta = self.run_writer(cloud)
        self.assertEqual([a["outcome"] for a in meta["attempts"]], ["empty", "ok"])
        self.assertEqual(len(self.ledger()), 2)  # the empty reply was paid and booked

    def test_truncated_twice_fails(self):
        cloud = FakeCloud([(GOOD[:80], "length"), ("", "stop")])
        with self.assertRaises(rw.ReportFailed):
            self.run_writer(cloud)
        self.assertFalse((self.out / "report.md").exists())
        self.assertTrue(all(l["meta"]["truncated"] or l["meta"]["empty"] for l in self.ledger()))


# ----------------------------------------------------------------------------------- rules refusals (nothing paid)
class Refusals(Base):
    def test_kill_switch_refuses_before_any_http(self):
        self.cfg.write_text(BASE_YAML.replace("kill_switch: false", "kill_switch: true"))
        with self.assertRaises(rules.Refused) as cm:
            self.run_writer(no_http)
        self.assertEqual(cm.exception.rule, "kill_switch")
        self.assertEqual(self.ledger(), [])

    def test_per_report_cap(self):
        spend.SpendLedger("mainnet", self.dir / "spend.jsonl").append(order_id=ORDER, kind="bigquery", usd="9.999", note="earlier queries")
        cloud = FakeCloud([GOOD])
        with self.assertRaises(rules.Refused) as cm:
            self.run_writer(cloud)
        self.assertEqual(cm.exception.rule, "report_cap")
        self.assertEqual(cloud.n, 0)
        self.assertEqual(len(self.ledger()), 1)

    def test_daily_cap(self):
        spend.SpendLedger("mainnet", self.dir / "spend.jsonl").append(order_id="other-order", kind="inference", usd="49.999")
        cloud = FakeCloud([GOOD])
        with self.assertRaises(rules.Refused) as cm:
            self.run_writer(cloud)
        self.assertEqual(cm.exception.rule, "daily_cap")
        self.assertEqual(cloud.n, 0)

    def test_run_ceiling(self):
        cloud = FakeCloud([GOOD])
        with self.assertRaises(rules.Refused) as cm:
            self.run_writer(cloud, max_usd=Decimal("0.001"))
        self.assertEqual(cm.exception.rule, "report_writer_max_usd")
        self.assertEqual(cloud.n, 0)

    def test_existing_report_is_never_overwritten(self):
        self.out.mkdir()
        (self.out / "report.md").write_text("delivered")
        with self.assertRaisesRegex(rw.PackError, "already exists"):
            self.run_writer(no_http)
        self.assertEqual((self.out / "report.md").read_text(), "delivered")

    def test_unconfigured_key_spends_nothing(self):
        os.environ.pop(nearai.KEY_ENV)
        cloud = FakeCloud([GOOD])
        with self.assertRaises(nearai.NotConfigured):
            self.run_writer(cloud)
        self.assertEqual((cloud.n, self.ledger()), (0, []))

    def test_cli_exit_codes(self):
        self.cfg.write_text(BASE_YAML.replace("kill_switch: false", "kill_switch: true"))
        env = {**os.environ, "RS_AGENT_STATE_DIR": str(self.dir / "state")}
        env.pop(nearai.KEY_ENV, None)
        r = subprocess.run([sys.executable, str(ROOT / "bin/write-report"), "--order", ORDER, "--pack", str(self.pack),
                            "--config", str(self.cfg), "--out", str(self.out)], capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 5, r.stderr)
        self.assertIn("REFUSED (kill_switch)", r.stderr)
        r = subprocess.run([sys.executable, str(ROOT / "bin/write-report"), "--order", ORDER, "--pack", str(self.dir / "nope"),
                            "--config", str(self.cfg)], capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 1)
        self.assertIn("no manifest.json", r.stderr)


class RealPack(unittest.TestCase):
    def test_published_pack_template_is_clean(self):
        pack = rw.rs_reports_dir() / "reports" / "near-users-vs-bots"
        if not pack.exists():
            self.skipTest("rs-reports checkout not found")
        p = rw.load_pack(pack)
        self.assertEqual(len(p["queries"]), 4)
        self.assertEqual(rw.load_checker().check_text(rw.render(p, p["title"], p["params"], None, ORDER, MODEL), pack, rounding=True)[1], [])


if __name__ == "__main__":
    unittest.main()
