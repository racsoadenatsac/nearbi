// Subscription state, checkout and payment confirmation.

import type { QuoteDepositFn } from "./intents";

export type SubStatus = "none" | "active" | "canceled";

export interface SubscriptionRow {
  account_id: string;
  status: SubStatus;
  current_period_end: number | null;
  last_payment_tx: string | null;
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
  return Math.floor(
    Date.UTC(y, m, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) / 1000,
  );
}

/** New period end after one paid month: stack onto a still-running period, otherwise start now. */
export function nextPeriodEnd(currentEnd: number | null | undefined, nowSec: number): number {
  const base = currentEnd && currentEnd > nowSec ? currentEnd : nowSec;
  return addOneMonth(base);
}

export function subscriptionState(row: SubscriptionRow | null | undefined, nowSec: number): SubscriptionState {
  if (!row || row.status === "none") return { status: "none", active: false, currentPeriodEnd: row?.current_period_end ?? null };
  const live = row.current_period_end !== null && row.current_period_end > nowSec;
  // A canceled subscription keeps access until the end of the period already paid for.
  if (live) return { status: row.status, active: true, currentPeriodEnd: row.current_period_end };
  return { status: "expired", active: false, currentPeriodEnd: row.current_period_end };
}

export async function getSubscription(db: D1Database, accountId: string): Promise<SubscriptionRow | null> {
  return db
    .prepare("SELECT account_id, status, current_period_end, last_payment_tx FROM subscriptions WHERE account_id = ?")
    .bind(accountId)
    .first<SubscriptionRow>();
}

export async function upsertAccountLogin(db: D1Database, accountId: string, nowSec: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO accounts (account_id, created_at, last_login_at) VALUES (?1, ?2, ?2)
       ON CONFLICT(account_id) DO UPDATE SET last_login_at = excluded.last_login_at`,
    )
    .bind(accountId, nowSec)
    .run();
}

export interface CheckoutResult {
  paymentId: string;
  amountUsd: number;
  token: string;
  depositAddress: string;
  deadline: string;
  stub: boolean;
}

export async function createCheckout(
  db: D1Database,
  opts: { accountId: string; amountUsd: number; nowSec: number; originAsset?: string; refundTo?: string },
  quote: QuoteDepositFn,
): Promise<CheckoutResult> {
  const paymentId = crypto.randomUUID();
  const q = await quote(
    { paymentId, amountUsd: opts.amountUsd, accountId: opts.accountId, originAsset: opts.originAsset, refundTo: opts.refundTo },
    new Date(opts.nowSec * 1000),
  );
  await db
    .prepare(
      `INSERT INTO payments (id, account_id, amount_usd, token, intents_deposit_address, status, created_at, quote_json)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .bind(paymentId, opts.accountId, opts.amountUsd, q.originAsset, q.depositAddress, opts.nowSec, JSON.stringify(q.raw))
    .run();
  return {
    paymentId,
    amountUsd: opts.amountUsd,
    token: q.originAsset,
    depositAddress: q.depositAddress,
    deadline: q.deadline,
    stub: q.stub,
  };
}

export type ConfirmResult =
  | { ok: true; alreadyPaid: boolean; accountId: string; currentPeriodEnd: number }
  | { ok: false; status: number; error: string };

/**
 * Mark a pending payment as paid and extend the account's subscription by one month.
 * Both writes happen in one D1 batch (one transaction); the subscription write only applies if the
 * payment row actually flipped from pending -> paid, so repeated confirms never extend twice.
 */
export async function confirmPayment(
  db: D1Database,
  paymentId: string,
  txHash: string,
  nowSec: number,
): Promise<ConfirmResult> {
  const pay = await db
    .prepare("SELECT id, account_id, status, tx_hash FROM payments WHERE id = ?")
    .bind(paymentId)
    .first<{ id: string; account_id: string; status: string; tx_hash: string | null }>();
  if (!pay) return { ok: false, status: 404, error: "payment not found" };
  if (pay.status === "paid") {
    const sub = await getSubscription(db, pay.account_id);
    return { ok: true, alreadyPaid: true, accountId: pay.account_id, currentPeriodEnd: sub?.current_period_end ?? 0 };
  }
  if (pay.status !== "pending") return { ok: false, status: 409, error: `payment is ${pay.status}` };

  const sub = await getSubscription(db, pay.account_id);
  const newEnd = nextPeriodEnd(sub?.status === "none" ? null : sub?.current_period_end, nowSec);

  try {
    await db.batch([
      db
        .prepare("UPDATE payments SET status = 'paid', tx_hash = ?, paid_at = ? WHERE id = ? AND status = 'pending'")
        .bind(txHash, nowSec, paymentId),
      db
        .prepare(
          `INSERT INTO subscriptions (account_id, status, current_period_end, last_payment_tx, updated_at)
           SELECT ?1, 'active', ?2, ?3, ?4 WHERE changes() = 1
           ON CONFLICT(account_id) DO UPDATE SET
             status = 'active', current_period_end = excluded.current_period_end,
             last_payment_tx = excluded.last_payment_tx, updated_at = excluded.updated_at`,
        )
        .bind(pay.account_id, newEnd, txHash, nowSec),
    ]);
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message)) return { ok: false, status: 409, error: "tx_hash already used" };
    throw e;
  }
  const after = await getSubscription(db, pay.account_id);
  return { ok: true, alreadyPaid: false, accountId: pay.account_id, currentPeriodEnd: after?.current_period_end ?? newEnd };
}
