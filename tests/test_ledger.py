"""Offline tests: python3 -I tests/test_ledger.py (or bin/py tests/test_ledger.py)."""
import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import verify_ledger as V  # noqa: E402


def ev(kind, data):
    return "EVENT_JSON:" + json.dumps({"standard": "nearbi_splitter", "version": "1.0.0", "event": kind, "data": [data]},
                                      separators=(",", ":"))


def row(seq, kind, data, amounts, tx="T%d"):
    return {"seq": seq, "kind": kind, "data": data, "raw": ev(kind, data), "amounts": amounts,
            "order_id": data.get("order_id"), "token": data.get("token"), "tx_hash": tx % seq,
            "receipt_id": "R%d" % seq, "log_index": 0, "explorer": V.EXPLORER + tx % seq}


def sample():
    tok = "usdc-mock.nearbi-agent.testnet"
    sale = {"order_id": "o1", "payer": "p.testnet", "token": tok, "amount": "49000000",
            "contributors_amount": "4900000", "treasury_amount": "44100000", "split_bps_contributors": 1000}
    p1 = {"order_id": "o1", "token": tok, "recipient": "c.testnet", "role": "Contributors", "amount": "4900000"}
    p2 = {"order_id": "o1", "token": tok, "recipient": "t.testnet", "role": "Treasury", "amount": "44100000"}
    bodies = [row(0, "sale", sale, {k: sale[k] for k in ("amount", "contributors_amount", "treasury_amount")}),
              row(1, "payout", p1, {"amount": p1["amount"]}), row(2, "payout", p2, {"amount": p2["amount"]})]
    out, prev = [], V.GENESIS
    for b in bodies:
        ln = V.seal(b, prev)
        prev = ln["line_hash"]
        out.append(ln)
    return out


class T(unittest.TestCase):
    def test_split_matches_contract(self):
        self.assertEqual(V.split_amount(49_000_000, 1000), (4_900_000, 44_100_000))
        self.assertEqual(V.split_amount(9_999, 1000), (999, 9_000))
        self.assertEqual(V.split_amount(2**127, 5000)[0] * 2, 2**127)

    def test_chain_ok(self):
        lines = sample()
        self.assertEqual(V.check_chain(lines)[0], [])
        self.assertEqual(V.check_rows(lines), [])
        stats, _ = V.totals(lines)
        s = stats["usdc-mock.nearbi-agent.testnet"]
        self.assertEqual((s["sales"], s["total_received"], s["paid_contributors"]), (1, 49_000_000, 4_900_000))

    def test_tamper_detected(self):
        lines = sample()
        bad = copy.deepcopy(lines)
        bad[1]["amounts"]["amount"] = "1"
        self.assertTrue(V.check_chain(bad)[0])
        resealed = copy.deepcopy(lines)
        resealed[1]["amounts"]["amount"] = "1"
        resealed[1] = V.seal(resealed[1], resealed[1]["prev_hash"])
        self.assertTrue(V.check_chain(resealed)[0], "later lines must break when an earlier one is resealed")
        self.assertTrue(V.check_rows(resealed), "amounts must match the raw event")
        self.assertTrue(V.check_chain(lines[:1] + lines[2:])[0], "dropping a line must break the chain")

    def test_bad_split_detected(self):
        lines = sample()
        d = dict(lines[0]["data"], contributors_amount="4900001", treasury_amount="44099999")
        b = dict(lines[0], data=d, raw=ev("sale", d))
        self.assertTrue(any("split" in e for e in V.check_rows([b])))

    def test_published_snapshots_verify(self):
        for net in ("testnet", "mainnet"):
            p = ROOT / "data" / net / "ledger.jsonl"
            if p.exists():
                lines = [json.loads(l) for l in p.read_text().splitlines() if l.strip()]
                self.assertEqual(V.check_chain(lines)[0], [], net)
                self.assertEqual(V.check_rows(lines), [], net)
                if lines:
                    self.assertEqual(V.infer_network(lines), net)

    def test_forwarder_events_dont_move_splitter_totals_and_mainnet_explorer(self):
        fwd = {"order_id": "o1", "amount": "49000000"}
        raw = "EVENT_JSON:" + json.dumps({"standard": "nearbi_forwarder", "version": "1.0.0", "event": "forwarded", "data": [fwd]})
        b = {"seq": 0, "kind": "forwarded", "standard": "nearbi_forwarder", "data": fwd, "raw": raw, "amounts": {"amount": "49000000"},
             "order_id": "o1", "token": None, "tx_hash": "TX", "receipt_id": "R", "log_index": 0,
             "explorer": "https://nearblocks.io/txns/TX"}
        ln = V.seal(b, V.GENESIS)
        self.assertEqual(V.infer_network([ln]), "mainnet")
        self.assertEqual(V.check_rows([ln]), [])
        self.assertEqual(V.totals([ln]), ({}, {}))
        self.assertTrue(V.check_rows([dict(ln, standard="nearbi_splitter")]), "standard must match the raw event")
        self.assertTrue(V.check_rows([ln], explorer=V.EXPLORER), "testnet explorer link on a mainnet row is rejected")


if __name__ == "__main__":
    unittest.main()
