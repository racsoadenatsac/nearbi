// Runtime configuration from environment variables (Lambda env, or process.env in local dev).
// Secrets (SESSION_SECRET, ADMIN_TOKEN) are injected by the deploy from SSM Parameter Store / Secrets
// Manager; they are never committed.

export interface Config {
  nearRpcUrl: string;
  monthlyPriceUsd: number;
  authRecipient: string;
  registryHost: string;
  freeReportSlug: string;
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
    freeReportSlug: env.FREE_REPORT_SLUG || "near-users-vs-bots",
    appOrigins: (env.APP_ORIGIN || "https://nearbi.ai").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean),
    staticOrigin: env.STATIC_ORIGIN ? env.STATIC_ORIGIN.replace(/\/+$/, "") : null,
    originVerifySecret: env.ORIGIN_VERIFY_SECRET || null,
    presignTtlSeconds: Math.min(num(env.PRESIGN_TTL_SECONDS, 300), 3600),
    sessionSecret: need("SESSION_SECRET"),
    adminToken: need("ADMIN_TOKEN"),
    tableName: opts.requireAws ? need("TABLE_NAME") : env.TABLE_NAME || "",
    contentBucket: opts.requireAws ? need("CONTENT_BUCKET") : env.CONTENT_BUCKET || "",
    contentPrefix: env.CONTENT_PREFIX || "",
  };
  if (missing.length) throw new Error(`missing required env: ${missing.join(", ")}`);
  if (cfg.sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  return cfg;
}
