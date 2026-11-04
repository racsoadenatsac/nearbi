"""Offline tests for the forwarding agent (no network, no AWS, no Keychain). Run: python3 -m unittest discover -s tests"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
os.environ["RS_AGENT_STATE_DIR"] = tempfile.mkdtemp(prefix="rs-agent-test-")
# The forwarder re-reads the operator rules; tests use a pinned copy (kill switch off) so they don't depend on
# the operator's current config.yaml. tests/test_rules.py covers the refusals.
_cfg = Path(os.environ["RS_AGENT_STATE_DIR"]) / "config.yaml"
_cfg.write_text((Path(__file__).resolve().parent.parent / "config.yaml").read_text().replace("kill_switch: true", "kill_switch: false"))
os.environ["RS_AGENT_CONFIG"] = str(_cfg)

from rs_agent import forwarder as fw  # noqa: E402

PID = "0b6f3c1e-1f2a-4c3d-9e8f-a1b2c3d4e5f6"
DEP = "0xDeposit"


def pay(**over):
    p = {"id": PID, "mode": "live", "status": "paid", "intentsStatus": "SUCCESS", "recipient": fw.FORWARDER,
         "destinationAsset": fw.USDC_ASSET, "depositAddress": DEP, "amountOut": "49000000", "settledAmountOut": "49000000",
         "depositMemo": None, "forwardedTx": None, "product": None, "amountUsd": 49}
    p.update(over)
    return p


def entry(**over):
    e = {"paymentId": PID, "amount": "49000000", "recipient": fw.FORWARDER, "destinationAsset": fw.USDC_ASSET,
         "depositAddress": DEP, "settlementTx": "T", "enqueuedAt": 1}
    e.update(over)
    return e


def status(**over):
    s = {"status": "SUCCESS", "quoteResponse": {"quoteRequest": {"recipient": fw.FORWARDER, "destinationAsset": fw.USDC_ASSET},
                                                "quote": {"depositAddress": DEP}}, "swapDetails": {"amountOut": "49000000"}}
    s.update(over)
    return s


def ev(executor, standard, event, data):
    return "EVENT_JSON:" + json.dumps({"standard": standard, "version": "1.0.0", "event": event, "data": [data]})


def tx(logs, status_ok=True, failed_executor=None):
    ros = []
    for executor, line in logs:
        st = {"Failure": {}} if executor == failed_executor else {"SuccessValue": ""}
        ros.append({"outcome": {"executor_id": executor, "logs": [line], "status": st}})
    return {"status": {"SuccessValue": ""} if status_ok else {"Failure": {"x": 1}}, "receipts_outcome": ros}


GOOD_TX = tx([
    (fw.FORWARDER, ev(fw.FORWARDER, "nearbi_forwarder", "forward_started", {"order_id": PID, "amount": "49000000"})),
    (fw.SPLITTER, ev(fw.SPLITTER, "nearbi_splitter", "sale", {"order_id": PID, "amount": "49000000", "token": fw.USDC})),
    (fw.FORWARDER, ev(fw.FORWARDER, "nearbi_forwarder", "forwarded", {"order_id": PID, "amount": "49000000"})),
])


class ValidateEntry(unittest.TestCase):
    def test_happy_path_returns_settled_amount(self):
        self.assertEqual(fw.validate_entry(entry(), pay()), "49000000")
        self.assertEqual(fw.validate_entry(entry(amount="49000123"), pay(settledAmountOut="49000123")), "49000123")

    def test_rejects_everything_unexpected(self):
        bad = [
            (entry(paymentId="x; rm -rf"), pay()),
            (entry(), None),
            (entry(), pay(mode="dry")),
            (entry(), pay(status="pending")),
            (entry(), pay(intentsStatus="PROCESSING")),
            (entry(), pay(recipient="attacker.near")),
            (entry(recipient="attacker.near"), pay()),
            (entry(), pay(destinationAsset="nep141:wrap.near")),
            (entry(depositAddress="other"), pay()),
            (entry(amount=None), pay()),
            (entry(amount="0"), pay()),
            (entry(amount="-5"), pay()),
            (entry(amount="1e6"), pay()),
            (entry(amount="49000001"), pay()),  # != settledAmountOut
            (entry(amount="48000000"), pay(settledAmountOut="48000000")),  # below the price
        ]
        for e, p in bad:
            with self.subTest(e=e, p=p), self.assertRaises(fw.Skip) as cm:
                fw.validate_entry(e, p)
            self.assertTrue(cm.exception.attention)


class OneClickCrossCheck(unittest.TestCase):
    def test_ok(self):
        fw.check_oneclick(status(), pay(), "49000000")

    def test_mismatches(self):
        for st in [status(status="PROCESSING"), status(status="REFUNDED"),
                   status(quoteResponse={"quoteRequest": {"recipient": "x.near", "destinationAsset": fw.USDC_ASSET}, "quote": {}}),
                   status(quoteResponse={"quoteRequest": {"recipient": fw.FORWARDER, "destinationAsset": fw.USDC_ASSET}, "quote": {"depositAddress": "other"}}),
                   status(swapDetails={"amountOut": "1"}), status(swapDetails={})]:
            with self.subTest(st=st), self.assertRaises(fw.Skip):
                fw.check_oneclick(st, pay(), "49000000")


class TxVerification(unittest.TestCase):
    def test_good_tx(self):
        self.assertEqual(fw.verify_forward_tx(GOOD_TX, PID, "49000000"), [])

    def test_wrong_order_amount_or_failure(self):
        self.assertTrue(fw.verify_forward_tx(GOOD_TX, PID, "1"))
        self.assertTrue(fw.verify_forward_tx(GOOD_TX, "other", "49000000"))
        failed = tx([(fw.FORWARDER, ev(fw.FORWARDER, "nearbi_forwarder", "forward_failed", {"order_id": PID, "amount": "49000000", "unused": "49000000"}))])
        self.assertTrue(any("forward_failed" in p for p in fw.verify_forward_tx(failed, PID, "49000000")))
        self.assertTrue(fw.verify_forward_tx(dict(GOOD_TX, status={"Failure": {}}), PID, "49000000"))

    def test_events_from_failed_receipts_or_wrong_executor_dont_count(self):
        spoof = tx([
            ("evil.near", ev("evil.near", "nearbi_splitter", "sale", {"order_id": PID, "amount": "49000000", "token": fw.USDC})),
            (fw.FORWARDER, ev(fw.FORWARDER, "nearbi_forwarder", "forwarded", {"order_id": PID, "amount": "49000000"})),
        ])
        self.assertIn("no nearbi_splitter 'sale' event for this order/amount", fw.verify_forward_tx(spoof, PID, "49000000"))
        failed_receipt = tx([(fw.SPLITTER, ev(fw.SPLITTER, "nearbi_splitter", "sale", {"order_id": PID, "amount": "49000000", "token": fw.USDC})),
                             (fw.FORWARDER, ev(fw.FORWARDER, "nearbi_forwarder", "forwarded", {"order_id": PID, "amount": "49000000"}))],
                            failed_executor=fw.SPLITTER)
        self.assertTrue(fw.verify_forward_tx(failed_receipt, PID, "49000000"))


class Misc(unittest.TestCase):
    def test_free_near(self):
        self.assertEqual(fw.free_near({"amount": str(2 * 10**24), "storage_usage": 100000}, 10**19), 10**24)

    def test_scrub_drops_secret_lines(self):
        sk = "ed25519:" + "3" * 87
        out = fw.scrub(f"Transaction ID: ABC\nprivate_key: {sk}\nkey {sk}\nok")
        self.assertNotIn(sk, out)
        self.assertIn("Transaction ID: ABC", out)

    def test_unmarshal(self):
        self.assertEqual(fw.unmarshal({"a": {"S": "x"}, "n": {"N": "5"}, "z": {"NULL": True}, "m": {"M": {"b": {"BOOL": True}}}}),
                         {"a": "x", "n": 5, "z": None, "m": {"b": True}})

    def test_b58_roundtrip_of_public_key_length(self):
        self.assertEqual(len(fw.b58decode(fw.FC_PUBLIC_KEY[8:])), 32)


class FakeRpc:
    def __init__(self, order=None, forwarded=False, balance="49000000", free=10**24, allowance=str(5 * 10**23), tx_obj=GOOD_TX):
        self.order, self.forwarded, self.balance, self.free, self.allowance, self.tx_obj = order, forwarded, balance, free, allowance, tx_obj

    def view(self, account, method, args):
        return {"get_order": lambda: self.order, "is_forwarded": lambda: self.forwarded, "ft_balance_of": lambda: self.balance}[method]()

    def account(self, a):
        return {"amount": str(self.free), "storage_usage": 0}

    def storage_price(self):
        return 10**19

    def access_key(self, a, k):
        return {"permission": {"FunctionCall": {"allowance": self.allowance, "receiver_id": fw.FORWARDER, "method_names": ["forward"]}}}

    def tx_final(self, h, s):
        return self.tx_obj


class FakeDb:
    def __init__(self, p):
        self.p, self.marked, self.dequeued = p, [], []

    def payment(self, pid):
        return self.p

    def mark_forwarded(self, pid, tx, amount, now):
        self.marked.append((pid, tx, amount))
        return True

    def dequeue(self, pid):
        self.dequeued.append(pid)


class FakeOneClick:
    def __init__(self, st=None):
        self.st = st or status()

    def status(self, addr, memo=None):
        return self.st


class FakeSigner:
    def __init__(self, out="Transaction ID: " + "A" * 44):
        self.calls, self.out = [], out

    def forward(self, order_id, amount):
        self.calls.append((order_id, amount))
        return 0, self.out


class Process(unittest.TestCase):
    def run_one(self, rpc=None, p=None, oc=None, signer=None, dry=False):
        db, signer = FakeDb(p if p is not None else pay()), signer or FakeSigner()
        r = fw.Runner(rpc or FakeRpc(), db, oc or FakeOneClick(), signer, dry_run=dry)
        return r, db, signer

    def test_forwards_verifies_and_marks(self):
        rpc = FakeRpc()
        r, db, s = self.run_one(rpc)
        calls = {"n": 0}
        orig = rpc.view

        def view(a, m, args):  # is_forwarded false before, true after the tx
            if m == "is_forwarded":
                calls["n"] += 1
                return calls["n"] > 1
            return orig(a, m, args)
        rpc.view = view
        self.assertEqual(r.process(entry()), "forwarded")
        self.assertEqual(s.calls, [(PID, "49000000")])
        self.assertEqual(db.marked, [(PID, "A" * 44, "49000000")])
        self.assertEqual(db.dequeued, [PID])

    def test_dry_run_sends_nothing(self):
        r, db, s = self.run_one(dry=True)
        self.assertEqual(r.process(entry()), "dry-run")
        self.assertEqual(s.calls, [])
        self.assertEqual(db.marked, [])

    def test_insufficient_usdc_balance_skips_without_sending(self):
        r, db, s = self.run_one(FakeRpc(balance="48999999"))
        with self.assertRaises(fw.Skip):
            r.process(entry())
        self.assertEqual(s.calls, [])

    def test_low_free_near_stops_with_top_up_message(self):
        r, db, s = self.run_one(FakeRpc(free=15 * 10**22))
        with self.assertRaises(fw.Stop) as cm:
            r.process(entry())
        self.assertEqual(cm.exception.code, fw.EXIT_TOPUP)
        self.assertIn("top up forwarder.nearbi.near", str(cm.exception))
        self.assertEqual(s.calls, [])

    def test_low_allowance_stops(self):
        r, db, s = self.run_one(FakeRpc(allowance=str(10**23)))
        with self.assertRaises(fw.Stop) as cm:
            r.process(entry())
        self.assertEqual(cm.exception.code, fw.EXIT_TOPUP)
        self.assertEqual(s.calls, [])

    def test_already_forwarded_onchain_or_in_flight_never_resends(self):
        for order, forwarded in [({"status": "in_flight"}, False), ({"status": "forwarded", "forwarded_amount": "49000000"}, True), (None, True)]:
            with self.subTest(order=order):
                r, db, s = self.run_one(FakeRpc(order=order, forwarded=forwarded))
                try:
                    r.process(entry())
                except fw.Skip:
                    pass
                self.assertEqual(s.calls, [])

    def test_recovers_from_journal_when_forwarded_onchain(self):
        r, db, s = self.run_one(FakeRpc(order={"status": "forwarded", "forwarded_amount": "49000000"}, forwarded=True))
        r.record(event="forwarded", order_id=PID, amount="49000000", tx="B" * 44)
        self.assertEqual(r.process(entry()), "recovered")
        self.assertEqual(db.marked, [(PID, "B" * 44, "49000000")])
        self.assertEqual(s.calls, [])

    def test_retryable_with_matching_unused_is_retried(self):
        rpc = FakeRpc(order={"status": "retryable", "unused": "49000000", "attempts": 1})
        n = {"c": 0}
        orig = rpc.view

        def view(a, m, args):
            if m == "is_forwarded":
                n["c"] += 1
                return n["c"] > 1
            return orig(a, m, args)
        rpc.view = view
        r, db, s = self.run_one(rpc)
        self.assertEqual(r.process(entry()), "forwarded")
        r2, _, s2 = self.run_one(FakeRpc(order={"status": "retryable", "unused": "1", "attempts": 1}))
        with self.assertRaises(fw.Skip):
            r2.process(entry())
        self.assertEqual(s2.calls, [])

    def test_already_marked_in_dynamo_is_just_dequeued(self):
        r, db, s = self.run_one(p=pay(forwardedTx="X"))
        self.assertEqual(r.process(entry()), "already-done")
        self.assertEqual(db.dequeued, [PID])
        self.assertEqual(s.calls, [])

    def test_no_tx_hash_from_cli_stops_the_run(self):
        r, db, s = self.run_one(signer=FakeSigner(out="Error: something"))
        with self.assertRaises(fw.Stop):
            r.process(entry())
        self.assertEqual(db.marked, [])

    def test_bad_tx_is_not_marked(self):
        r, db, s = self.run_one(FakeRpc(tx_obj=tx([])))
        with self.assertRaises(fw.Skip):
            r.process(entry())
        self.assertEqual(db.marked, [])
        self.assertEqual(db.dequeued, [])


if __name__ == "__main__":
    unittest.main()
