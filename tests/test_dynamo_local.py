"""The DynamoDB order source against DynamoDB Local (amazon/dynamodb-local), through the real aws CLI.

Skipped unless RS_AGENT_DDB_LOCAL=http://127.0.0.1:<port> is set; bin/test-dynamo-local.sh starts the container,
sets it and runs this file. Never touches AWS: dummy credentials, the local endpoint on every call.
It proves what the offline FakeDdb can only imitate: the claim/claim-holder/mark-forwarded condition expressions,
a claim race between two owners, the app's `forwardedTx: null` and a full OrderStep pass over real items.
"""
import json
import os
import sys
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))

from rs_agent import dynamo_orders as do  # noqa: E402
from rs_agent import forwarder as fw  # noqa: E402

import test_dynamo_orders as t  # noqa: E402

ENDPOINT = os.environ.get("RS_AGENT_DDB_LOCAL")


def M(v):
    if v is None:
        return {"NULL": True}
    if isinstance(v, bool):
        return {"BOOL": v}
    if isinstance(v, int):
        return {"N": str(v)}
    if isinstance(v, dict):
        return {"M": {k: M(x) for k, x in v.items()}}
    return {"S": str(v)}


class LocalTable(do.AwsTable):
    def __init__(self, name):
        super().__init__(table=name, endpoint=ENDPOINT)
        self.env = {k: v for k, v in self.env.items() if not k.startswith("AWS_PROFILE")}
        self.env.update(AWS_ACCESS_KEY_ID="local", AWS_SECRET_ACCESS_KEY="local", AWS_REGION="us-east-1")
        self.writes = []

    def put(self, item):
        self.aws("dynamodb", "put-item", "--item", json.dumps({k: M(v) for k, v in item.items()}))

    def update(self, *a, **k):
        ok = super().update(*a, **k)
        if ok:
            self.writes.append(a[:3])
        return ok


@unittest.skipUnless(ENDPOINT, "set RS_AGENT_DDB_LOCAL (bin/test-dynamo-local.sh)")
class DynamoLocal(t.Base):
    def setUp(self):
        super().setUp()
        name = f"nearbi-test-{uuid.uuid4().hex[:8]}"
        self.db = LocalTable(name)
        self.db.aws("dynamodb", "create-table", "--attribute-definitions", json.dumps([{"AttributeName": "PK", "AttributeType": "S"},
                    {"AttributeName": "SK", "AttributeType": "S"}]), "--key-schema", json.dumps([{"AttributeName": "PK", "KeyType": "HASH"},
                    {"AttributeName": "SK", "KeyType": "RANGE"}]), "--billing-mode", "PAY_PER_REQUEST")

    def pay(self, pid=t.PID):
        return self.db.get(f"PAY#{pid}", "PAYMENT")

    def test_claim_race_and_holder_only_writes(self):
        self.seed()
        a, b = do.OrderTable(self.db, "A", now=lambda: 1000), do.OrderTable(self.db, "B", now=lambda: 1001)
        self.assertTrue(a.claim(t.PID))
        self.assertFalse(b.claim(t.PID))
        self.assertFalse(b.set_status(t.PID, "done", "x"))
        self.assertTrue(a.set_status(t.PID, "running", "x", agentSlug="s"))
        self.assertEqual(self.pay()["agentSlug"], "s")
        self.assertTrue(a.release(t.PID))
        self.assertTrue(b.claim(t.PID))
        self.assertTrue(b.set_status(t.PID, "done", "finished"))
        self.assertTrue(b.release(t.PID))
        self.assertFalse(a.claim(t.PID))  # terminal

    def test_expired_claim_is_taken_over(self):
        self.seed()
        self.assertTrue(do.OrderTable(self.db, "A", now=lambda: 1000).claim(t.PID))
        self.assertFalse(do.OrderTable(self.db, "B", now=lambda: 1000 + do.CLAIM_SECONDS - 1).claim(t.PID))
        self.assertTrue(do.OrderTable(self.db, "B", now=lambda: 1000 + do.CLAIM_SECONDS + 1).claim(t.PID))

    def test_null_forwarded_tx_blocks_the_claim_and_can_be_marked_once(self):
        self.seed(forwarded=False)
        self.assertIn("forwardedTx", self.pay())  # the app's NULL attribute
        self.assertIsNone(self.pay()["forwardedTx"])
        # the forwarder-runner <= v0.4.1 condition: never true on an app-written payment (the bug)
        self.assertFalse(self.db.update(f"PAY#{t.PID}", "PAYMENT", "SET forwardedTx = :tx",
                                        "attribute_exists(PK) AND attribute_not_exists(forwardedTx)", {":tx": {"S": t.TX}}))
        tab = do.OrderTable(self.db, "A", now=lambda: 1)
        self.assertFalse(tab.claim(t.PID))
        self.assertTrue(tab.mark_forwarded(t.PID, t.TX, "29000000"))
        self.assertFalse(tab.mark_forwarded(t.PID, "OTHER", "29000000"))  # never overwritten
        self.assertEqual(self.pay()["forwardedTx"], t.TX)
        self.assertTrue(tab.claim(t.PID))

    def test_forwarder_runner_mark_works_on_the_apps_null(self):
        self.seed(forwarded=False)
        d = fw.Dynamo(table=self.db.table)
        d.env = self.db.env
        orig = d._aws
        d._aws = lambda *a: orig(*a, "--endpoint-url", ENDPOINT)  # type: ignore[assignment]
        self.assertTrue(d.mark_forwarded(t.PID, t.TX, "29000000", 5))
        self.assertFalse(d.mark_forwarded(t.PID, "OTHER", "29000000", 6))
        self.assertEqual(self.pay()["forwardedTx"], t.TX)

    def test_full_pass_over_real_items(self):
        self.seed(t.PID, created=1)
        self.seed(t.PID2, created=2, acct="b2.near", product="deep_dive", amount=499)
        self.assertEqual(self.step().run(), 2, self.text())
        self.assertEqual(self.pay(t.PID)["agentStatus"], "done")
        self.assertEqual(self.pay(t.PID2)["agentStatus"], "needs_human")
        self.assertNotIn("agentClaim", self.pay(t.PID))
        self.assertEqual(self.step(owner="B").run(), 0)  # idempotent
        self.assertEqual(len(self.calls["write_report"]), 1)

    def test_dry_run_writes_nothing(self):
        self.seed()
        self.assertEqual(self.step(dry_run=True).run(), 0)
        self.assertEqual(self.db.writes, [])
        self.assertNotIn("agentStatus", self.pay())


if __name__ == "__main__":
    unittest.main()
