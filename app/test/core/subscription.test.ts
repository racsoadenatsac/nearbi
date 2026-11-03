import { describe, expect, it } from "vitest";
import { addOneMonth, nextPeriodEnd, periodEndAfterPayment, subscriptionState } from "../../src/core/subscription";

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
  const row = (status: "none" | "active" | "canceled", end: number | null) => ({ status, currentPeriodEnd: end });
  it("is inactive with no row", () => expect(subscriptionState(null, now)).toEqual({ status: "none", active: false, currentPeriodEnd: null }));
  it("is active before period end", () => expect(subscriptionState(row("active", 2_000), now).active).toBe(true));
  it("expires exactly at period end", () => expect(subscriptionState(row("active", 1_000), now)).toMatchObject({ status: "expired", active: false }));
  it("canceled keeps access until period end", () => {
    expect(subscriptionState(row("canceled", 2_000), now)).toMatchObject({ status: "canceled", active: true });
    expect(subscriptionState(row("canceled", 999), now).active).toBe(false);
  });
});

describe("periodEndAfterPayment", () => {
  const now = ts("2026-11-02T00:00:00Z");
  it("treats a missing or 'none' subscription as starting now", () => {
    expect(periodEndAfterPayment(null, now)).toBe(ts("2026-12-02T00:00:00Z"));
    expect(periodEndAfterPayment({ status: "none", currentPeriodEnd: ts("2026-11-20T00:00:00Z") }, now)).toBe(ts("2026-12-02T00:00:00Z"));
  });
  it("stacks onto an active or canceled-but-running period", () => {
    expect(periodEndAfterPayment({ status: "canceled", currentPeriodEnd: ts("2026-11-20T00:00:00Z") }, now)).toBe(ts("2026-12-20T00:00:00Z"));
  });
});
