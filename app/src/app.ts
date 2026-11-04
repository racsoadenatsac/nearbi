// Hono application. Runtime-agnostic: storage, content, clock and external calls are injected, so the
// same app runs on AWS Lambda (src/lambda.ts), in local dev (src/dev.ts) and in tests (app.request()).
//
// Behind CloudFront the public static site (./public in S3) is served directly; only dynamic paths and
// gated reports reach this app (see README "CloudFront routing").

import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { rpcKeyCheck } from "./adapters/near-rpc";
import type { Config } from "./config";
import { sha256, timingSafeEqual, utf8 } from "./core/encoding";
import { decide, parseReportPath, requiredAccess } from "./core/gating";
import { clearSessionCookie, SESSION_COOKIE, SESSION_TTL_SECONDS, sessionCookie, signSession, verifySession } from "./core/session";
import { newChallenge, verifySignIn, type KeyCheckFn } from "./core/signin";
import { deliveredReportSlug, isOneOff, isProductId, validateBrief, type Product } from "./core/products";
import { subscriptionState, type SubscriptionState } from "./core/subscription";
import { IntentsAdapter, OneClickClient } from "./intents";
import { checkoutPage, containerPage, loginPage, membersPage, messagePage } from "./pages";
import type { ContentStore } from "./ports/content";
import type { Repository } from "./ports/repository";
import { CheckoutError, confirmPayment, createCheckout, listPaymentTokens, pollPaymentStatus, type BillingDeps } from "./services/billing";
import { orderJson, updateOrderAdmin } from "./services/orders";
import { issueRegistryToken } from "./services/registry";

export interface AppDeps {
  config: Config;
  repo: Repository;
  content: ContentStore;
  now?: () => number; // unix seconds
  /** NEAR Intents 1Click adapter; built from config.intents when omitted. */
  intents?: IntentsAdapter;
  keyCheck?: KeyCheckFn;
}

type Vars = { accountId: string | null; sub: SubscriptionState | null; contentPrefix?: string };
type C = Context<{ Variables: Vars }>;

const API_PREFIXES = ["/api/", "/auth/", "/billing/", "/registry/"];
const isApi = (path: string) => API_PREFIXES.some((p) => path.startsWith(p));

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  css: "text/css",
  json: "application/json",
  csv: "text/csv",
};

export function createApp(deps: AppDeps) {
  const { config, repo, content } = deps;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const intents = deps.intents ?? createIntentsAdapter(config);
  const billing: BillingDeps = { repo, intents, config: config.intents };
  const keyCheck = deps.keyCheck ?? rpcKeyCheck(config.nearRpcUrl);

  const app = new Hono<{ Variables: Vars }>();

  // --- Origin lock: when CloudFront is the only intended entry point it adds a secret header.
  if (config.originVerifySecret) {
    const expected = config.originVerifySecret;
    app.use("*", async (c, next) => {
      if (!(await constantTimeEquals(c.req.header("x-origin-verify") ?? "", expected))) return c.text("Forbidden", 403);
      await next();
    });
  }

  // --- CSRF: state-changing requests must come from our own origin (SameSite=Lax already blocks most of this).
  // Behind CloudFront the Host seen here is the API Gateway / Function URL host, so allowed origins are configured.
  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      if (origin !== undefined && !isAllowedOrigin(origin, c.req.url, config.appOrigins)) {
        return c.json({ error: "cross-origin request" }, 403);
      }
    }
    await next();
  });

  // --- Session + subscription, then the gate.
  app.use("*", async (c, next) => {
    const t = now();
    const s = await verifySession(config.sessionSecret, getCookie(c, SESSION_COOKIE), t);
    c.set("accountId", s?.sub ?? null);
    c.set("sub", s ? subscriptionState(await repo.getSubscription(s.sub), t) : null);

    const path = new URL(c.req.url).pathname;
    const access = requiredAccess(path, config.freeReportSlugs);
    const d = decide(access, c.get("accountId"), c.get("sub"));
    const report = access !== "public" ? parseReportPath(path) : null;
    if (report && c.get("accountId")) {
      // Signed in, gated report path: resolve what the slug is before deciding (signed-out visitors fall
      // through to the login redirect below for every gated path, so nothing about the slug leaks).
      const a = await reportAccess(c.get("accountId")!, c.get("sub"), report.slug);
      if (a.allow) {
        c.set("contentPrefix", a.contentPrefix);
        return next();
      }
      if (a.reason === "not_found") return notFound(c);
      return c.redirect(`/members?subscribe=1`, 302);
    }
    if (d.allow) return next();
    if (isApi(path)) {
      return d.reason === "login" ? c.json({ error: "sign in required" }, 401) : c.json({ error: "active subscription required" }, 402);
    }
    // Keep the query string (e.g. /members/checkout?product=quick_answer) through sign-in.
    if (d.reason === "login") return c.redirect(`/login?next=${encodeURIComponent(path + new URL(c.req.url).search)}`, 302);
    return c.redirect(`/members?subscribe=1`, 302);
  });

  /**
   * Who may open /reports/<slug>/ (signed in, non-free slug):
   * - an order deliverable: only the account behind the delivered order (or, with shared:true on the order,
   *   active subscribers too); everyone else gets 404 so its existence doesn't leak;
   * - a subscriber catalog report: active subscribers, or the buyer of a delivered order linking to it;
   *   other signed-in visitors are sent to subscribe;
   * - anything else: 404, except for the buyer of a delivered order whose delivery link points at it.
   */
  async function reportAccess(
    accountId: string,
    sub: SubscriptionState | null,
    slug: string,
  ): Promise<{ allow: true; contentPrefix: string } | { allow: false; reason: "not_found" | "subscribe" }> {
    const own = await repo.getOrderByDeliverable(slug);
    if (own?.deliverable) {
      const delivered = own.status === "delivered";
      const ok = delivered && (own.accountId === accountId || (own.shared && !!sub?.active));
      return ok ? { allow: true, contentPrefix: own.deliverable.contentPrefix } : { allow: false, reason: "not_found" };
    }
    const contentPrefix = `reports/${slug}/`;
    const catalogued = await repo.getReport(slug);
    if (catalogued && sub?.active) return { allow: true, contentPrefix };
    if (await hasDeliveredReport(accountId, slug)) return { allow: true, contentPrefix };
    return catalogued ? { allow: false, reason: "subscribe" } : { allow: false, reason: "not_found" };
  }

  async function hasDeliveredReport(accountId: string, slug: string): Promise<boolean> {
    const orders = await repo.listOrders(accountId);
    return orders.some((o) => o.status === "delivered" && deliveredReportSlug(o.deliveryUrl, config.appOrigins) === slug);
  }

  // ---------------------------------------------------------------- auth
  app.get("/auth/challenge", async (c) => {
    const ch = newChallenge(config.authRecipient, now());
    await repo.putChallenge({ nonce: ch.nonce, message: ch.message, expiresAt: ch.expiresAt });
    return c.json(ch, 200, { "cache-control": "no-store" });
  });

  app.post("/auth/verify", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const r = await verifySignIn(body, {
      expectedRecipient: config.authRecipient,
      nowSec: now(),
      consumeChallenge: (nonce) => repo.consumeChallenge(nonce),
      keyCheck,
    });
    if (!r.ok) return c.json({ error: r.error }, r.status);
    const t = now();
    await repo.recordLogin(r.accountId, t);
    const token = await signSession(config.sessionSecret, { sub: r.accountId, pk: r.publicKey, iat: t, exp: t + SESSION_TTL_SECONDS });
    c.header("set-cookie", sessionCookie(token));
    return c.json({ ok: true, accountId: r.accountId }, 200, { "cache-control": "no-store" });
  });

  app.post("/auth/logout", (c) => {
    c.header("set-cookie", clearSessionCookie());
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- api
  app.get("/api/me", (c) => {
    const sub = c.get("sub");
    return c.json(
      {
        authenticated: !!c.get("accountId"),
        accountId: c.get("accountId"),
        subscription: sub ? { ...sub, currentPeriodEnd: sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd * 1000).toISOString() : null } : null,
        priceUsd: config.monthlyPriceUsd,
        products: Object.fromEntries(Object.values(config.products).map((p) => [p.id, { name: p.name, priceUsd: p.priceUsd, kind: p.kind }])),
      },
      200,
      { "cache-control": "no-store" },
    );
  });

  /** ?product= / body.product -> catalog entry. Missing: subscription. Unknown: null. */
  const resolveProduct = (v: unknown): Product | null => (v === undefined || v === null || v === "" ? config.products.subscription : isProductId(v) ? config.products[v] : null);

  // ---------------------------------------------------------------- billing
  // Tokens the user can pay with: the live 1Click list (cached per execution environment).
  app.get("/billing/tokens", async (c) => {
    const product = resolveProduct(c.req.query("product"));
    if (!product) return c.json({ error: "unknown product" }, 400);
    try {
      const tokens = await listPaymentTokens(intents);
      const settlement = await intents.findToken(config.intents.settlementAsset);
      return c.json(
        {
          mode: config.intents.mode,
          product: product.id,
          priceUsd: product.priceUsd,
          settlement: settlement ? { assetId: settlement.assetId, symbol: settlement.symbol, blockchain: settlement.blockchain } : null,
          tokens,
        },
        200,
        { "cache-control": "private, max-age=300" },
      );
    } catch (e) {
      console.warn(`1click tokens: ${(e as Error).message}`);
      return c.json({ error: "token list unavailable, try again" }, 503);
    }
  });

  app.post("/billing/checkout", async (c) => {
    // Any amount/price field in the body is ignored: the price comes from the server-side catalog only.
    const body = (await c.req.json().catch(() => ({}))) as { originAsset?: unknown; refundTo?: unknown; product?: unknown; brief?: unknown };
    const product = resolveProduct(body.product);
    if (!product) return c.json({ error: "unknown product" }, 400);
    if (typeof body.originAsset !== "string" || !body.originAsset) return c.json({ error: "originAsset required (pick a token)" }, 400);
    if (body.refundTo !== undefined && body.refundTo !== "" && typeof body.refundTo !== "string") return c.json({ error: "refundTo must be a string" }, 400);
    let brief = null;
    if (isOneOff(product.id)) {
      const b = validateBrief(product.id, body.brief);
      if (!b.ok) return c.json({ error: b.error }, 400);
      brief = b.brief;
    }
    try {
      const co = await createCheckout(billing, {
        accountId: c.get("accountId")!,
        product,
        brief,
        nowSec: now(),
        originAsset: body.originAsset,
        refundTo: typeof body.refundTo === "string" && body.refundTo.trim() ? body.refundTo : undefined,
      });
      return c.json(co, 201, { "cache-control": "no-store" });
    } catch (e) {
      if (e instanceof CheckoutError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });

  // Poller for the checkout page. Live payments: asks 1Click and extends the subscription on SUCCESS.
  app.get("/billing/status/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/.test(id)) return c.json({ error: "payment not found" }, 404);
    const r = await pollPaymentStatus(billing, id, c.get("accountId")!, now());
    if (!r.ok) return c.json({ error: r.error }, r.status);
    return c.json(r.view, 200, { "cache-control": "no-store" });
  });

  // Admin override: mark a payment paid by hand (e.g. a deposit 1Click reported late, or a comp).
  // The normal path is GET /billing/status/:id seeing 1Click SUCCESS.
  app.post("/billing/confirm", async (c) => {
    if (!(await constantTimeBearer(c.req.header("authorization"), config.adminToken))) return c.json({ error: "forbidden" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { paymentId?: unknown; txHash?: unknown };
    if (typeof body.paymentId !== "string" || typeof body.txHash !== "string" || !body.paymentId || !body.txHash) {
      return c.json({ error: "paymentId and txHash required" }, 400);
    }
    const r = await confirmPayment(repo, body.paymentId, body.txHash, now());
    if (!r.ok) return c.json({ error: r.error }, r.status);
    return c.json({ ...r, currentPeriodEnd: r.currentPeriodEnd === null ? null : new Date(r.currentPeriodEnd * 1000).toISOString() });
  });

  // The signed-in account's one-off orders (also rendered on /members).
  app.get("/billing/orders", async (c) => {
    const orders = await repo.listOrders(c.get("accountId")!);
    return c.json({ orders: orders.map(orderJson) }, 200, { "cache-control": "no-store" });
  });

  // Admin / agent: orders awaiting delivery (status paid or in_progress), oldest first. Used by bin/list-orders --api.
  app.get("/billing/admin/orders", async (c) => {
    if (!(await constantTimeBearer(c.req.header("authorization"), config.adminToken))) return c.json({ error: "forbidden" }, 403);
    const orders = await repo.listOpenOrders(500);
    return c.json({ orders: orders.map(orderJson) }, 200, { "cache-control": "no-store" });
  });

  // Admin / agent: move an order along (paid -> in_progress -> delivered) and set its delivery link.
  app.post("/billing/admin/orders/:id", async (c) => {
    if (!(await constantTimeBearer(c.req.header("authorization"), config.adminToken))) return c.json({ error: "forbidden" }, 403);
    const body = await c.req.json().catch(() => ({}));
    const r = await updateOrderAdmin(repo, c.req.param("id"), body, now(), { freeSlugs: config.freeReportSlugs });
    if (!r.ok) return c.json({ error: r.error }, r.status);
    return c.json({ ok: true, order: orderJson(r.order) }, 200, { "cache-control": "no-store" });
  });

  // ---------------------------------------------------------------- registry
  app.post("/registry/token", async (c) => {
    const sub = c.get("sub")!;
    const issued = await issueRegistryToken(repo, {
      accountId: c.get("accountId")!,
      expiresAt: sub.currentPeriodEnd!,
      nowSec: now(),
      registryHost: config.registryHost,
    });
    return c.json({ ...issued, expiresAt: new Date(issued.expiresAt * 1000).toISOString() }, 201, { "cache-control": "no-store" });
  });

  // ---------------------------------------------------------------- pages
  app.get("/login", (c) => {
    const next = c.req.query("next") ?? "/members";
    return c.html(loginPage(next.startsWith("/") && !next.startsWith("//") ? next : "/members"), 200, { "cache-control": "no-store" });
  });

  app.get("/members", async (c) => {
    const orders = await repo.listOrders(c.get("accountId")!);
    // The catalog never lists order deliverables (they live on the order); this filter is only belt and braces.
    const reports = (await repo.listReports()).filter((r) => !orders.some((o) => o.deliverable?.slug === r.slug));
    const ownedSlugs = orders
      .filter((o) => o.status === "delivered")
      .map((o) => deliveredReportSlug(o.deliveryUrl, config.appOrigins))
      .filter((s): s is string => !!s);
    return c.html(
      membersPage({
        accountId: c.get("accountId")!,
        sub: c.get("sub")!,
        priceUsd: config.monthlyPriceUsd,
        reports,
        ownedSlugs,
        orders,
        products: config.products,
        paymentsLive: config.intents.mode === "live",
      }),
      200,
      { "cache-control": "no-store" },
    );
  });

  app.get("/members/checkout", (c) => {
    const product = resolveProduct(c.req.query("product"));
    if (!product) {
      const [html, status] = messagePage(
        "Unknown product",
        'We sell a <a href="/members/checkout?product=quick_answer">Quick Answer</a>, a <a href="/members/checkout?product=deep_dive">Deep Dive</a> and the <a href="/members/checkout">subscription</a>.',
        c.get("accountId"),
        400,
      );
      return c.html(html, status as 400);
    }
    return c.html(
      checkoutPage({ accountId: c.get("accountId")!, sub: c.get("sub")!, product, priceUsd: config.monthlyPriceUsd, mode: config.intents.mode }),
      200,
      { "cache-control": "no-store" },
    );
  });

  app.get("/members/container", (c) =>
    c.html(containerPage({ accountId: c.get("accountId")!, sub: c.get("sub")!, registryHost: config.registryHost }), 200, {
      "cache-control": "no-store",
    }),
  );

  // ---------------------------------------------------------------- reports
  // HTML is read from S3 and returned by the app (same origin, so relative chart/PDF links resolve back
  // here and stay gated). Every other file answers 302 to a short-lived presigned S3 GET URL.
  app.get("/reports/*", async (c) => {
    const url = new URL(c.req.url);
    const r = parseReportPath(url.pathname);
    if (!r) return notFound(c);
    if (!url.pathname.endsWith("/") && r.file === "index.html") return c.redirect(`/reports/${r.slug}/`, 301);
    if (config.freeReportSlugs.includes(r.slug)) {
      // Normally served by CloudFront from the static bucket and never routed here.
      return config.staticOrigin ? c.redirect(config.staticOrigin + url.pathname, 302) : notFound(c);
    }
    // The gate resolved where this report's files live (order deliverables may use their own prefix).
    const prefix = c.get("contentPrefix");
    if (!prefix) return notFound(c);
    const key = prefix + r.file;
    const ext = r.file.split(".").pop()!.toLowerCase();
    const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
    const privateHeaders = { "cache-control": "private, no-store", "x-robots-tag": "noindex" };

    if (ext === "html") {
      const obj = await content.getText(key);
      if (!obj) return notFound(c);
      const headers: Record<string, string> = { ...privateHeaders, "content-type": obj.contentType ?? contentType };
      if (obj.etag) headers.etag = obj.etag;
      return c.body(obj.body, 200, headers);
    }

    if (!(await content.exists(key))) return notFound(c);
    const fileName = r.file.split("/").pop()!.replace(/["\\\r\n]/g, "");
    const signed = await content.presignGet(key, {
      expiresInSeconds: config.presignTtlSeconds,
      contentType,
      contentDisposition: ext === "pdf" ? `inline; filename="${fileName}"` : undefined,
    });
    return c.body(null, 302, { ...privateHeaders, location: signed, "referrer-policy": "no-referrer" });
  });

  app.notFound((c) => notFound(c));
  app.onError((err, c) => {
    console.error(err);
    return isApi(new URL(c.req.url).pathname) ? c.json({ error: "internal error" }, 500) : c.text("Internal error", 500);
  });

  return app;
}

export function createIntentsAdapter(config: Config): IntentsAdapter {
  const client = new OneClickClient({ baseUrl: config.intents.baseUrl, jwt: config.intents.jwt });
  return new IntentsAdapter(client, { settlementAsset: config.intents.settlementAsset, slippageBps: config.intents.slippageBps });
}

function notFound(c: C) {
  if (isApi(new URL(c.req.url).pathname)) return c.json({ error: "not found" }, 404);
  const [html, status] = messagePage("Not found", 'That page does not exist. <a href="/">Back to NearBI</a>.', c.get("accountId"), 404);
  return c.html(html, status as 404);
}

function isAllowedOrigin(origin: string, requestUrl: string, allowed: string[]): boolean {
  if (allowed.includes(origin.replace(/\/+$/, ""))) return true;
  try {
    return new URL(origin).host === new URL(requestUrl).host; // direct access (no CloudFront), e.g. local dev
  } catch {
    return false; // includes the opaque origin "null"
  }
}

async function constantTimeEquals(given: string, expected: string): Promise<boolean> {
  if (!expected) return false;
  const [a, b] = await Promise.all([sha256(utf8.encode(given)), sha256(utf8.encode(expected))]);
  return timingSafeEqual(a, b);
}

async function constantTimeBearer(header: string | undefined, expected: string): Promise<boolean> {
  if (!header || !header.startsWith("Bearer ")) return false;
  return constantTimeEquals(header.slice(7), expected);
}
