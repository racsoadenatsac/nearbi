// Checkout and payment confirmation: core period math + the Repository's atomic applyPayment.
import { periodEndAfterPayment } from "../core/subscription";
import type { QuoteDepositFn } from "../adapters/intents";
import type { Repository } from "../ports/repository";

export interface CheckoutResult {
  paymentId: string;
  amountUsd: number;
  token: string;
  depositAddress: string;
  deadline: string;
  stub: boolean;
}

export async function createCheckout(
  repo: Repository,
  opts: { accountId: string; amountUsd: number; nowSec: number; originAsset?: string; refundTo?: string },
  quote: QuoteDepositFn,
): Promise<CheckoutResult> {
  const paymentId = crypto.randomUUID();
  const q = await quote(
    { paymentId, amountUsd: opts.amountUsd, accountId: opts.accountId, originAsset: opts.originAsset, refundTo: opts.refundTo },
    new Date(opts.nowSec * 1000),
  );
  await repo.createPayment({
    id: paymentId,
    accountId: opts.accountId,
    amountUsd: opts.amountUsd,
    token: q.originAsset,
    depositAddress: q.depositAddress,
    status: "pending",
    txHash: null,
    createdAt: opts.nowSec,
    paidAt: null,
    quoteJson: JSON.stringify(q.raw),
  });
  return { paymentId, amountUsd: opts.amountUsd, token: q.originAsset, depositAddress: q.depositAddress, deadline: q.deadline, stub: q.stub };
}

export type ConfirmResult =
  | { ok: true; alreadyPaid: boolean; accountId: string; currentPeriodEnd: number }
  | { ok: false; status: 404 | 409; error: string };

const MAX_ATTEMPTS = 3;

/**
 * Mark a pending payment as paid and extend the account's subscription by one month. Idempotent:
 * confirming an already-paid payment returns alreadyPaid and never extends twice. Concurrent renewals
 * are serialized by the repository's optimistic check on the subscription's current period end.
 */
export async function confirmPayment(repo: Repository, paymentId: string, txHash: string, nowSec: number): Promise<ConfirmResult> {
  for (let attempt = 1; ; attempt++) {
    const pay = await repo.getPayment(paymentId);
    if (!pay) return { ok: false, status: 404, error: "payment not found" };
    if (pay.status === "paid") {
      const sub = await repo.getSubscription(pay.accountId);
      return { ok: true, alreadyPaid: true, accountId: pay.accountId, currentPeriodEnd: sub?.currentPeriodEnd ?? 0 };
    }
    if (pay.status !== "pending") return { ok: false, status: 409, error: `payment is ${pay.status}` };

    const sub = await repo.getSubscription(pay.accountId);
    const newPeriodEnd = periodEndAfterPayment(sub, nowSec);
    const r = await repo.applyPayment({
      paymentId,
      accountId: pay.accountId,
      txHash,
      nowSec,
      newPeriodEnd,
      expected: { exists: !!sub, currentPeriodEnd: sub?.currentPeriodEnd ?? null },
    });
    if (r.ok) return { ok: true, alreadyPaid: false, accountId: pay.accountId, currentPeriodEnd: newPeriodEnd };
    if (r.reason === "tx_used") return { ok: false, status: 409, error: "tx_hash already used" };
    // not_pending: paid concurrently -> loop reports alreadyPaid. conflict: subscription moved -> recompute.
    if (attempt >= MAX_ATTEMPTS) return { ok: false, status: 409, error: "concurrent update, retry" };
  }
}
