// Hono application. Static files in ./public are served by the assets binding before this runs;
// everything else (auth, billing, gated content, dynamic pages) lands here.

import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { createChallenge, rpcKeyCheck, verifySignIn } from "./auth/service";
import type { KeyCheck } from "./auth/near-rpc";
import { clearSessionCookie, SESSION_COOKIE, SESSION_TTL_SECONDS, sessionCookie, signSession, verifySession } from "./auth/session";
import { quoteDeposit as defaultQuote, type QuoteDepositFn } from "./billing/intents";
import {
  confirmPayment,
  createCheckout,
  getSubscription,
  subscriptionState,
  upsertAccountLogin,
  type SubscriptionState,
} from "./billing/subscription";
import { type Env, freeSlug, monthlyPriceUsd, recipient, registryHost } from "./env";
import { decide, parseReportPath, requiredAccess } from "./gating";
import { sha256, timingSafeEqual, utf8 } from "./lib/encoding";
import { containerPage, loginPage, membersPage, messagePage, type ReportListItem } from "./pages";
import { issueRegistryToken } from "./registry";

export interface AppDeps {
  now?: () => number; // unix seconds
  quoteDeposit?: QuoteDepositFn;
  keyCheck?: (env: Env) => (accountId: string, publicKey: string) => Promise<KeyCheck>;
}

type Vars = { accountId: string | null; sub: SubscriptionState | null };
type C = Context<{ Bindings: Env; Variables: Vars }>;

const API_PREFIXES = ["/api/", "/auth/", "/billing/", "/registry/"];
const isApi = (path: string) => API_PREFIXES.some((p) => path.startsWith(p));

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  svg: "image/svg+xml",
  css: "text/css",
  json: "application/json",
  csv: "text/csv",
};

export function createApp(deps: AppDeps = {}) {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const quote = deps.quoteDeposit ?? defaultQuote;
  const keyCheckFor = deps.keyCheck ?? ((env: Env) => rpcKeyCheck(env.NEAR_RPC_URL));

  const app = new Hono<{ Bindings: Env; Variables: Vars }>();

  // --- CSRF: state-changing requests must be same-origin (SameSite=Lax already blocks most of this).
  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      if (origin && new URL(origin).host !== new URL(c.req.url).host) return c.json({ error: "cross-origin request" }, 403);
    }
    await next();
  });

  // --- Session + subscription, then the gate.
  app.use("*", async (c, next) => {
    const s = await verifySession(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE), now());
    c.set("accountId", s?.sub ?? null);
    c.set("sub", s ? subscriptionState(await getSubscription(c.env.DB, s.sub), now()) : null);

    const path = new URL(c.req.url).pathname;
    const d = decide(requiredAccess(path, freeSlug(c.env)), c.get("accountId"), c.get("sub"));
    if (d.allow) return next();
    if (isApi(path)) {
      return d.reason === "login"
        ? c.json({ error: "sign in required" }, 401)
        : c.json({ error: "active subscription required" }, 402);
    }
    if (d.reason === "login") return c.redirect(`/login?next=${encodeURIComponent(path)}`, 302);
    return c.redirect(`/members?subscribe=1`, 302);
  });

  // ---------------------------------------------------------------- auth
  app.get("/auth/challenge", async (c) => {
    const ch = await createChallenge(c.env.DB, recipient(c.env), now());
    return c.json(ch, 200, { "cache-control": "no-store" });
  });

  app.post("/auth/verify", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const r = await verifySignIn(body, {
      db: c.env.DB,
      expectedRecipient: recipient(c.env),
      nowSec: now(),
      keyCheck: keyCheckFor(c.env),
    });
    if (!r.ok) return c.json({ error: r.error }, r.status as 400 | 401);
    const t = now();
    await upsertAccountLogin(c.env.DB, r.accountId, t);
    const token = await signSession(c.env.SESSION_SECRET, { sub: r.accountId, pk: r.publicKey, iat: t, exp: t + SESSION_TTL_SECONDS });
    c.header("set-cookie", sessionCookie(token));
    return c.json({ ok: true, accountId: r.accountId });
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
        subscription: sub
          ? { ...sub, currentPeriodEnd: sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd * 1000).toISOString() : null }
          : null,
        priceUsd: monthlyPriceUsd(c.env),
      },
      200,
      { "cache-control": "no-store" },
    );
  });

  // ---------------------------------------------------------------- billing
  app.post("/billing/checkout", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { originAsset?: string; refundTo?: string };
    const co = await createCheckout(
      c.env.DB,
      {
        accountId: c.get("accountId")!,
        amountUsd: monthlyPriceUsd(c.env),
        nowSec: now(),
        originAsset: typeof body.originAsset === "string" ? body.originAsset : undefined,
        refundTo: typeof body.refundTo === "string" ? body.refundTo : undefined,
      },
      quote,
    );
    return c.json(co, 201);
  });

  // Internal: mark a payment paid. Will be replaced by 1Click status polling (see billing/intents.ts).
  app.post("/billing/confirm", async (c) => {
    if (!(await isAdmin(c))) return c.json({ error: "forbidden" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { paymentId?: string; txHash?: string };
    if (!body.paymentId || !body.txHash) return c.json({ error: "paymentId and txHash required" }, 400);
    const r = await confirmPayment(c.env.DB, body.paymentId, body.txHash, now());
    if (!r.ok) return c.json({ error: r.error }, r.status as 404 | 409);
    return c.json({ ...r, currentPeriodEnd: new Date(r.currentPeriodEnd * 1000).toISOString() });
  });

  // ---------------------------------------------------------------- registry
  app.post("/registry/token", async (c) => {
    const sub = c.get("sub")!;
    const issued = await issueRegistryToken(c.env.DB, {
      accountId: c.get("accountId")!,
      expiresAt: sub.currentPeriodEnd!,
      nowSec: now(),
      registryHost: registryHost(c.env),
    });
    return c.json({ ...issued, expiresAt: new Date(issued.expiresAt * 1000).toISOString() }, 201, { "cache-control": "no-store" });
  });

  // ---------------------------------------------------------------- pages
  app.get("/login", (c) => {
    const next = c.req.query("next") ?? "/members";
    return c.html(loginPage(next.startsWith("/") && !next.startsWith("//") ? next : "/members"));
  });

  app.get("/members", async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT slug, title, summary, published_at, is_free, pdf_file FROM reports ORDER BY published_at DESC, slug",
    ).all<ReportListItem>();
    return c.html(
      membersPage({ accountId: c.get("accountId")!, sub: c.get("sub")!, priceUsd: monthlyPriceUsd(c.env), reports: results }),
      200,
      { "cache-control": "no-store" },
    );
  });

  app.get("/members/container", (c) =>
    c.html(containerPage({ accountId: c.get("accountId")!, sub: c.get("sub")!, registryHost: registryHost(c.env) }), 200, {
      "cache-control": "no-store",
    }),
  );

  // ---------------------------------------------------------------- reports
  app.get("/reports/*", async (c) => {
    const url = new URL(c.req.url);
    const r = parseReportPath(url.pathname);
    if (!r) return notFound(c);
    // /reports/<slug> -> /reports/<slug>/ so relative chart/PDF links resolve.
    if (!url.pathname.endsWith("/") && r.file === "index.html") return c.redirect(`/reports/${r.slug}/`, 301);
    if (r.slug === freeSlug(c.env)) return c.env.ASSETS.fetch(c.req.raw); // free sample lives in public/
    const obj = await c.env.CONTENT.get(`reports/${r.slug}/${r.file}`);
    if (!obj) return notFound(c);
    const ext = r.file.split(".").pop()!.toLowerCase();
    const headers = new Headers({
      "content-type": obj.httpMetadata?.contentType ?? CONTENT_TYPES[ext] ?? "application/octet-stream",
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex",
    });
    if (ext === "pdf") headers.set("content-disposition", `inline; filename="${r.file.split("/").pop()}"`);
    if (obj.httpEtag) headers.set("etag", obj.httpEtag);
    return new Response(obj.body, { headers });
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

async function isAdmin(c: C): Promise<boolean> {
  const expected = c.env.ADMIN_TOKEN;
  const auth = c.req.header("authorization") ?? "";
  if (!expected || !auth.startsWith("Bearer ")) return false;
  const [a, b] = await Promise.all([sha256(utf8.encode(auth.slice(7))), sha256(utf8.encode(expected))]);
  return timingSafeEqual(a, b);
}
