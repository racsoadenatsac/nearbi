// Test Env: real migrations on node:sqlite, an in-memory R2 bucket and a fake ASSETS fetcher.

import type { Env } from "../../src/env";
import { createTestD1 } from "./d1";

export function createMemoryR2(): R2Bucket & { store: Map<string, { body: string; contentType?: string }> } {
  const store = new Map<string, { body: string; contentType?: string }>();
  return {
    store,
    async get(key: string) {
      const o = store.get(key);
      if (!o) return null;
      return {
        key,
        body: new Response(o.body).body,
        httpEtag: `"etag-${key}"`,
        httpMetadata: o.contentType ? { contentType: o.contentType } : {},
        text: async () => o.body,
      };
    },
    async put(key: string, body: string, opts?: { httpMetadata?: { contentType?: string } }) {
      store.set(key, { body, contentType: opts?.httpMetadata?.contentType });
      return {};
    },
  } as unknown as R2Bucket & { store: Map<string, { body: string; contentType?: string }> };
}

export function createTestEnv(overrides: Partial<Env> = {}) {
  const DB = createTestD1();
  const CONTENT = createMemoryR2();
  const assetHits: string[] = [];
  const ASSETS = {
    async fetch(req: Request | string) {
      const url = typeof req === "string" ? req : req.url;
      assetHits.push(new URL(url).pathname);
      return new Response("static asset", { headers: { "x-from": "assets" } });
    },
  } as unknown as Fetcher;
  const env: Env = {
    DB,
    CONTENT,
    ASSETS,
    NEAR_RPC_URL: "https://rpc.invalid",
    MONTHLY_PRICE_USD: "49",
    AUTH_RECIPIENT: "nearbi.ai",
    REGISTRY_HOST: "registry.nearbi.ai",
    FREE_REPORT_SLUG: "near-users-vs-bots",
    SESSION_SECRET: "test-session-secret-0123456789abcdef",
    ADMIN_TOKEN: "test-admin-token",
    ...overrides,
  };
  return { env, DB, CONTENT, assetHits };
}
