import { describe, expect, it, vi } from "vitest";
import { stubQuoteDeposit, USDC_ON_NEAR } from "../../src/adapters/intents";
import { MemoryRepository } from "../../src/adapters/memory-repository";
import { confirmPayment, createCheckout } from "../../src/services/billing";
import type { Repository } from "../../src/ports/repository";

const ts = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const now = ts("2026-11-02T00:00:00Z");

async function withPending(amount = 49) {
  const repo = new MemoryRepository();
  await repo.recordLogin("alice.near", now);
  const quote = vi.fn(stubQuoteDeposit);
  const co = await createCheckout(repo, { accountId: "alice.near", amountUsd: amount, nowSec: now }, quote);
  return { repo, co, quote };
}

describe("checkout + confirm", () => {
  it("creates a pending payment using the (stub) Intents quote", async () => {
    const { repo, co, quote } = await withPending();
    expect(quote).toHaveBeenCalledOnce();
    expect(co).toMatchObject({ amountUsd: 49, token: USDC_ON_NEAR, stub: true });
    expect(co.depositAddress).toMatch(/^STUB-NOT-A-REAL-ADDRESS-/);
    expect(await repo.getPayment(co.paymentId)).toMatchObject({ accountId: "alice.near", amountUsd: 49, status: "pending", depositAddress: co.depositAddress });
  });

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
    const { repo, co } = await withPending();
    await confirmPayment(repo, co.paymentId, "tx1", now);
    const co2 = await createCheckout(repo, { accountId: "alice.near", amountUsd: 49, nowSec: now + 86400 }, stubQuoteDeposit);
    expect(await confirmPayment(repo, co2.paymentId, "tx2", now + 86400)).toMatchObject({ ok: true, currentPeriodEnd: ts("2027-01-02T00:00:00Z") });
  });

  it("renewal after lapse starts from the confirmation time", async () => {
    const { repo, co } = await withPending();
    await confirmPayment(repo, co.paymentId, "tx1", now);
    const later = ts("2027-03-10T00:00:00Z");
    const co2 = await createCheckout(repo, { accountId: "alice.near", amountUsd: 49, nowSec: later }, stubQuoteDeposit);
    expect(await confirmPayment(repo, co2.paymentId, "tx2", later)).toMatchObject({ currentPeriodEnd: ts("2027-04-10T00:00:00Z") });
  });

  it("rejects unknown payments and reused tx hashes without extending", async () => {
    const { repo, co } = await withPending();
    expect(await confirmPayment(repo, "nope", "tx", now)).toMatchObject({ ok: false, status: 404 });
    await confirmPayment(repo, co.paymentId, "tx1", now);
    const co2 = await createCheckout(repo, { accountId: "alice.near", amountUsd: 49, nowSec: now }, stubQuoteDeposit);
    expect(await confirmPayment(repo, co2.paymentId, "tx1", now)).toMatchObject({ ok: false, status: 409 });
    expect((await repo.getSubscription("alice.near"))?.currentPeriodEnd).toBe(ts("2026-12-02T00:00:00Z"));
    expect((await repo.getPayment(co2.paymentId))?.status).toBe("pending");
  });

  it("two payments confirmed concurrently both count (optimistic retry)", async () => {
    const { repo, co } = await withPending();
    const co2 = await createCheckout(repo, { accountId: "alice.near", amountUsd: 49, nowSec: now }, stubQuoteDeposit);
    // Interleave: both read the subscription before either writes.
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
});
