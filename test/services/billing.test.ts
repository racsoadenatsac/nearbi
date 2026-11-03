import { describe, expect, it } from "vitest";
import { MemoryRepository } from "../../src/adapters/memory-repository";
import { loadIntentsConfig } from "../../src/config";
import { IntentsAdapter, OneClickClient, USDC_ON_NEAR } from "../../src/intents";
import type { Repository } from "../../src/ports/repository";
import { CheckoutError, confirmPayment, createCheckout, pollPaymentStatus, type BillingDeps } from "../../src/services/billing";
import { fakeOneClick, statusBody } from "../helpers/oneclick";

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
  const co = await createCheckout(x.d, { accountId: "alice.near", amountUsd: 49, nowSec: now, originAsset: BASE_USDC });
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
    await expect(createCheckout(d, { accountId: "a.near", amountUsd: 49, nowSec: now, originAsset: BASE_USDC })).rejects.toMatchObject({ name: "CheckoutError", status: 503 });
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
    expect(await confirmPayment(repo, co.paymentId, "tx1", now)).toEqual({ ok: true, alreadyPaid: false, accountId: "alice.near", currentPeriodEnd: ts("2026-12-02T00:00:00Z") });
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
    const co2 = await createCheckout(d, { accountId: "alice.near", amountUsd: 49, nowSec: now + 86400, originAsset: BASE_USDC });
    expect(await confirmPayment(repo, co2.paymentId, "tx2", now + 86400)).toMatchObject({ ok: true, currentPeriodEnd: ts("2027-01-02T00:00:00Z") });
  });

  it("renewal after lapse starts from the confirmation time", async () => {
    const { d, repo, co } = await withPending();
    await confirmPayment(repo, co.paymentId, "tx1", now);
    const later = ts("2027-03-10T00:00:00Z");
    const co2 = await createCheckout(d, { accountId: "alice.near", amountUsd: 49, nowSec: later, originAsset: BASE_USDC });
    expect(await confirmPayment(repo, co2.paymentId, "tx2", later)).toMatchObject({ currentPeriodEnd: ts("2027-04-10T00:00:00Z") });
  });

  it("rejects unknown payments and reused tx hashes without extending", async () => {
    const { d, repo, co } = await withPending();
    expect(await confirmPayment(repo, "nope", "tx", now)).toMatchObject({ ok: false, status: 404 });
    await confirmPayment(repo, co.paymentId, "tx1", now);
    const co2 = await createCheckout(d, { accountId: "alice.near", amountUsd: 49, nowSec: now, originAsset: BASE_USDC });
    expect(await confirmPayment(repo, co2.paymentId, "tx1", now)).toMatchObject({ ok: false, status: 409 });
    expect((await repo.getSubscription("alice.near"))?.currentPeriodEnd).toBe(ts("2026-12-02T00:00:00Z"));
    expect((await repo.getPayment(co2.paymentId))?.status).toBe("pending");
  });

  it("two payments confirmed concurrently both count (optimistic retry)", async () => {
    const { d, repo, co } = await withPending();
    const co2 = await createCheckout(d, { accountId: "alice.near", amountUsd: 49, nowSec: now, originAsset: BASE_USDC });
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

