// Runtime configuration from environment variables (Lambda env, or process.env in local dev).
// Secrets (SESSION_SECRET, ADMIN_TOKEN) are injected by the deploy from SSM Parameter Store / Secrets
// Manager; they are never committed.

import { DEFAULT_FREE_REPORT_SLUGS } from "./core/gating";
import { isMainnetAccount, looksLikeAssetId, ONECLICK_BASE_URL, USDC_ON_NEAR, type SettlementDelivery } from "./intents";

export type IntentsMode = "dry" | "live";

export interface IntentsConfig {
  /** dry: real DRY quotes (no deposit address, nothing payable). live: real deposit addresses. */
  mode: IntentsMode;
  baseUrl: string;
  /** Optional 1Click partner JWT (env ONECLICK_JWT). Only lowers fees; quotes work without it. Secret. */
  jwt: string | null;
  /** 1Click asset id revenue settles in (default: USDC on NEAR). The price is fixed in this asset. */
  settlementAsset: string;
  /** Mainnet NEAR account that receives revenue. Required in live mode; unset in dry mode is fine. */
  settlementRecipient: string | null;
  /** transfer: plain ft_transfer (default). ft_transfer_call: experimental 1Click customRecipientMsg, no refund on failure. */
  delivery: SettlementDelivery;
  slippageBps: number;
  quoteTtlMinutes: number;
}

export interface Config {
  nearRpcUrl: string;
  monthlyPriceUsd: number;
  authRecipient: string;
  registryHost: string;
  /** Public report slugs (static site). */
  freeReportSlugs: string[];
  /** Browser-facing origins (e.g. https://nearbi.ai). Used for the CSRF origin check behind CloudFront. */
  appOrigins: string[];
  /** Where the public static site lives; the free sample is redirected there if it ever reaches the app. */
  staticOrigin: string | null;
  /** If set, every request must carry `x-origin-verify: <secret>` (added by CloudFront) so the origin can't be hit directly. */
  originVerifySecret: string | null;
  presignTtlSeconds: number;
  sessionSecret: string;
  adminToken: string;
  // AWS wiring (only used by src/lambda.ts)
  tableName: string;
  contentBucket: string;
  contentPrefix: string;
  intents: IntentsConfig;
}

type Env = Record<string, string | undefined>;

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n > 0 ? n : d;
};

export function loadConfig(env: Env, opts: { requireAws?: boolean } = {}): Config {
  const missing: string[] = [];
  const need = (k: string) => {
    const v = env[k];
    if (!v) missing.push(k);
    return v ?? "";
  };
  const cfg: Config = {
    nearRpcUrl: env.NEAR_RPC_URL || "https://rpc.mainnet.near.org",
    monthlyPriceUsd: num(env.MONTHLY_PRICE_USD, 49),
    authRecipient: env.AUTH_RECIPIENT || "nearbi.ai",
    registryHost: env.REGISTRY_HOST || "registry.nearbi.ai",
    freeReportSlugs: (env.FREE_REPORT_SLUGS || env.FREE_REPORT_SLUG || DEFAULT_FREE_REPORT_SLUGS.join(","))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    appOrigins: (env.APP_ORIGIN || "https://nearbi.ai").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean),
    staticOrigin: env.STATIC_ORIGIN ? env.STATIC_ORIGIN.replace(/\/+$/, "") : null,
    originVerifySecret: env.ORIGIN_VERIFY_SECRET || null,
    presignTtlSeconds: Math.min(num(env.PRESIGN_TTL_SECONDS, 300), 3600),
    sessionSecret: need("SESSION_SECRET"),
    adminToken: need("ADMIN_TOKEN"),
    tableName: opts.requireAws ? need("TABLE_NAME") : env.TABLE_NAME || "",
    contentBucket: opts.requireAws ? need("CONTENT_BUCKET") : env.CONTENT_BUCKET || "",
    contentPrefix: env.CONTENT_PREFIX || "",
    intents: loadIntentsConfig(env),
  };
  if (missing.length) throw new Error(`missing required env: ${missing.join(", ")}`);
  if (cfg.sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  return cfg;
}

/**
 * NEAR Intents settings. Throws (so the Lambda refuses to start) on anything that could send live
 * payments to the wrong place: live mode needs SETTLEMENT_RECIPIENT set to a mainnet NEAR account.
 */
export function loadIntentsConfig(env: Env): IntentsConfig {
  const mode = (env.INTENTS_MODE || "dry").trim();
  if (mode !== "dry" && mode !== "live") throw new Error(`INTENTS_MODE must be "dry" or "live", got "${mode}"`);
  const settlementAsset = (env.SETTLEMENT_ASSET || USDC_ON_NEAR).trim();
  if (!looksLikeAssetId(settlementAsset)) throw new Error(`SETTLEMENT_ASSET is not a 1Click asset id: "${settlementAsset}"`);
  const delivery = (env.SETTLEMENT_DELIVERY || "transfer").trim();
  if (delivery !== "transfer" && delivery !== "ft_transfer_call") throw new Error(`SETTLEMENT_DELIVERY must be "transfer" or "ft_transfer_call"`);
  const recipient = (env.SETTLEMENT_RECIPIENT || "").trim() || null;

  if (mode === "live") {
    if (!recipient) throw new Error("INTENTS_MODE=live requires SETTLEMENT_RECIPIENT (a mainnet NEAR account)");
    if (!isMainnetAccount(recipient)) throw new Error(`INTENTS_MODE=live: SETTLEMENT_RECIPIENT "${recipient}" is not a mainnet NEAR account (*.near or 64-hex implicit)`);
    if (delivery === "ft_transfer_call") {
      if (!settlementAsset.startsWith("nep141:")) throw new Error("SETTLEMENT_DELIVERY=ft_transfer_call needs a NEP-141 SETTLEMENT_ASSET");
      // 1Click marks customRecipientMsg HIGHLY EXPERIMENTAL and the Verifier gives no refund when an
      // ft_transfer_call withdrawal fails, so a paused/misconfigured splitter loses the payment.
      if (env.SETTLEMENT_ACCEPT_NO_REFUND !== "yes")
        throw new Error("SETTLEMENT_DELIVERY=ft_transfer_call in live mode also requires SETTLEMENT_ACCEPT_NO_REFUND=yes (failed deliveries are not refunded)");
    }
  }
  return {
    mode,
    baseUrl: (env.ONECLICK_BASE_URL || ONECLICK_BASE_URL).replace(/\/+$/, ""),
    jwt: env.ONECLICK_JWT || null,
    settlementAsset,
    settlementRecipient: recipient,
    delivery,
    slippageBps: Math.min(num(env.QUOTE_SLIPPAGE_BPS, 100), 500),
    quoteTtlMinutes: Math.min(Math.max(num(env.QUOTE_TTL_MINUTES, 30), 5), 24 * 60),
  };
}
