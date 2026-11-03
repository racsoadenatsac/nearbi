// One behavioural contract for every Repository implementation (memory always, DynamoDB Local optionally).
import { describe, expect, it } from "vitest";
import type { PaymentRecord, Repository } from "../../src/ports/repository";

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
  ...over,
});

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
