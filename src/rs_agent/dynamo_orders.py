"""DynamoDB order source: live nearbi-app orders -> the order loop -> delivery on nearbi.ai -> status back in DynamoDB.

What the app writes (nearbi-app README "DynamoDB table design", src/services/billing.ts):

  PAY#<id>/PAYMENT          every checkout: product, amountUsd, accountId, brief, 1Click fields; status paid on SUCCESS;
                            forwardedTx (+At, Amount) set by forwarder-runner once forward() is final onchain
  ACCT#<acct>/ORDER#<id>    one-off products only (quick_answer, deep_dive), created in the same transaction that
                            marks the payment paid: brief {question, contact, scope}, status paid|in_progress|delivered,
                            deliveryUrl, deliverable {slug, title, summary, contentPrefix, pdfFile}
  ORDERQ/ORDER#<id>         open-order index (removed by the app when the order goes to delivered)

Subscriptions never create an ORDER: the app extends the paid period itself on SUCCESS, so there is nothing to
fulfil and this source never sees them.

One pass (OrderStep.run):
  1. rules gate (config.yaml re-read: kill switch, network must be mainnet), SSO check
  2. Query ORDERQ, GetItem the ORDER and the PAY# item for each (consistent reads), oldest first
  3. per order, rules re-read again, then:
       eligible = ORDER paid|in_progress, payment live + paid + 1Click SUCCESS + recipient forwarder + USDC +
                  same product/account/price, and **forwardedTx set** (the onchain revenue split happened first).
                  forwardedTx NULL but forwarded onchain -> backfilled from the forwarder journal after
                  verifying the tx (forwarder-runner <= v0.4.1 never managed to write it, see forwarder.Dynamo)
       mapping  = quick_answer -> best-matching cached pack (match_pack) -> automatic;
                  quick_answer with no clear match, deep_dive, anything else -> needs_human (never auto-delivered)
       caps     = rules.check_job for the write-report worst case (--max-usd) before claiming: daily cap -> the pass
                  stops (exit 5), per-report cap -> needs_human; at most --max-orders orders per pass
       claim    = conditional UpdateItem on PAY#<id> (agentClaim/agentClaimUntil; terminal agentStatus refused;
                  an expired claim can be taken over), released at the end
       run      = order_loop.Loop for this order: onchain get_order == forwarded + min price -> write-report ->
                  delivery (local inbox copy + S3 + admin API: ORDER delivered with a buyer-only deliverable) ->
                  record_cost per inference line -> anchor_report(order id, sha256(report.md))
       status   = agentStatus on PAY#<id>: waiting | paid | delivered | done | needs_human (+ agentNote,
                  agentUpdatedAt, agentReportSha256, agentAnchorTx, agentSlug)

Customer text (brief.question/contact/scope) is never sent to the model and never printed by this module: it is
matched against keyword lists locally and shown back to the buyer (HTML-escaped) on their own delivery page.
The admin token is read from SSM into memory for the API call only; never printed, logged or written.
"""
from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

from . import egress
from . import forwarder as fw
from . import order_loop as ol
from . import report_html, rules

TABLE, REGION, FUNCTION = "nearbi", "us-east-1", "nearbi-app"
# The deployed Lambda's CONTENT_BUCKET / CONTENT_PREFIX (nearbi-infra var.content_bucket_name / var.content_prefix).
# Fixed here so the agent needs no lambda:GetFunctionConfiguration (which would expose every app secret in the
# Lambda environment); NEARBI_CONTENT_BUCKET / NEARBI_CONTENT_PREFIX override, NEARBI_CONTENT_FROM_LAMBDA=1 reads the
# Lambda (operator SSO only).
CONTENT_BUCKET, CONTENT_PREFIX = "nearbi-content", ""
APP_URL = "https://nearbi.ai"
ADMIN_TOKEN_PARAM = "/nearbi/app/ADMIN_TOKEN"
CLAIM_SECONDS = 1800  # a claim older than this is considered abandoned (crashed tick) and may be taken over
TERMINAL = ("done", "needs_human")
EXIT_OK, EXIT_ERROR, EXIT_NEEDS_HUMAN, EXIT_SSO, EXIT_REFUSED = 0, 1, 2, 3, 5

# ------------------------------------------------------------------------------------------ pack matching
# Cached packs a Quick Answer can be answered from, with the phrases that make a question "about" that pack.
# A question needs >= MIN_SCORE distinct phrase hits for one pack and a lead of >= MIN_LEAD over the runner-up,
# otherwise a human decides (never guess on a paid order).
PACK_KEYWORDS: dict[str, tuple[str, ...]] = {
    "near-users-vs-bots": (
        "bot", "bots", "botted", "automated", "automation", "script", "scripted", "scripts", "sybil", "fake",
        "real user", "real users", "human", "humans", "organic", "genuine", "concentration", "concentrated",
        "relayer", "relayers", "busiest", "top signers", "high frequency", "high-frequency", "wash", "farm", "farming",
        "signer activity", "transactions per signer", "inflated",
    ),
    "near-oct-cohort-retention": (
        "retention", "retain", "retained", "retaining", "cohort", "cohorts", "churn", "churned", "come back",
        "came back", "coming back", "returning", "return", "stick", "stuck around", "still active", "stay active",
        "first-time", "first time", "new users", "new accounts", "new signers", "onboarding", "onboarded",
        "day 30", "30 days", "30-day", "drop off", "drop-off",
    ),
}
MIN_SCORE, MIN_LEAD = 2, 1


def _norm(text: str) -> str:
    return " " + re.sub(r"[^a-z0-9-]+", " ", (text or "").lower()) + " "


def match_pack(question: str, keywords: dict[str, tuple[str, ...]] = PACK_KEYWORDS) -> dict:
    """{"pack": name | None, "score": n, "hits": [...], "scores": {pack: n}, "why": text}. Pure, local."""
    q = _norm(question)
    scores, hits = {}, {}
    for pack, words in keywords.items():
        h = sorted({w for w in words if _norm(w) in q})
        scores[pack], hits[pack] = len(h), h
    ranked = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))
    best, score = ranked[0]
    second = ranked[1][1] if len(ranked) > 1 else 0
    if score < MIN_SCORE:
        return {"pack": None, "score": score, "hits": hits[best], "scores": scores,
                "why": f"no cached pack matches the question (best {best}: {score} keyword hits < {MIN_SCORE})"}
    if score - second < MIN_LEAD:
        return {"pack": None, "score": score, "hits": hits[best], "scores": scores,
                "why": f"the question matches several cached packs equally ({scores}); a human picks"}
    return {"pack": best, "score": score, "hits": hits[best], "scores": scores, "why": f"matched {best} ({score} hits)"}


def plan(order: dict) -> dict:
    """ORDER item -> {"kind": "report", topic, match} | {"kind": "human", why}. Never auto-delivers a deep dive."""
    product = order.get("product")
    if product == "quick_answer":
        m = match_pack(((order.get("brief") or {}).get("question")) or "")
        if m["pack"] is None:
            return {"kind": "human", "why": f"quick_answer: {m['why']}", "match": m}
        if m["pack"] not in ol.PRODUCTS["quick_answer"]["topics"]:
            return {"kind": "human", "why": f"quick_answer: matched {m['pack']} but it is not an enabled topic", "match": m}
        return {"kind": "report", "topic": m["pack"], "match": m}
    if product == "deep_dive":
        return {"kind": "human", "why": "deep_dive: new queries and a scoped report; never auto-delivered"}
    return {"kind": "human", "why": f"unexpected product {product!r} on the open-order queue"}


# ------------------------------------------------------------------------------------------ DynamoDB (aws CLI)
class AwsTable:
    """Generic DynamoDB access through the aws CLI, direct egress (rs_agent.egress), profile nearbi-agent by default.
    `endpoint` points at DynamoDB Local for the integration test; `run` is injectable for offline tests."""

    def __init__(self, profile: Optional[str] = None, table: str = TABLE, region: str = REGION, endpoint: Optional[str] = None,
                 run: Callable[..., Any] = subprocess.run):
        self.profile = profile = profile or fw.aws_profile()
        self.env = egress.direct_env(AWS_PROFILE=profile, AWS_REGION=region, AWS_PAGER="")
        self.table, self.endpoint, self.run = table, endpoint, run

    def aws(self, service: str, *args: str, table: bool = True) -> Any:
        cmd = ["aws", service, *args] + (["--table-name", self.table] if table else []) + ["--output", "json"]
        if self.endpoint:
            cmd += ["--endpoint-url", self.endpoint]
        p = self.run(cmd, capture_output=True, text=True, env=self.env, timeout=60)
        if p.returncode != 0:
            err = (p.stderr or "").strip()
            if fw.CREDS_ERR_RE.search(err):
                raise fw.Stop(EXIT_SSO, fw.creds_message(self.profile))
            if "ConditionalCheckFailed" in err:
                raise fw.ConditionFailed(err[:300])
            raise RuntimeError(f"aws {service} {args[0] if args else ''}: {err[:400]}")
        return json.loads(p.stdout) if (p.stdout or "").strip() else {}

    def check_sso(self) -> None:
        if self.endpoint:
            return
        p = self.run(["aws", "sts", "get-caller-identity", "--output", "json"], capture_output=True, text=True, env=self.env, timeout=60)
        if p.returncode != 0:
            raise fw.Stop(EXIT_SSO, fw.creds_message(self.profile))

    def query_pk(self, pk: str) -> list[dict]:
        items, start = [], None
        while True:
            args = ["query", "--key-condition-expression", "PK = :pk", "--expression-attribute-values",
                    json.dumps({":pk": {"S": pk}}), "--consistent-read"]
            if start:
                args += ["--exclusive-start-key", json.dumps(start)]
            out = self.aws("dynamodb", *args)
            items += [fw.unmarshal(i) for i in out.get("Items", [])]
            start = out.get("LastEvaluatedKey")
            if not start:
                return items

    def get(self, pk: str, sk: str) -> Optional[dict]:
        out = self.aws("dynamodb", "get-item", "--key", json.dumps({"PK": {"S": pk}, "SK": {"S": sk}}), "--consistent-read")
        return fw.unmarshal(out["Item"]) if out.get("Item") else None

    def update(self, pk: str, sk: str, update: str, condition: str, values: dict, names: Optional[dict] = None) -> bool:
        """Conditional UpdateItem. values are DynamoDB-typed ({":x": {"S": ...}}). False = condition failed."""
        args = ["update-item", "--key", json.dumps({"PK": {"S": pk}, "SK": {"S": sk}}), "--update-expression", update,
                "--condition-expression", condition, "--expression-attribute-values", json.dumps(values)]
        if names:
            args += ["--expression-attribute-names", json.dumps(names)]
        try:
            self.aws("dynamodb", *args)
            return True
        except fw.ConditionFailed:
            return False


def S(v: Any) -> dict:
    return {"S": str(v)}


def N(v: int) -> dict:
    return {"N": str(int(v))}


# Claim: only a paid + forwarded payment, never one already finished, and only if nobody else holds a live claim.
CLAIM_CONDITION = ("attribute_exists(PK) AND #st = :paid AND attribute_exists(forwardedTx) AND NOT attribute_type(forwardedTx, :nul) "
                   "AND (attribute_not_exists(agentStatus) OR NOT agentStatus IN (:t0, :t1)) "
                   "AND (attribute_not_exists(agentClaim) OR agentClaimUntil < :now OR agentClaim = :me)")


class OrderTable:
    """The order-source view of the app's table: open orders, claims and the agent's status on PAY#<id>."""

    def __init__(self, t: AwsTable, owner: str, now: Callable[[], int] = lambda: int(time.time())):
        self.t, self.owner, self.now = t, owner, now

    def open_orders(self) -> list[tuple[dict, Optional[dict], Optional[dict]]]:
        """[(ORDERQ ref, ORDER item or None, PAY# item or None)], oldest first."""
        out = []
        for ref in self.t.query_pk("ORDERQ"):
            pid, acct = ref.get("paymentId") or "", ref.get("accountId") or ""
            order = self.t.get(f"ACCT#{acct}", f"ORDER#{pid}") if pid and acct else None
            pay = self.t.get(f"PAY#{pid}", "PAYMENT") if fw.ORDER_ID_RE.match(pid) else None
            out.append((ref, order, pay))
        return sorted(out, key=lambda x: (x[0].get("createdAt") or 0, x[0].get("paymentId") or ""))

    def claim(self, pid: str) -> bool:
        now = self.now()
        return self.t.update(
            f"PAY#{pid}", "PAYMENT", "SET agentClaim = :me, agentClaimUntil = :until, agentUpdatedAt = :now",
            CLAIM_CONDITION,
            {":me": S(self.owner), ":until": N(now + CLAIM_SECONDS), ":now": N(now), ":paid": S("paid"), ":nul": S("NULL"),
             ":t0": S(TERMINAL[0]), ":t1": S(TERMINAL[1])}, {"#st": "status"})

    def set_status(self, pid: str, status: str, note: str, **extra: str) -> bool:
        """Write the agent's status (only while holding the claim)."""
        sets = ["agentStatus = :s", "agentNote = :n", "agentUpdatedAt = :now"]
        vals = {":s": S(status), ":n": S(note[:900]), ":now": N(self.now()), ":me": S(self.owner)}
        for i, (k, v) in enumerate(sorted(extra.items())):
            if not re.fullmatch(r"agent[A-Z][A-Za-z0-9]*", k):
                raise ValueError(f"agent attribute name {k!r}")
            sets.append(f"{k} = :x{i}")
            vals[f":x{i}"] = S(v)
        return self.t.update(f"PAY#{pid}", "PAYMENT", "SET " + ", ".join(sets), "agentClaim = :me", vals)

    def release(self, pid: str) -> bool:
        return self.t.update(f"PAY#{pid}", "PAYMENT", "REMOVE agentClaim, agentClaimUntil", "agentClaim = :me", {":me": S(self.owner)})

    def mark_forwarded(self, pid: str, tx: str, amount: str) -> bool:
        return self.t.update(f"PAY#{pid}", "PAYMENT", "SET forwardedTx = :tx, forwardedAt = :at, forwardedAmount = :amt",
                             fw.MARK_FORWARDED_CONDITION, {":tx": S(tx), ":at": N(self.now()), ":amt": S(amount), ":nul": S("NULL")})


# ------------------------------------------------------------------------------------------ eligibility (pure)
def check_payment(order: dict, pay: Optional[dict]) -> Optional[str]:
    """None if the ORDER and its PAY# item agree and the payment is live, paid and settled to the forwarder;
    else why not (the order then needs a human)."""
    pid = order.get("paymentId")
    if pay is None:
        return "payment record missing"
    checks = [
        (pay.get("mode") == "live", f"payment mode {pay.get('mode')!r}, not live"),
        (pay.get("status") == "paid", f"payment status {pay.get('status')!r}, not paid"),
        (pay.get("intentsStatus") == "SUCCESS", f"intentsStatus {pay.get('intentsStatus')!r}, not SUCCESS"),
        (pay.get("recipient") == fw.FORWARDER, f"recipient {pay.get('recipient')!r}, not {fw.FORWARDER}"),
        (pay.get("destinationAsset") == fw.USDC_ASSET, "settlement asset is not USDC"),
        (pay.get("id") in (None, pid), "payment id differs from the order"),
        ((pay.get("product") or "subscription") == order.get("product"), f"payment product {pay.get('product')!r} != order product {order.get('product')!r}"),
        (pay.get("accountId") == order.get("accountId"), "payment account differs from the order"),
        (str(pay.get("amountUsd")) == str(order.get("amountUsd")), f"payment amountUsd {pay.get('amountUsd')} != order {order.get('amountUsd')}"),
    ]
    for ok, why in checks:
        if not ok:
            return why
    return None


def forwarded_tx(pay: dict) -> Optional[str]:
    tx = pay.get("forwardedTx")
    return tx if isinstance(tx, str) and tx else None


# ------------------------------------------------------------------------------------------ delivery on nearbi.ai
def slug_for(pid: str) -> str:
    return f"qa-{pid}"


CONTENT_TYPES = {"html": "text/html; charset=utf-8", "csv": "text/csv", "json": "application/json",
                 "md": "text/markdown; charset=utf-8", "sql": "text/plain; charset=utf-8", "sha256": "text/plain; charset=utf-8"}


class AppDelivery:
    """The app's existing delivery path for a one-off order (nearbi-app README "Order deliverables"): upload the
    files to the private content bucket under reports/<slug>/, then POST /billing/admin/orders/<id> with
    {status: delivered, deliverable: {slug, title, summary}}. The buyer then sees it under "Your orders" on /members
    and only they can open /reports/<slug>/ (everyone else 404). Nothing emails or messages the customer."""

    def __init__(self, t: AwsTable, base_url: str = APP_URL, bucket: Optional[str] = None, prefix: Optional[str] = None,
                 http: Optional[Callable[[str, dict, str], tuple[int, dict]]] = None):
        self.t, self.base, self._bucket, self._prefix = t, base_url.rstrip("/"), bucket, prefix
        self.http = http or self._http
        self._token: Optional[str] = None

    def content_location(self) -> tuple[str, str]:
        """CONTENT_BUCKET + CONTENT_PREFIX of the deployed Lambda: the constants above (env overrides), or with
        NEARBI_CONTENT_FROM_LAMBDA=1 read from the Lambda (only these two values are queried)."""
        if self._bucket is None:
            b = os.environ.get("NEARBI_CONTENT_BUCKET")
            p = os.environ.get("NEARBI_CONTENT_PREFIX")
            if b is None and os.environ.get("NEARBI_CONTENT_FROM_LAMBDA") != "1":
                b, p = CONTENT_BUCKET, CONTENT_PREFIX if p is None else p
            if b is None:
                out = self.t.aws("lambda", "get-function-configuration", "--function-name", FUNCTION, "--query",
                                 "[Environment.Variables.CONTENT_BUCKET, Environment.Variables.CONTENT_PREFIX]", table=False)
                b, p = out[0], out[1] if p is None else p
            if not b:
                raise ol.OrderError("content bucket unknown (Lambda CONTENT_BUCKET empty); set NEARBI_CONTENT_BUCKET")
            self._bucket, self._prefix = b, p or ""
        return self._bucket, self._prefix or ""

    def admin_token_present(self) -> bool:
        out = self.t.aws("ssm", "describe-parameters", "--parameter-filters",
                         json.dumps([{"Key": "Name", "Values": [ADMIN_TOKEN_PARAM]}]), table=False)
        return bool(out.get("Parameters"))

    def _admin_token(self) -> str:
        if self._token is None:
            tok = os.environ.get("NEARBI_ADMIN_TOKEN")
            if not tok:
                out = self.t.aws("ssm", "get-parameter", "--name", ADMIN_TOKEN_PARAM, "--with-decryption", table=False)
                tok = ((out.get("Parameter") or {}).get("Value") or "").strip()
            if not tok:
                raise ol.OrderError(f"admin token not readable from SSM {ADMIN_TOKEN_PARAM}")
            self._token = tok
        return self._token

    def _http(self, url: str, body: dict, token: str) -> tuple[int, dict]:
        req = urllib.request.Request(url, json.dumps(body).encode(), method="POST",
                                     headers={"authorization": f"Bearer {token}", "content-type": "application/json",
                                              "user-agent": "rs-agent/order-source"})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # direct: no proxied secret needed
        try:
            with opener.open(req, timeout=30) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read() or b"{}")
            except ValueError:
                return e.code, {}

    def post_order(self, pid: str, body: dict) -> dict:
        if not fw.ORDER_ID_RE.match(pid):
            raise ol.OrderError(f"bad order id {pid!r}")
        code, out = self.http(f"{self.base}/billing/admin/orders/{pid}", body, self._admin_token())
        if code != 200 or not out.get("ok"):
            raise ol.OrderError(f"POST /billing/admin/orders/{pid} -> HTTP {code}: {str(out.get('error') or out)[:200]}")
        return out["order"]

    def upload(self, local: Path, key: str, sha256: str) -> str:
        bucket, _ = self.content_location()
        ext = local.name.rsplit(".", 1)[-1].lower()
        try:
            head = self.t.aws("s3api", "head-object", "--bucket", bucket, "--key", key, table=False)
        except RuntimeError as e:
            if not re.search(r"\b404\b|Not Found|NoSuchKey", str(e)):
                raise
            head = None
        if head is not None:
            if (head.get("Metadata") or {}).get("sha256") == sha256:
                return "exists"
            raise ol.OrderError(f"s3://{bucket}/{key} already exists with different content; never overwritten")
        self.t.aws("s3api", "put-object", "--bucket", bucket, "--key", key, "--body", str(local), "--content-type",
                   CONTENT_TYPES.get(ext, "application/octet-stream"), "--cache-control", "private, no-store",
                   "--metadata", json.dumps({"sha256": sha256}), table=False)
        head = self.t.aws("s3api", "head-object", "--bucket", bucket, "--key", key, table=False)
        if (head.get("Metadata") or {}).get("sha256") != sha256 or int(head.get("ContentLength", -1)) != local.stat().st_size:
            raise ol.OrderError(f"s3://{bucket}/{key}: uploaded object does not match the local file")
        return "uploaded"


# ------------------------------------------------------------------------------------------ the loop, delivering to the app
@dataclass
class DynamoLoop(ol.Loop):
    """order_loop.Loop whose delivery also publishes to nearbi.ai. Publishing is idempotent and is re-attempted
    before the onchain step if a previous pass stopped between the local copy and the app."""
    app: Optional[AppDelivery] = None

    def deliver(self, cfg: rules.Config, store: ol.OrderStore, order: dict, meta: dict) -> Path:
        dest = super().deliver(cfg, store, order, meta)
        self.publish(cfg, store, order, meta, dest)
        return dest

    def mirror_onchain(self, cfg: rules.Config, store: ol.OrderStore, order: dict) -> dict:
        if not (order.get("app_delivery") or {}).get("done"):
            dest = Path(next((h["inbox"] for h in reversed(order["history"]) if h.get("inbox")), None)
                        or self._inbox(cfg) / order["order_id"])
            meta = json.loads((dest / "meta.json").read_text())
            self.publish(cfg, store, order, meta, dest)
        return super().mirror_onchain(cfg, store, order)

    def publish(self, cfg: rules.Config, store: ol.OrderStore, order: dict, meta: dict, dest: Path) -> None:
        assert self.app is not None
        self.guard(f"publishing {order['order_id']} to nearbi.ai")
        pid, slug = order["order_id"], slug_for(order["order_id"])
        _, prefix = self.app.content_location()
        key0 = f"{prefix}reports/{slug}/"
        # everything in the inbox except meta.json (local paths, ledger internals); delivery.json is the receipt
        files = [(h, rel) for h, rel in (l.split("  ", 1) for l in (dest / "checksums.sha256").read_text().splitlines() if l.strip())
                 if rel != "meta.json"]
        files.append((ol.sha256_file(dest / "delivery.json"), "delivery.json"))
        published = dest / "published.sha256"
        published.write_text("".join(f"{h}  {rel}\n" for h, rel in files))
        pack_title = meta.get("question") or meta["pack"]["name"]  # write-report's question = the pack title
        title = f"Quick Answer: {pack_title}"[:200]
        index = dest / "index.html"
        index.write_text(report_html.page((dest / "report.md").read_text(), title=title, customer_question=order.get("question"),
                                          pack_title=pack_title, order_id=pid, files=[(h, rel) for h, rel in files]))
        for h, rel in files:
            self.app.upload(dest / rel, key0 + rel, h)
        self.app.upload(published, key0 + "checksums.sha256", ol.sha256_file(published))
        self.app.upload(index, key0 + "index.html", ol.sha256_file(index))  # last: the page only links what is there
        summary = re.sub(r"\*\*|`", "", meta.get("claim") or "")[:1000]
        self.guard(f"marking {pid} delivered on nearbi.ai")
        o = self.app.post_order(pid, {"status": "delivered", "deliverable": {"slug": slug, "title": title, "summary": summary}})
        order["app_delivery"] = {"done": True, "slug": slug, "url": o.get("deliveryUrl"), "at": ol.now_iso(),
                                 "s3_prefix": key0, "files": len(files) + 2}
        store.save(order)
        self.emit(f"  {pid}: PUBLISHED {len(files) + 2} files to the content bucket under {key0}; order delivered on nearbi.ai "
                  f"({o.get('deliveryUrl')}, buyer-only)")


# ------------------------------------------------------------------------------------------ one pass
def default_owner() -> str:
    return f"rs-agent@{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"


@dataclass
class OrderStep:
    table: OrderTable
    loop: DynamoLoop
    cfg_path: Optional[str] = None
    dry_run: bool = False
    max_orders: int = 3
    max_usd: str = "0.25"
    emit: Callable[[str], None] = fw.log
    is_forwarded: Optional[Callable[[str], bool]] = None
    journal_tx: Optional[Callable[[str], Optional[str]]] = None
    verify_tx: Optional[Callable[[str, str, str], list]] = None
    get_order_onchain: Optional[Callable[[str], Optional[dict]]] = None

    def gate(self, action: str) -> rules.Config:
        cfg = rules.current(self.cfg_path)
        rules.require_network(cfg, "mainnet", "the DynamoDB order source")
        rules.require_active(cfg, action)
        return cfg

    # -- forwardedTx backfill (forwarded onchain, never marked in DynamoDB)
    def _onchain(self, pid: str) -> Optional[dict]:
        if self.get_order_onchain:
            return self.get_order_onchain(pid)
        return fw.Rpc().view(fw.FORWARDER, "get_order", {"order_id": pid})

    def backfill(self, pid: str) -> Optional[str]:
        """Forwarded onchain but forwardedTx unset: mark it if the forwarder journal holds a tx that verifies.
        Returns the tx (marked, or would be in dry-run) or None (not forwarded yet / can't prove it)."""
        st = self._onchain(pid)
        if not st or st.get("status") != "forwarded":
            return None
        amount = str(st.get("forwarded_amount"))
        jtx = (self.journal_tx or (lambda p: fw.Runner(None, None, None, None).journal_tx(p)))(pid)  # type: ignore[arg-type]
        if not jtx:
            raise ol.OrderError(f"forwarded onchain ({amount}) but no forward tx in the forwarder journal; set forwardedTx by hand "
                                f"(bin/forwarder-runner --mark-forwarded {pid} --tx <hash>)")
        problems = (self.verify_tx or (lambda tx, p, a: fw.verify_forward_tx(fw.Rpc().tx_final(tx, fw.FORWARDER), p, a)))(jtx, pid, amount)
        if problems:
            raise ol.OrderError(f"journaled forward tx {jtx} does not verify: {'; '.join(problems)}")
        if self.dry_run:
            self.emit(f"  {pid}: forwardedTx unset but forwarded onchain; DRY RUN, would backfill forwardedTx={jtx} (verified)")
            return jtx
        if self.table.mark_forwarded(pid, jtx, amount):
            self.emit(f"  {pid}: backfilled forwardedTx={jtx} (verified onchain, from the forwarder journal)")
        return jtx

    def run(self) -> int:
        try:
            cfg = self.gate("running the DynamoDB order source")
        except rules.Refused as r:
            self.emit(str(r))
            return EXIT_REFUSED
        try:
            self.table.t.check_sso()
            rows = self.table.open_orders()
        except fw.Stop as s:
            self.emit(f"STOP: {s}")
            return s.code
        self.emit(f"order source: {len(rows)} open order(s) on ORDERQ{' (DRY RUN: no claims, no writes, no paid calls)' if self.dry_run else ''}")
        if self.dry_run and self.loop.app:
            try:
                b, pre = self.loop.app.content_location()
                tok = self.loop.app.admin_token_present()
                self.emit(f"delivery path: s3://{b}/{pre}reports/qa-<order id>/ + {self.loop.app.base}/billing/admin/orders/<id>; "
                          f"SSM {ADMIN_TOKEN_PARAM} {'present (not read)' if tok else 'MISSING'}")
            except (RuntimeError, ol.OrderError) as e:
                self.emit(f"  WARNING delivery path check: {e}")
        human = error = False
        started = 0
        for ref, order, pay in rows:
            pid = ref.get("paymentId") or "?"
            try:
                cfg = self.gate(f"processing order {pid}")
            except rules.Refused as r:
                self.emit(str(r))
                return EXIT_REFUSED
            try:
                r = self.one(cfg, pid, order, pay, started)
            except fw.Stop as s:
                self.emit(f"STOP: {s}")
                return s.code
            except rules.Refused as r_:
                self.emit(str(r_))
                return EXIT_REFUSED
            except (ol.OrderError, RuntimeError) as e:
                self.emit(f"  ERROR {pid}: {e}")
                error = True
                continue
            if r == "cap":
                self.emit(f"  max {self.max_orders} order(s) per pass reached; the rest wait for the next tick")
                break
            started += r in ("started", "would-start")
            human = human or r == "needs_human"
            error = error or r == "error"
            if r == "refused":
                return EXIT_REFUSED
        return EXIT_ERROR if error else EXIT_NEEDS_HUMAN if human else EXIT_OK

    def one(self, cfg: rules.Config, pid: str, order: Optional[dict], pay: Optional[dict], started: int) -> str:
        if order is None:
            self.emit(f"  ATTENTION {pid}: ORDERQ entry without an ORDER item")
            return "error"
        if order.get("status") == "delivered":
            self.emit(f"  {pid}: already delivered (stale ORDERQ entry); skipped")
            return "skip"
        if pay and pay.get("agentStatus") in TERMINAL:
            self.emit(f"  {pid}: agent status {pay['agentStatus']} since {pay.get('agentUpdatedAt')}: "
                      f"{'waiting for a human' if pay['agentStatus'] == 'needs_human' else 'done'}; skipped")
            return "skip"
        q = ((order.get("brief") or {}).get("question")) or ""
        p = plan(order)
        desc = f"{order.get('product')} ${order.get('amountUsd')} paid {time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime(order.get('createdAt') or 0))}, question {len(q)} chars"
        bad = check_payment(order, pay)
        if bad is None and not forwarded_tx(pay or {}):
            if not self.backfill(pid):
                self.emit(f"  {pid}: {desc}; not forwarded yet (forwardedTx unset, forwarder get_order != forwarded); waits for forwarder-runner")
                return "skip"
            if self.dry_run:
                pay = {**(pay or {}), "forwardedTx": "(backfill)"}
            else:
                pay = self.table.t.get(f"PAY#{pid}", "PAYMENT")
                if not forwarded_tx(pay or {}):
                    raise ol.OrderError("forwardedTx still unset after the backfill")
        if started >= self.max_orders and (bad is None and p["kind"] == "report"):
            return "cap"
        kind, why = ("human", f"payment check failed: {bad}") if bad else (p["kind"], p.get("why"))
        match = p.get("match")
        mtxt = f"; pack match scores {match['scores']}" if match else ""  # scores only: hits are words of the customer's text
        if kind == "report":
            try:
                rules.check_job(cfg, pid, "inference", self.max_usd)
            except rules.Refused as r:
                if r.rule == "report_cap":
                    kind, why = "human", str(r)
                else:
                    raise
        if self.dry_run:
            if kind == "human":
                self.emit(f"  {pid}: {desc}{mtxt} -> WOULD mark needs_human: {why}")
                return "needs_human"
            b, pre = self.loop.app.content_location() if self.loop.app else ("?", "")
            st = self._onchain(pid) or {}
            self.emit(f"  {pid}: {desc}{mtxt} -> WOULD claim, POST in_progress, write-report pack {p['topic']} "
                      f"(max ${self.max_usd}, paid NEAR AI), publish to s3://{b}/{pre}reports/{slug_for(pid)}/ + POST delivered "
                      f"(buyer-only), record_cost per inference line, anchor_report; forwarder get_order={st.get('status')} "
                      f"{st.get('forwarded_amount')}")
            return "would-start"
        if not self.table.claim(pid):
            self.emit(f"  {pid}: claimed by another runner (or finished meanwhile); skipped")
            return "skip"
        try:
            if kind == "human":
                self.table.set_status(pid, "needs_human", why)
                self.emit(f"  ATTENTION {pid}: {desc}{mtxt} -> needs_human: {why}")
                return "needs_human"
            return self.fulfil(cfg, pid, order, p)
        finally:
            self.table.release(pid)

    def fulfil(self, cfg: rules.Config, pid: str, order: dict, p: dict) -> str:
        store = self.loop._store(cfg)
        try:
            local = store.load(pid)
        except FileNotFoundError:
            local = store.create(order_id=pid, network=cfg.network, product=order["product"], price_usd=order["amountUsd"],
                                 customer=order["accountId"], topic=p["topic"], question=(order.get("brief") or {}).get("question"))
        if not local.get("app_in_progress") and order.get("status") == "paid":
            self.loop.app.post_order(pid, {"status": "in_progress"})  # type: ignore[union-attr]
            local["app_in_progress"] = ol.now_iso()
            store.save(local)
        self.table.set_status(pid, "running", f"order loop: {local['status']}")
        rc = self.loop.run_once(pid)
        local = store.load(pid)
        st = local["status"]
        note = local["history"][-1]["note"]
        if st == "done":
            ok = local.get("onchain") or {}
            self.table.set_status(pid, "done", note, agentReportSha256=local["report"]["sha256"], agentAnchorTx=str(ok.get("anchor")),
                                  agentSlug=(local.get("app_delivery") or {}).get("slug", ""))
        else:
            self.table.set_status(pid, {"awaiting_payment": "waiting"}.get(st, st), note)
        if rc == ol.EXIT_REFUSED:
            return "refused"
        if st == "needs_human":
            return "needs_human"
        return "error" if rc == ol.EXIT_ERROR else "started"
