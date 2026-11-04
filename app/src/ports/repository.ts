// Storage port. Implementations: MemoryRepository (tests, local dev) and DynamoRepository (AWS).
// Every method that must be atomic says so; implementations are tested against one shared contract.

import type { StoredChallenge } from "../core/signin";
import type { RegistryTokenRecord } from "../core/registry-token";
import type { SubscriptionRecord } from "../core/subscription";
import type { Deliverable, OrderBrief, OrderRecord, OrderStatus, ProductId } from "../core/products";

export type { Deliverable, OrderBrief, OrderRecord, OrderStatus, ProductId, RegistryTokenRecord, StoredChallenge, SubscriptionRecord };

export interface AccountRecord {
  accountId: string;
  createdAt: number;
  lastLoginAt: number;
}

/**
 * preview: DRY quote, nothing can be paid. pending: waiting for the deposit. processing: deposit seen /
 * swap running. incomplete: deposit below the quote. paid: subscription extended (only applyPayment sets
 * it). refunded / failed: 1Click gave the funds back / errored. expired: deadline passed with no deposit.
 */
export type PaymentStatus = "preview" | "pending" | "processing" | "incomplete" | "paid" | "refunded" | "failed" | "expired";

/** Statuses applyPayment may move to "paid". refunded/failed are final: the money went back or nowhere. */
export const PAYABLE_STATUSES: readonly PaymentStatus[] = ["preview", "pending", "processing", "incomplete", "expired"];

export type PaymentMode = "dry" | "live" | "stub";

export interface PaymentRecord {
  id: string; // uuid; also the order_id passed to the splitter
  accountId: string;
  amountUsd: number;
  token: string; // 1Click asset id the user pays with (originAsset)
  depositAddress: string | null; // null for dry quotes
  status: PaymentStatus;
  txHash: string | null; // uniqueness claim used when marking paid ("1click:<depositAddress>" or the admin's tx hash)
  createdAt: number;
  paidAt: number | null;
  quoteJson: string; // raw 1Click quote response (incl. signature), for audit and disputes
  // 1Click fields. Payments created before the integration (stub era) read back with these null.
  mode: PaymentMode | null;
  quoteId: string | null; // 1Click correlationId
  depositMemo: string | null;
  destinationAsset: string | null;
  recipient: string | null;
  amountIn: string | null; // base units of `token` to send
  amountInFormatted: string | null;
  minAmountIn: string | null;
  amountOut: string | null; // base units of destinationAsset the recipient receives
  deadline: number | null; // unix seconds
  intentsStatus: string | null; // last raw 1Click status
  checkedAt: number | null; // last 1Click status check
  settlementTx: string | null; // destination tx hash reported by 1Click on SUCCESS
  /** Settled output (base units of destinationAsset) 1Click reported on SUCCESS; what the forwarder forwards. */
  settledAmountOut: string | null;
  /** Set by the forwarding agent (rs-agent bin/forwarder-runner) once forward(order_id = id) is final onchain. */
  forwardedTx: string | null;
  /** What was bought. null on payments created before products existed: those are subscriptions. */
  product: ProductId | null;
  /** One-off products: the customer's brief, validated at checkout and copied onto the order when paid. */
  brief: OrderBrief | null;
}

/** Index entry for a live payment the background sweep still has to watch (see Repository.listOpenPayments). */
export interface OpenPaymentRef {
  paymentId: string;
  createdAt: number;
  deadline: number | null;
}

/**
 * Work item for the forwarding agent: a live payment 1Click reported SUCCESS for, delivered with plain
 * ft_transfer to the settlement account (the forwarder contract). The agent calls
 * forward(order_id = paymentId, amount) and removes the entry. Written before the subscription is extended.
 */
export interface ForwardQueueEntry {
  paymentId: string;
  /** settled amountOut in base units of destinationAsset; null if 1Click didn't report one (agent must not guess). */
  amount: string | null;
  recipient: string;
  destinationAsset: string;
  depositAddress: string;
  settlementTx: string | null;
  enqueuedAt: number;
}

export interface PaymentStatusPatch {
  status: Exclude<PaymentStatus, "paid">;
  intentsStatus: string | null;
  checkedAt: number;
  settlementTx?: string | null;
  settledAmountOut?: string | null;
}

export interface ReportRecord {
  slug: string;
  title: string;
  summary: string;
  publishedAt: string; // YYYY-MM-DD
  isFree: boolean;
  pdfFile: string | null; // file name inside reports/<slug>/
}

export interface ApplyPaymentInput {
  paymentId: string;
  accountId: string;
  txHash: string;
  nowSec: number;
  newPeriodEnd: number;
  /** Optimistic-concurrency guard: the subscription as read before computing newPeriodEnd. */
  expected: { exists: boolean; currentPeriodEnd: number | null };
}

export type ApplyPaymentResult =
  | { ok: true }
  | { ok: false; reason: "not_pending" | "tx_used" | "conflict" };

export interface ApplyOrderPaymentInput {
  paymentId: string;
  txHash: string;
  nowSec: number;
  /** The order to create (status "paid"); its accountId/paymentId must match the payment. */
  order: OrderRecord;
}

export type ApplyOrderPaymentResult = { ok: true } | { ok: false; reason: "not_pending" | "tx_used" };

export interface OrderUpdate {
  status: OrderStatus;
  /** undefined: leave as is. null: clear. */
  deliveryUrl?: string | null;
  /** undefined: leave as is. null: detach. A slug can belong to one order only (else DeliverableSlugTaken). */
  deliverable?: Deliverable | null;
  /** undefined: leave as is. */
  shared?: boolean;
  nowSec: number;
}

/** updateOrder: the deliverable slug is already attached to another order. */
export class DeliverableSlugTaken extends Error {
  constructor(readonly slug: string) {
    super(`report slug ${slug} already belongs to another order`);
    this.name = "DeliverableSlugTaken";
  }
}

export interface Repository {
  // auth
  putChallenge(c: StoredChallenge): Promise<void>;
  /** Atomic delete-and-return. A nonce can be consumed at most once. */
  consumeChallenge(nonce: string): Promise<StoredChallenge | null>;
  recordLogin(accountId: string, nowSec: number): Promise<void>;
  getAccount(accountId: string): Promise<AccountRecord | null>;

  // billing
  getSubscription(accountId: string): Promise<SubscriptionRecord | null>;
  createPayment(p: PaymentRecord): Promise<void>;
  getPayment(id: string): Promise<PaymentRecord | null>;
  /**
   * Atomically: payment in PAYABLE_STATUSES -> paid, claim txHash (globally unique), set the subscription to active
   * with newPeriodEnd, but only if the subscription still matches `expected`. All or nothing.
   */
  applyPayment(input: ApplyPaymentInput): Promise<ApplyPaymentResult>;
  /**
   * Conditional status update from the 1Click poller: applies only if the payment's current status is in
   * `from`. Never sets "paid" (only applyPayment does). Returns false if the condition failed.
   */
  updatePaymentStatus(id: string, from: readonly PaymentStatus[], patch: PaymentStatusPatch): Promise<boolean>;
  /**
   * Live payments still to be watched by the scheduled sweep. createPayment adds every live payment that
   * has a deposit address (atomically with the payment); the sweep removes it with closeOpenPayment.
   */
  listOpenPayments(limit: number): Promise<OpenPaymentRef[]>;
  closeOpenPayment(id: string): Promise<void>;
  /**
   * One-off products: atomically payment in PAYABLE_STATUSES -> paid, claim txHash, create the ORDER
   * (status "paid") and index it as awaiting delivery. Never touches the subscription. All or nothing.
   */
  applyOrderPayment(input: ApplyOrderPaymentInput): Promise<ApplyOrderPaymentResult>;
  getOrder(paymentId: string): Promise<OrderRecord | null>;
  /** An account's orders, newest first. */
  listOrders(accountId: string): Promise<OrderRecord[]>;
  /** Orders not yet delivered (status paid or in_progress), oldest first. */
  listOpenOrders(limit: number): Promise<OrderRecord[]>;
  /**
   * Set status (and optionally the delivery URL, deliverable, shared flag). delivered removes it from the open
   * list. Attaching a deliverable also indexes its slug (DELIV#<slug>) atomically; detaching/renaming removes the
   * old index. null if no such order; throws DeliverableSlugTaken if another order owns the slug.
   */
  updateOrder(paymentId: string, u: OrderUpdate): Promise<OrderRecord | null>;
  /** The order whose deliverable has this slug (any status), or null. */
  getOrderByDeliverable(slug: string): Promise<OrderRecord | null>;
  /** Idempotent: the same payment enqueued twice is one entry (the first write wins). */
  enqueueForward(e: ForwardQueueEntry): Promise<void>;
  listForwardQueue(limit: number): Promise<ForwardQueueEntry[]>;

  // registry
  /** Store a new token and revoke the account's previous one (one live token per account). */
  replaceRegistryToken(rec: RegistryTokenRecord): Promise<void>;
  getRegistryToken(tokenHash: string): Promise<RegistryTokenRecord | null>;

  // catalog
  listReports(): Promise<ReportRecord[]>;
  getReport(slug: string): Promise<ReportRecord | null>;
  putReport(r: ReportRecord): Promise<void>;
  deleteReport(slug: string): Promise<void>;
}
