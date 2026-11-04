"""Offline tests: near-cli-rs and aws subprocesses go direct (no gateway egress proxy), NEAR AI Cloud stays proxied.
No network, no AWS, no Keychain: subprocess.run / urlopen are replaced. Run: python3 -m unittest discover -s tests"""
import base64
import io
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
os.environ.setdefault("RS_AGENT_STATE_DIR", tempfile.mkdtemp(prefix="rs-agent-test-"))

from rs_agent import egress, nearai, onchain, order_loop, rules  # noqa: E402
from rs_agent import forwarder as fw  # noqa: E402

PROXY = "http://u:p@127.0.0.1:1"
GATEWAY_ENV = {
    "HTTPS_PROXY": PROXY, "HTTP_PROXY": PROXY, "ALL_PROXY": PROXY, "NODE_USE_ENV_PROXY": "1",
    "https_proxy": PROXY, "http_proxy": PROXY, "all_proxy": PROXY, "node_use_env_proxy": "1", "Https_Proxy": PROXY,
    "SSL_CERT_FILE": "/tmp/trust-bundle.pem", "NODE_EXTRA_CA_CERTS": "/tmp/trust-bundle.pem",
    "NEAR_AI_CLOUD_API_KEY": "sentinel-not-a-key", "PATH": "/usr/bin:/bin", "HOME": "/tmp",
}
FAKE_SK = "ed25519:" + "1" * 88  # never a real key: only the pipe plumbing is exercised


def no_proxy(env):
    return not any(k.upper() in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NODE_USE_ENV_PROXY") for k in env)


class GatewayEnv(unittest.TestCase):
    def setUp(self):
        self._old = dict(os.environ)
        os.environ.clear()
        os.environ.update(GATEWAY_ENV, RS_AGENT_STATE_DIR=self._old["RS_AGENT_STATE_DIR"])

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._old)


class DirectEnv(GatewayEnv):
    def test_strips_every_proxy_var_and_keeps_the_rest(self):
        env = egress.direct_env()
        self.assertTrue(no_proxy(env), env)
        for k in ("SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "PATH", "HOME", "NEAR_AI_CLOUD_API_KEY"):
            self.assertEqual(env[k], GATEWAY_ENV[k])
        self.assertIn("HTTPS_PROXY", os.environ)  # the process environment itself is untouched

    def test_overrides_and_explicit_base(self):
        env = egress.direct_env({"HTTPS_PROXY": PROXY, "A": "1"}, AWS_PROFILE="nearbi")
        self.assertEqual(env, {"A": "1", "AWS_PROFILE": "nearbi"})

    def test_keep_flag(self):
        os.environ[egress.KEEP_PROXY_FLAG] = "1"
        self.assertEqual(egress.direct_env()["HTTPS_PROXY"], PROXY)

    def test_proxy_vars_list(self):
        for n in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NODE_USE_ENV_PROXY", "node_use_env_proxy"):
            self.assertIn(n, egress.PROXY_VARS)
        self.assertIs(onchain.PROXY_VARS, egress.PROXY_VARS)
        self.assertTrue(no_proxy(onchain.near_cli_env()))


def completed(stdout="", rc=0, stderr=""):
    return subprocess.CompletedProcess([], rc, stdout, stderr)


class Subprocesses(GatewayEnv):
    def test_forward_signer_near_cli_is_direct(self):
        s = fw.Signer("/nonexistent/near")
        with mock.patch.object(s, "secret", return_value=FAKE_SK), \
                mock.patch("rs_agent.forwarder.subprocess.run", return_value=completed("Transaction ID: x")) as run:
            s.forward("0b6f3c1e-1f2a-4c3d-9e8f-a1b2c3d4e5f6", "1", broadcast=False)
        argv, kw = run.call_args.args[0], run.call_args.kwargs
        self.assertTrue(no_proxy(kw["env"]))
        self.assertEqual(kw["env"]["SSL_CERT_FILE"], GATEWAY_ENV["SSL_CERT_FILE"])
        self.assertEqual(argv[-1], "display")
        self.assertNotIn("send", argv)
        self.assertFalse(any(FAKE_SK in a for a in argv))  # key only through the pipe

    def test_forward_cmd_send_vs_display(self):
        s = fw.Signer("near")
        self.assertEqual(s.forward_cmd("o", "1", 7)[-2:], ["/dev/fd/7", "send"])
        self.assertEqual(s.forward_cmd("o", "1", 7, broadcast=False)[-2:], ["/dev/fd/7", "display"])

    def test_dynamo_aws_is_direct(self):
        db = fw.Dynamo(profile="nearbi")
        self.assertTrue(no_proxy(db.env))
        self.assertEqual((db.env["AWS_PROFILE"], db.env["AWS_REGION"], db.env["AWS_PAGER"]), ("nearbi", fw.REGION, ""))
        with mock.patch("rs_agent.forwarder.subprocess.run", return_value=completed('{"Items": []}')) as run:
            db.forward_queue()
            db.check_sso()
        for c in run.call_args_list:
            self.assertEqual(c.args[0][0], "aws")
            self.assertTrue(no_proxy(c.kwargs["env"]))

    def test_record_cost_signer_is_direct(self):
        cfg = rules.load(str(ROOT / "config.yaml"))
        s = onchain.SplitterSigner(cfg, "/nonexistent/near")
        with mock.patch.object(s, "secret", return_value=FAKE_SK), \
                mock.patch("rs_agent.onchain.subprocess.run", return_value=completed()) as run:
            s.call("record_cost", {"kind": "bigquery", "amount_usd_micros": "1", "ref": "r"})
        self.assertTrue(no_proxy(run.call_args.kwargs["env"]))
        self.assertEqual(run.call_args.args[0][-1], "send")

    def test_order_loop_children_that_may_call_nearai_keep_the_proxy(self):
        # write-report buys NEAR AI inference and record-cost may be run by it: both inherit the proxied env
        p = mock.MagicMock(stdout=io.StringIO(""), wait=mock.Mock(return_value=0))
        with mock.patch("rs_agent.order_loop.subprocess.Popen", return_value=p) as popen:
            order_loop.subprocess_write_report("o", "pack", None, Path("/tmp"), None, "0.1", lambda l: None)
        with mock.patch("rs_agent.order_loop.subprocess.run", return_value=completed()) as run:
            order_loop.subprocess_record_cost(1, None, lambda l: None)
        for kw in (popen.call_args.kwargs, run.call_args.kwargs):
            self.assertEqual(kw.get("env", os.environ).get("HTTPS_PROXY"), PROXY)


class NearAiStaysProxied(GatewayEnv):
    def test_nearai_request_goes_through_the_proxy(self):
        seen = {}

        def fake_urlopen(req, timeout):
            seen["proxies"] = urllib.request.getproxies()
            seen["auth"] = req.get_header("Authorization")
            r = mock.MagicMock(status=200, headers={})
            r.read.return_value = b"{}"
            r.__enter__.return_value = r
            return r

        with mock.patch("rs_agent.nearai.urllib.request.urlopen", fake_urlopen):
            c = nearai.Client()
            nearai.urllib_http("POST", f"{nearai.BASE}/chat/completions", c._headers(), b"{}", 5)
        self.assertEqual(seen["proxies"].get("https"), PROXY)
        self.assertEqual(seen["auth"], "Bearer sentinel-not-a-key")  # the proxy swaps the sentinel; we never see the key
        src = (ROOT / "src/rs_agent/nearai.py").read_text()
        self.assertFalse("import egress" in src or "direct_env" in src, "nearai must not strip the proxy")


class SignCheck(unittest.TestCase):
    DISPLAY = ("├  Your transaction was signed successfully.\n│    Public key: {pk}\n\n"
               "Signed transaction (serialized as base64):\n{blob}\n\nThis base64-encoded signed transaction is ready")

    def runner(self, out, rc=0):
        signer = mock.MagicMock()
        signer.forward_cmd.side_effect = fw.Signer("near").forward_cmd
        signer.forward.side_effect = lambda oid, amount, broadcast=True: (rc, out(oid))
        r = fw.Runner(mock.MagicMock(), mock.MagicMock(), mock.MagicMock(), signer)
        r.rules_gate = mock.Mock()
        r.preflight = mock.Mock()
        return r, signer

    def blob(self, oid, receiver=fw.FORWARDER):
        return base64.b64encode(receiver.encode() + b"forward" + oid.encode() + b"\0" * 64).decode()

    def test_ok_never_broadcasts(self):
        r, signer = self.runner(lambda oid: self.DISPLAY.format(pk=fw.FC_PUBLIC_KEY, blob=self.blob(oid)))
        oid = r.sign_check()
        self.assertRegex(oid, fw.ORDER_ID_RE)
        self.assertEqual(signer.forward.call_args.kwargs, {"broadcast": False})
        r.preflight.assert_called_once()

    def test_mismatch_and_withheld_blob(self):
        r, _ = self.runner(lambda oid: self.DISPLAY.format(pk=fw.FC_PUBLIC_KEY, blob=self.blob(oid, "evil.near")))
        with self.assertRaises(fw.Stop) as e:
            r.sign_check()
        self.assertIn("signer/receiver", str(e.exception))
        blob = self.blob("x")
        r, _ = self.runner(lambda oid: self.DISPLAY.format(pk=fw.FC_PUBLIC_KEY, blob=blob), rc=1)
        with self.assertRaises(fw.Stop) as e:
            r.sign_check()
        self.assertIn("<signed tx withheld>", str(e.exception))
        self.assertNotIn(blob, str(e.exception))

    def test_record_cost_sign_check_displays_only(self):
        cfg = rules.load(str(ROOT / "config.yaml"))
        s = onchain.SplitterSigner(cfg, "/nonexistent/near")
        args = {"kind": "bigquery", "amount_usd_micros": "1", "ref": "order:ops:x spend:0000"}
        blob = base64.b64encode(s.account.encode() + b"record_cost" + args["ref"].encode()).decode()
        out = self.DISPLAY.format(pk=s.public_key, blob=blob)
        with mock.patch.object(s, "secret", return_value=FAKE_SK), \
                mock.patch("rs_agent.onchain.subprocess.run", return_value=completed(out)) as run:
            onchain.sign_check(cfg, s, "record_cost", args)
        self.assertEqual(run.call_args.args[0][-1], "display")
        self.assertNotIn("send", run.call_args.args[0])
        with mock.patch.object(s, "secret", return_value=FAKE_SK), \
                mock.patch("rs_agent.onchain.subprocess.run", return_value=completed(out.replace(s.public_key, "ed25519:other"))):
            with self.assertRaises(fw.Stop):
                onchain.sign_check(cfg, s, "record_cost", args)

    def test_no_signed_tx(self):
        r, _ = self.runner(lambda oid: "ERROR failed to verify TLS certificate: invalid peer certificate: UnknownIssuer", rc=1)
        with self.assertRaises(fw.Stop) as e:
            r.sign_check()
        self.assertIn("UnknownIssuer", str(e.exception))


if __name__ == "__main__":
    unittest.main()
