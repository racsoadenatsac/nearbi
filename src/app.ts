// Hono application. Runtime-agnostic: storage, content, clock and external calls are injected, so the
// same app runs on AWS Lambda (src/lambda.ts), in local dev (src/dev.ts) and in tests (app.request()).
//
// Behind CloudFront the public static site (./public in S3) is served directly; only dynamic paths and
// gated reports reach this app (see README "CloudFront routing").

import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { quoteDeposit as defaultQuote, type QuoteDepositFn } from "./adapters/intents";
import { rpcKeyCheck } from "./adapters/near-rpc";
import type { Config } from "./config";
import { sha256, timingSafeEqual, utf8 } from "./core/encoding";
import { decide, parseReportPath, reportObjectKey, requiredAccess } from "./core/gating";
import { clearSessionCookie, SESSION_COOKIE, SESSION_TTL_SECONDS, sessionCookie, signSession, verifySession } from "./core/session";
import { newChallenge, verifySignIn, type KeyCheckFn } from "./core/signin";
import { subscriptionState, type SubscriptionState } from "./core/subscription";
import { containerPage, loginPage, membersPage, messagePage } from "./pages";
import type { ContentStore } from "./ports/content";
import type { Repository } from "./ports/repository";
import { confirmPayment, createCheckout } from "./services/billing";
import { issueRegistryToken } from "./services/registry";

export interface AppDeps {
  config: Config;
  repo: Repository;
  content: ContentStore;
  now?: () => number; // unix seconds
  quoteDeposit?: QuoteDepositFn;
  keyCheck?: KeyCheckFn;
}

type Vars = { accountId: string | null; sub: SubscriptionState | null };
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
  const quote = deps.quoteDeposit ?? defaultQuote;
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
    const d = decide(requiredAccess(path, config.freeReportSlug), c.get("accountId"), c.get("sub"));
    if (d.allow) return next();
    if (isApi(path)) {
      return d.reason === "login" ? c.json({ error: "sign in required" }, 401) : c.json({ error: "active subscription required" }, 402);
    }
    if (d.reason === "login") return c.redirect(`/login?next=${encodeURIComponent(path)}`, 302);
    return c.redirect(`/members?subscribe=1`, 302);
  });

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
      },
      200,
      { "cache-control": "no-store" },
    );
  });

  // ---------------------------------------------------------------- billing
  app.post("/billing/checkout", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { originAsset?: string; refundTo?: string };
    const co = await createCheckout(
      repo,
      {
        accountId: c.get("accountId")!,
        amountUsd: config.monthlyPriceUsd,
        nowSec: now(),
        originAsset: typeof body.originAsset === "string" ? body.originAsset : undefined,
        refundTo: typeof body.refundTo === "string" ? body.refundTo : undefined,
      },
      quote,
    );
    return c.json(co, 201, { "cache-control": "no-store" });
  });

  // Internal: mark a payment paid. To be replaced by 1Click status polling (see adapters/intents.ts).
  app.post("/billing/confirm", async (c) => {
    if (!(await constantTimeBearer(c.req.header("authorization"), config.adminToken))) return c.json({ error: "forbidden" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { paymentId?: unknown; txHash?: unknown };
    if (typeof body.paymentId !== "string" || typeof body.txHash !== "string" || !body.paymentId || !body.txHash) {
      return c.json({ error: "paymentId and txHash required" }, 400);
    }
    const r = await confirmPayment(repo, body.paymentId, body.txHash, now());
    if (!r.ok) return c.json({ error: r.error }, r.status);
    return c.json({ ...r, currentPeriodEnd: new Date(r.currentPeriodEnd * 1000).toISOString() });
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

  app.get("/members", async (c) =>
    c.html(
      membersPage({ accountId: c.get("accountId")!, sub: c.get("sub")!, priceUsd: config.monthlyPriceUsd, reports: await repo.listReports() }),
      200,
      { "cache-control": "no-store" },
    ),
  );

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
    if (r.slug === config.freeReportSlug) {
      // Normally served by CloudFront from the static bucket and never routed here.
      return config.staticOrigin ? c.redirect(config.staticOrigin + url.pathname, 302) : notFound(c);
    }
    const key = reportObjectKey(r.slug, r.file);
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
