"""NEAR AI Cloud inference client that obeys config.yaml and books every call's cost in the spend ledger.

API (docs.near.ai, checked 2026-11-03): OpenAI-compatible gateway at https://cloud-api.near.ai/v1
  POST /v1/chat/completions   Bearer <API key>; response `usage` {prompt_tokens, completion_tokens};
                              header `inference-id` = the request's billing id
  GET  /v1/model/list         public, no key: per-model inputCostPerToken / outputCostPerToken in nano-USD
                              ({"amount": n, "scale": 9, "currency": "USD"})
  POST /v1/billing/costs      {"requestIds": [inference-id]} -> {"requests": [{"requestId", "costNanoUsd"}]}
                              (the authoritative billed cost; can lag a few seconds; 0 = not found yet)

Flow per call: kill switch -> estimate an upper bound (prompt chars/3 tokens + max_tokens, at list price)
-> rules.check_job (daily cap, per-report cap) -> call -> cost = billed cost if available, else usage x
list price -> append to the spend ledger (kind=inference). A call that times out is booked at its estimate
(we may have been billed).

Key: NEAR_AI_CLOUD_API_KEY from the process environment. Store it as a *protected* secret in the host's secret store
(name NEAR_AI_CLOUD_API_KEY, allowed host cloud-api.near.ai): with the Gateway egress proxy on, exec'd
processes get an opaque sentinel in that variable and the proxy substitutes the real key on the way to
cloud-api.near.ai, so this process never holds it. The value is never logged, printed or format-checked.
Without it the client is UNCONFIGURED: estimates and pricing work, chat() raises NotConfigured.
"""
from __future__ import annotations

import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from decimal import ROUND_UP, Decimal
from typing import Any, Callable, Optional

from . import rules, spend

BASE = "https://cloud-api.near.ai/v1"
KEY_ENV = "NEAR_AI_CLOUD_API_KEY"
DEFAULT_MODEL = "zai-org/GLM-5.1-FP8"
CHARS_PER_TOKEN = 3  # conservative (English is ~4): over-estimating only refuses earlier
PER_MESSAGE_OVERHEAD = 16

Http = Callable[[str, str, dict, Optional[bytes], int], tuple[int, dict, bytes]]


class NotConfigured(RuntimeError):
    pass


class InferenceError(RuntimeError):
    pass


class EmptyCompletion(InferenceError):
    """A paid call that produced no usable text (e.g. every max_tokens went to reasoning)."""


def text_of(resp: dict, allow_truncated: bool = False) -> str:
    """The reply text of a chat() result, for report generation. Raises EmptyCompletion if the (already paid)
    call returned no text, or was cut off at max_tokens (finish_reason=length) unless allow_truncated."""
    r = resp.get("_rs_result") or {}
    text = r.get("text", "")
    if r.get("empty") or not text.strip():
        raise EmptyCompletion(f"empty completion (finish_reason={r.get('finish_reason')}, reasoning_tokens="
                              f"{r.get('reasoning_tokens')}); raise max_tokens or lower reasoning_effort")
    if r.get("truncated") and not allow_truncated:
        raise EmptyCompletion(f"completion truncated at max_tokens (finish_reason=length, {len(text)} chars)")
    return text


def urllib_http(method: str, url: str, headers: dict, body: Optional[bytes], timeout: int) -> tuple[int, dict, bytes]:
    req = urllib.request.Request(url, body, headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # honours HTTPS_PROXY (gateway egress proxy)
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in (e.headers or {}).items()}, e.read() or b""


def configured() -> bool:
    return bool(os.environ.get(KEY_ENV))


class Client:
    def __init__(self, cfg_path: Optional[str] = None, http: Http = urllib_http, base: str = BASE,
                 sleep: Callable[[float], None] = time.sleep):
        self.cfg_path, self.http, self.base, self.sleep = cfg_path, http, base, sleep
        self._prices: dict[str, tuple[int, int]] = {}

    # ---- pricing (public endpoint)
    def prices(self, model: str) -> tuple[int, int]:
        """(input, output) nano-USD per token."""
        if model not in self._prices:
            st, _, body = self.http("GET", f"{self.base}/model/list?limit=500", {"accept": "application/json"}, None, 30)
            if st != 200:
                raise InferenceError(f"model list HTTP {st}")
            for m in json.loads(body).get("models", []):
                ip, op = m.get("inputCostPerToken") or {}, m.get("outputCostPerToken") or {}
                if ip.get("scale") == 9 and op.get("scale") == 9 and ip.get("currency") == op.get("currency") == "USD":
                    self._prices[m["modelId"]] = (int(ip["amount"]), int(op["amount"]))
                    for a in (m.get("metadata") or {}).get("aliases") or []:
                        self._prices.setdefault(a, (int(ip["amount"]), int(op["amount"])))
        if model not in self._prices:
            raise InferenceError(f"model {model!r} not in the NEAR AI Cloud price list; refusing an unpriced call")
        return self._prices[model]

    @staticmethod
    def nano_to_usd(nano: int) -> Decimal:
        return (Decimal(nano) / Decimal(10**9)).quantize(Decimal("0.000001"), rounding=ROUND_UP)

    def estimate_usd(self, model: str, messages: list[dict], max_tokens: int) -> Decimal:
        chars = sum(len(json.dumps(m.get("content", ""), ensure_ascii=False)) for m in messages)
        prompt = math.ceil(chars / CHARS_PER_TOKEN) + PER_MESSAGE_OVERHEAD * len(messages)
        pin, pout = self.prices(model)
        return self.nano_to_usd(prompt * pin + max_tokens * pout)

    def billed_nano(self, inference_id: str) -> Optional[int]:
        for wait in (2, 4):
            self.sleep(wait)
            st, _, body = self.http("POST", f"{self.base}/billing/costs", self._headers(),
                                    json.dumps({"requestIds": [inference_id]}).encode(), 30)
            if st != 200:
                return None
            for r in json.loads(body).get("requests", []):
                if r.get("requestId") == inference_id and int(r.get("costNanoUsd") or 0) > 0:
                    return int(r["costNanoUsd"])
        return None

    def _headers(self) -> dict:
        key = os.environ.get(KEY_ENV)
        if not key:
            raise NotConfigured(f"NEAR AI Cloud is not configured: {KEY_ENV} is not set. Store the API key as the host's "
                                f"protected secret {KEY_ENV} (allowed host cloud-api.near.ai); never in a file or in chat.")
        return {"authorization": f"Bearer {key}", "content-type": "application/json", "accept": "application/json",
                "user-agent": "rs-agent/nearai"}

    # ---- the guarded call
    def chat(self, order_id: str, messages: list[dict], model: str = DEFAULT_MODEL, max_tokens: int = 2000,
             timeout: int = 180, **params: Any) -> dict:
        cfg = rules.current(self.cfg_path)
        rules.require_active(cfg, "calling NEAR AI Cloud")
        headers = self._headers()  # NotConfigured before anything is spent
        if not 1 <= max_tokens <= 64000:
            raise ValueError("max_tokens must be 1..64000 (it bounds the cost estimate)")
        est = self.estimate_usd(model, messages, max_tokens)
        budget = rules.check_job(cfg, order_id, "inference", est)
        sl = rules.ledger(cfg)
        body = json.dumps({"model": model, "messages": messages, "max_tokens": max_tokens, "stream": False, **params}).encode()
        try:
            st, hdrs, raw = self.http("POST", f"{self.base}/chat/completions", headers, body, timeout)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            sl.append(order_id=order_id, kind="inference", usd=est, note=f"{model}: no response ({type(e).__name__}); booked at estimate",
                      source="nearai", meta={"model": model, "cost_source": "estimate", "max_tokens": max_tokens})
            raise InferenceError(f"NEAR AI Cloud unreachable: {e}") from None
        if st != 200:
            # 4xx/5xx: the gateway did not run the model; nothing billed
            raise InferenceError(f"NEAR AI Cloud HTTP {st}: {raw[:300].decode('utf-8', 'replace')}")
        resp = json.loads(raw)
        usage = resp.get("usage") or {}
        pin, pout = self.prices(model)
        list_nano = int(usage.get("prompt_tokens", 0)) * pin + int(usage.get("completion_tokens", 0)) * pout
        choice = (resp.get("choices") or [{}])[0]
        text = (choice.get("message") or {}).get("content") or ""
        finish = choice.get("finish_reason")
        reasoning = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens")
        result = {"text": text, "finish_reason": finish, "truncated": finish == "length", "empty": not text.strip(),
                  "reasoning_tokens": reasoning}
        inference_id = hdrs.get("inference-id")
        billed = self.billed_nano(inference_id) if inference_id else None
        nano, source = (billed, "billing") if billed is not None else (list_nano, "list_price" if usage else "estimate")
        usd = self.nano_to_usd(nano) if usage or billed is not None else est
        rec = sl.append(order_id=order_id, kind="inference", usd=usd, note=f"{model} {usage.get('prompt_tokens', '?')}+{usage.get('completion_tokens', '?')} tok",
                        source="nearai", meta={"model": model, "inference_id": inference_id, "cost_source": source,
                                               "usage": {k: usage.get(k) for k in ("prompt_tokens", "completion_tokens", "total_tokens")},
                                               "estimate_usd": str(est), "list_price_nano": list_nano, "billed_nano": billed,
                                               "finish_reason": finish, "reasoning_tokens": reasoning,
                                               "truncated": result["truncated"], "empty": result["empty"]})
        if result["empty"] or result["truncated"]:
            print(f"WARNING nearai: order {order_id} {model}: {'EMPTY' if result['empty'] else 'TRUNCATED'} completion "
                  f"(finish_reason={finish}, completion_tokens={usage.get('completion_tokens')}, reasoning_tokens={reasoning}); "
                  f"paid ${rec['usd']} for it. Use nearai.text_of() so it can't ship.", file=sys.stderr)
        resp["_rs_result"] = result
        resp["_rs_cost"] = {"usd": rec["usd"], "source": source, "spend_line": rec["line_hash"], "budget_before": budget}
        return resp
