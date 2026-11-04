"""Egress for subprocesses: which ones go through the gateway's secret egress proxy and which go direct.

The gateway exec environment sets HTTPS_PROXY / HTTP_PROXY / NODE_USE_ENV_PROXY (and SSL_CERT_FILE etc. pointing
at a trust bundle with the proxy's TLS-intercepting CA). The proxy exists for one thing: swapping the real
NEAR_AI_CLOUD_API_KEY into requests to cloud-api.near.ai. Everything else needs no proxied secret, and some
clients don't trust the proxy CA:

  near-cli-rs (rustls platform verifier)  "invalid peer certificate: UnknownIssuer" on every RPC call
  aws CLI aws-crt S3 client               rejects the proxy CA (rs-ledger bin/publish)

So:
  direct_env()  for near-cli-rs and `aws` (NEAR RPC, DynamoDB, STS, S3): proxy variables removed
  os.environ    for NEAR AI Cloud (rs_agent.nearai, in-process urllib) and for anything that may call it
                (bin/write-report, bin/record-cost run by the order loop): unchanged, stays proxied

The CA-bundle variables (SSL_CERT_FILE, ...) are kept: the bundle also holds the public roots, so direct TLS
still verifies. RS_AGENT_NEAR_CLI_PROXY=1 keeps the proxy for these subprocesses too (debugging only).
"""
from __future__ import annotations

import os
from typing import Mapping, Optional

_NAMES = ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NODE_USE_ENV_PROXY")
PROXY_VARS = tuple(n for name in _NAMES for n in (name, name.lower()))
KEEP_PROXY_FLAG = "RS_AGENT_NEAR_CLI_PROXY"


def direct_env(base: Optional[Mapping[str, str]] = None, **overrides: str) -> dict:
    """A copy of `base` (default os.environ) without the egress-proxy variables, plus `overrides`.
    For near-cli-rs and aws CLI subprocesses only: never for anything that talks to NEAR AI Cloud."""
    src = dict(os.environ if base is None else base)
    env = src if src.get(KEEP_PROXY_FLAG) == "1" else {k: v for k, v in src.items() if k.upper() not in _NAMES}
    env.update(overrides)
    return env
