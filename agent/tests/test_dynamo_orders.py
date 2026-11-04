"""Offline tests for the DynamoDB order source (src/rs_agent/dynamo_orders.py, bin/agent-orders, bin/agent-tick).

No AWS, no network: FakeDdb stands in for AwsTable (an in-memory table that evaluates exactly the condition
expressions the module sends), FakeApp for S3 + the admin API, and the order loop's chain/inference/onchain calls
are fakes as in test_order_loop. The rules, order store, spend ledger, delivery, HTML rendering and checksums are real.
tests/test_dynamo_local.py runs the same conditions against DynamoDB Local when RS_AGENT_DDB_LOCAL is set.
"""
import copy
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
os.environ.setdefault("RS_AGENT_STATE_DIR", tempfile.mkdtemp(prefix="rs-agent-test-"))

from rs_agent import dynamo_orders as do  # noqa: E402
from rs_agent import forwarder as fw  # noqa: E402
from rs_agent import onchain, rules  # noqa: E402
from rs_agent import report_html  # noqa: E402

PID = "11111111-2222-4333-8444-555555555555"
PID2 = "66666666-7777-4888-9999-aaaaaaaaaaaa"
TX = "DZVmjroxaRey1i26btYBHzbxwbo4PMgivtVMkNHwBCKU"
BOTS_Q = "Is NEAR activity mostly bots or real users? How concentrated is it in a few relayers?"
COHORT_Q = "Do new users who started in October come back? What is the 30 days retention of that cohort?"


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def make_pack(d: Path, title: str) -> Path:
    (d / "results").mkdir(parents=True)
    (d / "queries").mkdir()
    man = {"dataset": "test", "queries": {}}
    for q, res, sql in (("q1", "a,b\n1,2\n", "-- question: one?\nSELECT 1\n"), ("q2", "c\n3\n", "-- question: two?\nSELECT 2\n")):
        (d / "results" / f"{q}.csv").write_text(res)
        (d / "queries" / f"{q}.sql").write_text(sql)
        man["queries"][q] = {"result_sha256": sha(res.encode()), "sql_sha256": sha(sql.encode()), "rows": 1}
    (d / "manifest.json").write_text(json.dumps(man))
    (d / "REPORT.md").write_text(f"---\ntitle: \"{title}\"\n---\n# {title}\n")
    return d


# ------------------------------------------------------------------------------------------ fake DynamoDB
def _val(v):
    (t, x), = v.items()
    return int(x) if t == "N" else None if t == "NULL" else x


class FakeDdb:
    """In-memory table behind the AwsTable interface. update() evaluates the module's condition expressions
    (claim, claim-holder, mark-forwarded) and applies SET/REMOVE; any other condition is a test failure."""

    def __init__(self):
        self.items: dict = {}
        self.writes: list = []
        self.sso_ok = True

    def put(self, item):
        self.items[(item["PK"], item["SK"])] = copy.deepcopy(item)

    def delete(self, pk, sk):
        self.items.pop((pk, sk), None)

    def check_sso(self):
        if not self.sso_ok:
            raise fw.Stop(do.EXIT_SSO, "SSO expired")

    def query_pk(self, pk):
        self.check_sso()
        return [copy.deepcopy(v) for (p, _), v in sorted(self.items.items()) if p == pk]

    def get(self, pk, sk):
        v = self.items.get((pk, sk))
        return copy.deepcopy(v) if v else None

    def aws(self, service, *args, table=True):
        raise AssertionError(f"unexpected aws {service} {args[:1]}")

    def _cond(self, cond, it, v):
        if it is None:
            return False
        if cond == do.CLAIM_CONDITION:
            return (it.get("status") == v[":paid"] and isinstance(it.get("forwardedTx"), str) and it["forwardedTx"]
                    and it.get("agentStatus") not in (v[":t0"], v[":t1"])
                    and ("agentClaim" not in it or it["agentClaimUntil"] < v[":now"] or it["agentClaim"] == v[":me"]))
        if cond == "agentClaim = :me":
            return it.get("agentClaim") == v[":me"]
        if cond == fw.MARK_FORWARDED_CONDITION:
            return "forwardedTx" not in it or it["forwardedTx"] is None
        raise AssertionError(f"unknown condition {cond}")

    def update(self, pk, sk, update, condition, values, names=None):
        v = {k: _val(x) for k, x in values.items()}
        it = self.items.get((pk, sk))
        if not self._cond(condition, it, v):
            return False
        m = re.fullmatch(r"SET (.+)|REMOVE (.+)", update)
        if m.group(1):
            for part in m.group(1).split(", "):
                k, x = part.split(" = ")
                it[(names or {}).get(k, k)] = v[x]
        else:
            for k in m.group(2).split(", "):
                it.pop(k, None)
        self.writes.append((pk, update))
        return True


class FakeApp(do.AppDelivery):
    def __init__(self):
        self.base, self._bucket, self._prefix = "https://nearbi.test", "nearbi-content", ""
        self.s3: dict = {}
        self.posts: list = []
        self.token_reads = 0
        self.fail_post = None
        self.db = None  # FakeDdb: then post_order applies the app's side effects like nearbi-app updateOrder

    def admin_token_present(self):
        return True

    def _admin_token(self):
        self.token_reads += 1
        return "SECRET-ADMIN-TOKEN"

    def upload(self, local, key, sha256):
        if key in self.s3:
            if self.s3[key][0] == sha256:
                return "exists"
            raise do.ol.OrderError(f"{key} exists with different content; never overwritten")
        self.s3[key] = (sha256, Path(local).read_bytes())
        return "uploaded"

    def post_order(self, pid, body):
        if self.fail_post:
            raise do.ol.OrderError(self.fail_post)
        self._admin_token()
        self.posts.append((pid, body))
        url = f"/reports/{body['deliverable']['slug']}/" if body.get("deliverable") else None
        ref = self.db.get("ORDERQ", f"ORDER#{pid}") if self.db is not None else None
        if ref:  # nearbi-app updateOrder: ORDER status/deliverable; delivered -> off ORDERQ
            o = self.db.get(f"ACCT#{ref['accountId']}", f"ORDER#{pid}")
            o["status"] = body["status"]
            if body.get("deliverable"):
                o["deliverable"], o["deliveryUrl"] = dict(body["deliverable"]), url
            self.db.put(o)
            if body["status"] == "delivered":
                self.db.delete("ORDERQ", f"ORDER#{pid}")
        return {"orderId": pid, "status": body["status"], "deliveryUrl": url}


# ------------------------------------------------------------------------------------------ base
class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="rs-do-"))
        self.env = {k: os.environ.get(k) for k in ("RS_AGENT_STATE_DIR", "RS_AGENT_SPEND_LEDGER")}
        os.environ["RS_AGENT_STATE_DIR"] = str(self.tmp / "state")
        os.environ.pop("RS_AGENT_SPEND_LEDGER", None)
        self.cfg_path = self.tmp / "config.yaml"
        self.cfg_path.write_text((ROOT / "config.yaml").read_text().replace("kill_switch: true", "kill_switch: false"))
        self.packs = self.tmp / "packs"
        make_pack(self.packs / "near-users-vs-bots", "NEAR activity: real users or bots?")
        make_pack(self.packs / "near-oct-cohort-retention", "October first-time signers: still active 30 days later?")
        self.db = FakeDdb()
        self.app = FakeApp()
        self.log: list = []
        self.calls = {"get_order": [], "write_report": [], "record_cost": [], "anchor": []}
        self.onchain = {"status": "forwarded", "amount": "29000000", "forwarded_amount": "29000000"}
        self.wr_exit = 0
        self.journal = {}
        self.verify_problems = []

    def tearDown(self):
        for k, v in self.env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def set_kill(self, on: bool):
        t = self.cfg_path.read_text()
        self.cfg_path.write_text(t.replace("kill_switch: false", "kill_switch: true") if on else t.replace("kill_switch: true", "kill_switch: false"))

    # -- seed the app's items exactly as nearbi-app writes them
    def seed(self, pid=PID, product="quick_answer", amount=29, question=BOTS_Q, forwarded=True, created=1793743277, acct="buyer.near", **pay_extra):
        brief = {"question": question, "contact": "@buyer_handle", "scope": None}
        self.db.put({"PK": f"PAY#{pid}", "SK": "PAYMENT", "type": "payment", "id": pid, "accountId": acct, "amountUsd": amount,
                     "product": product, "brief": brief, "mode": "live", "status": "paid", "intentsStatus": "SUCCESS",
                     "recipient": fw.FORWARDER, "destinationAsset": fw.USDC_ASSET, "settledAmountOut": str(amount * 10**6),
                     "forwardedTx": TX if forwarded else None, **pay_extra})
        self.db.put({"PK": f"ACCT#{acct}", "SK": f"ORDER#{pid}", "type": "order", "paymentId": pid, "accountId": acct,
                     "product": product, "brief": brief, "amountUsd": amount, "status": "paid", "deliveryUrl": None,
                     "deliverable": None, "createdAt": created, "updatedAt": created})
        self.db.put({"PK": "ORDERQ", "SK": f"ORDER#{pid}", "type": "orderq", "paymentId": pid, "accountId": acct, "createdAt": created})

    def pay(self, pid=PID):
        return self.db.items[(f"PAY#{pid}", "PAYMENT")]

    # -- order-loop fakes
    def fake_get_order(self, cfg, order_id):
        self.calls["get_order"].append(order_id)
        return self.onchain

    def fake_write_report(self, order_id, pack, question, out_dir, cfg_path, max_usd, emit):
        self.calls["write_report"].append((order_id, Path(pack).name, question))
        cfg = rules.current(cfg_path)
        line = rules.ledger(cfg).append(order_id=order_id, kind="inference", usd="0.002", note="fake", source="nearai")
        if self.wr_exit != 0:
            return self.wr_exit
        pack = Path(pack)
        man = json.loads((pack / "manifest.json").read_text())
        title = (pack / "REPORT.md").read_text().split("# ", 1)[1].strip()
        report = f"# {title}\n\n## Claim\n\n**Mostly automated by volume.**\n\n| a | b |\n|---|---|\n| 1 | 2 |\n".encode()
        out_dir.mkdir(parents=True, exist_ok=True)
        meta = {"report_sha256": sha(report), "claim": "**Mostly automated by volume.**", "cost_usd": "0.002000", "model": "m",
                "question": title,
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
        onchain.journal(cfg, line_hash=line["line_hash"], seq=seq, tx=f"COSTTX{seq}", args={})
        self.calls["record_cost"].append(seq)
        return 0

    def fake_anchor(self, cfg, args):
        self.calls["anchor"].append(args)
        return "ANCHORTX"

    def step(self, owner="owner-A", dry_run=False, max_orders=3, now=1_800_000_000, **kw):
        self.app.db = self.db  # FakeDdb, or DynamoDB Local in test_dynamo_local
        loop = do.DynamoLoop(cfg_path=str(self.cfg_path), packs_root=self.packs, emit=self.log.append, app=self.app,
                             get_order=self.fake_get_order, write_report=self.fake_write_report, record_cost=self.fake_record_cost,
                             anchor=self.fake_anchor)
        table = do.OrderTable(self.db, owner, now=lambda: now)  # type: ignore[arg-type]
        base = dict(table=table, loop=loop, cfg_path=str(self.cfg_path), dry_run=dry_run, max_orders=max_orders, emit=self.log.append,
                    get_order_onchain=lambda pid: self.onchain, journal_tx=lambda pid: self.journal.get(pid),
                    verify_tx=lambda tx, pid, amt: self.verify_problems)
        base.update(kw)
        return do.OrderStep(**base)

    def text(self):
        return "\n".join(self.log)


# ------------------------------------------------------------------------------------------ mapping
class Mapping(Base):
    def test_bots_question_matches_users_vs_bots(self):
        m = do.match_pack(BOTS_Q)
        self.assertEqual(m["pack"], "near-users-vs-bots")
        self.assertGreaterEqual(m["score"], 2)

    def test_retention_question_matches_cohort(self):
        self.assertEqual(do.match_pack(COHORT_Q)["pack"], "near-oct-cohort-retention")

    def test_vague_or_off_topic_questions_need_a_human(self):
        for q in ("", "What will the NEAR price be next week?", "Tell me about bots", "Which DEX has the most volume on NEAR?"):
            self.assertIsNone(do.match_pack(q)["pack"], q)

    def test_a_tie_needs_a_human(self):
        m = do.match_pack("Are the new users bots, and is retention real for that cohort? human or scripted?")
        if m["pack"] is not None:  # only accepted with a clear lead
            self.assertGreaterEqual(m["score"] - sorted(m["scores"].values())[-2], do.MIN_LEAD)
        m2 = do.match_pack("bots automated retention cohort")
        self.assertIsNone(m2["pack"])

    def test_plan(self):
        self.assertEqual(do.plan({"product": "quick_answer", "brief": {"question": BOTS_Q}})["kind"], "report")
        self.assertEqual(do.plan({"product": "deep_dive", "brief": {"question": BOTS_Q}})["kind"], "human")
        self.assertEqual(do.plan({"product": "subscription"})["kind"], "human")
        self.assertEqual(do.plan({"product": "quick_answer", "brief": {"question": "price?"}})["kind"], "human")

    def test_check_payment(self):
        self.seed()
        order = self.db.get("ACCT#buyer.near", f"ORDER#{PID}")
        self.assertIsNone(do.check_payment(order, self.pay()))
        for k, v in (("mode", "dry"), ("status", "pending"), ("intentsStatus", "PROCESSING"), ("recipient", "x.near"),
                     ("destinationAsset", "nep141:other"), ("product", "deep_dive"), ("accountId", "other.near"), ("amountUsd", 1)):
            self.assertIsNotNone(do.check_payment(order, {**self.pay(), k: v}), k)
        self.assertIsNotNone(do.check_payment(order, None))


# ------------------------------------------------------------------------------------------ the pass
class HappyPath(Base):
    def test_paid_forwarded_quick_answer_is_fulfilled_delivered_recorded_and_anchored(self):
        self.seed()
        rc = self.step().run()
        self.assertEqual(rc, 0, self.text())
        self.assertEqual(self.calls["write_report"], [(PID, "near-users-vs-bots", None)])  # customer text never reaches the model
        self.assertEqual(len(self.calls["record_cost"]), 1)
        self.assertEqual(self.calls["anchor"][0]["slug"], PID)
        p = self.pay()
        self.assertEqual(p["agentStatus"], "done")
        self.assertEqual(p["agentAnchorTx"], "ANCHORTX")
        self.assertEqual(p["agentSlug"], f"qa-{PID}")
        self.assertNotIn("agentClaim", p)  # released
        # app: in_progress first, then delivered with a buyer-only deliverable
        self.assertEqual([b["status"] for _, b in self.app.posts], ["in_progress", "delivered"])
        d = self.app.posts[1][1]["deliverable"]
        self.assertEqual(d["slug"], f"qa-{PID}")
        self.assertTrue(d["title"].startswith("Quick Answer: NEAR activity"))
        self.assertEqual(d["summary"], "Mostly automated by volume.")
        keys = sorted(self.app.s3)
        self.assertIn(f"reports/qa-{PID}/index.html", keys)
        self.assertIn(f"reports/qa-{PID}/report.md", keys)
        self.assertIn(f"reports/qa-{PID}/pack/results/q1.csv", keys)
        self.assertNotIn(f"reports/qa-{PID}/meta.json", keys)  # local paths / ledger internals stay local
        sums = self.app.s3[f"reports/qa-{PID}/checksums.sha256"][1].decode()
        for key, (h, body) in self.app.s3.items():
            rel = key.split(f"qa-{PID}/", 1)[1]
            if rel not in ("index.html", "checksums.sha256"):
                self.assertIn(f"{h}  {rel}", sums)
                self.assertEqual(sha(body), h)
        page = self.app.s3[f"reports/qa-{PID}/index.html"][1].decode()
        self.assertIn("relayers?", page)  # the buyer's own question, escaped
        self.assertNotIn("SECRET-ADMIN-TOKEN", self.text())

    def test_rerun_is_idempotent(self):
        self.seed()
        self.assertEqual(self.step().run(), 0)
        n_posts, n_wr = len(self.app.posts), len(self.calls["write_report"])
        self.assertEqual(self.step(owner="owner-B").run(), 0)
        self.assertEqual((len(self.app.posts), len(self.calls["write_report"])), (n_posts, n_wr))
        self.assertIn("order source: 0 open order(s)", self.text())  # the app took it off ORDERQ
        self.assertNotIn("resuming", self.text())  # done locally: nothing to resume
        self.assertEqual(len(self.calls["anchor"]), 1)

    def test_cohort_question_uses_the_cohort_pack(self):
        self.seed(question=COHORT_Q)
        self.assertEqual(self.step().run(), 0, self.text())
        self.assertEqual(self.calls["write_report"][0][1], "near-oct-cohort-retention")

    def test_resume_after_a_failed_publish(self):
        self.seed()
        self.app.fail_post = None
        orig = self.app.post_order
        state = {"n": 0}

        def flaky(pid, body):
            if body["status"] == "delivered" and state["n"] == 0:
                state["n"] += 1
                raise do.ol.OrderError("HTTP 502")
            return orig(pid, body)
        self.app.post_order = flaky  # type: ignore[assignment]
        self.assertEqual(self.step().run(), 1)
        self.assertEqual(self.pay()["agentStatus"], "delivered")  # local copy done, app not yet: not terminal
        self.assertEqual(self.calls["anchor"], [])
        self.assertEqual(self.step().run(), 0, self.text())
        self.assertEqual(self.pay()["agentStatus"], "done")
        self.assertEqual(len(self.calls["write_report"]), 1)  # never paid twice
        self.assertEqual(len(self.calls["anchor"]), 1)


class ResumeOffQueue(Base):
    """The app drops a delivered order from ORDERQ before record_cost/anchor_report run: an interrupted onchain step
    must resume from the local order store, never re-running write-report or re-delivering."""

    def fail_record_cost_once(self):
        orig, state = self.fake_record_cost, {"n": 0}

        def flaky(seq, cfg_path, emit):
            if state["n"] == 0:
                state["n"] += 1
                return 1
            return orig(seq, cfg_path, emit)
        self.fake_record_cost = flaky  # type: ignore[assignment]

    def test_onchain_failure_after_delivery_resumes_next_pass(self):
        self.seed()
        self.fail_record_cost_once()
        self.assertEqual(self.step().run(), 1, self.text())
        self.assertNotIn(("ORDERQ", f"ORDER#{PID}"), self.db.items)  # delivered: the app took it off the queue
        self.assertEqual(self.pay()["agentStatus"], "delivered")
        self.assertNotIn("agentClaim", self.pay())
        self.assertEqual(self.calls["anchor"], [])
        n_posts = len(self.app.posts)
        self.log.clear()
        self.assertEqual(self.step(owner="owner-B").run(), 0, self.text())
        self.assertIn("1 delivered order(s) off ORDERQ", self.text())
        self.assertEqual(self.pay()["agentStatus"], "done")
        self.assertEqual(self.pay()["agentAnchorTx"], "ANCHORTX")
        self.assertEqual(len(self.calls["write_report"]), 1)  # never paid twice
        self.assertEqual(len(self.app.posts), n_posts)  # never re-delivered
        self.assertEqual((len(self.calls["record_cost"]), len(self.calls["anchor"])), (1, 1))
        self.log.clear()
        self.assertEqual(self.step(owner="owner-C").run(), 0)  # done: nothing left to resume
        self.assertNotIn("resuming", self.text())
        self.assertEqual(len(self.calls["anchor"]), 1)

    def test_kill_switch_after_delivery_resumes_when_lifted(self):
        self.seed()
        orig = self.app.post_order

        def post_then_kill(pid, body):
            out = orig(pid, body)
            if body["status"] == "delivered":
                self.set_kill(True)
            return out
        self.app.post_order = post_then_kill  # type: ignore[assignment]
        self.assertEqual(self.step().run(), 5)
        self.assertEqual((self.calls["record_cost"], self.calls["anchor"]), ([], []))
        self.assertEqual(self.step().run(), 5)  # still on: nothing sent
        self.assertEqual(self.calls["anchor"], [])
        self.set_kill(False)
        self.assertEqual(self.step().run(), 0, self.text())
        self.assertEqual(self.pay()["agentStatus"], "done")
        self.assertEqual(len(self.calls["anchor"]), 1)

    def test_resume_dry_run_writes_nothing(self):
        self.seed()
        self.fail_record_cost_once()
        self.step().run()
        before = copy.deepcopy(self.db.items)
        self.log.clear()
        self.assertEqual(self.step(dry_run=True).run(), 0)
        self.assertIn("WOULD claim and resume", self.text())
        self.assertEqual(self.db.items, before)
        self.assertEqual(self.calls["anchor"], [])

    def test_post_landed_but_not_saved_is_recovered_without_reposting(self):
        self.seed()
        orig = self.app.post_order

        def post_then_crash(pid, body):
            out = orig(pid, body)
            if body["status"] == "delivered":
                raise do.ol.OrderError("connection reset after the app answered")
            return out
        self.app.post_order = post_then_crash  # type: ignore[assignment]
        self.assertEqual(self.step().run(), 1)
        self.app.post_order = orig  # type: ignore[assignment]
        n_posts = len(self.app.posts)
        self.assertEqual(self.step().run(), 0, self.text())
        self.assertEqual(len(self.app.posts), n_posts)  # the app already had it: no second POST
        self.assertEqual(self.pay()["agentStatus"], "done")

    def test_app_order_not_delivered_needs_a_human_without_a_claim(self):
        self.seed()
        orig = self.app.post_order

        def refuse_delivered(pid, body):
            if body["status"] == "delivered":
                raise do.ol.OrderError("HTTP 502")
            return orig(pid, body)
        self.app.post_order = refuse_delivered  # type: ignore[assignment]
        self.assertEqual(self.step().run(), 1)  # delivered locally, the app never got it
        self.db.delete("ORDERQ", f"ORDER#{PID}")  # someone took it off the queue by hand
        writes = len(self.db.writes)
        self.log.clear()
        self.assertEqual(self.step().run(), 2)
        self.assertIn("ATTENTION", self.text())
        self.assertEqual(len(self.db.writes), writes)
        self.assertEqual(self.calls["anchor"], [])

    def test_terminal_or_claimed_elsewhere_is_not_resumed(self):
        self.seed()
        self.fail_record_cost_once()
        self.step().run()
        self.pay().update(agentClaim="other", agentClaimUntil=1_900_000_000)
        self.assertEqual(self.step().run(), 0)
        self.assertIn("claimed by another runner", self.text())
        self.pay().pop("agentClaim")
        self.pay()["agentStatus"] = "needs_human"
        self.log.clear()
        self.assertEqual(self.step().run(), 0)
        self.assertIn("not resumed", self.text())
        self.assertEqual(self.calls["anchor"], [])

    def test_resume_still_runs_when_new_orders_hit_max_orders(self):
        self.seed(PID, created=1)
        self.fail_record_cost_once()
        self.step().run()
        self.seed(PID2, created=2, acct="b2.near")
        self.assertEqual(self.step(max_orders=0).run(), 0, self.text())
        self.assertEqual(self.pay(PID)["agentStatus"], "done")
        self.assertNotIn("agentStatus", self.pay(PID2))


class Claims(Base):
    def test_claim_race_only_one_runner_wins(self):
        self.seed()
        a = do.OrderTable(self.db, "A", now=lambda: 1000)  # type: ignore[arg-type]
        b = do.OrderTable(self.db, "B", now=lambda: 1001)  # type: ignore[arg-type]
        self.assertTrue(a.claim(PID))
        self.assertFalse(b.claim(PID))
        self.assertFalse(b.set_status(PID, "done", "x"))  # only the holder writes status
        self.assertTrue(a.claim(PID))  # re-entrant for the holder
        self.assertTrue(a.release(PID))
        self.assertTrue(b.claim(PID))

    def test_a_held_claim_blocks_the_whole_order(self):
        self.seed()
        self.assertTrue(do.OrderTable(self.db, "other", now=lambda: 1_800_000_000).claim(PID))
        self.assertEqual(self.step(now=1_800_000_010).run(), 0)
        self.assertIn("claimed by another runner", self.text())
        self.assertEqual(self.calls["write_report"], [])
        self.assertEqual(self.app.posts, [])

    def test_an_expired_claim_is_taken_over(self):
        self.seed()
        self.assertTrue(do.OrderTable(self.db, "crashed", now=lambda: 1_000).claim(PID))
        self.assertEqual(self.step(now=1_000 + do.CLAIM_SECONDS + 1).run(), 0, self.text())
        self.assertEqual(self.pay()["agentStatus"], "done")

    def test_claim_refuses_unforwarded_unpaid_and_terminal(self):
        t = do.OrderTable(self.db, "A", now=lambda: 1)  # type: ignore[arg-type]
        self.seed(forwarded=False)
        self.assertFalse(t.claim(PID))  # forwardedTx NULL (as the app writes it)
        self.seed(status="pending")
        self.assertFalse(t.claim(PID))
        for st in do.TERMINAL:
            self.seed(agentStatus=st)
            self.assertFalse(t.claim(PID), st)
        self.seed(agentStatus="delivered")
        self.assertTrue(t.claim(PID))  # unfinished work can be resumed


class AlreadyProcessed(Base):
    def test_done_and_needs_human_are_skipped_without_a_claim(self):
        for st in ("done", "needs_human"):
            self.db = FakeDdb()
            self.log = []
            self.seed(agentStatus=st)
            self.assertEqual(self.step().run(), 0)
            self.assertEqual(self.db.writes, [])
            self.assertEqual(self.calls["write_report"], [])
            self.assertIn(f"agent status {st}", self.text())

    def test_delivered_order_on_a_stale_queue_entry_is_skipped(self):
        self.seed()
        self.db.items[("ACCT#buyer.near", f"ORDER#{PID}")]["status"] = "delivered"
        self.assertEqual(self.step().run(), 0)
        self.assertEqual(self.db.writes, [])


class NeedsHuman(Base):
    def test_deep_dive_is_never_auto_delivered(self):
        self.seed(product="deep_dive", amount=499)
        self.assertEqual(self.step().run(), 2)
        self.assertEqual(self.pay()["agentStatus"], "needs_human")
        self.assertIn("deep_dive", self.pay()["agentNote"])
        self.assertEqual((self.calls["write_report"], self.app.posts, self.app.s3), ([], [], {}))
        self.assertNotIn("agentClaim", self.pay())

    def test_unmatched_quick_answer_needs_a_human(self):
        self.seed(question="What will the NEAR price be next week?")
        self.assertEqual(self.step().run(), 2)
        self.assertEqual(self.pay()["agentStatus"], "needs_human")
        self.assertEqual(self.calls["write_report"], [])
        self.assertNotIn("NEAR price", self.text())  # customer text is not logged

    def test_payment_mismatch_needs_a_human(self):
        self.seed(amountUsd=49)  # PAY says 49, ORDER says 29
        self.assertEqual(self.step().run(), 2)
        self.assertIn("payment check failed", self.pay()["agentNote"])

    def test_write_report_exit_6_is_needs_human_and_nothing_is_delivered(self):
        self.seed()
        self.wr_exit = 6
        self.assertEqual(self.step().run(), 2)
        self.assertEqual(self.pay()["agentStatus"], "needs_human")
        self.assertEqual(self.app.s3, {})
        self.assertEqual([b["status"] for _, b in self.app.posts], ["in_progress"])  # never "delivered"
        self.assertEqual(self.calls["anchor"], [])
        self.assertEqual(len(rules.ledger(rules.current(str(self.cfg_path))).load()), 1)  # the paid call stays booked
        self.assertEqual(self.step(owner="B").run(), 0)  # not retried
        self.assertEqual(len(self.calls["write_report"]), 1)

    def test_below_floor_onchain_amount_needs_a_human(self):
        self.seed()
        self.onchain = {"status": "forwarded", "amount": "1000000", "forwarded_amount": "1000000"}
        self.assertEqual(self.step().run(), 2)
        self.assertEqual(self.pay()["agentStatus"], "needs_human")
        self.assertEqual(self.calls["write_report"], [])


class KillSwitchAndCaps(Base):
    def test_kill_switch_refuses_before_anything(self):
        self.seed()
        self.set_kill(True)
        self.assertEqual(self.step().run(), 5)
        self.assertEqual(self.db.writes, [])
        self.assertIn("REFUSED (kill_switch)", self.text())

    def test_kill_switch_flipped_mid_pass_stops_the_next_order(self):
        self.seed(PID, created=1)
        self.seed(PID2, created=2, acct="b2.near")
        orig = self.fake_anchor

        def anchor_then_kill(cfg, args):
            self.set_kill(True)
            return orig(cfg, args)
        self.fake_anchor = anchor_then_kill  # type: ignore[assignment]
        self.assertEqual(self.step().run(), 5)
        self.assertEqual(self.pay(PID)["agentStatus"], "done")
        self.assertNotIn("agentStatus", self.pay(PID2))
        self.assertEqual(len(self.calls["write_report"]), 1)

    def test_kill_switch_before_write_report_leaves_the_order_resumable(self):
        self.seed()
        orig = self.app.post_order

        def post_then_kill(pid, body):
            out = orig(pid, body)
            if body["status"] == "in_progress":
                self.set_kill(True)
            return out
        self.app.post_order = post_then_kill  # type: ignore[assignment]
        self.assertEqual(self.step().run(), 5)
        self.assertEqual(self.calls["write_report"], [])
        self.assertNotIn(self.pay()["agentStatus"], do.TERMINAL)
        self.assertNotIn("agentClaim", self.pay())

    def test_daily_cap_refuses_the_pass_and_claims_nothing(self):
        self.seed()
        cfg = rules.current(str(self.cfg_path))
        rules.ledger(cfg).append(order_id="other", kind="inference", usd=str(cfg.max_inference_usd_per_day), note="x", source="test")
        self.assertEqual(self.step().run(), 5)
        self.assertIn("REFUSED (daily_cap)", self.text())
        self.assertEqual(self.db.writes, [])
        self.assertEqual(self.calls["write_report"], [])

    def test_per_report_cap_sends_the_order_to_a_human(self):
        self.seed()
        cfg = rules.current(str(self.cfg_path))
        rules.ledger(cfg).append(order_id=PID, kind="inference", usd=str(cfg.per_report_cost_cap_usd), note="x", source="test")
        self.assertEqual(self.step().run(), 2)
        self.assertEqual(self.pay()["agentStatus"], "needs_human")
        self.assertIn("report_cap", self.pay()["agentNote"])

    def test_max_orders_per_pass(self):
        self.seed(PID, created=1)
        self.seed(PID2, created=2, acct="b2.near")
        self.assertEqual(self.step(max_orders=1).run(), 0)
        self.assertEqual(self.pay(PID)["agentStatus"], "done")
        self.assertNotIn("agentStatus", self.pay(PID2))
        self.assertIn("max 1 order(s) per pass", self.text())

    def test_network_must_be_mainnet(self):
        self.seed()
        self.cfg_path.write_text(self.cfg_path.read_text().replace("network: mainnet", "network: testnet"))
        self.assertEqual(self.step().run(), 5)
        self.assertEqual(self.db.writes, [])

    def test_sso_expired_is_exit_3(self):
        self.seed()
        self.db.sso_ok = False
        self.assertEqual(self.step().run(), 3)


class Forwarding(Base):
    def test_not_forwarded_yet_waits_without_a_claim(self):
        self.seed(forwarded=False)
        self.onchain = {"status": "in_flight"}
        self.assertEqual(self.step().run(), 0)
        self.assertEqual(self.db.writes, [])
        self.assertIn("waits for forwarder-runner", self.text())

    def test_forwarded_onchain_but_unmarked_is_backfilled_then_fulfilled(self):
        self.seed(forwarded=False)
        self.journal[PID] = TX
        self.assertEqual(self.step().run(), 0, self.text())
        self.assertEqual(self.pay()["forwardedTx"], TX)
        self.assertEqual(self.pay()["agentStatus"], "done")

    def test_backfill_needs_a_verifiable_tx(self):
        self.seed(forwarded=False)
        self.assertEqual(self.step().run(), 1)  # no journal entry
        self.assertIsNone(self.pay()["forwardedTx"])
        self.journal[PID] = TX
        self.verify_problems = ["no nearbi_splitter 'sale' event"]
        self.log = []
        self.assertEqual(self.step().run(), 1)
        self.assertIn("does not verify", self.text())
        self.assertEqual(self.calls["write_report"], [])


class DryRun(Base):
    def test_dry_run_writes_nothing_and_pays_nothing(self):
        self.seed(PID, created=1)
        self.seed(PID2, created=2, acct="b2.near", product="deep_dive", amount=499)
        self.seed("33333333-2222-4333-8444-555555555555", created=3, acct="b3.near", forwarded=False)
        self.journal["33333333-2222-4333-8444-555555555555"] = TX
        rc = self.step(dry_run=True).run()
        self.assertEqual(rc, 2)
        self.assertEqual(self.db.writes, [])
        self.assertEqual((self.app.posts, self.app.s3, self.app.token_reads), ([], {}, 0))
        self.assertEqual((self.calls["write_report"], self.calls["record_cost"], self.calls["anchor"]), ([], [], []))
        t = self.text()
        self.assertIn("WOULD claim", t)
        self.assertIn("WOULD mark needs_human", t)
        self.assertIn("would backfill forwardedTx", t)
        self.assertNotIn("relayers", t)  # no customer text


# ------------------------------------------------------------------------------------------ adapters
class AwsTableAdapter(unittest.TestCase):
    def run_fake(self, rc=0, out="{}", err=""):
        self.cmds = []

        def run(cmd, **kw):
            self.cmds.append((cmd, kw))
            return SimpleNamespace(returncode=rc, stdout=out, stderr=err)
        return run

    def test_claim_is_a_conditional_update_with_direct_egress(self):
        os.environ["HTTPS_PROXY"] = "http://proxy:1"
        try:
            t = do.AwsTable(run=self.run_fake())
        finally:
            os.environ.pop("HTTPS_PROXY")
        self.assertTrue(do.OrderTable(t, "me", now=lambda: 5).claim(PID))
        cmd, kw = self.cmds[0]
        self.assertEqual(cmd[:3], ["aws", "dynamodb", "update-item"])
        self.assertIn(do.CLAIM_CONDITION, cmd)
        self.assertNotIn("HTTPS_PROXY", kw["env"])
        self.assertEqual(kw["env"]["AWS_PROFILE"], os.environ.get("AWS_PROFILE") or "nearbi-agent")
        vals = json.loads(cmd[cmd.index("--expression-attribute-values") + 1])
        self.assertEqual(vals[":nul"], {"S": "NULL"})
        self.assertEqual(vals[":until"], {"N": str(5 + do.CLAIM_SECONDS)})

    def test_condition_failure_is_false_and_sso_is_exit_3(self):
        t = do.AwsTable(run=self.run_fake(rc=254, err="An error occurred (ConditionalCheckFailedException) when calling the UpdateItem"))
        self.assertFalse(do.OrderTable(t, "me").claim(PID))
        t = do.AwsTable(run=self.run_fake(rc=255, err="Error when retrieving token from sso: Token has expired and refresh failed"))
        with self.assertRaises(fw.Stop) as c:
            t.query_pk("ORDERQ")
        self.assertEqual(c.exception.code, 3)

    def test_mark_forwarded_accepts_the_apps_null(self):
        self.assertIn("attribute_type(forwardedTx, :nul)", fw.MARK_FORWARDED_CONDITION)
        self.assertIn("attribute_not_exists(forwardedTx)", fw.MARK_FORWARDED_CONDITION)

    def test_forwarder_dynamo_mark_sends_the_null_aware_condition(self):
        sent = []
        orig = subprocess.run

        def fake(cmd, **kw):
            sent.append(cmd)
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        subprocess.run = fake  # type: ignore[assignment]
        try:
            fw.Dynamo().mark_forwarded(PID, TX, "29000000", 1)
        finally:
            subprocess.run = orig  # type: ignore[assignment]
        cmd = sent[0]
        self.assertIn(fw.MARK_FORWARDED_CONDITION, cmd)
        self.assertEqual(json.loads(cmd[cmd.index("--expression-attribute-values") + 1])[":nul"], {"S": "NULL"})


class AppDeliveryAdapter(unittest.TestCase):
    def test_admin_post_uses_the_token_only_in_the_header(self):
        seen = []
        t = do.AwsTable(run=lambda *a, **k: SimpleNamespace(returncode=0, stdout=json.dumps({"Parameter": {"Value": "TOK-123"}}), stderr=""))
        app = do.AppDelivery(t, base_url="https://x.test", bucket="b", prefix="",
                             http=lambda url, body, tok: (seen.append((url, body, tok)) or (200, {"ok": True, "order": {"deliveryUrl": "/r/"}})))
        app.post_order(PID, {"status": "in_progress"})
        app.post_order(PID, {"status": "delivered"})
        self.assertEqual(seen[0], (f"https://x.test/billing/admin/orders/{PID}", {"status": "in_progress"}, "TOK-123"))
        self.assertEqual(len(seen), 2)

    def test_admin_post_error_does_not_leak_the_token(self):
        t = do.AwsTable(run=lambda *a, **k: SimpleNamespace(returncode=0, stdout=json.dumps({"Parameter": {"Value": "TOK-123"}}), stderr=""))
        app = do.AppDelivery(t, bucket="b", prefix="", http=lambda url, body, tok: (409, {"error": "slug taken"}))
        with self.assertRaises(do.ol.OrderError) as c:
            app.post_order(PID, {"status": "delivered"})
        self.assertIn("409", str(c.exception))
        self.assertNotIn("TOK-123", str(c.exception))

    def test_upload_never_overwrites_different_content(self):
        tmp = Path(tempfile.mkdtemp())
        f = tmp / "report.md"
        f.write_text("x")
        h = sha(b"x")
        calls = []

        def run(cmd, **kw):
            calls.append(cmd[2])
            if cmd[2] == "head-object":
                return SimpleNamespace(returncode=0, stdout=json.dumps({"Metadata": {"sha256": "other"}, "ContentLength": 1}), stderr="")
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        app = do.AppDelivery(do.AwsTable(run=run), bucket="b", prefix="")
        with self.assertRaises(do.ol.OrderError):
            app.upload(f, "reports/qa-x/report.md", h)
        self.assertNotIn("put-object", calls)

    def test_upload_puts_then_verifies(self):
        tmp = Path(tempfile.mkdtemp())
        f = tmp / "q1.csv"
        f.write_text("a,b\n")
        h = sha(b"a,b\n")
        calls = []

        def run(cmd, **kw):
            calls.append(cmd)
            if cmd[2] == "head-object" and not any(c[2] == "put-object" for c in calls):
                return SimpleNamespace(returncode=254, stdout="", stderr="An error occurred (404) when calling the HeadObject operation: Not Found")
            if cmd[2] == "head-object":
                return SimpleNamespace(returncode=0, stdout=json.dumps({"Metadata": {"sha256": h}, "ContentLength": 4}), stderr="")
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        app = do.AppDelivery(do.AwsTable(run=run), bucket="b", prefix="")
        self.assertEqual(app.upload(f, "reports/qa-x/pack/results/q1.csv", h), "uploaded")
        put = [c for c in calls if c[2] == "put-object"][0]
        self.assertIn("text/csv", put)
        self.assertIn("private, no-store", put)


class Html(unittest.TestCase):
    def test_customer_text_and_report_are_escaped(self):
        page = report_html.page("# T <b>\n\n## Claim\n\n**bold** and `code<x>`\n\n1. one\n2. two\n\n| a | b |\n|---|---|\n| <i> | 2 |\n",
                                title="T", customer_question="<script>alert(1)</script>", pack_title="P & Q", order_id=PID,
                                files=[("ab" * 32, "report.md")])
        self.assertNotIn("<script>", page)
        self.assertIn("&lt;script&gt;", page)
        self.assertIn("<strong>bold</strong>", page)
        self.assertIn("<code>code&lt;x&gt;</code>", page)
        self.assertIn("<ol><li>one</li><li>two</li></ol>", page)
        self.assertIn("<td>&lt;i&gt;</td>", page)
        self.assertIn("P &amp; Q", page)
        self.assertNotIn("<i>", page)

    def test_real_example_report_renders(self):
        md = (ROOT / "examples/demo-order-qa-20261104T120735Z/report.md").read_text()
        h = report_html.markdown_to_html(md)
        self.assertEqual(h.count("<h2>"), 5)
        self.assertIn("<table>", h)
        self.assertNotIn("narrative_model:", h)  # front matter dropped


class Tick(unittest.TestCase):
    def load(self):
        import importlib.machinery
        import importlib.util
        loader = importlib.machinery.SourceFileLoader("agent_tick", str(ROOT / "bin/agent-tick"))
        spec = importlib.util.spec_from_loader("agent_tick", loader)
        m = importlib.util.module_from_spec(spec)
        loader.exec_module(m)
        return m

    def test_exit_code_priority(self):
        c = self.load().combine
        self.assertEqual(c(0, 0), 0)
        self.assertEqual(c(2, 0), 2)
        self.assertEqual(c(4, 2), 4)
        self.assertEqual(c(1, 4), 1)
        self.assertEqual(c(0, 5), 5)
        self.assertEqual(c(5, 3), 3)
        self.assertEqual(c(0, 7), 1)

    def test_help_documents_exit_codes(self):
        out = subprocess.run([sys.executable, str(ROOT / "bin/agent-tick"), "--help"], capture_output=True, text=True).stdout
        for s in ("3 AWS credentials invalid", "5 refused", "4 top up", "2 a payment"):
            self.assertIn(s, out)


class MarkForwardedCli(Base):
    """forwarder-runner --mark-forwarded: backfill of a payment forwarded onchain but never marked."""

    def runner(self, dry_run, onchain_status="forwarded", problems=()):
        db = SimpleNamespace(check_sso=lambda: None, payment=lambda pid: {"forwardedTx": None}, marked=[])
        db.mark_forwarded = lambda pid, tx, amt, now: db.marked.append((pid, tx, amt)) or True
        rpc = SimpleNamespace(view=lambda acct, m, a: {"status": onchain_status, "forwarded_amount": "29000000"},
                              tx_final=lambda tx, sender: {"tx": tx})
        r = fw.Runner(rpc, db, None, None, dry_run=dry_run, config_path=str(self.cfg_path))
        r.journal_tx = lambda pid: TX
        return r, db, list(problems)

    def test_dry_run_writes_nothing_and_real_run_marks(self):
        orig = fw.verify_forward_tx
        fw.verify_forward_tx = lambda tx, pid, amt: []
        try:
            r, db, _ = self.runner(True)
            self.assertEqual(r.mark_forwarded(PID), "dry-run")
            self.assertEqual(db.marked, [])
            r, db, _ = self.runner(False)
            self.assertEqual(r.mark_forwarded(PID), "marked")
            self.assertEqual(db.marked, [(PID, TX, "29000000")])
            r, db, _ = self.runner(False, onchain_status="in_flight")
            with self.assertRaises(fw.Stop):
                r.mark_forwarded(PID)
            fw.verify_forward_tx = lambda tx, pid, amt: ["no sale event"]
            r, db, _ = self.runner(False)
            with self.assertRaises(fw.Stop):
                r.mark_forwarded(PID)
            self.assertEqual(db.marked, [])
        finally:
            fw.verify_forward_tx = orig

    def test_kill_switch_refuses(self):
        self.set_kill(True)
        r, db, _ = self.runner(False)
        with self.assertRaises(fw.Stop) as c:
            r.mark_forwarded(PID)
        self.assertEqual(c.exception.code, 5)


# ------------------------------------------------------------------------------------------ AWS identity (v0.5.1)
class AwsIdentity(unittest.TestCase):
    def setUp(self):
        self._prof = os.environ.pop("AWS_PROFILE", None)

    def tearDown(self):
        os.environ.pop("AWS_PROFILE", None)
        if self._prof is not None:
            os.environ["AWS_PROFILE"] = self._prof

    def fake(self, rc, err):
        return lambda cmd, **kw: SimpleNamespace(returncode=rc, stdout="", stderr=err)

    def test_default_profile_is_nearbi_agent_and_overridable(self):
        self.assertEqual(fw.aws_profile(), "nearbi-agent")
        self.assertEqual(do.AwsTable().env["AWS_PROFILE"], "nearbi-agent")
        self.assertEqual(fw.Dynamo().env["AWS_PROFILE"], "nearbi-agent")
        os.environ["AWS_PROFILE"] = "nearbi"
        self.assertEqual(do.AwsTable().env["AWS_PROFILE"], "nearbi")
        self.assertEqual(fw.Dynamo().env["AWS_PROFILE"], "nearbi")
        self.assertEqual(do.AwsTable(profile="x").env["AWS_PROFILE"], "x")

    def test_invalid_or_missing_key_is_exit_3_with_rotation_hint(self):
        for err in ("An error occurred (InvalidClientTokenId) when calling the Query operation: The security token included in the request is invalid.",
                    "Error when retrieving credentials from custom-process: aws-keychain-credentials: Keychain item nearbi-agent-aws not readable",
                    "Unable to locate credentials. You can configure credentials by running \"aws configure\".",
                    "An error occurred (SignatureDoesNotMatch) when calling the GetItem operation"):
            t = do.AwsTable(run=self.fake(255, err))
            with self.assertRaises(fw.Stop) as c:
                t.query_pk("ORDERQ")
            self.assertEqual(c.exception.code, 3, err)
            self.assertIn("AWS key invalid or missing", str(c.exception))
            self.assertIn("nearbi-agent-aws", str(c.exception))

    def test_sso_profile_keeps_the_sso_message(self):
        t = do.AwsTable(profile="nearbi", run=self.fake(255, "Error when retrieving token from sso: Token has expired and refresh failed"))
        with self.assertRaises(fw.Stop) as c:
            t.check_sso()
        self.assertEqual(c.exception.code, 3)
        self.assertIn("aws sso login --profile nearbi", str(c.exception))

    def test_access_denied_is_an_error_not_exit_3(self):
        t = do.AwsTable(run=self.fake(254, "An error occurred (AccessDeniedException) when calling the Scan operation: User: "
                                           "arn:aws:iam::1:user/nearbi-agent is not authorized to perform: dynamodb:Scan"))
        with self.assertRaises(RuntimeError):
            t.query_pk("ORDERQ")

    def test_content_location_needs_no_lambda_call(self):
        calls = []
        t = do.AwsTable(run=lambda cmd, **kw: calls.append(cmd) or SimpleNamespace(returncode=0, stdout="[]", stderr=""))
        for k in ("NEARBI_CONTENT_BUCKET", "NEARBI_CONTENT_PREFIX", "NEARBI_CONTENT_FROM_LAMBDA"):
            os.environ.pop(k, None)
        self.assertEqual(do.AppDelivery(t).content_location(), ("nearbi-content", ""))
        self.assertEqual(calls, [])

    def test_keychain_helper_fails_closed_without_output(self):
        p = subprocess.run([sys.executable, str(Path(__file__).resolve().parent.parent / "bin/aws-keychain-credentials"),
                            "rs-agent-test-no-such-item"], capture_output=True, text=True)
        self.assertEqual(p.returncode, 1)
        self.assertEqual(p.stdout, "")
        self.assertIn("not readable", p.stderr)
        p = subprocess.run([sys.executable, str(Path(__file__).resolve().parent.parent / "bin/aws-keychain-credentials"),
                            "bad name;rm"], capture_output=True, text=True)
        self.assertEqual((p.returncode, p.stdout), (1, ""))


if __name__ == "__main__":
    unittest.main()
