export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  CONTENT: R2Bucket;

  NEAR_RPC_URL: string;
  MONTHLY_PRICE_USD?: string;
  AUTH_RECIPIENT?: string;
  REGISTRY_HOST?: string;
  FREE_REPORT_SLUG?: string;

  // secrets
  SESSION_SECRET: string;
  ADMIN_TOKEN: string;
}

export const DEFAULTS = {
  MONTHLY_PRICE_USD: 49,
  AUTH_RECIPIENT: "nearbi.ai",
  REGISTRY_HOST: "registry.nearbi.ai",
  FREE_REPORT_SLUG: "near-users-vs-bots",
} as const;

export function monthlyPriceUsd(env: Env): number {
  const n = Number(env.MONTHLY_PRICE_USD);
  return Number.isFinite(n) && n > 0 ? n : DEFAULTS.MONTHLY_PRICE_USD;
}

export const recipient = (env: Env) => env.AUTH_RECIPIENT || DEFAULTS.AUTH_RECIPIENT;
export const registryHost = (env: Env) => env.REGISTRY_HOST || DEFAULTS.REGISTRY_HOST;
export const freeSlug = (env: Env) => env.FREE_REPORT_SLUG || DEFAULTS.FREE_REPORT_SLUG;
