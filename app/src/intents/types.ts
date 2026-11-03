// Types for the NEAR Intents 1Click Swap API (https://1click.chaindefuser.com/v0), checked against the
// live OpenAPI spec (https://1click.chaindefuser.com/docs/v0/openapi.yaml) and live responses on
// 2026-11-02. Only the fields this app reads are typed strictly; everything else is kept as `unknown`
// in the raw payload we store for audit.

/** GET /v0/tokens item. */
export interface OneClickToken {
  assetId: string; // e.g. "nep141:wrap.near", "nep141:base-0x8335….omft.near", "1cs_v1:near:nep141:zec.omft.near"
  decimals: number;
  blockchain: string; // "near" | "eth" | "base" | "arb" | "btc" | "sol" | … (the enum grows; keep it open)
  symbol: string;
  price: number; // USD
  priceUpdatedAt: string;
  contractAddress?: string | null;
  coingeckoId?: string;
}

export type SwapType = "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT" | "ANY_INPUT";
export type DepositType = "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type RefundType = "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type RecipientType = "DESTINATION_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";

/** POST /v0/quote body (required fields per the spec, plus the optional ones we use). */
export interface OneClickQuoteRequest {
  dry: boolean;
  swapType: SwapType;
  slippageTolerance: number; // basis points
  originAsset: string;
  depositType: DepositType;
  destinationAsset: string;
  amount: string; // integer string in base units; with EXACT_OUTPUT it is the amount the recipient gets
  refundTo: string;
  refundType: RefundType;
  recipient: string;
  recipientType: RecipientType;
  deadline: string; // ISO; refunds start if the swap hasn't completed by then
  referral?: string;
  /** HIGHLY EXPERIMENTAL per the spec: withdraw to NEAR with ft_transfer_call(msg) instead of ft_transfer. */
  customRecipientMsg?: string;
  quoteWaitingTimeMs?: number;
  appFees?: { recipient: string; fee: number }[];
}

export interface OneClickQuote {
  depositAddress?: string; // absent on dry quotes
  depositMemo?: string; // some chains (stellar, xrp, ton) require it
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  deadline?: string; // absent on dry quotes
  timeWhenInactive?: string; // absent on dry quotes
  timeEstimate: number; // seconds
  refundFee?: string;
  withdrawFee?: string;
  customRecipientMsg?: string;
}

/** POST /v0/quote response (HTTP 201 on success). There is no separate quote id: correlationId identifies it. */
export interface OneClickQuoteResponse {
  correlationId: string;
  timestamp: string;
  signature: string; // 1Click's ed25519 signature over the quote; keep it for disputes
  quoteRequest: OneClickQuoteRequest & Record<string, unknown>;
  quote: OneClickQuote;
}

/** Statuses from GetExecutionStatusResponse.status in the spec. */
export const ONECLICK_STATUSES = [
  "PENDING_DEPOSIT",
  "KNOWN_DEPOSIT_TX",
  "INCOMPLETE_DEPOSIT",
  "PROCESSING",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
] as const;
export type OneClickStatus = (typeof ONECLICK_STATUSES)[number];

export interface OneClickTxDetails {
  hash: string;
  explorerUrl: string;
}

export interface OneClickSwapDetails {
  intentHashes: string[];
  nearTxHashes: string[];
  amountIn?: string;
  amountInFormatted?: string;
  amountInUsd?: string;
  amountOut?: string;
  amountOutFormatted?: string;
  amountOutUsd?: string;
  slippage?: number;
  originChainTxHashes: OneClickTxDetails[];
  destinationChainTxHashes: OneClickTxDetails[];
  refundedAmount?: string;
  refundedAmountFormatted?: string;
  refundReason?: string;
  depositedAmount?: string;
  depositedAmountFormatted?: string;
}

/** GET /v0/status?depositAddress=… response. `status` is a string so unknown future values don't break parsing. */
export interface OneClickStatusResponse {
  correlationId: string;
  quoteResponse: OneClickQuoteResponse;
  status: OneClickStatus | (string & {});
  updatedAt: string;
  swapDetails: OneClickSwapDetails;
}

/** Error body the API returns on 4xx (e.g. {"message":"refundTo is not valid", "correlationId": …}). */
export interface OneClickErrorBody {
  message?: string;
  correlationId?: string;
}
