import { describe, expect, it } from "vitest";
import { MemoryRepository } from "../../src/adapters/memory-repository";
import { loadIntentsConfig } from "../../src/config";
import { IntentsAdapter, OneClickClient, USDC_ON_NEAR } from "../../src/intents";
import type { Repository } from "../../src/ports/repository";
import { CheckoutError, confirmPayment, createCheckout, LATE_SUCCESS_WINDOW, pollPaymentStatus, SWEEP_SLOW_RECHECK, sweepOpenPayments, type BillingDeps } from "../../src/services/billing";
import { fakeOneClick, statusBody } from "../helpers/oneclick";
import { buildCatalog } from "../../src/core/products";

const SUB = buildCatalog({ monthlyPriceUsd: 49, quickAnswerPriceUsd: 29, deepDivePriceUsd: 499 }).subscription;

const ts = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const now = ts("2026-11-02T00:00:00Z");
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const LIVE = { INTENTS_MODE: "live", SETTLEMENT_RECIPIENT: "treasury.nearbi.near" };

function deps(env: Record<string, string> = LIVE) {
  const repo = new MemoryRepository();
  const f = fakeOneClick();
  const config = loadIntentsConfig(env);
  const intents = new IntentsAdapter(new OneClickClient({ fetch: f.fetch, sleep: async () => {} }), { settlementAsset: config.settlementAsset });
  const d: BillingDeps = { repo, intents, config };
  return { d, repo, f };
}

async function withPending(env: Record<string, string> = LIVE) {
  const x = deps(env);
  await x.repo.recordLogin("alice.near", now);
  const co = await createCheckout(x.d, { accountId: "alice.near", product: SUB, nowSec: now, originAsset: BASE_USDC });
  return { ...x, co };
}

const setStatus = (f: ReturnType<typeof fakeOneClick>, addr: string, s: string, over = {}) => f.statuses.set(addr, statusBody(s, f.issued.get(addr)!, over));

describe("createCheckout", () => {
  it("live: stores a pending payment with deposit address, quote id, amountIn, asset and deadline", async () => {
    const { repo, co, f } = await withPending();
    expect(co).toMatchObject({ mode: "live", status: "pending", amountUsd: 49, originAsset: BASE_USDC });
    expect(co.depositAddress).toMatch(/^0xSynthDeposit/);
    expect(co.qrSvg).toMatch(/^<svg/);
    expect(co.deadline).toBe("2026-11-02T00:30:00.000Z");
    const sent = f.calls.find((c) => c.url.endsWith("/quote"))!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ dry: false, swapType: "EXACT_OUTPUT", amount: "49000000", destinationAsset: USDC_ON_NEAR, recipient: "treasury.nearbi.near", recipientType: "DESTINATION_CHAIN" });
    expect(sent.customRecipientMsg).toBeUndefined(); // default delivery is plain ft_transfer
    expect(await repo.getPayment(co.paymentId)).toMatchObject({
      accountId: "alice.near",
      status: "pending",
      mode: "live",
      depositAddress: co.depositAddress,
      quoteId: co.quoteId,
      amountIn: co.amountIn,
      token: BASE_USDC,
      destinationAsset: USDC_ON_NEAR,
      recipient: "treasury.nearbi.near",
      amountOut: "49000000",
      deadline: ts("2026-11-02T00:30:00Z"),
    });
  });

  it("ft_transfer_call delivery passes {order_id: paymentId} to the splitter", async () => {
    const { co, f } = await withPending({ ...LIVE, SETTLEMENT_RECIPIENT: "splitter.nearbi.near", SETTLEMENT_DELIVERY: "ft_transfer_call", SETTLEMENT_ACCEPT_NO_REFUND: "yes" });
    const sent = f.calls.find((c) => c.url.endsWith("/quote"))!.body as Record<string, unknown>;
    expect(JSON.parse(sent.customRecipientMsg as string)).toEqual({ order_id: co.paymentId });
  });

  it("dry: uses the placeholder recipient unless a mainnet one is configured; testnet is never sent to 1Click", async () => {
    for (const [env, expected] of [
      [{}, "0".repeat(64)],
      [{ SETTLEMENT_RECIPIENT: "splitter.nearbi-agent.testnet" }, "0".repeat(64)],
      [{ SETTLEMENT_RECIPIENT: "treasury.nearbi.near" }, "treasury.nearbi.near"],
    ] as const) {
      const { f, co } = await withPending(env);
      expect(co).toMatchObject({ mode: "dry", status: "preview", depositAddress: null });
      expect((f.calls.find((c) => c.url.endsWith("/quote"))!.body as Record<string, unknown>).recipient).toBe(expected);
    }
  });

  it("maps a quote service outage to a 503 CheckoutError", async () => {
    const { d, f } = deps();
    await d.intents.listTokens();
    f.on = () => new Response("{}", { status: 502 });
    await expect(createCheckout(d, { accountId: "a.near", product: SUB, nowSec: now, originAsset: BASE_USDC })).rejects.toMatchObject({ name: "CheckoutError", status: 503 });
    expect(CheckoutError).toBeDefined();
  });
});

describe("pollPaymentStatus (1Click -> payment state)", () => {
  it("walks PENDING_DEPOSIT -> KNOWN_DEPOSIT_TX -> PROCESSING -> SUCCESS and extends exactly once", async () => {
    const { d, repo, co, f } = await withPending();
    const addr = co.depositAddress!;
    let t = now + 10;
    const poll = async () => {
      t += 10;
      const r = await pollPaymentStatus(d, co.paymentId, "alice.near", t);
      if (!r.ok) throw new Error(r.error);
      return r.view;
    };

    expect((await poll()).status).toBe("pending"); // 1Click 404 (not seen yet) counts as pending
    setStatus(f, addr, "PENDING_DEPOSIT");
    expect((await poll()).status).toBe("pending");
    setStatus(f, addr, "KNOWN_DEPOSIT_TX");
    expect((await poll())).toMatchObject({ status: "processing", intentsStatus: "KNOWN_DEPOSIT_TX" });
    setStatus(f, addr, "PROCESSING");
    expect((await poll()).status).toBe("processing");
    expect(await repo.getSubscription("alice.near")).toBeNull();

    setStatus(f, addr, "SUCCESS");
    const v = await poll();
    expect(v).toMatchObject({ status: "paid", intentsStatus: "SUCCESS", qrSvg: null });
    const sub = await repo.getSubscription("alice.near");
    expect(sub).toMatchObject({ status: "active", currentPeriodEnd: ts("2026-12-02T00:01:00Z") });
    expect(await repo.getPayment(co.paymentId)).toMatchObject({ status: "paid", txHash: `1click:${addr}`, settlementTx: "DestTxSynthetic1111111111111111111111111111" });

    // terminal: further polls don't call 1Click and never extend again
    const statusCalls = f.calls.filter((c) => c.url.includes("/status")).length;
    await poll();
    await poll();
    expect(f.calls.filter((c) => c.url.includes("/status")).length).toBe(statusCalls);
    expect((await repo.getSubscription("alice.near"))?.currentPeriodEnd).toBe(sub!.currentPeriodEnd);
  });

  it("SUCCESS seen by two concurrent polls extends once", async () => {
    const { d, repo, co, f } = await withPending();
    setStatus(f, co.depositAddress!, "SUCCESS");
    await Promise.all([pollPaymentStatus(d, co.paymentId, "alice.near", now + 60), pollPaymentStatus(d, co.paymentId, "alice.near", now + 60)]);
    expect((await repo.getSubscription("alice.near"))?.currentPeriodEnd).toBe(ts("2026-12-02T00:01:00Z"));
  });

  it.each([
    ["REFUNDED", "refunded"],
    ["FAILED", "failed"],
    ["INCOMPLETE_DEPOSIT", "incomplete"],
  ])("%s -> %s, no subscription", async (s, ours) => {
    const { d, repo, co, f } = await withPending();
    setStatus(f, co.depositAddress!, s);
    const r = await pollPaymentStatus(d, co.paymentId, "alice.near", now + 60);
    expect(r.ok && r.view.status).toBe(ours);
    expect(await repo.getSubscription("alice.near")).toBeNull();
  });

  it("a refunded payment can't be confirmed later, even by the admin override", async () => {
    const { d, repo, co, f } = await withPending();
    setStatus(f, co.depositAddress!, "REFUNDED");
    await pollPaymentStatus(d, co.paymentId, "alice.near", now + 60);
    expect(await confirmPayment(repo, co.paymentId, "manual", now + 70)).toMatchObject({ ok: false, status: 409 });
  });

  it("throttles 1Click calls to one per 5 s per payment", async () => {
    const { d, co, f } = await withPending();
    setStatus(f, co.depositAddress!, "PENDING_DEPOSIT");
    await pollPaymentStatus(d, co.paymentId, "alice.near", now + 100);
    await pollPaymentStatus(d, co.paymentId, "alice.near", now + 102);
    await pollPaymentStatus(d, co.paymentId, "alice.near", now + 106);
    expect(f.calls.filter((c) => c.url.includes("/status"))).toHaveLength(2);
  });

  it("expires after the deadline + grace with no deposit; a late SUCCESS is still honoured", async () => {
    const { d, repo, co, f } = await withPending();
    setStatus(f, co.depositAddress!, "PENDING_DEPOSIT");
    const late = ts("2026-11-02T00:46:00Z");
    expect((await pollPaymentStatus(d, co.paymentId, "alice.near", late)) as unknown).toMatchObject({ view: { status: "expired" } });
    // expired is not polled by the page, but the admin override (or a later poll) can still confirm it
    expect(await confirmPayment(repo, co.paymentId, "late-tx", late + 100)).toMatchObject({ ok: true, alreadyPaid: false });
  });

  it("1Click unreachable: returns the stored state flagged stale", async () => {
    const { d, co, f } = await withPending();
    f.on = (_m, url) => (url.pathname.endsWith("/status") ? new Response("{}", { status: 503 }) : undefined);
    const r = await pollPaymentStatus(d, co.paymentId, "alice.near", now + 60);
    expect(r).toMatchObject({ ok: true, view: { status: "pending", stale: true } });
  });

  it("refuses to confirm when the status payload doesn't match the stored quote", async () => {
    const { d, repo, co, f } = await withPending();
    const body = statusBody("SUCCESS", f.issued.get(co.depositAddress!)!);
    body.quoteResponse = { ...body.quoteResponse, quoteRequest: { ...body.quoteResponse.quoteRequest, recipient: "attacker.near" } };
    f.statuses.set(co.depositAddress!, body);
    const r = await pollPaymentStatus(d, co.paymentId, "alice.near", now + 60);
    expect(r).toMatchObject({ ok: true, view: { status: "pending", intentsStatus: "MISMATCH:SUCCESS" } });
    expect(await repo.getSubscription("alice.near")).toBeNull();
  });

  it("refuses SUCCESS whose settled amountOut is below the price", async () => {
    const { d, repo, co, f } = await withPending();
    setStatus(f, co.depositAddress!, "SUCCESS", { amountOut: "1000000" });
    await pollPaymentStatus(d, co.paymentId, "alice.near", now + 60);
    expect(await repo.getSubscription("alice.near")).toBeNull();
  });

  it("other accounts' payments are 404, unknown future statuses leave the payment alone", async () => {
    const { d, co, f } = await withPending();
    expect(await pollPaymentStatus(d, co.paymentId, "mallory.near", now + 60)).toMatchObject({ ok: false, status: 404 });
    setStatus(f, co.depositAddress!, "SOMETHING_NEW");
    expect(await pollPaymentStatus(d, co.paymentId, "alice.near", now + 60)).toMatchObject({ ok: true, view: { status: "pending", intentsStatus: "SOMETHING_NEW" } });
  });
});

describe("confirmPayment (admin override and poller)", () => {
  it("confirm marks paid and activates one month from now", async () => {
    const { repo, co } = await withPending();
    expect(await confirmPayment(repo, co.paymentId, "tx1", now)).toEqual({ ok: true, alreadyPaid: false, accountId: "alice.near", product: "subscription", currentPeriodEnd: ts("2026-12-02T00:00:00Z"), orderId: null });
    expect(await repo.getSubscription("alice.near")).toMatchObject({ status: "active", lastPaymentTx: "tx1" });
    expect(await repo.getPayment(co.paymentId)).toMatchObject({ status: "paid", txHash: "tx1", paidAt: now });
  });

  it("is idempotent: confirming the same payment twice extends only once", async () => {
    const { repo, co } = await withPending();
    await confirmPayment(repo, co.paymentId, "tx1", now);
    expect(await confirmPayment(repo, co.paymentId, "tx1", now + 10)).toMatchObject({ ok: true, alreadyPaid: true, currentPeriodEnd: ts("2026-12-02T00:00:00Z") });
  });

  it("a second payment stacks a second month onto the running period", async () => {
    const { d, repo, co } = await withPending();
    await confirmPayment(repo, co.paymentId, "tx1", now);
    const co2 = await createCheckout(d, { accountId: "alice.near", product: SUB, nowSec: now + 86400, originAsset: BASE_USDC });
    expect(await confirmPayment(repo, co2.paymentId, "tx2", now + 86400)).toMatchObject({ ok: true, currentPeriodEnd: ts("2027-01-02T00:00:00Z") });
  });

  it("renewal after lapse starts from the confirmation time", async () => {
    const { d, repo, co } = await withPending();
    await confirmPayment(repo, co.paymentId, "tx1", now);
    const later = ts("2027-03-10T00:00:00Z");
    const co2 = await createCheckout(d, { accountId: "alice.near", product: SUB, nowSec: later, originAsset: BASE_USDC });
    expect(await confirmPayment(repo, co2.paymentId, "tx2", later)).toMatchObject({ currentPeriodEnd: ts("2027-04-10T00:00:00Z") });
  });

  it("rejects unknown payments and reused tx hashes without extending", async () => {
    const { d, repo, co } = await withPending();
    expect(await confirmPayment(repo, "nope", "tx", now)).toMatchObject({ ok: false, status: 404 });
    await confirmPayment(repo, co.paymentId, "tx1", now);
    const co2 = await createCheckout(d, { accountId: "alice.near", product: SUB, nowSec: now, originAsset: BASE_USDC });
    expect(await confirmPayment(repo, co2.paymentId, "tx1", now)).toMatchObject({ ok: false, status: 409 });
    expect((await repo.getSubscription("alice.near"))?.currentPeriodEnd).toBe(ts("2026-12-02T00:00:00Z"));
    expect((await repo.getPayment(co2.paymentId))?.status).toBe("pending");
  });

  it("two payments confirmed concurrently both count (optimistic retry)", async () => {
    const { d, repo, co } = await withPending();
    const co2 = await createCheckout(d, { accountId: "alice.near", product: SUB, nowSec: now, originAsset: BASE_USDC });
    const slow: Repository = Object.create(repo);
    let reads = 0;
    slow.getSubscription = async (id) => {
      const s = await repo.getSubscription(id);
      if (++reads <= 2) await new Promise((r) => setTimeout(r, 5));
      return s;
    };
    const [a, b] = await Promise.all([confirmPayment(slow, co.paymentId, "tx1", now), confirmPayment(slow, co2.paymentId, "tx2", now)]);
    expect(a.ok && b.ok).toBe(true);
    expect((await repo.getSubscription("alice.near"))?.currentPeriodEnd).toBe(ts("2027-01-02T00:00:00Z"));
  });

  it("the admin override also works on a dry preview payment (manual comp)", async () => {
    const { repo, co } = await withPending({});
    expect(co.status).toBe("preview");
    expect(await confirmPayment(repo, co.paymentId, "comp-1", now)).toMatchObject({ ok: true });
  });
});

describe("mode switch (loadIntentsConfig)", () => {
  it("defaults to dry with USDC on NEAR and no recipient", () => {
    expect(loadIntentsConfig({})).toMatchObject({ mode: "dry", settlementAsset: USDC_ON_NEAR, settlementRecipient: null, delivery: "transfer", jwt: null });
  });
  it.each([
    [{ INTENTS_MODE: "live" }, /requires SETTLEMENT_RECIPIENT/],
    [{ INTENTS_MODE: "live", SETTLEMENT_RECIPIENT: "splitter.nearbi-agent.testnet" }, /not a mainnet/],
    [{ INTENTS_MODE: "live", SETTLEMENT_RECIPIENT: "0".repeat(64) }, /not a mainnet/],
    [{ INTENTS_MODE: "live", SETTLEMENT_RECIPIENT: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D" }, /not a mainnet/],
    [{ INTENTS_MODE: "live", SETTLEMENT_RECIPIENT: "s.nearbi.near", SETTLEMENT_DELIVERY: "ft_transfer_call" }, /SETTLEMENT_ACCEPT_NO_REFUND/],
    [{ INTENTS_MODE: "prod" }, /must be "dry" or "live"/],
    [{ SETTLEMENT_ASSET: "usdc" }, /not a 1Click asset id/],
    [{ SETTLEMENT_DELIVERY: "push" }, /SETTLEMENT_DELIVERY/],
  ])("refuses %o", (env, err) => expect(() => loadIntentsConfig(env as Record<string, string>)).toThrow(err));
  it("live with a mainnet recipient starts", () => {
    expect(loadIntentsConfig(LIVE)).toMatchObject({ mode: "live", settlementRecipient: "treasury.nearbi.near" });
  });
  it("reads the optional JWT from ONECLICK_JWT", () => expect(loadIntentsConfig({ ONECLICK_JWT: "j" }).jwt).toBe("j"));
});


describe("background sweep (EventBridge Scheduler -> sweepOpenPayments)", () => {
  it("confirms a SUCCESS nobody is watching, queues it for forwarding with the settled amount, then closes it", async () => {
    const { d, repo, co, f } = await withPending();
    expect((await repo.listOpenPayments(10)).map((x) => x.paymentId)).toEqual([co.paymentId]);

    let r = await sweepOpenPayments(d, now + 60);
    expect(r).toMatchObject({ open: 1, checked: 1, closed: 0, paid: 0, errors: 0 });
    expect((await repo.getPayment(co.paymentId))?.status).toBe("pending");

    setStatus(f, co.depositAddress!, "SUCCESS", { amountOut: "49000123" });
    r = await sweepOpenPayments(d, now + 120);
    expect(r).toMatchObject({ open: 1, checked: 1, closed: 1, paid: 1 });
    expect(await repo.getPayment(co.paymentId)).toMatchObject({ status: "paid", settledAmountOut: "49000123", forwardedTx: null });
    expect((await repo.getSubscription("alice.near"))?.status).toBe("active");
    expect(await repo.listForwardQueue(10)).toEqual([
      {
        paymentId: co.paymentId,
        amount: "49000123",
        recipient: "treasury.nearbi.near",
        destinationAsset: USDC_ON_NEAR,
        depositAddress: co.depositAddress,
        settlementTx: "DestTxSynthetic1111111111111111111111111111",
        enqueuedAt: now + 120,
      },
    ]);
    expect(await repo.listOpenPayments(10)).toEqual([]);

    // the page poller seeing it afterwards changes nothing
    await pollPaymentStatus(d, co.paymentId, "alice.near", now + 200);
    expect((await repo.getSubscription("alice.near"))?.currentPeriodEnd).toBe(ts("2026-12-02T00:02:00Z"));
    expect(await repo.listForwardQueue(10)).toHaveLength(1);
  });

  it("sweep and page poll racing on SUCCESS extend once and queue once", async () => {
    const { d, repo, co, f } = await withPending();
    setStatus(f, co.depositAddress!, "SUCCESS");
    await Promise.all([sweepOpenPayments(d, now + 60), pollPaymentStatus(d, co.paymentId, "alice.near", now + 60), sweepOpenPayments(d, now + 60)]);
    expect((await repo.getSubscription("alice.near"))?.currentPeriodEnd).toBe(ts("2026-12-02T00:01:00Z"));
    expect(await repo.listForwardQueue(10)).toHaveLength(1);
  });

  it("refunded / failed close without queueing; expired stays watched for the late-success window", async () => {
    const a = await withPending();
    setStatus(a.f, a.co.depositAddress!, "REFUNDED");
    expect(await sweepOpenPayments(a.d, now + 60)).toMatchObject({ closed: 1, paid: 0 });
    expect(await a.repo.listForwardQueue(10)).toEqual([]);

    const b = await withPending();
    const deadline = (await b.repo.getPayment(b.co.paymentId))!.deadline!;
    await sweepOpenPayments(b.d, deadline + 16 * 60);
    expect((await b.repo.getPayment(b.co.paymentId))?.status).toBe("expired");
    expect(await b.repo.listOpenPayments(10)).toHaveLength(1); // still watched
    setStatus(b.f, b.co.depositAddress!, "SUCCESS");
    expect(await sweepOpenPayments(b.d, deadline + 3600)).toMatchObject({ paid: 1, closed: 1 }); // late SUCCESS honoured

    const c = await withPending();
    const dl = (await c.repo.getPayment(c.co.paymentId))!.deadline!;
    await sweepOpenPayments(c.d, dl + 16 * 60);
    expect(await sweepOpenPayments(c.d, dl + LATE_SUCCESS_WINDOW + 1)).toMatchObject({ closed: 1, paid: 0 });
    expect(await c.repo.listOpenPayments(10)).toEqual([]);
  });

  it("SUCCESS without a reported amountOut is queued with amount null (the agent must not guess)", async () => {
    const { d, repo, co, f } = await withPending();
    const body = statusBody("SUCCESS", f.issued.get(co.depositAddress!)!);
    delete body.swapDetails.amountOut;
    f.statuses.set(co.depositAddress!, body);
    await sweepOpenPayments(d, now + 60);
    expect((await repo.listForwardQueue(10))[0]?.amount).toBeNull();
    expect((await repo.getPayment(co.paymentId))?.status).toBe("paid");
  });

  it("a mismatching 1Click payload is neither confirmed nor queued", async () => {
    const { d, repo, co, f } = await withPending();
    const body = statusBody("SUCCESS", f.issued.get(co.depositAddress!)!);
    body.quoteResponse.quoteRequest.recipient = "attacker.near";
    f.statuses.set(co.depositAddress!, body);
    await sweepOpenPayments(d, now + 60);
    expect((await repo.getPayment(co.paymentId))?.status).toBe("pending");
    expect(await repo.listForwardQueue(10)).toEqual([]);
    expect(await repo.listOpenPayments(10)).toHaveLength(1);
  });

  it("ft_transfer_call delivery (straight into the splitter) is never queued for forwarding", async () => {
    const { d, repo, co, f } = await withPending({ ...LIVE, SETTLEMENT_DELIVERY: "ft_transfer_call", SETTLEMENT_ACCEPT_NO_REFUND: "yes" });
    setStatus(f, co.depositAddress!, "SUCCESS");
    await sweepOpenPayments(d, now + 60);
    expect((await repo.getPayment(co.paymentId))?.status).toBe("paid");
    expect(await repo.listForwardQueue(10)).toEqual([]);
  });

  it("stops at the time budget and reports truncated; one bad payment doesn't stop the rest", async () => {
    const x = deps();
    for (let i = 0; i < 3; i++) await createCheckout(x.d, { accountId: "alice.near", product: SUB, nowSec: now, originAsset: BASE_USDC });
    let t = 0;
    const r = await sweepOpenPayments(x.d, now + 60, { budgetMs: 15, clock: () => (t += 10), concurrency: 1 });
    expect(r).toMatchObject({ open: 3, truncated: true });
    expect(r.checked).toBeLessThan(3);

    const orig = x.repo.getPayment.bind(x.repo);
    let calls = 0;
    x.repo.getPayment = async (id: string) => (++calls === 1 ? Promise.reject(new Error("boom")) : orig(id));
    const r2 = await sweepOpenPayments(x.d, now + 120);
    expect(r2).toMatchObject({ open: 3, errors: 1, checked: 2 });
  });

  it("randomized order: a truncated run doesn't always pick the same payments", async () => {
    const x = deps();
    for (let i = 0; i < 6; i++) await createCheckout(x.d, { accountId: "alice.near", product: SUB, nowSec: now, originAsset: BASE_USDC });
    const seen = new Set<string>();
    const orig = x.repo.getPayment.bind(x.repo);
    x.repo.getPayment = async (id: string) => (seen.add(id), orig(id));
    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 20; k++) {
      let t = 0;
      await sweepOpenPayments(x.d, now + 60 + k * 10, { budgetMs: 15, clock: () => (t += 10), concurrency: 1, random });
    }
    expect(seen.size).toBe(6);
  });

  it("backs off old pending payments (1Click keeps addresses open ~72 h) but keeps young ones at every run", async () => {
    const x = deps();
    const old = await createCheckout(x.d, { accountId: "alice.near", product: SUB, nowSec: now, originAsset: BASE_USDC });
    const young = await createCheckout(x.d, { accountId: "alice.near", product: SUB, nowSec: now + 7200, originAsset: BASE_USDC });
    const t0 = now + 7260;
    expect(await sweepOpenPayments(x.d, t0)).toMatchObject({ checked: 2, deferred: 0 });
    expect(await sweepOpenPayments(x.d, t0 + 60)).toMatchObject({ checked: 1, deferred: 1 }); // old one deferred
    expect((await x.repo.getPayment(young.paymentId))?.checkedAt).toBe(t0 + 60);
    expect((await x.repo.getPayment(old.paymentId))?.checkedAt).toBe(t0);
    expect(await sweepOpenPayments(x.d, t0 + SWEEP_SLOW_RECHECK + 1)).toMatchObject({ checked: 2, deferred: 0 });
    // a deposit on the old one is still picked up within SWEEP_SLOW_RECHECK
    setStatus(x.f, old.depositAddress!, "SUCCESS");
    expect(await sweepOpenPayments(x.d, t0 + 2 * SWEEP_SLOW_RECHECK + 2)).toMatchObject({ paid: 1 });
  });
});

describe("one-off products (Quick Answer / Deep Dive)", () => {
  const CATALOG = buildCatalog({ monthlyPriceUsd: 49, quickAnswerPriceUsd: 29, deepDivePriceUsd: 499 });
  const brief = { question: "How many accounts used Intents last week, excluding bots?", contact: "me@example.com", scope: null };

  async function withOrder(product: "quick_answer" | "deep_dive" = "quick_answer") {
    const x = deps();
    const co = await createCheckout(x.d, { accountId: "alice.near", product: CATALOG[product], brief, nowSec: now, originAsset: BASE_USDC });
    return { ...x, co };
  }

  it("quotes EXACT_OUTPUT for the product's price (29 / 499 USDC) to the same live recipient", async () => {
    for (const [product, amount] of [["quick_answer", "29000000"], ["deep_dive", "499000000"]] as const) {
      const { f, co, repo } = await withOrder(product);
      const sent = f.calls.find((c) => c.url.endsWith("/quote"))!.body as Record<string, unknown>;
      expect(sent).toMatchObject({ dry: false, swapType: "EXACT_OUTPUT", amount, recipient: "treasury.nearbi.near", destinationAsset: USDC_ON_NEAR });
      expect(co).toMatchObject({ product, amountUsd: CATALOG[product].priceUsd, status: "pending" });
      expect(await repo.getPayment(co.paymentId)).toMatchObject({ product, brief, amountUsd: CATALOG[product].priceUsd, amountOut: amount });
    }
  });

  it("refuses a one-off checkout without a brief; the subscription never stores one", async () => {
    const x = deps();
    await expect(createCheckout(x.d, { accountId: "alice.near", product: CATALOG.quick_answer, nowSec: now, originAsset: BASE_USDC })).rejects.toMatchObject({ status: 400 });
    const sub = await createCheckout(x.d, { accountId: "alice.near", product: CATALOG.subscription, brief, nowSec: now, originAsset: BASE_USDC });
    expect(await x.repo.getPayment(sub.paymentId)).toMatchObject({ product: "subscription", brief: null });
  });

  it("SUCCESS -> ORDER (status paid) + FWDQ entry, and the subscription is NOT extended", async () => {
    const { repo, f, d, co } = await withOrder();
    setStatus(f, co.depositAddress!, "SUCCESS");
    const r = await pollPaymentStatus(d, co.paymentId, "alice.near", now + 60);
    expect(r).toMatchObject({ ok: true, view: { status: "paid", product: "quick_answer", statusLabel: expect.stringMatching(/order is in our queue/) } });
    expect(await repo.getOrder(co.paymentId)).toEqual({
      paymentId: co.paymentId,
      accountId: "alice.near",
      product: "quick_answer",
      brief,
      amountUsd: 29,
      status: "paid",
      deliveryUrl: null,
      deliverable: null,
      shared: false,
      createdAt: now + 60,
      updatedAt: now + 60,
    });
    expect(await repo.getSubscription("alice.near")).toBeNull();
    expect(await repo.listForwardQueue(10)).toEqual([expect.objectContaining({ paymentId: co.paymentId, amount: "29000000", recipient: "treasury.nearbi.near" })]);
  });

  it("idempotent: page polls, the sweep and the admin override never create a second order or touch the subscription", async () => {
    const { repo, f, d, co } = await withOrder("deep_dive");
    setStatus(f, co.depositAddress!, "SUCCESS");
    await Promise.all([pollPaymentStatus(d, co.paymentId, "alice.near", now + 60), sweepOpenPayments(d, now + 60)]);
    await pollPaymentStatus(d, co.paymentId, "alice.near", now + 120);
    await sweepOpenPayments(d, now + 180);
    expect(await confirmPayment(repo, co.paymentId, "manual-tx", now + 200)).toEqual({
      ok: true,
      alreadyPaid: true,
      accountId: "alice.near",
      product: "deep_dive",
      currentPeriodEnd: null,
      orderId: co.paymentId,
    });
    expect(await repo.listOrders("alice.near")).toHaveLength(1);
    expect(await repo.listForwardQueue(10)).toHaveLength(1);
    expect(await repo.getSubscription("alice.near")).toBeNull();
    expect((await repo.getOrder(co.paymentId))?.createdAt).toBe(now + 60);
  });

  it("an existing subscription keeps its period end when a one-off is paid", async () => {
    const x = deps();
    const sub = await createCheckout(x.d, { accountId: "alice.near", product: CATALOG.subscription, nowSec: now, originAsset: BASE_USDC });
    await confirmPayment(x.repo, sub.paymentId, "tx-sub", now);
    const end = (await x.repo.getSubscription("alice.near"))!.currentPeriodEnd;
    const qa = await createCheckout(x.d, { accountId: "alice.near", product: CATALOG.quick_answer, brief, nowSec: now, originAsset: BASE_USDC });
    expect(await confirmPayment(x.repo, qa.paymentId, "tx-qa", now + 10)).toMatchObject({ ok: true, alreadyPaid: false, product: "quick_answer", currentPeriodEnd: null, orderId: qa.paymentId });
    expect((await x.repo.getSubscription("alice.near"))!.currentPeriodEnd).toBe(end);
  });

  it("the admin override creates the order (no forward queued: no settled amount, forward by hand)", async () => {
    const { repo, co } = await withOrder();
    expect(await confirmPayment(repo, co.paymentId, "tx-manual", now)).toMatchObject({ ok: true, alreadyPaid: false, orderId: co.paymentId });
    expect(await repo.getOrder(co.paymentId)).toMatchObject({ status: "paid" });
    expect(await repo.listForwardQueue(10)).toEqual([]);
    expect(await confirmPayment(repo, co.paymentId, "tx-manual", now)).toMatchObject({ ok: true, alreadyPaid: true });
  });

  it("refunded one-off payments never become orders", async () => {
    const { repo, f, d, co } = await withOrder();
    setStatus(f, co.depositAddress!, "REFUNDED");
    await pollPaymentStatus(d, co.paymentId, "alice.near", now + 60);
    expect(await confirmPayment(repo, co.paymentId, "tx", now + 70)).toMatchObject({ ok: false, status: 409 });
    expect(await repo.listOrders("alice.near")).toEqual([]);
  });
});
