// Subscription period math and state. Pure: no storage, no clock (callers pass unix seconds).

export type SubStatus = "none" | "active" | "canceled";

export interface SubscriptionRecord {
  accountId: string;
  status: SubStatus;
  currentPeriodEnd: number | null; // unix seconds; access while now < currentPeriodEnd
  lastPaymentTx: string | null;
  updatedAt: number;
}

export interface SubscriptionState {
  status: SubStatus | "expired";
  active: boolean;
  currentPeriodEnd: number | null; // unix seconds
}

/** Add one calendar month in UTC, clamping to the last day of the target month (Jan 31 -> Feb 28/29). */
export function addOneMonth(unixSec: number): number {
  const d = new Date(unixSec * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), lastDay);
  return Math.floor(Date.UTC(y, m, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) / 1000);
}

/** New period end after one paid month: stack onto a still-running period, otherwise start now. */
export function nextPeriodEnd(currentEnd: number | null | undefined, nowSec: number): number {
  const base = currentEnd && currentEnd > nowSec ? currentEnd : nowSec;
  return addOneMonth(base);
}

/** Period end after applying one paid month to an existing (or missing) subscription. */
export function periodEndAfterPayment(sub: Pick<SubscriptionRecord, "status" | "currentPeriodEnd"> | null, nowSec: number): number {
  return nextPeriodEnd(!sub || sub.status === "none" ? null : sub.currentPeriodEnd, nowSec);
}

export function subscriptionState(
  sub: Pick<SubscriptionRecord, "status" | "currentPeriodEnd"> | null | undefined,
  nowSec: number,
): SubscriptionState {
  if (!sub || sub.status === "none") return { status: "none", active: false, currentPeriodEnd: sub?.currentPeriodEnd ?? null };
  const live = sub.currentPeriodEnd !== null && sub.currentPeriodEnd > nowSec;
  // A canceled subscription keeps access until the end of the period already paid for.
  if (live) return { status: sub.status, active: true, currentPeriodEnd: sub.currentPeriodEnd };
  return { status: "expired", active: false, currentPeriodEnd: sub.currentPeriodEnd };
}
