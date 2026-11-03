// High-level NEAR Intents adapter the billing service uses: cached token list, "charge N USD in the
// settlement asset" quotes (EXACT_OUTPUT), and status lookups.

import { toBaseUnits, USD_STABLE_SYMBOLS } from "./amount";
import { OneClickClient } from "./client";
import type { OneClickQuoteRequest, OneClickStatusResponse, OneClickToken, RefundType } from "./types";

export interface IntentsAdapterOptions {
  /** 1Click asset id the recipient receives (the price is fixed in this asset). */
  settlementAsset: string;
  slippageBps?: number;
  referral?: string;
  tokensTtlMs?: number;
  /** Serve a stale token list for this long if 1Click is unreachable. */
  tokensStaleMs?: number;
  nowMs?: () => number;
}

export interface QuoteUsdInput {
  originAsset: string;
  amountUsd: number;
  refundTo: string;
  refundType: RefundType;
  recipient: string;
  deadline: Date;
  dry: boolean;
  /** ft_transfer_call msg for the NEAR withdrawal (experimental 1Click feature); omit for plain ft_transfer. */
  customRecipientMsg?: string;
}

export interface PaymentQuote {
  dry: boolean;
  /** 1Click has no quote id; the response correlationId identifies the quote (with timestamp + signature). */
  quoteId: string;
  signature: string;
  depositAddress: string | null;
  depositMemo: string | null;
  originAsset: string;
  origin: { symbol: string; blockchain: string; decimals: number };
  destinationAsset: string;
  amountIn: string; // base units of originAsset to send (includes the slippage buffer; excess is refunded)
  amountInFormatted: string;
  minAmountIn: string;
  amountInUsd: string;
  amountOut: string; // exact base units the recipient gets
  amountOutFormatted: string;
  recipient: string;
  /** ISO. Live quotes: 1Click's deadline for the deposit address. Dry quotes: the deadline we requested. */
  deadline: string;
  timeEstimateSec: number;
  raw: unknown;
}

export class QuoteInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteInputError";
  }
}

export class IntentsAdapter {
  private tokens: { at: number; list: OneClickToken[] } | null = null;
  private inflight: Promise<OneClickToken[]> | null = null;
  private readonly nowMs: () => number;
  private readonly ttl: number;
  private readonly stale: number;

  constructor(
    readonly client: OneClickClient,
    readonly opts: IntentsAdapterOptions,
  ) {
    this.nowMs = opts.nowMs ?? Date.now;
    this.ttl = opts.tokensTtlMs ?? 5 * 60_000;
    this.stale = opts.tokensStaleMs ?? 60 * 60_000;
  }

  /** Live GET /tokens, cached per execution environment (TTL), stale-if-error. */
  async listTokens(): Promise<OneClickToken[]> {
    const t = this.nowMs();
    if (this.tokens && t - this.tokens.at < this.ttl) return this.tokens.list;
    if (!this.inflight) {
      this.inflight = this.client
        .getTokens()
        .then((list) => {
          this.tokens = { at: this.nowMs(), list };
          return list;
        })
        .finally(() => (this.inflight = null));
    }
    try {
      return await this.inflight;
    } catch (e) {
      if (this.tokens && t - this.tokens.at < this.stale) return this.tokens.list;
      throw e;
    }
  }

  async findToken(assetId: string): Promise<OneClickToken | null> {
    return (await this.listTokens()).find((x) => x.assetId === assetId) ?? null;
  }

  /** The settlement asset amount (base units) worth `amountUsd`. Stablecoins are 1:1; anything else uses the 1Click price. */
  settlementAmount(settlement: OneClickToken, amountUsd: number): string {
    if (USD_STABLE_SYMBOLS.has(settlement.symbol.toUpperCase())) return toBaseUnits(amountUsd, settlement.decimals);
    if (!(settlement.price > 0)) throw new QuoteInputError(`no USD price for settlement asset ${settlement.assetId}`);
    return toBaseUnits(amountUsd / settlement.price, settlement.decimals);
  }

  async quote(i: QuoteUsdInput): Promise<PaymentQuote> {
    if (!(i.amountUsd > 0)) throw new QuoteInputError("amountUsd must be positive");
    const [origin, settlement] = await Promise.all([this.findToken(i.originAsset), this.findToken(this.opts.settlementAsset)]);
    if (!origin) throw new QuoteInputError(`unsupported token: ${i.originAsset}`);
    if (!settlement) throw new QuoteInputError(`settlement asset not listed by 1Click: ${this.opts.settlementAsset}`);

    const req: OneClickQuoteRequest = {
      dry: i.dry,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: this.opts.slippageBps ?? 100,
      originAsset: origin.assetId,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: settlement.assetId,
      amount: this.settlementAmount(settlement, i.amountUsd),
      refundTo: i.refundTo,
      refundType: i.refundType,
      recipient: i.recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline: i.deadline.toISOString(),
      referral: this.opts.referral ?? "nearbi",
      ...(i.customRecipientMsg ? { customRecipientMsg: i.customRecipientMsg } : {}),
    };
    const r = await this.client.quote(req);
    const q = r.quote;
    return {
      dry: i.dry,
      quoteId: r.correlationId,
      signature: r.signature,
      depositAddress: q.depositAddress ?? null,
      depositMemo: q.depositMemo ?? null,
      originAsset: origin.assetId,
      origin: { symbol: origin.symbol, blockchain: origin.blockchain, decimals: origin.decimals },
      destinationAsset: settlement.assetId,
      amountIn: q.amountIn,
      amountInFormatted: q.amountInFormatted,
      minAmountIn: q.minAmountIn,
      amountInUsd: q.amountInUsd,
      amountOut: q.amountOut,
      amountOutFormatted: q.amountOutFormatted,
      recipient: i.recipient,
      deadline: q.deadline ?? req.deadline,
      timeEstimateSec: q.timeEstimate,
      raw: r,
    };
  }

  status(depositAddress: string, depositMemo?: string | null): Promise<OneClickStatusResponse> {
    return this.client.status(depositAddress, depositMemo ?? undefined);
  }
}

/** Slow chains need longer before 1Click starts refunding. */
export function quoteDeadline(now: Date, blockchain: string, baseMinutes = 30): Date {
  const slow = new Set(["btc", "ltc", "doge", "bch", "zec", "dash", "cardano"]);
  const minutes = slow.has(blockchain) ? Math.max(baseMinutes, 60) : baseMinutes;
  return new Date(now.getTime() + minutes * 60_000);
}
