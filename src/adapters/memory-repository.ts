// In-memory Repository for tests and local dev. Single-threaded JS makes each method atomic.
import {
  PAYABLE_STATUSES,
  type AccountRecord,
  type ApplyPaymentInput,
  type ApplyPaymentResult,
  type PaymentRecord,
  type PaymentStatus,
  type PaymentStatusPatch,
  type ForwardQueueEntry,
  type OpenPaymentRef,
  type RegistryTokenRecord,
  type ReportRecord,
  type Repository,
  type StoredChallenge,
  type SubscriptionRecord,
} from "../ports/repository";

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryRepository implements Repository {
  readonly challenges = new Map<string, StoredChallenge>();
  readonly accounts = new Map<string, AccountRecord>();
  readonly subscriptions = new Map<string, SubscriptionRecord>();
  readonly payments = new Map<string, PaymentRecord>();
  readonly txHashes = new Map<string, string>(); // txHash -> paymentId
  readonly tokens = new Map<string, RegistryTokenRecord>(); // tokenHash -> record
  readonly currentToken = new Map<string, string>(); // accountId -> tokenHash
  readonly reports = new Map<string, ReportRecord>();
  readonly openPayments = new Map<string, OpenPaymentRef>();
  readonly forwardQueue = new Map<string, ForwardQueueEntry>();

  constructor(seed: { reports?: ReportRecord[] } = {}) {
    for (const r of seed.reports ?? []) this.reports.set(r.slug, clone(r));
  }

  async putChallenge(c: StoredChallenge) {
    this.challenges.set(c.nonce, clone(c));
  }
  async consumeChallenge(nonce: string) {
    const c = this.challenges.get(nonce) ?? null;
    this.challenges.delete(nonce);
    return c;
  }
  async recordLogin(accountId: string, nowSec: number) {
    const a = this.accounts.get(accountId);
    this.accounts.set(accountId, { accountId, createdAt: a?.createdAt ?? nowSec, lastLoginAt: nowSec });
  }
  async getAccount(accountId: string) {
    const a = this.accounts.get(accountId);
    return a ? clone(a) : null;
  }

  async getSubscription(accountId: string) {
    const s = this.subscriptions.get(accountId);
    return s ? clone(s) : null;
  }
  async createPayment(p: PaymentRecord) {
    if (this.payments.has(p.id)) throw new Error(`payment ${p.id} already exists`);
    this.payments.set(p.id, clone(p));
    if (p.mode === "live" && p.depositAddress) this.openPayments.set(p.id, { paymentId: p.id, createdAt: p.createdAt, deadline: p.deadline });
  }
  async getPayment(id: string) {
    const p = this.payments.get(id);
    return p ? clone(p) : null;
  }
  async applyPayment(i: ApplyPaymentInput): Promise<ApplyPaymentResult> {
    const pay = this.payments.get(i.paymentId);
    if (!pay || !PAYABLE_STATUSES.includes(pay.status)) return { ok: false, reason: "not_pending" };
    if (this.txHashes.has(i.txHash)) return { ok: false, reason: "tx_used" };
    const sub = this.subscriptions.get(i.accountId);
    const matches = i.expected.exists ? !!sub && sub.currentPeriodEnd === i.expected.currentPeriodEnd : !sub;
    if (!matches) return { ok: false, reason: "conflict" };
    this.payments.set(i.paymentId, { ...pay, status: "paid", txHash: i.txHash, paidAt: i.nowSec });
    this.txHashes.set(i.txHash, i.paymentId);
    this.subscriptions.set(i.accountId, {
      accountId: i.accountId,
      status: "active",
      currentPeriodEnd: i.newPeriodEnd,
      lastPaymentTx: i.txHash,
      updatedAt: i.nowSec,
    });
    return { ok: true };
  }

  async updatePaymentStatus(id: string, from: readonly PaymentStatus[], patch: PaymentStatusPatch) {
    if ((patch.status as string) === "paid") throw new Error("use applyPayment to mark a payment paid");
    const pay = this.payments.get(id);
    if (!pay || !from.includes(pay.status)) return false;
    this.payments.set(id, {
      ...pay,
      status: patch.status,
      intentsStatus: patch.intentsStatus,
      checkedAt: patch.checkedAt,
      ...(patch.settlementTx !== undefined ? { settlementTx: patch.settlementTx } : {}),
      ...(patch.settledAmountOut !== undefined ? { settledAmountOut: patch.settledAmountOut } : {}),
    });
    return true;
  }

  async listOpenPayments(limit: number) {
    return [...this.openPayments.values()].sort((a, b) => a.paymentId.localeCompare(b.paymentId)).slice(0, limit).map(clone);
  }
  async closeOpenPayment(id: string) {
    this.openPayments.delete(id);
  }
  async enqueueForward(e: ForwardQueueEntry) {
    if (!this.forwardQueue.has(e.paymentId)) this.forwardQueue.set(e.paymentId, clone(e));
  }
  async listForwardQueue(limit: number) {
    return [...this.forwardQueue.values()].sort((a, b) => a.paymentId.localeCompare(b.paymentId)).slice(0, limit).map(clone);
  }

  async replaceRegistryToken(rec: RegistryTokenRecord) {
    const prev = this.currentToken.get(rec.accountId);
    if (prev) {
      const old = this.tokens.get(prev);
      if (old) this.tokens.set(prev, { ...old, revoked: true });
    }
    this.tokens.set(rec.tokenHash, clone(rec));
    this.currentToken.set(rec.accountId, rec.tokenHash);
  }
  async getRegistryToken(tokenHash: string) {
    const t = this.tokens.get(tokenHash);
    return t ? clone(t) : null;
  }

  async listReports() {
    return [...this.reports.values()]
      .map(clone)
      .sort((a, b) => (a.publishedAt === b.publishedAt ? a.slug.localeCompare(b.slug) : b.publishedAt.localeCompare(a.publishedAt)));
  }
  async putReport(r: ReportRecord) {
    this.reports.set(r.slug, clone(r));
  }
}
