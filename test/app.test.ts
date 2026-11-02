// End-to-end through the Hono app: sign in with a local key, subscribe (stub quote), confirm, read gated content.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { base64Decode } from "../src/lib/encoding";
import { hashToken, validateRegistryToken } from "../src/registry";
import { stubQuoteDeposit } from "../src/billing/intents";
import { createTestEnv } from "./helpers/env";
import { generateTestKey } from "./helpers/keys";

const T0 = Math.floor(Date.parse("2026-11-02T00:00:00Z") / 1000);
const ORIGIN = "https://nearbi.ai";

function setup() {
  let clock = T0;
  const ctx = createTestEnv();
  const ownedKeys = new Map<string, string>(); // publicKey -> accountId, i.e. our fake chain state
  const app = createApp({
    now: () => clock,
    quoteDeposit: stubQuoteDeposit,
    keyCheck: () => async (accountId, publicKey) =>
      ownedKeys.get(publicKey) === accountId ? { ok: true, permission: "FullAccess" } : { ok: false, reason: "UNKNOWN_ACCESS_KEY" },
  });
  const req = (path: string, init: RequestInit & { cookie?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set("cookie", init.cookie);
    return app.request(ORIGIN + path, { ...init, headers }, ctx.env);
  };
  const json = (path: string, body: unknown, init: RequestInit & { cookie?: string } = {}) =>
    req(path, { method: "POST", ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) }, body: JSON.stringify(body) });

  async function signIn(accountId = "alice.near") {
    const key = await generateTestKey();
    ownedKeys.set(key.publicKey, accountId);
    const ch = await (await req("/auth/challenge")).json<any>();
    const signature = await key.sign({ message: ch.message, nonce: base64Decode(ch.nonce), recipient: ch.recipient });
    const res = await json("/auth/verify", { accountId, publicKey: key.publicKey, signature, nonce: ch.nonce, message: ch.message, recipient: "nearbi.ai" });
    const setCookie = res.headers.get("set-cookie") ?? "";
    return { res, key, cookie: setCookie.split(";")[0], setCookie };
  }

  async function subscribe(cookie: string, tx = "tx-" + Math.random()) {
    const co = await (await json("/billing/checkout", {}, { cookie })).json<any>();
    const conf = await json("/billing/confirm", { paymentId: co.paymentId, txHash: tx }, { headers: { authorization: "Bearer test-admin-token" } });
    return { co, conf };
  }

  return { ctx, req, json, signIn, subscribe, advance: (s: number) => (clock += s), ownedKeys };
}

describe("auth endpoints", () => {
  it("sign-in sets an HttpOnly, Secure, SameSite=Lax session cookie", async () => {
    const { signIn, req } = setup();
    const { res, setCookie, cookie } = await signIn();
    expect(res.status).toBe(200);
    expect(await res.json<any>()).toEqual({ ok: true, accountId: "alice.near" });
    expect(setCookie).toMatch(/^nearbi_session=[^;]+;/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    const me = await (await req("/api/me", { cookie })).json<any>();
    expect(me).toMatchObject({ authenticated: true, accountId: "alice.near", subscription: { status: "none", active: false }, priceUsd: 49 });
  });

  it("refuses a key that is not on the account (RPC check fails)", async () => {
    const { req, json } = setup();
    const key = await generateTestKey(); // never registered in ownedKeys
    const ch = await (await req("/auth/challenge")).json<any>();
    const signature = await key.sign({ message: ch.message, nonce: base64Decode(ch.nonce), recipient: ch.recipient });
    const res = await json("/auth/verify", { accountId: "alice.near", publicKey: key.publicKey, signature, nonce: ch.nonce, message: ch.message, recipient: "nearbi.ai" });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("/api/me is anonymous without a cookie, and ignores forged cookies", async () => {
    const { req } = setup();
    expect(await (await req("/api/me")).json<any>()).toMatchObject({ authenticated: false, accountId: null });
    expect(await (await req("/api/me", { cookie: "nearbi_session=eyJzdWIiOiJib2IubmVhciJ9.AAAA" })).json<any>()).toMatchObject({ authenticated: false });
  });

  it("rejects cross-origin POSTs", async () => {
    const { json } = setup();
    const res = await json("/auth/verify", {}, { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
});

describe("gating over HTTP", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    t.ctx.CONTENT.store.set("reports/near-defi-flows/index.html", { body: "<h1>premium</h1>" });
    t.ctx.CONTENT.store.set("reports/near-defi-flows/report.pdf", { body: "%PDF-1.7" });
  });

  it("free sample is served from static assets, no sign-in needed", async () => {
    const res = await t.req("/reports/near-users-vs-bots/NEAR-real-users-or-bots.pdf");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-from")).toBe("assets");
  });

  it("anonymous visitors are redirected to /login for gated reports and /members", async () => {
    for (const p of ["/reports/near-defi-flows/", "/members", "/members/container"]) {
      const res = await t.req(p);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`/login?next=${encodeURIComponent(p)}`);
    }
  });

  it("APIs answer 401 / 402 instead of redirecting", async () => {
    expect((await t.json("/billing/checkout", {})).status).toBe(401);
    expect((await t.json("/registry/token", {})).status).toBe(401);
    const { cookie } = await t.signIn();
    expect((await t.json("/registry/token", {}, { cookie })).status).toBe(402);
  });

  it("signed-in non-subscribers see /members but are sent to subscribe for gated content", async () => {
    const { cookie } = await t.signIn();
    const members = await t.req("/members", { cookie });
    expect(members.status).toBe(200);
    const html = await members.text();
    expect(html).toContain("No subscription");
    expect(html).toContain("Subscribe: $49/month");
    expect(html).toContain("NEAR activity: real users or bots?");
    const gated = await t.req("/reports/near-defi-flows/", { cookie });
    expect(gated.status).toBe(302);
    expect(gated.headers.get("location")).toBe("/members?subscribe=1");
  });

  it("subscribers get gated HTML and PDFs from R2 with private caching", async () => {
    const { cookie } = await t.signIn();
    const { conf } = await t.subscribe(cookie);
    expect(conf.status).toBe(200);
    const html = await t.req("/reports/near-defi-flows/", { cookie });
    expect(html.status).toBe(200);
    expect(await html.text()).toBe("<h1>premium</h1>");
    expect(html.headers.get("cache-control")).toBe("private, no-store");
    const pdf = await t.req("/reports/near-defi-flows/report.pdf", { cookie });
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect((await t.req("/reports/near-defi-flows", { cookie })).headers.get("location")).toBe("/reports/near-defi-flows/");
    expect((await t.req("/reports/does-not-exist/", { cookie })).status).toBe(404);
    expect((await t.req("/members/container", { cookie })).status).toBe(200);
  });

  it("access ends when the period ends", async () => {
    const { cookie } = await t.signIn();
    await t.subscribe(cookie);
    t.advance(31 * 86400);
    // session cookies last 7 days, so sign in again after a month
    const again = await t.signIn();
    expect((await t.req("/reports/near-defi-flows/", { cookie: again.cookie })).status).toBe(302);
    const me = await (await t.req("/api/me", { cookie: again.cookie })).json<any>();
    expect(me.subscription).toMatchObject({ status: "expired", active: false });
  });
});

describe("billing over HTTP", () => {
  it("checkout returns a STUB deposit address and the env price", async () => {
    const t = setup();
    t.ctx.env.MONTHLY_PRICE_USD = "99";
    const { cookie } = await t.signIn();
    const res = await t.json("/billing/checkout", {}, { cookie });
    expect(res.status).toBe(201);
    const co = await res.json<any>();
    expect(co).toMatchObject({ amountUsd: 99, stub: true });
    expect(co.depositAddress).toContain("STUB");
  });

  it("confirm requires the admin token", async () => {
    const t = setup();
    const { cookie } = await t.signIn();
    const co = await (await t.json("/billing/checkout", {}, { cookie })).json<any>();
    for (const auth of [undefined, "Bearer wrong", "test-admin-token"]) {
      const res = await t.json("/billing/confirm", { paymentId: co.paymentId, txHash: "x" }, { headers: auth ? { authorization: auth } : {} });
      expect(res.status).toBe(403);
    }
    // a subscriber session is not an admin either
    const res = await t.json("/billing/confirm", { paymentId: co.paymentId, txHash: "x" }, { cookie });
    expect(res.status).toBe(403);
  });

  it("confirm extends by one month and is idempotent", async () => {
    const t = setup();
    const { cookie } = await t.signIn();
    const { co, conf } = await t.subscribe(cookie, "tx-a");
    expect(await conf.json<any>()).toMatchObject({ ok: true, alreadyPaid: false, currentPeriodEnd: "2026-12-02T00:00:00.000Z" });
    const again = await t.json("/billing/confirm", { paymentId: co.paymentId, txHash: "tx-a" }, { headers: { authorization: "Bearer test-admin-token" } });
    expect(await again.json<any>()).toMatchObject({ alreadyPaid: true, currentPeriodEnd: "2026-12-02T00:00:00.000Z" });
    const me = await (await t.req("/api/me", { cookie })).json<any>();
    expect(me.subscription).toEqual({ status: "active", active: true, currentPeriodEnd: "2026-12-02T00:00:00.000Z" });
  });
});

describe("registry tokens over HTTP", () => {
  it("issues a token, stores only its sha256, expires at period end, revokes the previous one", async () => {
    const t = setup();
    const { cookie } = await t.signIn();
    await t.subscribe(cookie);
    const r1 = await (await t.json("/registry/token", {}, { cookie })).json<any>();
    expect(r1.token).toMatch(/^nbr_[A-Za-z0-9_-]{43}$/);
    expect(r1.expiresAt).toBe("2026-12-02T00:00:00.000Z");
    expect(r1.instructions[0]).toBe(`echo '${r1.token}' | docker login registry.nearbi.ai -u alice.near --password-stdin`);

    const rows = (await t.ctx.DB.prepare("SELECT * FROM registry_tokens").all<Record<string, unknown>>()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(await hashToken(r1.token));
    expect(JSON.stringify(rows)).not.toContain(r1.token);

    expect(await validateRegistryToken(t.ctx.DB, r1.token, T0)).toBe("alice.near");
    const r2 = await (await t.json("/registry/token", {}, { cookie })).json<any>();
    expect(await validateRegistryToken(t.ctx.DB, r1.token, T0)).toBeNull(); // revoked
    expect(await validateRegistryToken(t.ctx.DB, r2.token, T0)).toBe("alice.near");
    expect(await validateRegistryToken(t.ctx.DB, r2.token, T0 + 31 * 86400)).toBeNull(); // expired
  });
});
