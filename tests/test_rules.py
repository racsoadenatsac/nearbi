"""Offline tests for the operator rules (config.yaml), the spend ledger, record-cost and the NEAR AI client.
No network, no Keychain. Run: python3 -m unittest discover -s tests"""
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

from rs_agent import forwarder as fw  # noqa: E402
from rs_agent import miniyaml, nearai, onchain, rules, spend  # noqa: E402

BASE_YAML = (ROOT / "config.yaml").read_text().replace("kill_switch: true", "kill_switch: false")
ONCHAIN_OK = {"version": "0.1.0", "owner": "nearbi.near", "treasury": "nearbi.near", "contributors": "contributors.nearbi.near",
              "split_bps_contributors": 1000, "split_bps_treasury": 9000, "accepted_tokens": [fw.USDC], "paused": False}
PID = "0b6f3c1e-1f2a-4c3d-9e8f-a1b2c3d4e5f6"


def edit(text=BASE_YAML, **repl):
    for old, new in repl.items():
        old = old.replace("__", " ")
        assert old in text, old
        text = text.replace(old, new)
    return text


def cfg_of(text=BASE_YAML):
    return rules.parse(text, "test-config.yaml")


class TempState(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="rs-rules-"))
        self.cfg_file = self.dir / "config.yaml"
        self.write_cfg(BASE_YAML)
        self.sl = spend.SpendLedger("mainnet", self.dir / "spend.jsonl")

    def write_cfg(self, text):
        self.cfg_file.write_text(text)


# ----------------------------------------------------------------------------------- config file
class ConfigFile(unittest.TestCase):
    def test_committed_config_is_valid_and_matches_the_brief(self):
        c = rules.load(ROOT / "config.yaml")
        self.assertEqual(c.network, "mainnet")
        self.assertEqual(c.max_inference_usd_per_day, Decimal(50))
        self.assertEqual(c.min_price_usd["quick_answer"], Decimal(29))
        self.assertEqual(c.min_price_usd["deep_dive"], Decimal(499))
        self.assertEqual((c.contributors_bps, c.treasury_bps), (1000, 9000))
        self.assertEqual((c.contributors_account, c.treasury_account), ("contributors.nearbi.near", "nearbi.near"))

    def test_schema_file_is_generated_from_the_code(self):
        self.assertEqual((ROOT / "config.schema.json").read_text(), rules.schema_json())

    def test_every_field_has_an_operator_comment(self):
        lines = (ROOT / "config.yaml").read_text().splitlines()
        for i, l in enumerate(lines):
            if l and not l.startswith("#") and not l.startswith(" ") and ":" in l:
                commented = "#" in l or (i > 0 and lines[i - 1].startswith("#"))
                self.assertTrue(commented, f"top-level key without a comment: {l}")

    def test_typo_key_is_an_error_not_ignored(self):
        with self.assertRaisesRegex(rules.ConfigError, "kill_swich: unknown key"):
            cfg_of(edit(**{"kill_switch: false": "kill_swich: true"}))

    def test_split_must_sum_to_100_and_respect_the_contract_cap(self):
        with self.assertRaisesRegex(rules.ConfigError, "must be 100"):
            cfg_of(edit(**{"treasury_pct: 90": "treasury_pct: 80"}))
        with self.assertRaisesRegex(rules.ConfigError, "contributors_pct: must be <= 50"):
            cfg_of(edit(**{"contributors_pct: 10": "contributors_pct: 60", "treasury_pct: 90": "treasury_pct: 40"}))
        c = cfg_of(edit(**{"contributors_pct: 10": "contributors_pct: 12.5", "treasury_pct: 90": "treasury_pct: 87.5"}))
        self.assertEqual((c.contributors_bps, c.treasury_bps), (1250, 8750))

    def test_bad_values(self):
        for repl, msg in [({"network: mainnet": "network: devnet"}, "network: must be one of"),
                          ({"kill_switch: false": "kill_switch: yes"}, "ambiguous boolean"),
                          ({"max_inference_usd_per_day: 50": "max_inference_usd_per_day: -1"}, "must be >= 0"),
                          ({"max_inference_usd_per_day: 50": "max_inference_usd_per_day: 0.0000001"}, "at most 6 decimal"),
                          ({"quick_answer: 29": "quick_answer: 0"}, "must be > 0"),
                          ({"treasury: nearbi.near": "treasury: Nearbi.NEAR"}, "not a valid NEAR account id"),
                          ({"per_report_cost_cap_usd: 10": "per_report_cost_cap_usd: 80"}, "larger than max_inference"),
                          ({"version: 1\n": ""}, "missing required key 'version'")]:
            with self.subTest(msg=msg), self.assertRaisesRegex(rules.ConfigError, msg):
                cfg_of(edit(**repl))

    def test_missing_or_broken_file_fails_closed(self):
        with self.assertRaises(rules.Refused) as e:
            rules.current(Path(tempfile.mkdtemp()) / "nope.yaml")
        self.assertEqual(e.exception.rule, "config")
        self.assertIn("kill_switch: true", str(e.exception))

    def test_miniyaml_rejects_ambiguous_yaml(self):
        for bad in ["a: [1, 2]", "- a", "a: &x 1", "a: 1\na: 2", "a:\n\tb: 1", "a: 1\n  b: 2", "a: 1e3", "a: 'x", "---\na: 1\n---\nb: 2"]:
            with self.subTest(bad=bad), self.assertRaises(miniyaml.ParseError):
                miniyaml.loads(bad)
        self.assertEqual(miniyaml.loads("a:\n  b: 0.5 # c\nc: \"#not a comment\"\nd: it's"),
                         {"a": {"b": Decimal("0.5")}, "c": "#not a comment", "d": "it's"})


# ----------------------------------------------------------------------------------- kill switch
class KillSwitch(TempState):
    def test_require_active(self):
        rules.require_active(cfg_of(), "x")
        with self.assertRaises(rules.Refused) as e:
            rules.require_active(cfg_of(edit(**{"kill_switch: false": "kill_switch: true"})), "forwarding")
        self.assertEqual(e.exception.rule, "kill_switch")

    def test_no_job_starts(self):
        c = cfg_of(edit(**{"kill_switch: false": "kill_switch: true"}))
        with self.assertRaises(rules.Refused) as e:
            rules.check_job(c, PID, "bigquery", "0.01", self.sl)
        self.assertEqual(e.exception.rule, "kill_switch")

    def test_forwarder_refuses_before_preflight_and_never_signs(self):
        self.write_cfg(edit(**{"kill_switch: false": "kill_switch: true"}))
        signer = FwSigner()
        r = fw.Runner(Boom(), Boom(), Boom(), signer, config_path=str(self.cfg_file))
        with self.assertRaises(fw.Stop) as e:
            r.run_once()
        self.assertEqual(e.exception.code, fw.EXIT_REFUSED)
        self.assertIn("REFUSED (kill_switch)", str(e.exception))
        self.assertEqual(signer.calls, [])
        refused = [json.loads(l) for l in r.journal.read_text().splitlines() if '"refused"' in l]
        self.assertEqual(refused[-1]["rule"], "kill_switch")

    def test_flip_between_check_and_signing_is_caught(self):
        """The operator flips the switch while an order is being checked: the last gate before signing stops it."""
        signer = FwSigner()
        rpc = FwRpc()
        cfg_file = self.cfg_file

        class FlippingOneClick:
            def status(self, addr, memo=None):
                cfg_file.write_text(edit(**{"kill_switch: false": "kill_switch: true"}))
                return fw_status()

        r = fw.Runner(rpc, FwDb(fw_pay()), FlippingOneClick(), signer, config_path=str(self.cfg_file))
        with self.assertRaises(fw.Stop) as e:
            r.process(fw_entry())
        self.assertEqual(e.exception.code, fw.EXIT_REFUSED)
        self.assertEqual(signer.calls, [])

    def test_forwarder_is_mainnet_only(self):
        self.write_cfg(edit(**{"network: mainnet": "network: testnet"}))
        r = fw.Runner(Boom(), Boom(), Boom(), FwSigner(), config_path=str(self.cfg_file))
        with self.assertRaisesRegex(fw.Stop, r"REFUSED \(network\)"):
            r.run_once()

    def test_record_cost_books_but_refuses_send(self):
        self.write_cfg(edit(**{"kill_switch: false": "kill_switch: true"}))
        env = {**os.environ, "RS_AGENT_STATE_DIR": str(self.dir), "RS_AGENT_SPEND_LEDGER": str(self.dir / "spend.jsonl"),
               "NEAR_CLI": "/usr/bin/false"}
        p = subprocess.run([sys.executable, "-I", str(ROOT / "bin/record-cost"), "--config", str(self.cfg_file), "--order", PID,
                            "--usd", "0.25", "--kind", "bigquery", "--send"], capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(p.returncode, fw.EXIT_REFUSED, p.stdout + p.stderr)
        self.assertIn("REFUSED (kill_switch)", p.stdout)
        self.assertIn("DRY RUN onchain record_cost", p.stdout)
        self.assertEqual([l["usd_micros"] for l in self.sl.load()], [250000])

    def test_nearai_refuses_without_any_http(self):
        self.write_cfg(edit(**{"kill_switch: false": "kill_switch: true"}))
        c = nearai.Client(str(self.cfg_file), http=no_http)
        with self.assertRaises(rules.Refused) as e:
            c.chat(PID, [{"role": "user", "content": "hi"}])
        self.assertEqual(e.exception.rule, "kill_switch")


# ----------------------------------------------------------------------------------- spend caps
class SpendCaps(TempState):
    def test_daily_cap(self):
        c = cfg_of()
        self.sl.append(order_id="a", kind="inference", usd="30", now=1793750400)  # 2026-11-04
        self.sl.append(order_id="b", kind="bigquery", usd="15.5", now=1793750500)
        b = rules.check_job(c, "c", "inference", "4.5", self.sl, day="2026-11-04")  # exactly at the cap: allowed
        self.assertEqual(b["today_micros"], 45_500_000)
        with self.assertRaises(rules.Refused) as e:
            rules.check_job(c, "c", "inference", "4.500001", self.sl, day="2026-11-04")
        self.assertEqual(e.exception.rule, "daily_cap")
        self.assertIn("$4.500000 of today's $50 cap is left", str(e.exception))

    def test_bigquery_counts_against_the_daily_cap_and_the_day_resets_at_utc_midnight(self):
        c = cfg_of()
        self.sl.append(order_id="a", kind="bigquery", usd="49.99", now=1793750399)  # 2026-11-03 23:59:59 UTC
        rules.check_job(c, "z", "inference", "5", self.sl, day="2026-11-04")
        with self.assertRaises(rules.Refused):
            rules.check_job(c, "z", "inference", "0.02", self.sl, day="2026-11-03")

    def test_per_report_cap(self):
        c = cfg_of()
        self.sl.append(order_id=PID, kind="bigquery", usd="6", now=1793750400)
        self.sl.append(order_id=PID, kind="inference", usd="3.5", now=1793750401)
        rules.check_job(c, PID, "inference", "0.5", self.sl, day="2026-11-04")
        with self.assertRaises(rules.Refused) as e:
            rules.check_job(c, PID, "inference", "0.51", self.sl, day="2026-11-04")
        self.assertEqual(e.exception.rule, "report_cap")
        rules.check_job(c, "other-order", "inference", "5", self.sl, day="2026-11-04")

    def test_zero_cap_refuses_everything(self):
        c = cfg_of(edit(**{"max_inference_usd_per_day: 50": "max_inference_usd_per_day: 0", "per_report_cost_cap_usd: 10": "per_report_cost_cap_usd: 0"}))
        with self.assertRaises(rules.Refused):
            rules.check_job(c, "x", "inference", "0.000001", self.sl)

    def test_corrupt_ledger_refuses(self):
        self.sl.append(order_id="a", kind="inference", usd="1")
        self.sl.append(order_id="a", kind="inference", usd="2")
        text = self.sl.path.read_text().replace('"usd_micros":1000000', '"usd_micros":1')
        self.sl.path.write_text(text)
        with self.assertRaises(rules.Refused) as e:
            rules.check_job(cfg_of(), "b", "inference", "0.01", self.sl)
        self.assertEqual(e.exception.rule, "spend_ledger")

    def test_nearai_over_cap_makes_no_call(self):
        self.write_cfg(edit(**{"max_inference_usd_per_day: 50": "max_inference_usd_per_day: 0.01", "per_report_cost_cap_usd: 10": "per_report_cost_cap_usd: 0.01"}))
        http = FakeNearAI()
        os.environ[nearai.KEY_ENV] = "sentinel-not-a-real-key"
        try:
            c = nearai.Client(str(self.cfg_file), http=http, sleep=lambda s: None)
            with self.assertRaises(rules.Refused) as e:
                c.chat(PID, [{"role": "user", "content": "x" * 3000}], max_tokens=4000)
        finally:
            os.environ.pop(nearai.KEY_ENV)
        self.assertEqual(e.exception.rule, "daily_cap")
        self.assertNotIn("/chat/completions", [u for _, u in http.calls][-1])


# ----------------------------------------------------------------------------------- min price
class MinPrice(TempState):
    def test_rules(self):
        c = cfg_of()
        rules.check_min_price(c, "quick_answer", 29, "28420000")  # 2% slippage floor = 28.42
        rules.check_min_price(c, "deep_dive", 600)
        rules.check_min_price(c, None, 49, "49000000")  # pre-products payment = subscription
        cases = [("quick_answer", 28.99, None, "below the minimum $29"),
                 ("quick_answer", 29, "28419999", "settled 28.419999 USDC"),
                 ("deep_dive", 100, None, "below the minimum $499"),
                 ("custom", 5000, None, "has no min_price_usd"),
                 ("quick_answer", None, None, "no quoted price"),
                 (None, 1, "1000000", "subscription priced $1")]
        for product, price, settled, msg in cases:
            with self.subTest(product=product, price=price), self.assertRaises(rules.Refused) as e:
                rules.check_min_price(c, product, price, settled)
            self.assertEqual(e.exception.rule, "min_price")
            self.assertIn(msg, str(e.exception))

    def test_forwarder_skips_order_below_min_price_and_never_signs(self):
        signer = FwSigner()
        r = fw.Runner(FwRpc(), FwDb(fw_pay(product="quick_answer", amountUsd=5)), FwOneClick(), signer, config_path=str(self.cfg_file))
        with self.assertRaises(fw.Skip) as e:
            r.process(fw_entry())
        self.assertTrue(e.exception.attention)
        self.assertIn("REFUSED (min_price)", str(e.exception))
        self.assertEqual(signer.calls, [])

    def test_forwarder_forwards_an_order_at_the_minimum(self):
        signer = FwSigner()
        rpc = FwRpc()
        r = fw.Runner(rpc, FwDb(fw_pay(product="quick_answer", amountUsd=29)), FwOneClick(), signer, config_path=str(self.cfg_file), dry_run=True)
        self.assertEqual(r.process(fw_entry()), "dry-run")


# ----------------------------------------------------------------------------------- split check
class SplitCheck(TempState):
    def test_match(self):
        rules.check_split(cfg_of(), dict(ONCHAIN_OK))

    def test_mismatches_alert(self):
        for over, needle in [({"split_bps_contributors": 500, "split_bps_treasury": 9500}, "split_bps_contributors: config.yaml 1000 != onchain 500"),
                             ({"contributors": "evil.near"}, "contributors: config.yaml 'contributors.nearbi.near' != onchain 'evil.near'"),
                             ({"treasury": "other.near"}, "treasury:"),
                             ({"paused": True}, "paused onchain")]:
            with self.subTest(over=over), self.assertRaises(rules.Refused) as e:
                rules.check_split(cfg_of(), {**ONCHAIN_OK, **over})
            self.assertEqual(e.exception.rule, "split_mismatch")
            self.assertIn("ALERT:", str(e.exception))
            self.assertIn(needle, str(e.exception))

    def test_config_change_without_contract_change_is_a_mismatch(self):
        c = cfg_of(edit(**{"contributors_pct: 10": "contributors_pct: 20", "treasury_pct: 90": "treasury_pct: 80"}))
        with self.assertRaisesRegex(rules.Refused, "2000 != onchain 1000"):
            rules.check_split(c, dict(ONCHAIN_OK))

    def test_unreadable_onchain_config_fails_closed(self):
        class DeadRpc:
            def view(self, *a):
                raise RuntimeError("rpc unreachable")
        with self.assertRaisesRegex(rules.Refused, "could not read splitter.nearbi.near.get_config"):
            rules.fetch_split(cfg_of(), DeadRpc())

    def test_forwarder_preflight_stops_with_alert(self):
        rpc = FwRpc(splitter={**ONCHAIN_OK, "split_bps_contributors": 0, "split_bps_treasury": 10000})
        r = fw.Runner(rpc, FwDb(fw_pay()), FwOneClick(), FwSigner(), config_path=str(self.cfg_file))
        with self.assertRaises(fw.Stop) as e:
            r.preflight()
        self.assertEqual(e.exception.code, fw.EXIT_REFUSED)
        self.assertIn("ALERT:", str(e.exception))


# ----------------------------------------------------------------------------------- spend ledger
class SpendLedgerChain(TempState):
    def test_chain_is_the_rs_ledger_algorithm(self):
        a = self.sl.append(order_id="o1", kind="inference", usd="0.0125", note="n", meta={"m": 1})
        b = self.sl.append(order_id="o1", kind="bigquery", usd="1")
        body = {k: v for k, v in a.items() if k not in ("prev_hash", "line_hash")}
        canon = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        self.assertEqual(a["prev_hash"], "0" * 64)
        self.assertEqual(a["line_hash"], hashlib.sha256(canon.encode() + a["prev_hash"].encode()).hexdigest())
        self.assertEqual(b["prev_hash"], a["line_hash"])
        self.assertEqual([l["seq"] for l in self.sl.load()], [0, 1])
        rs_ledger = ROOT.parent / "rs-ledger/src/verify_ledger.py"
        if rs_ledger.exists():  # cross-check with rs-ledger's own verifier when the sibling repo is checked out
            import importlib.util
            spec = importlib.util.spec_from_file_location("verify_ledger", rs_ledger)
            v = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(v)
            self.assertEqual(v.line_hash(body, "0" * 64), a["line_hash"])

    def test_tamper_truncate_and_delete_are_detected(self):
        for i in range(3):
            self.sl.append(order_id="o", kind="inference", usd="1")
        lines = self.sl.path.read_text().splitlines()
        for broken in (lines[:1] + lines[2:], [lines[0], lines[1].replace('"note":""', '"note":"x"'), lines[2]], ["{not json"]):
            self.sl.path.write_text("\n".join(broken) + "\n")
            with self.assertRaises(spend.LedgerCorrupt):
                self.sl.load()

    def test_amounts(self):
        self.assertEqual(spend.usd_to_micros("0.0000001"), 1)  # rounds up
        self.assertEqual(spend.usd_to_micros("12.5"), 12_500_000)
        for bad in ("-1", "abc", "NaN", 0.1):
            with self.assertRaises(ValueError):
                spend.usd_to_micros(bad)
        with self.assertRaises(ValueError):
            self.sl.append(order_id="o", kind="gpu", usd="1")
        with self.assertRaises(ValueError):
            self.sl.append(order_id="bad id with spaces", kind="inference", usd="1")


# ----------------------------------------------------------------------------------- record_cost call
class RecordCostCall(unittest.TestCase):
    def test_args_and_ref(self):
        ref = onchain.build_ref(PID, "ab" * 32, "x" * 400)
        self.assertTrue(ref.startswith(f"order:{PID} spend:abababababababab "))
        self.assertLessEqual(len(ref.encode()), 256)
        self.assertEqual(onchain.call_args("bigquery", 420000, ref), {"kind": "bigquery", "amount_usd_micros": "420000", "ref": ref})

    def test_dry_run_names_network_key_source_and_does_not_send(self):
        text = onchain.dry_run_text(cfg_of(), onchain.call_args("inference", 1, "r"))
        self.assertIn("REAL MONEY", text)
        self.assertIn("Keychain nearbi-mainnet-fc-splitter.nearbi.near", text)
        self.assertIn("not sent", text)

    def test_verify_cost_tx(self):
        args = onchain.call_args("inference", 12500, "r1")
        log = "EVENT_JSON:" + json.dumps({"standard": "nearbi_splitter", "version": "1.0.0", "event": "cost", "data": [
            {"kind": "inference", "amount_usd_micros": "12500", "ref": "r1"}]})
        good = {"status": {"SuccessValue": ""}, "receipts_outcome": [{"outcome": {"executor_id": "splitter.nearbi.near", "status": {"SuccessValue": ""}, "logs": [log]}}]}
        self.assertEqual(onchain.verify_cost_tx(good, "splitter.nearbi.near", args), [])
        self.assertTrue(onchain.verify_cost_tx(good, "splitter.nearbi.near", {**args, "ref": "other"}))


# ----------------------------------------------------------------------------------- NEAR AI client
class NearAIClient(TempState):
    def setUp(self):
        super().setUp()
        os.environ["RS_AGENT_SPEND_LEDGER"] = str(self.dir / "spend.jsonl")
        os.environ[nearai.KEY_ENV] = "sentinel-not-a-real-key"

    def tearDown(self):
        os.environ.pop("RS_AGENT_SPEND_LEDGER", None)
        os.environ.pop(nearai.KEY_ENV, None)

    def test_books_the_billed_cost(self):
        http = FakeNearAI(billed=1_234_567)
        r = nearai.Client(str(self.cfg_file), http=http, sleep=lambda s: None).chat(PID, [{"role": "user", "content": "hello"}], max_tokens=100)
        self.assertEqual(r["choices"][0]["message"]["content"], "hi")
        (line,) = self.sl.load()
        self.assertEqual((line["kind"], line["usd_micros"], line["meta"]["cost_source"], line["order_id"]), ("inference", 1235, "billing", PID))
        sent = [h for (m, u), h in zip(http.calls, http.headers) if u.endswith("/chat/completions")][0]
        self.assertEqual(sent["authorization"], "Bearer sentinel-not-a-real-key")
        self.assertNotIn("sentinel-not-a-real-key", self.sl.path.read_text())

    def test_falls_back_to_list_price(self):
        http = FakeNearAI(billed=0)
        nearai.Client(str(self.cfg_file), http=http, sleep=lambda s: None).chat(PID, [{"role": "user", "content": "hello"}], max_tokens=100)
        (line,) = self.sl.load()
        # 11 prompt x 1000 nano + 70 completion x 3000 nano = 221000 nano = $0.000221
        self.assertEqual((line["usd_micros"], line["meta"]["cost_source"]), (221, "list_price"))

    def test_timeout_is_booked_at_the_estimate(self):
        http = FakeNearAI(timeout=True)
        c = nearai.Client(str(self.cfg_file), http=http, sleep=lambda s: None)
        with self.assertRaises(nearai.InferenceError):
            c.chat(PID, [{"role": "user", "content": "hello"}], max_tokens=100)
        (line,) = self.sl.load()
        self.assertEqual(line["meta"]["cost_source"], "estimate")
        self.assertEqual(line["usd_micros"], spend.usd_to_micros(c.estimate_usd(nearai.DEFAULT_MODEL, [{"role": "user", "content": "hello"}], 100)))

    def test_unconfigured_spends_nothing(self):
        os.environ.pop(nearai.KEY_ENV)
        http = FakeNearAI()
        with self.assertRaisesRegex(nearai.NotConfigured, "protected secret NEAR_AI_CLOUD_API_KEY"):
            nearai.Client(str(self.cfg_file), http=http).chat(PID, [{"role": "user", "content": "x"}])
        self.assertEqual(http.calls, [])
        self.assertEqual(self.sl.load(), [])

    def test_ok_completion_is_not_flagged(self):
        r = nearai.Client(str(self.cfg_file), http=FakeNearAI(billed=1000), sleep=lambda s: None).chat(PID, [{"role": "user", "content": "hello"}], max_tokens=100)
        self.assertEqual(nearai.text_of(r), "hi")
        self.assertEqual((r["_rs_result"]["truncated"], r["_rs_result"]["empty"]), (False, False))

    def test_empty_reasoning_only_completion_is_flagged_booked_and_cannot_ship(self):
        import contextlib, io
        http = FakeNearAI(billed=22_000, content="", finish_reason="length", reasoning_tokens=70)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            r = nearai.Client(str(self.cfg_file), http=http, sleep=lambda s: None).chat(PID, [{"role": "user", "content": "hello"}], max_tokens=70)
        self.assertEqual(r["_rs_result"], {"text": "", "finish_reason": "length", "truncated": True, "empty": True, "reasoning_tokens": 70})
        self.assertIn("EMPTY completion", err.getvalue())
        self.assertNotIn("sentinel-not-a-real-key", err.getvalue())
        (line,) = self.sl.load()  # still paid, still booked
        self.assertEqual((line["usd_micros"], line["meta"]["empty"], line["meta"]["truncated"], line["meta"]["reasoning_tokens"]), (22, True, True, 70))
        with self.assertRaisesRegex(nearai.EmptyCompletion, "empty completion"):
            nearai.text_of(r)

    def test_truncated_text_is_flagged(self):
        import contextlib, io
        with contextlib.redirect_stderr(io.StringIO()) as err:
            r = nearai.Client(str(self.cfg_file), http=FakeNearAI(content="Hello, NEAR is", finish_reason="length"), sleep=lambda s: None).chat(PID, [{"role": "user", "content": "x"}], max_tokens=70)
        self.assertIn("TRUNCATED completion", err.getvalue())
        with self.assertRaisesRegex(nearai.EmptyCompletion, "truncated"):
            nearai.text_of(r)
        self.assertEqual(nearai.text_of(r, allow_truncated=True), "Hello, NEAR is")

    def test_unpriced_model_is_refused(self):
        with self.assertRaisesRegex(nearai.InferenceError, "not in the NEAR AI Cloud price list"):
            nearai.Client(str(self.cfg_file), http=FakeNearAI(), sleep=lambda s: None).chat(PID, [{"role": "user", "content": "x"}], model="nope/x")


# ----------------------------------------------------------------------------------- fakes
class Boom:
    def __getattr__(self, name):
        raise AssertionError(f"must not be called: {name}")


def no_http(*a):
    raise AssertionError("no HTTP expected")


class FakeNearAI:
    def __init__(self, billed=None, timeout=False, content="hi", finish_reason="stop", reasoning_tokens=0):
        self.billed, self.timeout, self.calls, self.headers = billed, timeout, [], []
        self.content, self.finish_reason, self.reasoning_tokens = content, finish_reason, reasoning_tokens

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append((method, url))
        self.headers.append(headers)
        if url.endswith("/model/list?limit=500"):
            return 200, {}, json.dumps({"models": [{"modelId": nearai.DEFAULT_MODEL, "inputCostPerToken": {"amount": 1000, "scale": 9, "currency": "USD"},
                                                    "outputCostPerToken": {"amount": 3000, "scale": 9, "currency": "USD"}, "metadata": {"aliases": []}}]}).encode()
        if url.endswith("/chat/completions"):
            if self.timeout:
                raise TimeoutError("timed out")
            return 200, {"inference-id": "6f1c1f0e-0000-5000-8000-000000000001"}, json.dumps({
                "id": "x", "choices": [{"message": {"role": "assistant", "content": self.content}, "finish_reason": self.finish_reason}],
                "usage": {"prompt_tokens": 11, "completion_tokens": 70, "total_tokens": 81,
                          "completion_tokens_details": {"reasoning_tokens": self.reasoning_tokens}}}).encode()
        if url.endswith("/billing/costs"):
            return 200, {}, json.dumps({"requests": [{"requestId": "6f1c1f0e-0000-5000-8000-000000000001", "costNanoUsd": self.billed or 0}]}).encode()
        raise AssertionError(url)


def fw_pay(**over):
    p = {"id": PID, "mode": "live", "status": "paid", "intentsStatus": "SUCCESS", "recipient": fw.FORWARDER, "destinationAsset": fw.USDC_ASSET,
         "depositAddress": "0xD", "amountOut": "29000000", "settledAmountOut": "29000000", "depositMemo": None, "forwardedTx": None,
         "product": "quick_answer", "amountUsd": 29}
    p.update(over)
    return p


def fw_entry():
    return {"paymentId": PID, "amount": "29000000", "recipient": fw.FORWARDER, "destinationAsset": fw.USDC_ASSET, "depositAddress": "0xD", "enqueuedAt": 1}


def fw_status():
    return {"status": "SUCCESS", "quoteResponse": {"quoteRequest": {"recipient": fw.FORWARDER, "destinationAsset": fw.USDC_ASSET},
                                                   "quote": {"depositAddress": "0xD"}}, "swapDetails": {"amountOut": "29000000"}}


class FwOneClick:
    def status(self, addr, memo=None):
        return fw_status()


class FwRpc:
    def __init__(self, splitter=None):
        self.splitter = splitter or dict(ONCHAIN_OK)

    def view(self, account, method, args):
        if account == fw.SPLITTER and method == "get_config":
            return self.splitter
        if method == "get_config":
            return {"splitter": fw.SPLITTER, "token": fw.USDC, "agent": fw.FORWARDER, "paused": False}
        return {"get_order": None, "is_forwarded": False, "ft_balance_of": "29000000"}[method]

    def account(self, a):
        return {"amount": str(10**24), "storage_usage": 0}

    def storage_price(self):
        return 10**19

    def access_key(self, a, k):
        return {"permission": {"FunctionCall": {"allowance": str(5 * 10**23), "receiver_id": fw.FORWARDER, "method_names": ["forward"]}}}


class FwDb:
    def __init__(self, p):
        self.p = p

    def payment(self, pid):
        return self.p

    def check_sso(self):
        pass


class FwSigner:
    def __init__(self):
        self.calls = []

    def key_matches(self):
        return True

    def forward(self, order_id, amount):
        self.calls.append((order_id, amount))
        return 0, "Transaction ID: " + "A" * 44


if __name__ == "__main__":
    unittest.main()
