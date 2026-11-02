// ============================================================================
//  STUB: NEAR Intents 1Click adapter.
//  Nothing here talks to the network. quoteDeposit() returns a fake deposit
//  address that is clearly marked as such and MUST NOT be shown to real users.
// ============================================================================
//
// TODO(1click): replace stubQuoteDeposit with a real call:
//   POST https://1click.chaindefuser.com/v0/quote   (Authorization: Bearer <ONECLICK_JWT>, optional)
//   body (sketch, check against the current 1Click docs before shipping):
//     {
//       dry: false,
//       swapType: "EXACT_OUTPUT",
//       slippageTolerance: 100,                       // basis points
//       originAsset: input.originAsset,               // what the user pays with
//       depositType: "ORIGIN_CHAIN",
//       destinationAsset: USDC_ON_NEAR,               // we settle in USDC on NEAR
//       amount: <amountUsd in USDC base units, 6 decimals>,
//       refundTo: input.refundTo, refundType: "ORIGIN_CHAIN",
//       recipient: <NEARBI_TREASURY_ACCOUNT>, recipientType: "DESTINATION_CHAIN",
//       deadline: <ISO time, ~1h>,
//       referral: "nearbi"
//     }
//   response.quote.depositAddress is what the user sends funds to.
// TODO(1click): poll GET https://1click.chaindefuser.com/v0/status?depositAddress=... (or a cron
//   trigger) and call confirmPayment() on SUCCESS, replacing the manual POST /billing/confirm.

export const USDC_ON_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

export interface QuoteInput {
  paymentId: string;
  amountUsd: number;
  accountId: string;
  originAsset?: string; // 1Click asset id the user pays with; defaults to USDC on NEAR
  refundTo?: string;
}

export interface DepositQuote {
  stub: boolean;
  depositAddress: string;
  originAsset: string;
  destinationAsset: string;
  amountUsd: number;
  deadline: string; // ISO
  raw: unknown;
}

export type QuoteDepositFn = (input: QuoteInput, now: Date) => Promise<DepositQuote>;

/** STUB. Deterministic, offline, obviously fake. */
export const stubQuoteDeposit: QuoteDepositFn = async (input, now) => {
  const originAsset = input.originAsset ?? USDC_ON_NEAR;
  return {
    stub: true,
    depositAddress: `STUB-NOT-A-REAL-ADDRESS-${input.paymentId}`,
    originAsset,
    destinationAsset: USDC_ON_NEAR,
    amountUsd: input.amountUsd,
    deadline: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    raw: { stub: true, note: "1Click quote not requested; see src/billing/intents.ts TODO" },
  };
};

/** The adapter the app uses. Swap this for the real implementation once 1Click is wired up. */
export const quoteDeposit: QuoteDepositFn = stubQuoteDeposit;
