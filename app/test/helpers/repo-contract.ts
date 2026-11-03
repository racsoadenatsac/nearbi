// One behavioural contract for every Repository implementation (memory always, DynamoDB Local optionally).
import { describe, expect, it } from "vitest";
import type { OrderRecord, PaymentRecord, Repository } from "../../src/ports/repository";

const pay = (id: string, accountId = "alice.near", over: Partial<PaymentRecord> = {}): PaymentRecord => ({
  id,
  accountId,
  amountUsd: 49,
  token: "nep141:usdc",
  depositAddress: `dep-${id}`,
  status: "pending",
  txHash: null,
  createdAt: 1000,
  paidAt: null,
  quoteJson: "{}",
  mode: "live",
  quoteId: `q-${id}`,
  depositMemo: null,
  destinationAsset: "nep141:usdc",
  recipient: "treasury.near",
  amountIn: "49500000",
  amountInFormatted: "49.5",
  minAmountIn: "49005000",
  amountOut: "49000000",
  deadline: 2800,
  intentsStatus: null,
  checkedAt: null,
  settlementTx: null,
  settledAmountOut: null,
  forwardedTx: null,
  product: "subscription",
  brief: null,
  ...over,
});

const brief = { question: "How many real users used Intents last week?", contact: "@alice_near", scope: null };
const order = (paymentId: string, accountId = "alice.near", over: Partial<OrderRecord> = {}): OrderRecord => ({
  paymentId,
  accountId,
  product: "quick_answer",
  brief,
  amountUsd: 29,
  status: "paid",
  deliveryUrl: null,
  createdAt: 1100,
  updatedAt: 1100,
  ...over,
});
const oneOff = (id: string, accountId = "alice.near", over: Partial<PaymentRecord> = {}) =>
  pay(id, accountId, { product: "quick_answer", brief, amountUsd: 29, amountOut: "29000000", ...over });

export function repositoryContract(name: string, make: () => Promise<Repository>) {
  describe(`Repository contract: ${name}`, () => {
    it("challenges are consumed exactly once", async () => {
      const r = await make();
      await r.putChallenge({ nonce: "n1", message: "m", expiresAt: 500 });
      expect(await r.consumeChallenge("n1")).toEqual({ nonce: "n1", message: "m", expiresAt: 500 });
      expect(await r.consumeChallenge("n1")).toBeNull();
      expect(await r.consumeChallenge("never")).toBeNull();
    });

    it("concurrent consumers: only one wins", async () => {
      const r = await make();
      await r.putChallenge({ nonce: "n2", message: "m", expiresAt: 500 });
      const results = await Promise.all([1, 2, 3, 4].map(() => r.consumeChallenge("n2")));
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("recordLogin keeps createdAt and bumps lastLoginAt", async () => {
      const r = await make();
      await r.recordLogin("alice.near", 100);
      await r.recordLogin("alice.near", 200);
      expect(await r.getAccount("alice.near")).toEqual({ accountId: "alice.near", createdAt: 100, lastLoginAt: 200 });
      expect(await r.getAccount("nobody.near")).toBeNull();
    });

    it("payments round-trip and ids are unique", async () => {
      const r = await make();
      await r.createPayment(pay("p1"));
      expect(await r.getPayment("p1")).toEqual(pay("p1"));
      expect(await r.getPayment("nope")).toBeNull();
      await expect(r.createPayment(pay("p1"))).rejects.toThrow();
    });

    it("applyPayment: pending -> paid, activates subscription, all or nothing", async () => {
      const r = await make();
      await r.createPayment(pay("p1"));
      expect(await r.getSubscription("alice.near")).toBeNull();
      const ok = await r.applyPayment({ paymentId: "p1", accountId: "alice.near", txHash: "tx1", nowSec: 1100, newPeriodEnd: 5000, expected: { exists: false, currentPeriodEnd: null } });
      expect(ok).toEqual({ ok: true });
      expect(await r.getPayment("p1")).toMatchObject({ status: "paid", txHash: "tx1", paidAt: 1100 });
      expect(await r.getSubscription("alice.near")).toEqual({ accountId: "alice.near", status: "active", currentPeriodEnd: 5000, lastPaymentTx: "tx1", updatedAt: 1100 });

      // same payment again
      expect(await r.applyPayment({ paymentId: "p1", accountId: "alice.near", txHash: "tx9", nowSec: 1200, newPeriodEnd: 9000, expected: { exists: true, currentPeriodEnd: 5000 } })).toEqual({ ok: false, reason: "not_pending" });

      // tx hash reuse on another payment: nothing changes
      await r.createPayment(pay("p2"));
      expect(await r.applyPayment({ paymentId: "p2", accountId: "alice.near", txHash: "tx1", nowSec: 1200, newPeriodEnd: 9000, expected: { exists: true, currentPeriodEnd: 5000 } })).toEqual({ ok: false, reason: "tx_used" });
      expect(await r.getPayment("p2")).toMatchObject({ status: "pending", txHash: null });

      // stale expectation (someone else extended in between): nothing changes
      expect(await r.applyPayment({ paymentId: "p2", accountId: "alice.near", txHash: "tx2", nowSec: 1200, newPeriodEnd: 9000, expected: { exists: true, currentPeriodEnd: 4000 } })).toEqual({ ok: false, reason: "conflict" });
      expect(await r.getPayment("p2")).toMatchObject({ status: "pending" });
      expect((await r.getSubscription("alice.near"))?.currentPeriodEnd).toBe(5000);

      // tx2 was not claimed by the failed attempt
      expect(await r.applyPayment({ paymentId: "p2", accountId: "alice.near", txHash: "tx2", nowSec: 1200, newPeriodEnd: 9000, expected: { exists: true, currentPeriodEnd: 5000 } })).toEqual({ ok: true });
      expect((await r.getSubscription("alice.near"))?.currentPeriodEnd).toBe(9000);
    });

    it("dry payments (no deposit address) round-trip", async () => {
      const r = await make();
      const p = pay("d1", "alice.near", { mode: "dry", status: "preview", depositAddress: null });
      await r.createPayment(p);
      expect(await r.getPayment("d1")).toEqual(p);
    });

    it("updatePaymentStatus is conditional on the current status and never marks paid", async () => {
      const r = await make();
      await r.createPayment(pay("u1"));
      expect(await r.updatePaymentStatus("u1", ["pending"], { status: "processing", intentsStatus: "PROCESSING", checkedAt: 1200 })).toBe(true);
      expect(await r.getPayment("u1")).toMatchObject({ status: "processing", intentsStatus: "PROCESSING", checkedAt: 1200, settlementTx: null });
      expect(await r.updatePaymentStatus("u1", ["pending"], { status: "failed", intentsStatus: "FAILED", checkedAt: 1300 })).toBe(false);
      expect((await r.getPayment("u1"))?.status).toBe("processing");
      expect(await r.updatePaymentStatus("nope", ["pending"], { status: "failed", intentsStatus: null, checkedAt: 1 })).toBe(false);
      await expect(r.updatePaymentStatus("u1", ["processing"], { status: "paid" as never, intentsStatus: null, checkedAt: 1 })).rejects.toThrow();
      // settlementTx is only written when given
      await r.updatePaymentStatus("u1", ["processing"], { status: "processing", intentsStatus: "PROCESSING", checkedAt: 1400, settlementTx: "Tx1" });
      expect((await r.getPayment("u1"))?.settlementTx).toBe("Tx1");
    });

    it("applyPayment accepts every payable status, but not refunded/failed", async () => {
      const r = await make();
      let end = 5000;
      for (const st of ["processing", "incomplete", "expired", "preview"] as const) {
        await r.createPayment(pay(`a-${st}`, "carol.near", { status: st }));
        const sub = await r.getSubscription("carol.near");
        const res = await r.applyPayment({ paymentId: `a-${st}`, accountId: "carol.near", txHash: `tx-${st}`, nowSec: 1100, newPeriodEnd: end, expected: { exists: !!sub, currentPeriodEnd: sub?.currentPeriodEnd ?? null } });
        expect(res).toEqual({ ok: true });
        end += 1000;
      }
      for (const st of ["refunded", "failed"] as const) {
        await r.createPayment(pay(`b-${st}`, "carol.near", { status: st }));
        const res = await r.applyPayment({ paymentId: `b-${st}`, accountId: "carol.near", txHash: `tx-${st}`, nowSec: 1100, newPeriodEnd: 99999, expected: { exists: true, currentPeriodEnd: end - 1000 } });
        expect(res).toEqual({ ok: false, reason: "not_pending" });
      }
    });

    it("live payments with a deposit address are indexed for the sweep; dry ones are not", async () => {
      const r = await make();
      await r.createPayment(pay("o1"));
      await r.createPayment(pay("o2", "bob.near", { deadline: 9000 }));
      await r.createPayment(pay("o3", "alice.near", { mode: "dry", depositAddress: null, status: "preview" }));
      expect(await r.listOpenPayments(10)).toEqual([
        { paymentId: "o1", createdAt: 1000, deadline: 2800 },
        { paymentId: "o2", createdAt: 1000, deadline: 9000 },
      ]);
      await r.closeOpenPayment("o1");
      await r.closeOpenPayment("o1"); // idempotent
      expect((await r.listOpenPayments(10)).map((x) => x.paymentId)).toEqual(["o2"]);
      expect((await r.getPayment("o1"))?.status).toBe("pending"); // closing the index leaves the payment alone
    });

    it("forward queue: enqueue is idempotent (first write wins); settledAmountOut round-trips", async () => {
      const r = await make();
      await r.createPayment(pay("f1"));
      await r.updatePaymentStatus("f1", ["pending"], { status: "pending", intentsStatus: "SUCCESS", checkedAt: 1500, settledAmountOut: "49000001" });
      expect((await r.getPayment("f1"))?.settledAmountOut).toBe("49000001");
      const e = { paymentId: "f1", amount: "49000001", recipient: "forwarder.nearbi.near", destinationAsset: "nep141:usdc", depositAddress: "dep-f1", settlementTx: "Tx9", enqueuedAt: 1500 };
      await r.enqueueForward(e);
      await r.enqueueForward({ ...e, amount: "1", enqueuedAt: 1600 });
      expect(await r.listForwardQueue(10)).toEqual([e]);
    });

    it("one-off payments round-trip with product and brief", async () => {
      const r = await make();
      const p = oneOff("q1", "alice.near", { product: "deep_dive", brief: { question: "Q?", contact: null, scope: "DeFi" }, amountUsd: 499 });
      await r.createPayment(p);
      expect(await r.getPayment("q1")).toEqual(p);
    });

    it("applyOrderPayment: paid + ORDER + open-order index, subscription untouched, all or nothing", async () => {
      const r = await make();
      await r.createPayment(oneOff("q1"));
      expect(await r.applyOrderPayment({ paymentId: "q1", txHash: "1click:dep-q1", nowSec: 1100, order: order("q1") })).toEqual({ ok: true });
      expect(await r.getPayment("q1")).toMatchObject({ status: "paid", txHash: "1click:dep-q1", paidAt: 1100 });
      expect(await r.getOrder("q1")).toEqual(order("q1"));
      expect(await r.getSubscription("alice.near")).toBeNull();
      expect(await r.listOpenOrders(10)).toEqual([order("q1")]);
      // second time: not_pending, nothing duplicated
      expect(await r.applyOrderPayment({ paymentId: "q1", txHash: "1click:other", nowSec: 1200, order: order("q1", "alice.near", { createdAt: 1200 }) })).toEqual({ ok: false, reason: "not_pending" });
      expect(await r.listOrders("alice.near")).toEqual([order("q1")]);
      // tx claim reused by another payment: nothing changes
      await r.createPayment(oneOff("q2"));
      expect(await r.applyOrderPayment({ paymentId: "q2", txHash: "1click:dep-q1", nowSec: 1300, order: order("q2") })).toEqual({ ok: false, reason: "tx_used" });
      expect(await r.getPayment("q2")).toMatchObject({ status: "pending", txHash: null });
      expect(await r.getOrder("q2")).toBeNull();
      // refunded payments can't become orders
      await r.createPayment(oneOff("q3", "alice.near", { status: "refunded" }));
      expect(await r.applyOrderPayment({ paymentId: "q3", txHash: "tx-q3", nowSec: 1300, order: order("q3") })).toEqual({ ok: false, reason: "not_pending" });
      expect(await r.getOrder("q3")).toBeNull();
      expect(await r.getOrder("missing")).toBeNull();
    });

    it("orders: per-account list newest first; open list oldest first; delivered leaves the open list", async () => {
      const r = await make();
      for (const [id, acct, t] of [["o1", "alice.near", 1000], ["o2", "bob.near", 1100], ["o3", "alice.near", 1200]] as const) {
        await r.createPayment(oneOff(id, acct));
        await r.applyOrderPayment({ paymentId: id, txHash: `tx-${id}`, nowSec: t, order: order(id, acct, { createdAt: t, updatedAt: t }) });
      }
      expect((await r.listOrders("alice.near")).map((o) => o.paymentId)).toEqual(["o3", "o1"]);
      expect(await r.listOrders("nobody.near")).toEqual([]);
      expect((await r.listOpenOrders(10)).map((o) => o.paymentId)).toEqual(["o1", "o2", "o3"]);
      expect((await r.listOpenOrders(2)).map((o) => o.paymentId)).toEqual(["o1", "o2"]);

      expect(await r.updateOrder("o1", { status: "in_progress", nowSec: 1500 })).toMatchObject({ status: "in_progress", updatedAt: 1500, deliveryUrl: null });
      expect((await r.listOpenOrders(10)).map((o) => [o.paymentId, o.status])).toEqual([["o1", "in_progress"], ["o2", "paid"], ["o3", "paid"]]);
      const done = await r.updateOrder("o1", { status: "delivered", deliveryUrl: "/reports/o1/", nowSec: 1600 });
      expect(done).toEqual(order("o1", "alice.near", { createdAt: 1000, status: "delivered", deliveryUrl: "/reports/o1/", updatedAt: 1600 }));
      expect(await r.getOrder("o1")).toEqual(done);
      expect((await r.listOpenOrders(10)).map((o) => o.paymentId)).toEqual(["o2", "o3"]);
      // re-opening puts it back; deliveryUrl untouched when not given
      expect(await r.updateOrder("o1", { status: "in_progress", nowSec: 1700 })).toMatchObject({ deliveryUrl: "/reports/o1/" });
      expect((await r.listOpenOrders(10)).map((o) => o.paymentId)).toEqual(["o1", "o2", "o3"]);
      expect(await r.updateOrder("nope", { status: "delivered", nowSec: 1 })).toBeNull();
      expect(await r.getSubscription("alice.near")).toBeNull();
    });

    it("registry tokens: one live token per account", async () => {
      const r = await make();
      const t = (h: string, accountId = "alice.near") => ({ tokenHash: h, accountId, expiresAt: 9000, revoked: false, createdAt: 100 });
      await r.replaceRegistryToken(t("h1"));
      expect(await r.getRegistryToken("h1")).toEqual(t("h1"));
      await r.replaceRegistryToken(t("h2"));
      expect(await r.getRegistryToken("h1")).toMatchObject({ revoked: true });
      expect(await r.getRegistryToken("h2")).toMatchObject({ revoked: false });
      await r.replaceRegistryToken(t("b1", "bob.near"));
      expect(await r.getRegistryToken("h2")).toMatchObject({ revoked: false }); // other accounts unaffected
      expect(await r.getRegistryToken("missing")).toBeNull();
    });

    it("report catalog lists newest first", async () => {
      const r = await make();
      await r.putReport({ slug: "a", title: "A", summary: "", publishedAt: "2026-10-01", isFree: false, pdfFile: null });
      await r.putReport({ slug: "b", title: "B", summary: "s", publishedAt: "2026-11-01", isFree: true, pdfFile: "b.pdf" });
      const list = await r.listReports();
      expect(list.map((x) => x.slug)).toEqual(["b", "a"]);
      expect(list[0]).toEqual({ slug: "b", title: "B", summary: "s", publishedAt: "2026-11-01", isFree: true, pdfFile: "b.pdf" });
    });
  });
}
