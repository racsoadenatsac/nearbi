// End-to-end through the Hono app: sign in with a local key, subscribe (stub quote), confirm, read gated content.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it } from "vitest";
import { generateTestKey } from "./helpers/keys";
import { base64Decode } from "../src/core/encoding";
import { hashToken } from "../src/core/registry-token";
import { validateRegistryToken } from "../src/services/registry";
import { BASE_USDC, setup, T0 } from "./helpers/app";
import { statusBody } from "./helpers/oneclick";

describe("auth endpoints", () => {
  it("sign-in sets an HttpOnly, Secure, SameSite=Lax session cookie", async () => {
    const { signIn, req, repo } = setup();
    const { res, setCookie, cookie } = await signIn();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accountId: "alice.near" });
    expect(setCookie).toMatch(/^nearbi_session=[^;]+;/);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax"]) expect(setCookie).toContain(attr);
    const me = await (await req("/api/me", { cookie })).json();
    expect(me).toMatchObject({ authenticated: true, accountId: "alice.near", subscription: { status: "none", active: false }, priceUsd: 49 });
    expect(await repo.getAccount("alice.near")).toMatchObject({ lastLoginAt: T0 });
    expect(repo.challenges.size).toBe(0); // nonce burned
  });

  it("refuses a key that is not on the account (RPC check fails)", async () => {
    const { req, json } = setup();
    const key = await generateTestKey();
    const ch = await (await req("/auth/challenge")).json();
    const signature = await key.sign({ message: ch.message, nonce: base64Decode(ch.nonce), recipient: ch.recipient });
    const res = await json("/auth/verify", { accountId: "alice.near", publicKey: key.publicKey, signature, nonce: ch.nonce, message: ch.message, recipient: "nearbi.ai" });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("/api/me is anonymous without a cookie, and ignores forged cookies", async () => {
    const { req } = setup();
    expect(await (await req("/api/me")).json()).toMatchObject({ authenticated: false, accountId: null });
    expect(await (await req("/api/me", { cookie: "nearbi_session=eyJzdWIiOiJib2IubmVhciJ9.AAAA" })).json()).toMatchObject({ authenticated: false });
  });

  it("CSRF: rejects cross-origin and opaque-origin POSTs; accepts the configured app origin behind CloudFront", async () => {
    const { json } = setup();
    expect((await json("/auth/verify", {}, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await json("/auth/verify", {}, { headers: { origin: "null" } })).status).toBe(403);
    // Request host is the API Gateway domain; the browser origin is nearbi.ai.
    const viaCf = await json("/auth/verify", {}, { base: "https://abc123.execute-api.us-east-1.amazonaws.com", headers: { origin: "https://nearbi.ai" } });
    expect(viaCf.status).toBe(400); // passed CSRF, failed validation
  });

  it("origin lock: with ORIGIN_VERIFY_SECRET set, requests without the CloudFront header are refused", async () => {
    const t = setup({ ORIGIN_VERIFY_SECRET: "cf-shared-secret" });
    expect((await t.req("/api/me")).status).toBe(403);
    expect((await t.req("/api/me", { headers: { "x-origin-verify": "wrong" } })).status).toBe(403);
    expect((await t.req("/api/me", { headers: { "x-origin-verify": "cf-shared-secret" } })).status).toBe(200);
  });

  it("logout clears the cookie", async () => {
    const t = setup();
    const { cookie } = await t.signIn();
    const res = await t.json("/auth/logout", {}, { cookie });
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

describe("gating over HTTP", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup({ STATIC_ORIGIN: "https://static.nearbi.ai" });
    t.content.put("reports/near-defi-flows/index.html", "<h1>premium</h1>", "text/html; charset=utf-8");
    t.content.put("reports/near-defi-flows/report.pdf", "%PDF-1.7");
    t.content.put("reports/near-defi-flows/charts/a.png", "png");
  });

  it("free sample is public and points at the static site (never served from the private bucket)", async () => {
    const res = await t.req("/reports/near-users-vs-bots/NEAR-real-users-or-bots.pdf");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://static.nearbi.ai/reports/near-users-vs-bots/NEAR-real-users-or-bots.pdf");
    const noStatic = setup();
    expect((await noStatic.req("/reports/near-users-vs-bots/")).status).toBe(404);
  });

  it("the free thesis is public too and points at the static site", async () => {
    for (const p of ["/reports/near-thesis/", "/reports/near-thesis/dashboard/", "/reports/near-thesis/NEAR-thesis-intents-vs-real-usage.pdf"]) {
      const res = await t.req(p);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`https://static.nearbi.ai${p}`);
    }
    const res = await t.req("/reports/near-thesis");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/reports/near-thesis/");
  });

  it("anonymous visitors are redirected to /login for gated reports and /members", async () => {
    for (const p of ["/reports/near-defi-flows/", "/reports/near-defi-flows/report.pdf", "/members", "/members/container"]) {
      const res = await t.req(p);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`/login?next=${encodeURIComponent(p)}`);
    }
  });

  it("APIs answer 401 / 402 instead of redirecting", async () => {
    expect((await t.json("/billing/checkout", {})).status).toBe(401);
    expect((await t.req("/billing/tokens")).status).toBe(401);
    expect((await t.req("/billing/status/0b6f3a1e-0000-4000-8000-000000000000")).status).toBe(401);
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

  it("subscribers: HTML proxied with private caching, binaries via short-lived presigned redirect", async () => {
    const { cookie } = await t.signIn();
    const { conf } = await t.subscribe(cookie);
    expect(conf.status).toBe(200);

    const html = await t.req("/reports/near-defi-flows/", { cookie });
    expect(html.status).toBe(200);
    expect(await html.text()).toBe("<h1>premium</h1>");
    expect(html.headers.get("cache-control")).toBe("private, no-store");
    expect(html.headers.get("content-type")).toContain("text/html");

    const pdf = await t.req("/reports/near-defi-flows/report.pdf", { cookie });
    expect(pdf.status).toBe(302);
    expect(pdf.headers.get("cache-control")).toBe("private, no-store");
    const loc = new URL(pdf.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://content.test/reports/near-defi-flows/report.pdf");
    expect(Number(loc.searchParams.get("expires"))).toBe(T0 + 300);
    expect(loc.searchParams.get("response-content-type")).toBe("application/pdf");
    expect(loc.searchParams.get("response-content-disposition")).toBe('inline; filename="report.pdf"');

    const png = new URL((await t.req("/reports/near-defi-flows/charts/a.png", { cookie })).headers.get("location")!);
    expect(png.searchParams.get("response-content-type")).toBe("image/png");

    expect((await t.req("/reports/near-defi-flows", { cookie })).headers.get("location")).toBe("/reports/near-defi-flows/");
    expect((await t.req("/reports/does-not-exist/", { cookie })).status).toBe(404);
    expect((await t.req("/reports/near-defi-flows/missing.png", { cookie })).status).toBe(404);
    expect((await t.req("/members/container", { cookie })).status).toBe(200);
  });

  it("presign TTL is configurable", async () => {
    const t2 = setup({ PRESIGN_TTL_SECONDS: "60" });
    t2.content.put("reports/r/x.pdf", "%PDF");
    await t2.repo.putReport({ slug: "r", title: "R", summary: "", publishedAt: "2026-11-01", isFree: false, pdfFile: null });
    const { cookie } = await t2.signIn();
    await t2.subscribe(cookie);
    const loc = new URL((await t2.req("/reports/r/x.pdf", { cookie })).headers.get("location")!);
    expect(Number(loc.searchParams.get("expires"))).toBe(T0 + 60);
  });

  it("access ends when the period ends", async () => {
    const { cookie } = await t.signIn();
    await t.subscribe(cookie);
    t.advance(31 * 86400);
    const again = await t.signIn(); // sessions last 7 days
    expect((await t.req("/reports/near-defi-flows/", { cookie: again.cookie })).status).toBe(302);
    expect((await (await t.req("/api/me", { cookie: again.cookie })).json()).subscription).toMatchObject({ status: "expired", active: false });
  });
});

describe("billing over HTTP", () => {
  it("dry mode (default): checkout returns a real DRY quote, no deposit address, a preview payment", async () => {
    const t = setup({ MONTHLY_PRICE_USD: "99" });
    const { cookie } = await t.signIn();
    const res = await t.json("/billing/checkout", { originAsset: BASE_USDC }, { cookie });
    expect(res.status).toBe(201);
    const co = await res.json();
    expect(co).toMatchObject({ mode: "dry", status: "preview", amountUsd: 99, depositAddress: null, qrSvg: null, origin: { symbol: "USDC", blockchain: "base" } });
    expect(co.amountInFormatted).toMatch(/^\d+\.\d+$/);
    expect(co.quoteId).toMatch(/^[0-9a-f-]{36}$/);
    expect(co.statusLabel).toMatch(/Preview/);
    const sent = t.oneclick.calls.find((c) => c.url.endsWith("/quote"))!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ dry: true, swapType: "EXACT_OUTPUT", amount: "99000000", refundTo: "alice.near", refundType: "INTENTS", recipient: "0".repeat(64) });
    expect(await t.repo.getPayment(co.paymentId)).toMatchObject({ mode: "dry", status: "preview", depositAddress: null, quoteId: co.quoteId, amountIn: co.amountIn });
    // status for a preview never calls 1Click
    const st = await (await t.req(`/billing/status/${co.paymentId}`, { cookie })).json();
    expect(st).toMatchObject({ status: "preview", mode: "dry" });
    expect(t.oneclick.calls.some((c) => c.url.includes("/status"))).toBe(false);
  });

  it("checkout validates input and maps 1Click errors", async () => {
    const t = setup();
    const { cookie } = await t.signIn();
    expect((await t.json("/billing/checkout", {}, { cookie })).status).toBe(400);
    expect((await t.json("/billing/checkout", { originAsset: "nep141:not-listed.near" }, { cookie })).status).toBe(400);
    t.oneclick.on = (_m, url) => (url.pathname.endsWith("/quote") ? new Response(JSON.stringify({ message: "refundTo is not valid" }), { status: 400 }) : undefined);
    const bad = await t.json("/billing/checkout", { originAsset: "nep141:arb.omft.near", refundTo: "0x0000000000000000000000000000000000000bad" }, { cookie });
    expect(bad.status).toBe(422);
    expect((await bad.json()).error).toMatch(/refundTo is not valid/);
    t.oneclick.on = (_m, url) => (url.pathname.endsWith("/quote") ? new Response("{}", { status: 503 }) : undefined);
    expect((await t.json("/billing/checkout", { originAsset: BASE_USDC }, { cookie })).status).toBe(503);
  });

  it("an origin-chain refund address switches refundType to ORIGIN_CHAIN", async () => {
    const t = setup();
    const { cookie } = await t.signIn();
    await t.json("/billing/checkout", { originAsset: "nep141:arb.omft.near", refundTo: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D" }, { cookie });
    expect(t.oneclick.calls.find((c) => c.url.endsWith("/quote"))!.body).toMatchObject({ refundTo: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D", refundType: "ORIGIN_CHAIN" });
  });

  it("GET /billing/tokens lists the live (recorded) 1Click tokens, popular first", async () => {
    const t = setup();
    const { cookie } = await t.signIn();
    const r = await (await t.req("/billing/tokens", { cookie })).json();
    expect(r.mode).toBe("dry");
    expect(r.settlement).toMatchObject({ symbol: "USDC", blockchain: "near" });
    expect(r.tokens.length).toBeGreaterThan(100);
    expect(r.tokens[0]).toMatchObject({ symbol: "USDC", blockchain: "near", popular: true });
    await t.req("/billing/tokens", { cookie });
    expect(t.oneclick.calls.filter((c) => c.url.endsWith("/tokens"))).toHaveLength(1); // cached
  });

  it("the checkout page loads for a signed-in non-subscriber and shows the preview banner in dry mode", async () => {
    const t = setup();
    expect((await t.req("/members/checkout")).status).toBe(302);
    const { cookie } = await t.signIn();
    const res = await t.req("/members/checkout", { cookie });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Preview: payments not enabled yet");
    expect(html).toContain('data-mode="dry"');
    expect(html).toContain("/js/checkout.js");
    const live = setup({ INTENTS_MODE: "live", SETTLEMENT_RECIPIENT: "treasury.nearbi.near" });
    const c2 = (await live.signIn()).cookie;
    const liveHtml = await (await live.req("/members/checkout", { cookie: c2 })).text();
    expect(liveHtml).not.toContain("Preview: payments not enabled yet");
    expect(liveHtml).toContain("Payments settle as USDC on NEAR into an onchain revenue splitter");
    expect(liveHtml).toContain('href="/ledger/"');
    expect(liveHtml).toContain('data-mode="live"');
    expect(html).not.toContain("live-note");
  });

  it("confirm requires the admin token", async () => {
    const t = setup();
    const { cookie } = await t.signIn();
    const co = await (await t.json("/billing/checkout", { originAsset: BASE_USDC }, { cookie })).json();
    for (const auth of [undefined, "Bearer wrong", "test-admin-token"]) {
      const res = await t.json("/billing/confirm", { paymentId: co.paymentId, txHash: "x" }, { headers: auth ? { authorization: auth } : {} });
      expect(res.status).toBe(403);
    }
    expect((await t.json("/billing/confirm", { paymentId: co.paymentId, txHash: "x" }, { cookie })).status).toBe(403);
    expect((await t.json("/billing/confirm", { paymentId: 1 }, { headers: { authorization: "Bearer test-admin-token" } })).status).toBe(400);
  });

  it("confirm extends by one month and is idempotent", async () => {
    const t = setup();
    const { cookie } = await t.signIn();
    const { co, conf } = await t.subscribe(cookie, "tx-a");
    expect(await conf.json()).toMatchObject({ ok: true, alreadyPaid: false, currentPeriodEnd: "2026-12-02T00:00:00.000Z" });
    const again = await t.json("/billing/confirm", { paymentId: co.paymentId, txHash: "tx-a" }, { headers: { authorization: "Bearer test-admin-token" } });
    expect(await again.json()).toMatchObject({ alreadyPaid: true, currentPeriodEnd: "2026-12-02T00:00:00.000Z" });
    expect((await (await t.req("/api/me", { cookie })).json()).subscription).toEqual({ status: "active", active: true, currentPeriodEnd: "2026-12-02T00:00:00.000Z" });
  });
});

describe("live 1Click flow over HTTP (synthetic deposit + status built from recorded fixtures)", () => {
  it("checkout -> deposit address + QR -> poll -> SUCCESS -> subscription active, once", async () => {
    const t = setup({ INTENTS_MODE: "live", SETTLEMENT_RECIPIENT: "treasury.nearbi.near" });
    const { cookie } = await t.signIn();
    const co = await (await t.json("/billing/checkout", { originAsset: BASE_USDC }, { cookie })).json();
    expect(co).toMatchObject({ mode: "live", status: "pending" });
    expect(co.depositAddress).toBeTruthy();
    expect(co.qrSvg).toContain("<svg");

    const poll = async () => {
      t.advance(10);
      return (await t.req(`/billing/status/${co.paymentId}`, { cookie })).json();
    };
    expect((await poll()).status).toBe("pending");
    t.oneclick.statuses.set(co.depositAddress, statusBody("PROCESSING", t.oneclick.issued.get(co.depositAddress)!));
    expect((await poll()).status).toBe("processing");
    t.oneclick.statuses.set(co.depositAddress, statusBody("SUCCESS", t.oneclick.issued.get(co.depositAddress)!));
    expect((await poll()).status).toBe("paid");
    const me1 = (await (await t.req("/api/me", { cookie })).json()).subscription;
    expect(me1).toMatchObject({ status: "active", active: true });
    await poll();
    expect((await (await t.req("/api/me", { cookie })).json()).subscription).toEqual(me1);

    // someone else can't read it
    const other = await t.signIn("mallory.near");
    expect((await t.req(`/billing/status/${co.paymentId}`, { cookie: other.cookie })).status).toBe(404);
    expect((await t.req(`/billing/status/not-a-uuid`, { cookie })).status).toBe(404);
  });
});

describe("registry tokens over HTTP", () => {
  it("issues a token, stores only its sha256, expires at period end, revokes the previous one", async () => {
    const t = setup();
    const { cookie } = await t.signIn();
    await t.subscribe(cookie);
    const r1 = await (await t.json("/registry/token", {}, { cookie })).json();
    expect(r1.token).toMatch(/^nbr_[A-Za-z0-9_-]{43}$/);
    expect(r1.expiresAt).toBe("2026-12-02T00:00:00.000Z");
    expect(r1.instructions[0]).toBe(`echo '${r1.token}' | docker login registry.nearbi.ai -u alice.near --password-stdin`);
    expect([...t.repo.tokens.keys()]).toEqual([await hashToken(r1.token)]);
    expect(JSON.stringify([...t.repo.tokens.values()])).not.toContain(r1.token);

    expect(await validateRegistryToken(t.repo, r1.token, T0)).toBe("alice.near");
    const r2 = await (await t.json("/registry/token", {}, { cookie })).json();
    expect(await validateRegistryToken(t.repo, r1.token, T0)).toBeNull();
    expect(await validateRegistryToken(t.repo, r2.token, T0)).toBe("alice.near");
    expect(await validateRegistryToken(t.repo, r2.token, T0 + 31 * 86400)).toBeNull();
  });
});

describe("misc", () => {
  it("unknown API paths answer JSON 404, pages answer HTML 404", async () => {
    const t = setup();
    expect(await (await t.req("/api/nope")).json()).toEqual({ error: "not found" });
    const page = await t.req("/nope");
    expect(page.status).toBe(404);
    expect(await page.text()).toContain("Not found");
  });
  it("/login only accepts local next paths", async () => {
    const t = setup();
    expect(await (await t.req("/login?next=//evil.example")).text()).toContain('value="/members"');
    expect(await (await t.req("/login?next=/reports/x/")).text()).toContain('value="/reports/x/"');
  });
});
