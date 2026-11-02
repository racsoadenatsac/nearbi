// The app behind hono/aws-lambda, driven by synthetic API Gateway HTTP API (payload v2) events. No AWS calls.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { handle } from "hono/aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { base64Decode } from "../src/core/encoding";
import { setup } from "./helpers/app";
import { generateTestKey } from "./helpers/keys";

function event(method: string, rawPath: string, opts: { body?: unknown; cookies?: string[]; headers?: Record<string, string>; query?: string } = {}) {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath,
    rawQueryString: opts.query ?? "",
    cookies: opts.cookies,
    headers: { host: "abc123.execute-api.us-east-1.amazonaws.com", "content-type": "application/json", ...(opts.headers ?? {}) },
    requestContext: {
      accountId: "123456789012",
      apiId: "abc123",
      domainName: "abc123.execute-api.us-east-1.amazonaws.com",
      domainPrefix: "abc123",
      http: { method, path: rawPath, protocol: "HTTP/1.1", sourceIp: "203.0.113.1", userAgent: "vitest" },
      requestId: "r",
      routeKey: "$default",
      stage: "$default",
      time: "02/Nov/2026:00:00:00 +0000",
      timeEpoch: 0,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    isBase64Encoded: false,
  };
}

describe("AWS Lambda adapter (API Gateway HTTP API v2 events)", () => {
  it("full sign-in round trip: cookies come back in the v2 `cookies` array and are read from event.cookies", async () => {
    const t = setup();
    const handler = handle(t.app) as unknown as (e: unknown, ctx: unknown) => Promise<any>;
    const key = await generateTestKey();
    t.ownedKeys.set(key.publicKey, "alice.near");

    const chRes = await handler(event("GET", "/auth/challenge"), {});
    expect(chRes.statusCode).toBe(200);
    const ch = JSON.parse(chRes.body);
    const signature = await key.sign({ message: ch.message, nonce: base64Decode(ch.nonce), recipient: ch.recipient });

    const verify = await handler(
      event("POST", "/auth/verify", {
        headers: { origin: "https://nearbi.ai" },
        body: { accountId: "alice.near", publicKey: key.publicKey, signature, nonce: ch.nonce, message: ch.message, recipient: "nearbi.ai" },
      }),
      {},
    );
    expect(verify.statusCode).toBe(200);
    const setCookie: string[] = verify.cookies ?? (verify.multiValueHeaders?.["set-cookie"] as string[]) ?? [verify.headers["set-cookie"]];
    expect(setCookie[0]).toMatch(/^nearbi_session=/);

    const me = await handler(event("GET", "/api/me", { cookies: [setCookie[0].split(";")[0]] }), {});
    expect(JSON.parse(me.body)).toMatchObject({ authenticated: true, accountId: "alice.near" });
  });

  it("redirects and query strings survive the adapter", async () => {
    const t = setup();
    const handler = handle(t.app) as unknown as (e: unknown, ctx: unknown) => Promise<any>;
    const r = await handler(event("GET", "/members/container"), {});
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe("/login?next=%2Fmembers%2Fcontainer");
    const login = await handler(event("GET", "/login", { query: "next=%2Freports%2Fx%2F" }), {});
    expect(login.statusCode).toBe(200);
    expect(login.body).toContain('value="/reports/x/"');
  });
});

describe("src/lambda.ts module", () => {
  it("fails fast at cold start when required env is missing", async () => {
    const saved = { ...process.env };
    for (const k of ["SESSION_SECRET", "ADMIN_TOKEN", "TABLE_NAME", "CONTENT_BUCKET"]) delete process.env[k];
    try {
      vi.resetModules();
      await expect(import("../src/lambda")).rejects.toThrow(/missing required env: SESSION_SECRET, ADMIN_TOKEN, TABLE_NAME, CONTENT_BUCKET/);
    } finally {
      process.env = saved;
    }
  });

  it("wires DynamoDB + S3 and serves requests that need no storage, with no network", async () => {
    Object.assign(process.env, {
      SESSION_SECRET: "x".repeat(32),
      ADMIN_TOKEN: "a",
      TABLE_NAME: "nearbi",
      CONTENT_BUCKET: "nearbi-content",
      AWS_REGION: "us-east-1",
    });
    vi.resetModules();
    const mod = await import("../src/lambda");
    const r = await (mod.handler as any)(event("GET", "/api/me"), {});
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ authenticated: false, priceUsd: 49 });
  });
});

describe("config", () => {
  it("rejects short session secrets", async () => {
    const { loadConfig } = await import("../src/config");
    expect(() => loadConfig({ SESSION_SECRET: "short", ADMIN_TOKEN: "a" })).toThrow(/at least 32/);
    expect(loadConfig({ SESSION_SECRET: "x".repeat(32), ADMIN_TOKEN: "a", APP_ORIGIN: "https://nearbi.ai/, https://www.nearbi.ai" }).appOrigins).toEqual([
      "https://nearbi.ai",
      "https://www.nearbi.ai",
    ]);
  });
});
