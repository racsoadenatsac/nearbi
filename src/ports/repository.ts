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

export interface PaymentRecord {
  id: string; // uuid
  accountId: string;
  amountUsd: number;
  token: string; // 1Click asset id the user pays with
  depositAddress: string;
  status: PaymentStatus;
  txHash: string | null;
  createdAt: number;
  paidAt: number | null;
  quoteJson: string; // raw quote, for audit
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
   * Atomically: payment pending -> paid, claim txHash (globally unique), set the subscription to active
   * with newPeriodEnd, but only if the subscription still matches `expected`. All or nothing.
   */
  applyPayment(input: ApplyPaymentInput): Promise<ApplyPaymentResult>;

  // registry
  /** Store a new token and revoke the account's previous one (one live token per account). */
  replaceRegistryToken(rec: RegistryTokenRecord): Promise<void>;
  getRegistryToken(tokenHash: string): Promise<RegistryTokenRecord | null>;

  // catalog
  listReports(): Promise<ReportRecord[]>;
  putReport(r: ReportRecord): Promise<void>;
}
