import { describe, expect, it, vi } from "vitest";
import {
  addOneMonth,
  confirmPayment,
  createCheckout,
  getSubscription,
  nextPeriodEnd,
  subscriptionState,
  upsertAccountLogin,
} from "../src/billing/subscription";
import { stubQuoteDeposit, USDC_ON_NEAR } from "../src/billing/intents";
import { createTestD1 } from "./helpers/d1";

const ts = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const iso = (sec: number) => new Date(sec * 1000).toISOString();

describe("addOneMonth", () => {
  it("adds a calendar month in UTC", () => {
    expect(iso(addOneMonth(ts("2026-11-02T10:00:00Z")))).toBe("2026-12-02T10:00:00.000Z");
    expect(iso(addOneMonth(ts("2026-12-15T00:00:00Z")))).toBe("2027-01-15T00:00:00.000Z");
  });
  it("clamps to the end of shorter months", () => {
    expect(iso(addOneMonth(ts("2027-01-31T12:00:00Z")))).toBe("2027-02-28T12:00:00.000Z");
    expect(iso(addOneMonth(ts("2028-01-31T12:00:00Z")))).toBe("2028-02-29T12:00:00.000Z");
    expect(iso(addOneMonth(ts("2026-03-31T00:00:00Z")))).toBe("2026-04-30T00:00:00.000Z");
  });
});

describe("nextPeriodEnd", () => {
  const now = ts("2026-11-02T00:00:00Z");
  it("starts from now when there is no period or it has lapsed", () => {
    expect(nextPeriodEnd(null, now)).toBe(ts("2026-12-02T00:00:00Z"));
    expect(nextPeriodEnd(ts("2026-10-01T00:00:00Z"), now)).toBe(ts("2026-12-02T00:00:00Z"));
  });
  it("stacks onto a running period (early renewal loses no days)", () => {
    expect(nextPeriodEnd(ts("2026-11-20T00:00:00Z"), now)).toBe(ts("2026-12-20T00:00:00Z"));
  });
});

describe("subscriptionState", () => {
  const now = 1_000;
  const row = (status: "none" | "active" | "canceled", end: number | null) => ({ account_id: "a.near", status, current_period_end: end, last_payment_tx: null });
  it("is inactive with no row", () => expect(subscriptionState(null, now)).toEqual({ status: "none", active: false, currentPeriodEnd: null }));
  it("is active before period end", () => expect(subscriptionState(row("active", 2_000), now).active).toBe(true));
  it("expires exactly at period end", () => expect(subscriptionState(row("active", 1_000), now)).toMatchObject({ status: "expired", active: false }));
  it("canceled keeps access until period end", () => {
    expect(subscriptionState(row("canceled", 2_000), now)).toMatchObject({ status: "canceled", active: true });
    expect(subscriptionState(row("canceled", 999), now).active).toBe(false);
  });
});

describe("checkout + confirm (D1 via node:sqlite, real migrations)", () => {
  const now = ts("2026-11-02T00:00:00Z");

  async function withPending(amount = 49) {
    const db = createTestD1();
    await upsertAccountLogin(db, "alice.near", now);
    const quote = vi.fn(stubQuoteDeposit);
    const co = await createCheckout(db, { accountId: "alice.near", amountUsd: amount, nowSec: now }, quote);
    return { db, co, quote };
  }

  it("creates a pending payment using the (stub) Intents quote", async () => {
    const { db, co, quote } = await withPending();
    expect(quote).toHaveBeenCalledOnce();
    expect(co).toMatchObject({ amountUsd: 49, token: USDC_ON_NEAR, stub: true });
    expect(co.depositAddress).toMatch(/^STUB-NOT-A-REAL-ADDRESS-/);
    const row = await db.prepare("SELECT * FROM payments WHERE id = ?").bind(co.paymentId).first<Record<string, unknown>>();
    expect(row).toMatchObject({ account_id: "alice.near", amount_usd: 49, status: "pending", intents_deposit_address: co.depositAddress });
  });

  it("confirm marks paid and activates one month from now", async () => {
    const { db, co } = await withPending();
    const r = await confirmPayment(db, co.paymentId, "tx1", now);
    expect(r).toEqual({ ok: true, alreadyPaid: false, accountId: "alice.near", currentPeriodEnd: ts("2026-12-02T00:00:00Z") });
    expect(await getSubscription(db, "alice.near")).toMatchObject({ status: "active", last_payment_tx: "tx1" });
    expect(await db.prepare("SELECT status, tx_hash, paid_at FROM payments WHERE id = ?").bind(co.paymentId).first()).toEqual({ status: "paid", tx_hash: "tx1", paid_at: now });
  });

  it("is idempotent: confirming the same payment twice extends only once", async () => {
    const { db, co } = await withPending();
    await confirmPayment(db, co.paymentId, "tx1", now);
    const again = await confirmPayment(db, co.paymentId, "tx1", now + 10);
    expect(again).toMatchObject({ ok: true, alreadyPaid: true, currentPeriodEnd: ts("2026-12-02T00:00:00Z") });
  });

  it("a second payment stacks a second month onto the running period", async () => {
    const { db, co } = await withPending();
    await confirmPayment(db, co.paymentId, "tx1", now);
    const co2 = await createCheckout(db, { accountId: "alice.near", amountUsd: 49, nowSec: now + 86400 }, stubQuoteDeposit);
    const r = await confirmPayment(db, co2.paymentId, "tx2", now + 86400);
    expect(r).toMatchObject({ ok: true, currentPeriodEnd: ts("2027-01-02T00:00:00Z") });
  });

  it("renewal after lapse starts from the confirmation time", async () => {
    const { db, co } = await withPending();
    await confirmPayment(db, co.paymentId, "tx1", now);
    const later = ts("2027-03-10T00:00:00Z");
    const co2 = await createCheckout(db, { accountId: "alice.near", amountUsd: 49, nowSec: later }, stubQuoteDeposit);
    expect(await confirmPayment(db, co2.paymentId, "tx2", later)).toMatchObject({ currentPeriodEnd: ts("2027-04-10T00:00:00Z") });
  });

  it("rejects unknown payments and reused tx hashes without extending", async () => {
    const { db, co } = await withPending();
    expect(await confirmPayment(db, "nope", "tx", now)).toMatchObject({ ok: false, status: 404 });
    await confirmPayment(db, co.paymentId, "tx1", now);
    const co2 = await createCheckout(db, { accountId: "alice.near", amountUsd: 49, nowSec: now }, stubQuoteDeposit);
    expect(await confirmPayment(db, co2.paymentId, "tx1", now)).toMatchObject({ ok: false, status: 409 });
    expect((await getSubscription(db, "alice.near"))?.current_period_end).toBe(ts("2026-12-02T00:00:00Z"));
    expect(await db.prepare("SELECT status FROM payments WHERE id = ?").bind(co2.paymentId).first("status")).toBe("pending");
  });
});
