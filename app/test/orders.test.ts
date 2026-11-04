// One-off reports over HTTP: Quick Answer / Deep Dive checkout with a brief, SUCCESS -> ORDER, the members
// orders list and the admin order endpoints.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { BASE_USDC, setup, T0 } from "./helpers/app";
import { statusBody } from "./helpers/oneclick";

const LIVE = { INTENTS_MODE: "live", SETTLEMENT_RECIPIENT: "forwarder.nearbi.near" };
const ADMIN = { authorization: "Bearer test-admin-token" };
const brief = { question: "How many accounts used NEAR Intents last week, excluding bots?", contact: "@alice_near" };

async function order(t: ReturnType<typeof setup>, cookie: string, product = "quick_answer", extra: Record<string, unknown> = {}) {
  return t.json("/billing/checkout", { product, originAsset: BASE_USDC, brief, ...extra }, { cookie });
}

async function paidOrder(t: ReturnType<typeof setup>, cookie: string, product = "quick_answer") {
  const co = await (await order(t, cookie, product)).json();
  t.oneclick.statuses.set(co.depositAddress, statusBody("SUCCESS", t.oneclick.issued.get(co.depositAddress)!));
  t.advance(10);
  const st = await (await t.req(`/billing/status/${co.paymentId}`, { cookie })).json();
  return { co, st };
}

describe("product price resolution over HTTP", () => {
  it("the price comes from the catalog; amounts in the request body are ignored", async () => {
    const t = setup(LIVE);
    const { cookie } = await t.signIn();
    const res = await order(t, cookie, "quick_answer", { amountUsd: 1, priceUsd: 1, amount: "1000000", price: 1 });
    expect(res.status).toBe(201);
    const co = await res.json();
    expect(co).toMatchObject({ product: "quick_answer", amountUsd: 29, mode: "live", status: "pending" });
    const sent = t.oneclick.calls.find((c) => c.url.endsWith("/quote"))!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ swapType: "EXACT_OUTPUT", amount: "29000000", recipient: "forwarder.nearbi.near", dry: false });
    expect(await t.repo.getPayment(co.paymentId)).toMatchObject({ amountUsd: 29, amountOut: "29000000", product: "quick_answer" });
  });

  it("deep_dive quotes 499 USDC; no product means the subscription (49); env overrides the prices", async () => {
    const t = setup({ ...LIVE, DEEP_DIVE_PRICE_USD: "650" });
    const { cookie } = await t.signIn();
    const dd = await (await order(t, cookie, "deep_dive", { brief: { ...brief, scope: "Intents, last 30 days" } })).json();
    expect(dd).toMatchObject({ product: "deep_dive", amountUsd: 650 });
    const sub = await (await t.json("/billing/checkout", { originAsset: BASE_USDC, amountUsd: 1 }, { cookie })).json();
    expect(sub).toMatchObject({ product: "subscription", amountUsd: 49 });
    const amounts = t.oneclick.calls.filter((c) => c.url.endsWith("/quote")).map((c) => (c.body as any).amount);
    expect(amounts).toEqual(["650000000", "49000000"]);
    expect(await t.repo.getPayment(sub.paymentId)).toMatchObject({ product: "subscription", brief: null });
  });

  it("unknown products are refused (checkout, tokens, page)", async () => {
    const t = setup();
    const { cookie } = await t.signIn();
    for (const product of ["ecosystem", "free", "__proto__", 5]) {
      expect((await order(t, cookie, product as string)).status).toBe(400);
    }
    expect((await t.req("/billing/tokens?product=ecosystem", { cookie })).status).toBe(400);
    expect((await t.req("/members/checkout?product=ecosystem", { cookie })).status).toBe(400);
    expect(t.oneclick.calls.filter((c) => c.url.endsWith("/quote"))).toHaveLength(0);
  });

  it("GET /billing/tokens and /api/me report per-product prices", async () => {
    const t = setup();
    const { cookie } = await t.signIn();
    expect(await (await t.req("/billing/tokens?product=deep_dive", { cookie })).json()).toMatchObject({ product: "deep_dive", priceUsd: 499 });
    expect(await (await t.req("/billing/tokens", { cookie })).json()).toMatchObject({ product: "subscription", priceUsd: 49 });
    expect((await (await t.req("/api/me")).json()).products).toEqual({
      subscription: { name: "Subscription", priceUsd: 49, kind: "subscription" },
      quick_answer: { name: "Quick Answer", priceUsd: 29, kind: "one_off" },
      deep_dive: { name: "Deep Dive", priceUsd: 499, kind: "one_off" },
    });
  });
});

describe("brief validation over HTTP", () => {
  it("one-off checkout needs a valid brief; nothing is quoted otherwise", async () => {
    const t = setup(LIVE);
    const { cookie } = await t.signIn();
    const cases: [unknown, RegExp][] = [
      [undefined, /brief required/],
      [{}, /question required/],
      [{ question: "  " }, /question required/],
      [{ question: "q".repeat(2001) }, /too long/],
      [{ question: "q", contact: "not a contact" }, /email address or a Telegram handle/],
      [{ question: "q", contact: "a".repeat(201) }, /too long/],
      [{ question: 5 }, /must be text/],
    ];
    for (const [b, err] of cases) {
      const res = await t.json("/billing/checkout", { product: "quick_answer", originAsset: BASE_USDC, brief: b }, { cookie });
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect((await res.json()).error).toMatch(err);
    }
    expect(t.oneclick.calls.filter((c) => c.url.endsWith("/quote"))).toHaveLength(0);
    expect(t.repo.payments.size).toBe(0);
  });

  it("stores the cleaned brief on the payment (scope only for deep_dive)", async () => {
    const t = setup(LIVE);
    const { cookie } = await t.signIn();
    const qa = await (await order(t, cookie, "quick_answer", { brief: { question: "  Q1?  ", contact: "me@example.com", scope: "dropped" } })).json();
    expect((await t.repo.getPayment(qa.paymentId))!.brief).toEqual({ question: "Q1?", contact: "me@example.com", scope: null });
    const dd = await (await order(t, cookie, "deep_dive", { brief: { question: "Q2?", scope: "DeFi" } })).json();
    expect((await t.repo.getPayment(dd.paymentId))!.brief).toEqual({ question: "Q2?", contact: null, scope: "DeFi" });
  });
});

describe("one-off SUCCESS over HTTP", () => {
  it("creates an ORDER, queues the forward, does not extend the subscription; polling again changes nothing", async () => {
    const t = setup(LIVE);
    const { cookie } = await t.signIn();
    const { co, st } = await paidOrder(t, cookie);
    expect(st).toMatchObject({ status: "paid", product: "quick_answer", statusLabel: expect.stringMatching(/order/) });
    expect(await t.repo.getOrder(co.paymentId)).toMatchObject({ status: "paid", product: "quick_answer", accountId: "alice.near", amountUsd: 29, brief: { question: brief.question, contact: "@alice_near", scope: null } });
    expect((await (await t.req("/api/me", { cookie })).json()).subscription).toMatchObject({ status: "none", active: false });
    expect(await t.repo.listForwardQueue(10)).toEqual([expect.objectContaining({ paymentId: co.paymentId, amount: "29000000" })]);
    // gated content stays gated
    expect((await t.req("/reports/near-defi-flows/", { cookie })).status).toBe(302);
    t.advance(10);
    await t.req(`/billing/status/${co.paymentId}`, { cookie });
    expect(t.repo.orders.size).toBe(1);
    expect(t.repo.forwardQueue.size).toBe(1);
  });
});

describe("members orders list", () => {
  it("shows the account's orders with status and delivery link; other accounts' orders are not shown", async () => {
    const t = setup(LIVE);
    const alice = await t.signIn();
    const empty = await (await t.req("/members", { cookie: alice.cookie })).text();
    expect(empty).toContain("Your orders");
    expect(empty).toContain("No orders yet.");
    expect(empty).toContain('href="/members/checkout?product=quick_answer"');

    const { co: first } = await paidOrder(t, alice.cookie, "quick_answer");
    t.advance(100);
    const { co: second } = await paidOrder(t, alice.cookie, "deep_dive");
    const mallory = await t.signIn("mallory.near");
    await paidOrder(t, mallory.cookie, "quick_answer");

    let html = await (await t.req("/members", { cookie: alice.cookie })).text();
    expect(html).toContain("Quick Answer");
    expect(html).toContain("Deep Dive");
    expect(html).toContain(first.paymentId);
    expect(html).toContain(second.paymentId);
    expect(html.indexOf(second.paymentId)).toBeLessThan(html.indexOf(first.paymentId)); // newest first
    expect(html).toContain(">Paid<");
    expect(html).toContain(new Date((T0 + 10) * 1000).toISOString().slice(0, 10));

    const own = await (await t.req("/billing/orders", { cookie: alice.cookie })).json();
    expect(own.orders.map((o: any) => o.orderId)).toEqual([second.paymentId, first.paymentId]);
    expect((await (await t.req("/billing/orders", { cookie: mallory.cookie })).json()).orders).toHaveLength(1);
    expect((await t.req("/billing/orders")).status).toBe(401);

    await t.json(`/billing/admin/orders/${first.paymentId}`, { status: "delivered", deliveryUrl: "/reports/qa-alice-1/" }, { headers: ADMIN });
    await t.json(`/billing/admin/orders/${second.paymentId}`, { status: "in_progress" }, { headers: ADMIN });
    html = await (await t.req("/members", { cookie: alice.cookie })).text();
    expect(html).toContain('<a class="btn pri" href="/reports/qa-alice-1/" rel="noopener">Open delivery</a>');
    expect(html).toContain(">Delivered<");
    expect(html).toContain(">In progress<");
  });

  it("escapes the brief on the members page", async () => {
    const t = setup(LIVE);
    const { cookie } = await t.signIn();
    const co = await (await order(t, cookie, "quick_answer", { brief: { question: "<script>alert(1)</script>" } })).json();
    await t.json("/billing/confirm", { paymentId: co.paymentId, txHash: "tx-x" }, { headers: ADMIN });
    const html = await (await t.req("/members", { cookie })).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("admin order endpoints", () => {
  it("require the admin token (bearer), not a session", async () => {
    const t = setup(LIVE);
    const { cookie } = await t.signIn();
    const { co } = await paidOrder(t, cookie);
    for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: "test-admin-token" }] as Record<string, string>[]) {
      expect((await t.req("/billing/admin/orders", { headers })).status).toBe(403);
      expect((await t.json(`/billing/admin/orders/${co.paymentId}`, { status: "in_progress" }, { headers })).status).toBe(403);
    }
    expect((await t.req("/billing/admin/orders", { cookie })).status).toBe(403);
    expect((await t.repo.getOrder(co.paymentId))!.status).toBe("paid");
  });

  it("lists open orders oldest first with the brief; delivered ones drop off", async () => {
    const t = setup(LIVE);
    const { cookie } = await t.signIn();
    const { co: a } = await paidOrder(t, cookie, "quick_answer");
    t.advance(60);
    const { co: b } = await paidOrder(t, cookie, "deep_dive");
    let list = (await (await t.req("/billing/admin/orders", { headers: ADMIN })).json()).orders;
    expect(list.map((o: any) => [o.orderId, o.product, o.status])).toEqual([[a.paymentId, "quick_answer", "paid"], [b.paymentId, "deep_dive", "paid"]]);
    expect(list[0]).toMatchObject({ accountId: "alice.near", amountUsd: 29, brief: { question: brief.question, contact: "@alice_near" }, deliveryUrl: null });
    await t.json(`/billing/admin/orders/${a.paymentId}`, { status: "delivered", deliveryUrl: "https://nearbi.ai/reports/qa-1/" }, { headers: ADMIN });
    list = (await (await t.req("/billing/admin/orders", { headers: ADMIN })).json()).orders;
    expect(list.map((o: any) => o.orderId)).toEqual([b.paymentId]);
  });

  it("validates status and delivery URL; delivered needs a link", async () => {
    const t = setup(LIVE);
    const { cookie } = await t.signIn();
    const { co } = await paidOrder(t, cookie);
    const post = (body: unknown, id = co.paymentId) => t.json(`/billing/admin/orders/${id}`, body, { headers: ADMIN });
    expect((await post({ status: "shipped" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ deliveryUrl: "javascript:alert(1)" })).status).toBe(400);
    expect((await post({ deliveryUrl: "http://insecure.example/x" })).status).toBe(400);
    expect((await post({ status: "delivered" })).status).toBe(400);
    expect((await post({ status: "in_progress" }, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await post({ status: "in_progress" }, "nope")).status).toBe(404);

    const r1 = await (await post({ status: "in_progress" })).json();
    expect(r1).toMatchObject({ ok: true, order: { status: "in_progress", deliveryUrl: null } });
    await post({ deliveryUrl: "/reports/qa-1/" }); // link first, status unchanged
    expect(await t.repo.getOrder(co.paymentId)).toMatchObject({ status: "in_progress", deliveryUrl: "/reports/qa-1/" });
    const r2 = await (await post({ status: "delivered" })).json(); // stored link is enough
    expect(r2.order).toMatchObject({ status: "delivered", deliveryUrl: "/reports/qa-1/" });
    expect((await t.repo.getOrder(co.paymentId))!.updatedAt).toBe(t.now());
    // payment and subscription untouched by order updates
    expect((await t.repo.getPayment(co.paymentId))!.status).toBe("paid");
    expect(await t.repo.getSubscription("alice.near")).toBeNull();
  });
});

describe("checkout page per product", () => {
  it("signed out: redirects to /login keeping ?product in next", async () => {
    const t = setup();
    const res = await t.req("/members/checkout?product=quick_answer");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/login?next=${encodeURIComponent("/members/checkout?product=quick_answer")}`);
    const login = await (await t.req(res.headers.get("location")!)).text();
    expect(login).toContain('value="/members/checkout?product=quick_answer"');
  });

  it("one-off pages carry the product, the brief form and the delivery time; the subscription page has no brief", async () => {
    const t = setup(LIVE);
    const { cookie } = await t.signIn();
    const qa = await (await t.req("/members/checkout?product=quick_answer", { cookie })).text();
    expect(qa).toContain("Order a Quick Answer: $29");
    expect(qa).toContain('data-product="quick_answer"');
    expect(qa).toContain('id="brief-question"');
    expect(qa).toContain('maxlength="2000"');
    expect(qa).toContain("within 24 hours");
    expect(qa).not.toContain('id="brief-scope"');
    expect(qa).toContain("does not start or extend a subscription");
    const dd = await (await t.req("/members/checkout?product=deep_dive", { cookie })).text();
    expect(dd).toContain("Order a Deep Dive: $499");
    expect(dd).toContain('id="brief-scope"');
    expect(dd).toContain("within 48 hours");
    const sub = await (await t.req("/members/checkout", { cookie })).text();
    expect(sub).toContain("Subscribe: $49/month");
    expect(sub).toContain('data-product="subscription"');
    expect(sub).not.toContain('id="brief"');
  });
});

describe("delivered order opens its report", () => {
  it("the buyer can read /reports/<slug>/ once delivered; others and undelivered orders can't", async () => {
    const t = setup(LIVE);
    t.content.put("reports/qa-alice-1/index.html", "<h1>Your answer</h1>", "text/html; charset=utf-8");
    const alice = await t.signIn();
    const { co } = await paidOrder(t, alice.cookie);
    const bob = await t.signIn("bob.near");
    expect((await t.req("/reports/qa-alice-1/", { cookie: alice.cookie })).status).toBe(404); // paid, not delivered
    await t.json(`/billing/admin/orders/${co.paymentId}`, { status: "in_progress", deliveryUrl: "https://nearbi.ai/reports/qa-alice-1/" }, { headers: ADMIN });
    expect((await t.req("/reports/qa-alice-1/", { cookie: alice.cookie })).status).toBe(404); // link set but not delivered
    await t.json(`/billing/admin/orders/${co.paymentId}`, { status: "delivered" }, { headers: ADMIN });
    const ok = await t.req("/reports/qa-alice-1/", { cookie: alice.cookie });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("Your answer");
    expect((await t.req("/reports/qa-alice-1/", { cookie: bob.cookie })).status).toBe(404);
    expect((await t.req("/reports/qa-alice-1/")).headers.get("location")).toMatch(/^\/login\?next=/);
    expect((await t.req("/reports/near-defi-flows/", { cookie: alice.cookie })).headers.get("location")).toBe("/members?subscribe=1"); // only that report
    expect((await t.req("/registry/token", { method: "POST", cookie: alice.cookie })).status).toBe(402); // still no subscription
  });

  it("an order deliverable is buyer-only: buyer 200 on html/pdf/chart; subscribers and others 404; signed out to login", async () => {
    const t = setup(LIVE);
    const slug = "qa-buyer-only";
    t.content.put(`reports/${slug}/index.html`, "<h1>Answer</h1>", "text/html; charset=utf-8");
    t.content.put(`reports/${slug}/REPORT.pdf`, "%PDF", "application/pdf");
    t.content.put(`reports/${slug}/charts/c2.png`, "png", "image/png");
    const buyer = await t.signIn();
    const subscriber = await t.signIn("bob.near");
    await t.subscribe(subscriber.cookie);
    const stranger = await t.signIn("carol.near");
    const { co } = await paidOrder(t, buyer.cookie);
    const deliverable = { slug, title: "Buyer's own title", summary: "Buyer's own answer", pdfFile: "REPORT.pdf" };
    const up = await t.json(`/billing/admin/orders/${co.paymentId}`, { status: "delivered", deliverable }, { headers: ADMIN });
    expect(up.status).toBe(200);
    expect((await up.json()).order).toMatchObject({ deliveryUrl: `/reports/${slug}/`, shared: false, deliverable: { ...deliverable, contentPrefix: `reports/${slug}/` } });

    const html = await t.req(`/reports/${slug}/`, { cookie: buyer.cookie });
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("Answer");
    for (const f of ["REPORT.pdf", "charts/c2.png"]) {
      const r = await t.req(`/reports/${slug}/${f}`, { cookie: buyer.cookie });
      expect(r.status).toBe(302);
      expect(new URL(r.headers.get("location")!).pathname).toBe(`/reports/${slug}/${f}`); // presigned content, not the gate
    }
    for (const p of [`/reports/${slug}/`, `/reports/${slug}/REPORT.pdf`, `/reports/${slug}/charts/c2.png`, `/reports/${slug}`]) {
      for (const who of [subscriber, stranger]) expect((await t.req(p, { cookie: who.cookie })).status).toBe(404);
      const anon = await t.req(p);
      expect(anon.status).toBe(302);
      expect(anon.headers.get("location")).toBe(`/login?next=${encodeURIComponent(p)}`);
    }
    // Free reports stay public for everyone.
    for (const p of ["/reports/near-users-vs-bots/", "/reports/near-thesis/"]) {
      expect((await setup({ STATIC_ORIGIN: "https://static.nearbi.ai" }).req(p)).status).toBe(302); // to the static site (200 there)
    }

    // Members page: the buyer sees it under "Your orders" with an Open report button and no lock; nobody else sees it.
    const mine = await (await t.req("/members", { cookie: buyer.cookie })).text();
    const orders = mine.slice(mine.indexOf('id="orders"'), mine.indexOf('<h2 class="sec">Reports'));
    expect(orders).toContain(`<a class="btn pri" href="/reports/${slug}/">Open report</a>`);
    expect(orders).toContain("Buyer&#39;s own title");
    expect(orders).toContain(`/reports/${slug}/REPORT.pdf`);
    expect(orders).not.toContain("🔒");
    for (const who of [subscriber, stranger]) {
      const theirs = await (await t.req("/members", { cookie: who.cookie })).text();
      expect(theirs).not.toContain(slug);
      expect(theirs).not.toContain("Buyer&#39;s own");
    }
  });

  it("an undelivered deliverable is 404 even for the buyer; shared:true opens it to active subscribers only", async () => {
    const t = setup(LIVE);
    const slug = "qa-shared";
    t.content.put(`reports/${slug}/index.html`, "<h1>S</h1>", "text/html; charset=utf-8");
    const buyer = await t.signIn();
    const subscriber = await t.signIn("bob.near");
    await t.subscribe(subscriber.cookie);
    const stranger = await t.signIn("carol.near");
    const { co } = await paidOrder(t, buyer.cookie);
    const post = (b: unknown) => t.json(`/billing/admin/orders/${co.paymentId}`, b, { headers: ADMIN });
    expect((await post({ status: "in_progress", deliverable: { slug, title: "T" } })).status).toBe(200);
    expect((await t.req(`/reports/${slug}/`, { cookie: buyer.cookie })).status).toBe(404);
    expect((await post({ status: "delivered" })).status).toBe(200);
    expect((await t.req(`/reports/${slug}/`, { cookie: buyer.cookie })).status).toBe(200);
    expect((await t.req(`/reports/${slug}/`, { cookie: subscriber.cookie })).status).toBe(404);
    expect((await post({ shared: "yes" })).status).toBe(400);
    expect((await post({ shared: true })).status).toBe(200);
    expect((await t.req(`/reports/${slug}/`, { cookie: subscriber.cookie })).status).toBe(200);
    expect((await t.req(`/reports/${slug}/`, { cookie: stranger.cookie })).status).toBe(404);
    expect((await post({ shared: false })).status).toBe(200);
    expect((await t.req(`/reports/${slug}/`, { cookie: subscriber.cookie })).status).toBe(404);
  });

  it("deliverable validation: no catalog/free slugs, no slug shared by two orders, safe prefix and pdf names", async () => {
    const t = setup(LIVE);
    const alice = await t.signIn();
    const a = (await paidOrder(t, alice.cookie)).co;
    const b = (await paidOrder(t, alice.cookie)).co;
    const post = (id: string, d: unknown) => t.json(`/billing/admin/orders/${id}`, { deliverable: d }, { headers: ADMIN });
    expect((await post(a.paymentId, { slug: "near-thesis", title: "x" })).status).toBe(409); // free
    expect((await post(a.paymentId, { slug: "near-defi-flows", title: "x" })).status).toBe(409); // catalog
    expect((await post(a.paymentId, { slug: "Bad Slug", title: "x" })).status).toBe(400);
    expect((await post(a.paymentId, { slug: "qa-a" })).status).toBe(400); // title required
    expect((await post(a.paymentId, { slug: "qa-a", title: "x", contentPrefix: "secrets/x/" })).status).toBe(400);
    expect((await post(a.paymentId, { slug: "qa-a", title: "x", contentPrefix: "reports/../x/" })).status).toBe(400);
    expect((await post(a.paymentId, { slug: "qa-a", title: "x", pdfFile: "../x.pdf" })).status).toBe(400);
    expect((await post(a.paymentId, { slug: "qa-a", title: "x", contentPrefix: "reports/orders/qa-a/" })).status).toBe(200);
    expect((await post(b.paymentId, { slug: "qa-a", title: "y" })).status).toBe(409);
    expect((await post(a.paymentId, { slug: "qa-a", title: "x2" })).status).toBe(200); // same order may update it
    expect((await t.repo.getOrderByDeliverable("qa-a"))?.paymentId).toBe(a.paymentId);
    // renaming frees the old slug
    expect((await post(a.paymentId, { slug: "qa-a2", title: "x" })).status).toBe(200);
    expect(await t.repo.getOrderByDeliverable("qa-a")).toBeNull();
    expect((await post(b.paymentId, { slug: "qa-a", title: "y" })).status).toBe(200);
  });

  it("a deliverable with its own content prefix is served from there", async () => {
    const t = setup(LIVE);
    t.content.put("reports/orders/o1/index.html", "<h1>Prefixed</h1>", "text/html; charset=utf-8");
    const alice = await t.signIn();
    const { co } = await paidOrder(t, alice.cookie);
    await t.json(`/billing/admin/orders/${co.paymentId}`, { status: "delivered", deliverable: { slug: "qa-pre", title: "P", contentPrefix: "reports/orders/o1/" } }, { headers: ADMIN });
    expect(await (await t.req("/reports/qa-pre/", { cookie: alice.cookie })).text()).toBe("<h1>Prefixed</h1>");
  });

  it("deliveredReportSlug only trusts our own origins and report paths", async () => {
    const { deliveredReportSlug } = await import("../src/core/products");
    const o = ["https://nearbi.ai"];
    expect(deliveredReportSlug("/reports/qa-1/", o)).toBe("qa-1");
    expect(deliveredReportSlug("/reports/qa-1/data.pdf", o)).toBe("qa-1");
    expect(deliveredReportSlug("https://nearbi.ai/reports/qa-1/", o)).toBe("qa-1");
    expect(deliveredReportSlug("https://evil.example/reports/qa-1/", o)).toBeNull();
    expect(deliveredReportSlug("/ledger/", o)).toBeNull();
    expect(deliveredReportSlug(null, o)).toBeNull();
  });
});
