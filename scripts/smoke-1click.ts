// Opt-in LIVE smoke test against the real 1Click API. DRY quotes only: no deposit address is created,
// nothing can be paid, nothing is signed. Run through bin/smoke-1click.sh (Docker, needs network).
//
//   bin/smoke-1click.sh            -> prints a DRY EXACT_OUTPUT quote for $MONTHLY_PRICE_USD from a few assets
//   bin/smoke-1click.sh --record   -> also (re)writes test/fixtures/1click/*.json (sanitized)
//
// Env: SETTLEMENT_ASSET (default USDC on NEAR), SETTLEMENT_RECIPIENT (default: the dry placeholder),
//      MONTHLY_PRICE_USD (default 49), ONECLICK_JWT (optional; never printed or recorded),
//      ONECLICK_BASE_URL (default https://1click.chaindefuser.com/v0).
import { mkdirSync, writeFileSync } from "node:fs";
import {
  DRY_QUOTE_RECIPIENT,
  IntentsAdapter,
  isMainnetAccount,
  OneClickClient,
  OneClickHttpError,
  quoteDeadline,
  USDC_ON_NEAR,
} from "../src/intents";

const record = process.argv.includes("--record");
const env = process.env;
const settlementAsset = env.SETTLEMENT_ASSET || USDC_ON_NEAR;
const configured = env.SETTLEMENT_RECIPIENT || "";
const recipient = configured && isMainnetAccount(configured) ? configured : DRY_QUOTE_RECIPIENT;
const priceUsd = Number(env.MONTHLY_PRICE_USD || 49);

// Origins to quote from: [label, assetId, refundType]. Refunds go to the payer's NEAR Intents account
// (refundType INTENTS), which is what the checkout does by default; the placeholder stands in for it here.
const ORIGINS: [string, string][] = [
  ["USDC on Base", "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"],
  ["ETH on Arbitrum", "nep141:arb.omft.near"],
  ["NEAR (wNEAR)", "nep141:wrap.near"],
  ["USDT on NEAR", "nep141:usdt.tether-token.near"],
];

const FIX = "test/fixtures/1click";
const client = new OneClickClient({ baseUrl: env.ONECLICK_BASE_URL, jwt: env.ONECLICK_JWT || null, timeoutMs: 15000, attempts: 2 });
const intents = new IntentsAdapter(client, { settlementAsset, slippageBps: 100 });

const t0 = Date.now();
const tokens = await intents.listTokens();
const settlement = tokens.find((t) => t.assetId === settlementAsset);
console.log(`1Click ${env.ONECLICK_BASE_URL || "https://1click.chaindefuser.com/v0"}  auth=${client.authenticated ? "JWT" : "none (unauthenticated fee schedule)"}`);
console.log(`GET /tokens: ${tokens.length} tokens in ${Date.now() - t0} ms`);
console.log(`settlement asset: ${settlementAsset} = ${settlement ? `${settlement.symbol} on ${settlement.blockchain}, ${settlement.decimals} decimals` : "NOT LISTED"}`);
console.log(`recipient: ${recipient}${recipient === DRY_QUOTE_RECIPIENT ? " (dry placeholder, not a payment destination)" : ""}`);
console.log(`price: ${priceUsd} USD -> EXACT_OUTPUT, dry=true, slippage 100 bps\n`);

let failures = 0;
const quotes: Record<string, unknown> = {};
for (const [label, assetId] of ORIGINS) {
  const tok = tokens.find((t) => t.assetId === assetId);
  const started = Date.now();
  try {
    const q = await intents.quote({
      originAsset: assetId,
      amountUsd: priceUsd,
      refundTo: DRY_QUOTE_RECIPIENT,
      refundType: "INTENTS",
      recipient,
      deadline: quoteDeadline(new Date(), tok?.blockchain ?? "near"),
      dry: true,
    });
    quotes[assetId] = q.raw;
    console.log(
      `ok   ${label.padEnd(16)} send ${q.amountInFormatted} ${q.origin.symbol} (min ${fmt(q.minAmountIn, q.origin.decimals)}, ~$${Number(q.amountInUsd).toFixed(2)})` +
        ` -> ${q.amountOutFormatted} out  quote ${q.quoteId}  eta ${q.timeEstimateSec}s  depositAddress=${q.depositAddress ?? "none (dry)"}  ${Date.now() - started} ms`,
    );
  } catch (e) {
    failures++;
    console.log(`FAIL ${label.padEnd(16)} ${e instanceof OneClickHttpError ? `HTTP ${e.status} ${e.message} (correlationId ${e.correlationId})` : String(e)}`);
  }
}

// Known error shapes, for the unit-test fixtures.
let errTestnet: unknown = null;
let errRefund: unknown = null;
let status404: unknown = null;
if (record) {
  errTestnet = await raw("/quote", { ...baseReq(), recipient: "splitter.nearbi-agent.testnet" });
  errRefund = await raw("/quote", { ...baseReq(), originAsset: "nep141:arb.omft.near", refundTo: "not-an-evm-address", refundType: "ORIGIN_CHAIN" });
  status404 = await raw(`/status?depositAddress=0x0000000000000000000000000000000000000001`);
}

if (record) {
  mkdirSync(FIX, { recursive: true });
  const meta = { recordedAt: new Date().toISOString(), source: "live 1Click API, dry quotes only", notes: "response bodies only; no request headers or keys" };
  write("tokens.json", tokens);
  write("quote-dry-base-usdc.json", quotes[ORIGINS[0][1]]);
  write("quote-dry-arb-eth.json", quotes[ORIGINS[1][1]]);
  write("quote-dry-wrap-near.json", quotes[ORIGINS[2][1]]);
  write("error-400-testnet-recipient.json", errTestnet);
  write("error-400-refund-to.json", errRefund);
  write("status-404.json", status404);
  write("_recorded.json", meta);
  console.log(`\nrecorded fixtures into ${FIX}/`);
}

process.exit(failures ? 1 : 0);

function baseReq() {
  return {
    dry: true,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,
    originAsset: ORIGINS[0][1],
    depositType: "ORIGIN_CHAIN",
    destinationAsset: settlementAsset,
    amount: String(priceUsd * 1_000_000),
    refundTo: DRY_QUOTE_RECIPIENT,
    refundType: "INTENTS",
    recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    referral: "nearbi",
  };
}

async function raw(path: string, body?: unknown) {
  const res = await fetch((env.ONECLICK_BASE_URL || "https://1click.chaindefuser.com/v0") + path, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  return { status: res.status, body: safeJson(await res.text()) };
}

function write(name: string, data: unknown) {
  writeFileSync(`${FIX}/${name}`, JSON.stringify(data, null, 2) + "\n");
}
function safeJson(t: string) {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
function fmt(base: string, decimals: number) {
  const p = base.padStart(decimals + 1, "0");
  return `${p.slice(0, -decimals) || "0"}.${p.slice(-decimals)}`.replace(/\.?0+$/, "");
}
