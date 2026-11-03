// Where revenue goes, and the rules that keep live mode from paying somewhere wrong.

/** USDC (native Circle USDC) on NEAR mainnet, as 1Click names it (GET /v0/tokens, blockchain "near"). */
export const USDC_ON_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

/**
 * Recipient used for DRY quotes when no mainnet SETTLEMENT_RECIPIENT is configured. 1Click rejects
 * testnet accounts (e.g. splitter.nearbi-agent.testnet -> HTTP 400), so dry pricing needs a syntactically
 * valid mainnet account. This is the all-zero NEAR implicit account: nobody holds its key. It is NOT a
 * payment destination; dry quotes return no deposit address, so nothing can ever be sent through it,
 * and live mode refuses to start with it.
 */
export const DRY_QUOTE_RECIPIENT = "0".repeat(64);

// NEAR account id rules (nomicon): 2-64 chars, lowercase alnum separated by single - _ or .
const NEAR_ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const IMPLICIT_RE = /^[0-9a-f]{64}$/;

export function isNearAccountId(s: string): boolean {
  return NEAR_ACCOUNT_RE.test(s);
}

/** A mainnet NEAR account: a named `*.near` account (or the top-level `near`), or a 64-hex implicit account. */
export function isMainnetAccount(s: string): boolean {
  if (!isNearAccountId(s)) return false;
  if (IMPLICIT_RE.test(s)) return s !== DRY_QUOTE_RECIPIENT;
  return s === "near" || s.endsWith(".near");
}

/** Shape of a 1Click asset id (nep141:…, nep245:…, 1cs_v1:…). */
export function looksLikeAssetId(s: string): boolean {
  return /^(nep141|nep245|1cs_v1):\S{3,200}$/.test(s);
}

export type SettlementDelivery = "transfer" | "ft_transfer_call";

/**
 * The msg we ask 1Click to pass to ft_transfer_call when delivering to the splitter. Matches the
 * splitter's ft_on_transfer contract in rs-payments: JSON {"order_id": "..."} (1-128 chars).
 */
export function splitterMsg(orderId: string): string {
  if (!orderId || orderId.length > 128) throw new Error("order_id must be 1-128 chars");
  return JSON.stringify({ order_id: orderId });
}
