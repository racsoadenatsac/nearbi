// Checkout, 1Click status polling and payment confirmation: core period math + the Repository's atomic
// applyPayment + the NEAR Intents adapter.
import QRCode from "qrcode";
import type { IntentsConfig } from "../config";
import { periodEndAfterPayment } from "../core/subscription";
import {
  DRY_QUOTE_RECIPIENT,
  fromBaseUnits,
  isMainnetAccount,
  mapOneClickStatus,
  OneClickHttpError,
  QuoteInputError,
  quoteDeadline,
  splitterMsg,
  type IntentsAdapter,
  type OneClickStatusResponse,
  type OneClickToken,
} from "../intents";
import { PAYABLE_STATUSES, type PaymentRecord, type PaymentStatus, type Repository } from "../ports/repository";

export interface BillingDeps {
  repo: Repository;
  intents: IntentsAdapter;
  config: IntentsConfig;
}

/** What the checkout page and the status poller get back. */
export interface PaymentView {
  paymentId: string;
  mode: "dry" | "live" | "stub";
  status: PaymentStatus;
  statusLabel: string;
  amountUsd: number;
  originAsset: string;
  origin: { symbol: string; blockchain: string; decimals: number } | null;
  /** What to send (base units + formatted). Includes the slippage buffer; any excess is refunded. */
  amountIn: string | null;
  amountInFormatted: string | null;
  minAmountInFormatted: string | null;
  settlement: { assetId: string | null; amountOutFormatted: string | null; recipient: string | null };
  depositAddress: string | null;
  depositMemo: string | null;
  deadline: string | null; // ISO
  quoteId: string | null;
  intentsStatus: string | null;
  qrSvg: string | null;
  /** True when 1Click couldn't be reached on this poll and the stored state is shown. */
  stale?: boolean;
}

const PREVIEW_LABEL = "Preview only: payments are not enabled yet. This quote is real, but there is no deposit address to pay.";

// ------------------------------------------------------------------------------------------ tokens

const POPULAR: string[] = [
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", // USDC NEAR
  "nep141:usdt.tether-token.near",
  "nep141:wrap.near",
  "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", // USDC Base
  "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", // USDC Arbitrum
  "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", // USDC Ethereum
  "nep141:eth.omft.near",
  "nep141:base.omft.near",
  "nep141:arb.omft.near",
  "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", // USDC Solana
  "nep141:sol.omft.near",
  "nep141:btc.omft.near",
];

export interface TokenOption {
  assetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
  priceUsd: number;
  popular: boolean;
}

/** Live 1Click token list (cached by the adapter), popular first, then by chain and symbol. */
export async function listPaymentTokens(intents: IntentsAdapter): Promise<TokenOption[]> {
  const tokens = await intents.listTokens();
  const rank = (t: OneClickToken) => {
    const i = POPULAR.indexOf(t.assetId);
    return i === -1 ? POPULAR.length : i;
  };
  return tokens
    .filter((t) => t.price > 0 && !t.assetId.startsWith("1cs_v1:any"))
    .sort((a, b) => rank(a) - rank(b) || a.blockchain.localeCompare(b.blockchain) || a.symbol.localeCompare(b.symbol))
    .map((t) => ({ assetId: t.assetId, symbol: t.symbol, blockchain: t.blockchain, decimals: t.decimals, priceUsd: t.price, popular: rank(t) < POPULAR.length }));
}

// ---------------------------------------------------------------------------------------- checkout

export interface CheckoutInput {
  accountId: string;
  amountUsd: number;
  nowSec: number;
  originAsset: string;
  /** Origin-chain refund address. Omitted: refunds go to the signed-in account's NEAR Intents balance. */
  refundTo?: string;
}

export class CheckoutError extends Error {
  constructor(
    readonly status: 400 | 422 | 503,
    message: string,
  ) {
    super(message);
    this.name = "CheckoutError";
  }
}

/** Where the quote sends the money. Live: the configured mainnet recipient. Dry: that, or the inert placeholder. */
export function quoteRecipient(cfg: IntentsConfig): string {
  if (cfg.settlementRecipient && isMainnetAccount(cfg.settlementRecipient)) return cfg.settlementRecipient;
  if (cfg.mode === "live") throw new Error("live mode without a mainnet SETTLEMENT_RECIPIENT"); // loadConfig prevents this
  return DRY_QUOTE_RECIPIENT;
}

export async function createCheckout(d: BillingDeps, i: CheckoutInput): Promise<PaymentView> {
  const dry = d.config.mode === "dry";
  const paymentId = crypto.randomUUID();
  const origin = await d.intents.findToken(i.originAsset).catch((e) => {
    throw new CheckoutError(503, `token list unavailable: ${(e as Error).message}`);
  });
  if (!origin) throw new CheckoutError(400, "unsupported token");
  const refund = i.refundTo
    ? { refundTo: i.refundTo.trim(), refundType: "ORIGIN_CHAIN" as const }
    : { refundTo: i.accountId, refundType: "INTENTS" as const };
  if (i.refundTo && !/^[A-Za-z0-9:._-]{20,128}$/.test(refund.refundTo) && !/^[a-z0-9._-]{2,64}$/.test(refund.refundTo)) {
    throw new CheckoutError(400, "refund address looks malformed");
  }

  let customRecipientMsg: string | undefined;
  if (d.config.delivery === "ft_transfer_call") {
    const settlement = await d.intents.findToken(d.config.settlementAsset);
    if (!settlement || settlement.blockchain !== "near") throw new CheckoutError(503, "ft_transfer_call delivery needs a NEAR settlement asset");
    customRecipientMsg = splitterMsg(paymentId);
  }

  const deadline = quoteDeadline(new Date(i.nowSec * 1000), origin.blockchain, d.config.quoteTtlMinutes);
  let q;
  try {
    q = await d.intents.quote({
      originAsset: origin.assetId,
      amountUsd: i.amountUsd,
      ...refund,
      recipient: quoteRecipient(d.config),
      deadline,
      dry,
      customRecipientMsg,
    });
  } catch (e) {
    if (e instanceof QuoteInputError) throw new CheckoutError(400, e.message);
    if (e instanceof OneClickHttpError && e.status < 500 && e.status !== 429) throw new CheckoutError(422, `quote rejected: ${e.message.replace(/^1Click \S+ -> /, "")}`);
    throw new CheckoutError(503, "quote service unavailable, try again");
  }
  if (!dry && !q.depositAddress) throw new CheckoutError(503, "quote came back without a deposit address");

  const pay: PaymentRecord = {
    id: paymentId,
    accountId: i.accountId,
    amountUsd: i.amountUsd,
    token: q.originAsset,
    depositAddress: q.depositAddress,
    status: dry ? "preview" : "pending",
    txHash: null,
    createdAt: i.nowSec,
    paidAt: null,
    quoteJson: JSON.stringify(q.raw),
    mode: dry ? "dry" : "live",
    quoteId: q.quoteId,
    depositMemo: q.depositMemo,
    destinationAsset: q.destinationAsset,
    recipient: q.recipient,
    amountIn: q.amountIn,
    amountInFormatted: q.amountInFormatted,
    minAmountIn: q.minAmountIn,
    amountOut: q.amountOut,
    deadline: Math.floor(Date.parse(q.deadline) / 1000),
    intentsStatus: null,
    checkedAt: null,
    settlementTx: null,
    settledAmountOut: null,
    forwardedTx: null,
  };
  await d.repo.createPayment(pay);
  return view(pay, origin, await d.intents.findToken(q.destinationAsset), { dry });
}

// ------------------------------------------------------------------------------------------ status

/** Don't ask 1Click more than once per this many seconds per payment. */
const MIN_CHECK_INTERVAL = 5;
/** After the deadline with still no deposit, call it expired (a late SUCCESS is still honoured). */
const EXPIRY_GRACE = 15 * 60;
const TERMINAL: PaymentStatus[] = ["paid", "refunded", "failed"];

export type StatusResult = { ok: true; view: PaymentView } | { ok: false; status: 404; error: string };

/**
 * GET /billing/status/:id. Live payments: ask 1Click (throttled), map its status, and on SUCCESS extend
 * the subscription exactly once (confirmPayment is idempotent and the claim key is per deposit address).
 */
export async function pollPaymentStatus(d: BillingDeps, paymentId: string, accountId: string, nowSec: number): Promise<StatusResult> {
  const pay = await d.repo.getPayment(paymentId);
  if (!pay || pay.accountId !== accountId) return { ok: false, status: 404, error: "payment not found" };
  const r = await refreshPayment(d, pay, nowSec);
  const origin = await d.intents.findToken(r.pay.token).catch(() => null);
  const settlement = r.pay.destinationAsset ? await d.intents.findToken(r.pay.destinationAsset).catch(() => null) : null;
  return { ok: true, view: await view(r.pay, origin, settlement, { dry: r.pay.mode === "dry", stale: r.stale, label: r.label }) };
}

export interface RefreshResult {
  pay: PaymentRecord;
  /** 1Click was asked on this call (false: dry/stub, terminal or throttled). */
  checked: boolean;
  stale?: boolean;
  label?: string;
}

/**
 * One status check of a live payment against 1Click, shared by the checkout page's poller and the
 * scheduled sweep. Never trusts the caller: the 1Click payload must match the stored quote, and SUCCESS
 * goes through confirmPayment's once-only claim.
 */
export async function refreshPayment(d: BillingDeps, pay: PaymentRecord, nowSec: number): Promise<RefreshResult> {
  if (pay.mode !== "live" || !pay.depositAddress) return { pay, checked: false }; // dry preview / legacy stub
  if (TERMINAL.includes(pay.status)) return { pay, checked: false };
  if (pay.checkedAt !== null && nowSec - pay.checkedAt < MIN_CHECK_INTERVAL) return { pay, checked: false };

  let st: OneClickStatusResponse | null = null;
  try {
    st = await d.intents.status(pay.depositAddress, pay.depositMemo);
  } catch (e) {
    if (!(e instanceof OneClickHttpError && e.status === 404)) {
      console.warn(`1click status ${pay.id}: ${(e as Error).message}`);
      return { pay, checked: true, stale: true };
    }
    // 404: 1Click doesn't know the address (yet). Treat like PENDING_DEPOSIT.
  }
  const raw = st?.status ?? "PENDING_DEPOSIT";

  if (st && !matchesOurQuote(st, pay, raw)) {
    console.error(`1click status ${pay.id}: response does not match the stored quote; not confirming`);
    await d.repo.updatePaymentStatus(pay.id, [pay.status], { status: pay.status as Exclude<PaymentStatus, "paid">, intentsStatus: `MISMATCH:${raw}`, checkedAt: nowSec });
    return { pay: { ...pay, intentsStatus: `MISMATCH:${raw}` }, checked: true, label: "Payment state could not be verified; support has been notified" };
  }

  const mapped = mapOneClickStatus(raw);
  if (mapped?.status === "paid") {
    const settlementTx = st?.swapDetails.destinationChainTxHashes[0]?.hash ?? st?.swapDetails.nearTxHashes.at(-1) ?? null;
    const out = st?.swapDetails.amountOut;
    const settledAmountOut = out && /^\d+$/.test(out) ? out : null;
    await d.repo.updatePaymentStatus(pay.id, PAYABLE_STATUSES, {
      status: pay.status as Exclude<PaymentStatus, "paid">,
      intentsStatus: raw,
      checkedAt: nowSec,
      settlementTx,
      settledAmountOut,
    });
    // Plain ft_transfer delivery lands in the settlement account (the forwarder contract); queue it for
    // the forwarding agent BEFORE extending the subscription, so a paid payment is never left unqueued.
    if (d.config.delivery === "transfer" && pay.recipient && pay.destinationAsset) {
      await d.repo.enqueueForward({
        paymentId: pay.id,
        amount: settledAmountOut,
        recipient: pay.recipient,
        destinationAsset: pay.destinationAsset,
        depositAddress: pay.depositAddress,
        settlementTx,
        enqueuedAt: nowSec,
      });
    }
    const r = await confirmPayment(d.repo, pay.id, `1click:${pay.depositAddress}`, nowSec);
    if (!r.ok) console.error(`1click SUCCESS for ${pay.id} but confirm failed: ${r.error}`);
  } else {
    let next: Exclude<PaymentStatus, "paid"> = mapped ? (mapped.status as Exclude<PaymentStatus, "paid">) : (pay.status as Exclude<PaymentStatus, "paid">);
    if (next === "pending" && pay.deadline !== null && nowSec > pay.deadline + EXPIRY_GRACE) next = "expired";
    await d.repo.updatePaymentStatus(pay.id, PAYABLE_STATUSES, { status: next, intentsStatus: raw, checkedAt: nowSec });
  }
  return { pay: (await d.repo.getPayment(pay.id))!, checked: true };
}

// ------------------------------------------------------------------------------- scheduled sweep

/** Expired payments stay watched this long past their deadline, so a late SUCCESS still confirms. */
export const LATE_SUCCESS_WINDOW = 24 * 3600;
/**
 * 1Click keeps a deposit address open ~72 h past the deadline we request, so an abandoned checkout stays
 * open for days. Payments older than this with no deposit seen are checked at most every SLOW_RECHECK s.
 */
export const SWEEP_FAST_AGE = 3600;
export const SWEEP_SLOW_RECHECK = 600;
const SWEEP_CONCURRENCY = 4;

export interface SweepResult {
  open: number;
  checked: number;
  /** Old payments with no deposit seen, skipped this run (backoff). */
  deferred: number;
  closed: number;
  paid: number;
  errors: number;
  /** Stopped early because the time budget ran out; the rest is picked up next run (order is randomized). */
  truncated: boolean;
}

/**
 * Background confirmation (EventBridge Scheduler -> Lambda, every minute): check every open live payment
 * against 1Click so payments confirm even if nobody keeps the checkout page open. Idempotent and safe to
 * run concurrently with the page's poller (same refreshPayment, same once-only confirm). Payments are
 * visited in random order with bounded concurrency, so a long list can't starve its tail.
 */
export async function sweepOpenPayments(
  d: BillingDeps,
  nowSec: number,
  opts: { limit?: number; budgetMs?: number; clock?: () => number; random?: () => number; concurrency?: number } = {},
): Promise<SweepResult> {
  const clock = opts.clock ?? Date.now;
  const random = opts.random ?? Math.random;
  const started = clock();
  const budget = opts.budgetMs ?? 7000;
  const refs = await d.repo.listOpenPayments(opts.limit ?? 500);
  for (let i = refs.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [refs[i], refs[j]] = [refs[j]!, refs[i]!];
  }
  const res: SweepResult = { open: refs.length, checked: 0, deferred: 0, closed: 0, paid: 0, errors: 0, truncated: false };
  let next = 0;
  const worker = async () => {
    while (next < refs.length) {
      if (clock() - started > budget) {
        res.truncated = true;
        return;
      }
      const ref = refs[next++]!;
      try {
        const pay = await d.repo.getPayment(ref.paymentId);
        if (!pay || pay.mode !== "live" || !pay.depositAddress) {
          await d.repo.closeOpenPayment(ref.paymentId);
          res.closed++;
          continue;
        }
        const quiet = (pay.status === "pending" || pay.status === "expired") && nowSec - pay.createdAt > SWEEP_FAST_AGE;
        if (quiet && pay.checkedAt !== null && nowSec - pay.checkedAt < SWEEP_SLOW_RECHECK) {
          res.deferred++;
          continue;
        }
        const before = pay.status;
        const r = await refreshPayment(d, pay, nowSec);
        if (r.checked && !r.stale) res.checked++;
        if (r.pay.status === "paid" && before !== "paid") res.paid++;
        const lateWindowOver = r.pay.status === "expired" && r.pay.deadline !== null && nowSec > r.pay.deadline + LATE_SUCCESS_WINDOW;
        if (TERMINAL.includes(r.pay.status) || lateWindowOver) {
          await d.repo.closeOpenPayment(ref.paymentId);
          res.closed++;
        }
      } catch (e) {
        res.errors++;
        console.error(`sweep ${ref.paymentId}: ${(e as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? SWEEP_CONCURRENCY) }, worker));
  return res;
}

/** The status 1Click returns embeds the original quote; make sure it is the one we issued and stored. */
function matchesOurQuote(st: OneClickStatusResponse, pay: PaymentRecord, raw: string): boolean {
  const qr = st.quoteResponse?.quoteRequest;
  const q = st.quoteResponse?.quote;
  if (!qr || !q) return false;
  if (q.depositAddress && q.depositAddress !== pay.depositAddress) return false;
  if (pay.recipient && qr.recipient !== pay.recipient) return false;
  if (pay.destinationAsset && qr.destinationAsset !== pay.destinationAsset) return false;
  if (pay.amountOut && (qr.swapType !== "EXACT_OUTPUT" || BigInt(qr.amount) < BigInt(pay.amountOut))) return false;
  // On SUCCESS, the settled output (when reported) must cover what we charged.
  const out = st.swapDetails?.amountOut;
  if (raw === "SUCCESS" && pay.amountOut && out && /^\d+$/.test(out) && BigInt(out) < BigInt(pay.amountOut)) return false;
  return true;
}

// ---------------------------------------------------------------------------------------- confirm

export type ConfirmResult =
  | { ok: true; alreadyPaid: boolean; accountId: string; currentPeriodEnd: number }
  | { ok: false; status: 404 | 409; error: string };

const MAX_ATTEMPTS = 3;

/**
 * Mark a payable payment as paid and extend the account's subscription by one month. Idempotent:
 * confirming an already-paid payment returns alreadyPaid and never extends twice. Concurrent renewals
 * are serialized by the repository's optimistic check on the subscription's current period end.
 * Used by the 1Click poller on SUCCESS and by the admin override (POST /billing/confirm).
 */
export async function confirmPayment(repo: Repository, paymentId: string, txHash: string, nowSec: number): Promise<ConfirmResult> {
  for (let attempt = 1; ; attempt++) {
    const pay = await repo.getPayment(paymentId);
    if (!pay) return { ok: false, status: 404, error: "payment not found" };
    if (pay.status === "paid") {
      const sub = await repo.getSubscription(pay.accountId);
      return { ok: true, alreadyPaid: true, accountId: pay.accountId, currentPeriodEnd: sub?.currentPeriodEnd ?? 0 };
    }
    if (!PAYABLE_STATUSES.includes(pay.status)) return { ok: false, status: 409, error: `payment is ${pay.status}` };

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

// -------------------------------------------------------------------------------------------- view

const LABELS: Record<PaymentStatus, string> = {
  preview: PREVIEW_LABEL,
  pending: "Waiting for your deposit",
  processing: "Deposit received, swap in progress",
  incomplete: "Deposit below the quoted amount: send the rest before the deadline, or it is refunded",
  paid: "Paid: your subscription is active",
  refunded: "Refunded to your refund address",
  failed: "Swap failed; any deposit is refunded by NEAR Intents",
  expired: "Quote expired with no deposit. Start a new checkout",
};

async function view(
  p: PaymentRecord,
  origin: OneClickToken | null,
  settlement: OneClickToken | null,
  o: { dry: boolean; stale?: boolean; label?: string },
): Promise<PaymentView> {
  const decimals = origin?.decimals;
  const base: PaymentView = {
    paymentId: p.id,
    mode: p.mode ?? "stub",
    status: p.status,
    statusLabel: o.label ?? LABELS[p.status],
    amountUsd: p.amountUsd,
    originAsset: p.token,
    origin: origin ? { symbol: origin.symbol, blockchain: origin.blockchain, decimals: origin.decimals } : null,
    amountIn: p.amountIn,
    amountInFormatted: p.amountInFormatted,
    minAmountInFormatted: p.minAmountIn && decimals !== undefined ? fromBaseUnits(p.minAmountIn, decimals) : null,
    settlement: {
      assetId: p.destinationAsset,
      amountOutFormatted: p.amountOut && settlement ? `${fromBaseUnits(p.amountOut, settlement.decimals)} ${settlement.symbol}` : null,
      recipient: p.recipient,
    },
    depositAddress: o.dry ? null : p.depositAddress,
    depositMemo: p.depositMemo,
    deadline: p.deadline ? new Date(p.deadline * 1000).toISOString() : null,
    quoteId: p.quoteId,
    intentsStatus: p.intentsStatus,
    qrSvg: null,
    ...(o.stale ? { stale: true } : {}),
  };
  if (!base.depositAddress || TERMINAL.includes(p.status)) return base;
  return { ...base, qrSvg: await QRCode.toString(base.depositAddress, { type: "svg", margin: 1, errorCorrectionLevel: "M" }) };
}
