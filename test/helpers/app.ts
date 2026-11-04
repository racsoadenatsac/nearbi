// Test harness: the real Hono app with in-memory storage/content, a fake chain and a controllable clock.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { MemoryContentStore } from "../../src/adapters/memory-content";
import { MemoryRepository } from "../../src/adapters/memory-repository";
import { createApp } from "../../src/app";
import { SEED_REPORTS } from "../../src/catalog";
import { loadConfig, type Config } from "../../src/config";
import { base64Decode } from "../../src/core/encoding";
import { IntentsAdapter, OneClickClient } from "../../src/intents";
import { generateTestKey } from "./keys";
import { fakeOneClick } from "./oneclick";

export const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";

export const SUBSCRIBER_REPORT = { slug: "near-defi-flows", title: "NEAR DeFi flows", summary: "Subscriber report", publishedAt: "2026-11-01", isFree: false, pdfFile: "report.pdf" };

export const T0 = Math.floor(Date.parse("2026-11-02T00:00:00Z") / 1000);
export const ORIGIN = "https://nearbi.ai";
export const TEST_ENV = { SESSION_SECRET: "test-session-secret-0123456789abcdef", ADMIN_TOKEN: "test-admin-token", APP_ORIGIN: ORIGIN };

export function setup(env: Record<string, string> = {}) {
  let clock = T0;
  const config: Config = loadConfig({ ...TEST_ENV, ...env });
  // near-defi-flows: a subscriber-only catalog report used by the gating tests.
  const repo = new MemoryRepository({ reports: [...SEED_REPORTS, SUBSCRIBER_REPORT] });
  const content = new MemoryContentStore("https://content.test", () => clock);
  const ownedKeys = new Map<string, string>(); // publicKey -> accountId: our fake chain state
  const oneclick = fakeOneClick(); // recorded 1Click fixtures, no network
  const intents = new IntentsAdapter(new OneClickClient({ fetch: oneclick.fetch, sleep: async () => {} }), {
    settlementAsset: config.intents.settlementAsset,
    nowMs: () => clock * 1000,
  });
  const app = createApp({
    config,
    repo,
    content,
    now: () => clock,
    intents,
    keyCheck: async (accountId, publicKey) =>
      ownedKeys.get(publicKey) === accountId ? { ok: true, permission: "FullAccess" } : { ok: false, reason: "UNKNOWN_ACCESS_KEY" },
  });
  const req = (path: string, init: RequestInit & { cookie?: string; base?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set("cookie", init.cookie);
    return app.request((init.base ?? ORIGIN) + path, { ...init, headers });
  };
  const json = (path: string, body: unknown, init: RequestInit & { cookie?: string; base?: string } = {}) =>
    req(path, { method: "POST", ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) }, body: JSON.stringify(body) });

  async function signIn(accountId = "alice.near") {
    const key = await generateTestKey();
    ownedKeys.set(key.publicKey, accountId);
    const ch = await (await req("/auth/challenge")).json();
    const signature = await key.sign({ message: ch.message, nonce: base64Decode(ch.nonce), recipient: ch.recipient });
    const res = await json("/auth/verify", { accountId, publicKey: key.publicKey, signature, nonce: ch.nonce, message: ch.message, recipient: "nearbi.ai" });
    const setCookie = res.headers.get("set-cookie") ?? "";
    return { res, key, cookie: setCookie.split(";")[0], setCookie };
  }

  async function subscribe(cookie: string, tx = "tx-" + Math.random()) {
    const co = await (await json("/billing/checkout", { originAsset: BASE_USDC }, { cookie })).json();
    const conf = await json("/billing/confirm", { paymentId: co.paymentId, txHash: tx }, { headers: { authorization: "Bearer test-admin-token" } });
    return { co, conf };
  }

  return { app, config, repo, content, req, json, signIn, subscribe, advance: (s: number) => (clock += s), now: () => clock, ownedKeys, oneclick, intents };
}
