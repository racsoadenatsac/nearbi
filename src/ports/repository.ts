// Storage port. Implementations: MemoryRepository (tests, local dev) and DynamoRepository (AWS).
// Every method that must be atomic says so; implementations are tested against one shared contract.

import type { StoredChallenge } from "../core/signin";
import type { RegistryTokenRecord } from "../core/registry-token";
import type { SubscriptionRecord } from "../core/subscription";

export type { RegistryTokenRecord, StoredChallenge, SubscriptionRecord };

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
}

export interface PaymentStatusPatch {
  status: Exclude<PaymentStatus, "paid">;
  intentsStatus: string | null;
  checkedAt: number;
  settlementTx?: string | null;
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

  // registry
  /** Store a new token and revoke the account's previous one (one live token per account). */
  replaceRegistryToken(rec: RegistryTokenRecord): Promise<void>;
  getRegistryToken(tokenHash: string): Promise<RegistryTokenRecord | null>;

  // catalog
  listReports(): Promise<ReportRecord[]>;
  putReport(r: ReportRecord): Promise<void>;
}
