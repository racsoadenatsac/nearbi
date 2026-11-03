import { describe, expect, it } from "vitest";
import { OneClickClient, OneClickHttpError, OneClickUnavailableError, type FetchFn } from "../../src/intents";
import { fakeOneClick, fx } from "../helpers/oneclick";

const noSleep = { sleep: async () => {}, random: () => 0.5 };
const reqBody = () => ({ ...fx.quoteBaseUsdc().quoteRequest, dry: true });

describe("OneClickClient", () => {
  it("parses the recorded /tokens list", async () => {
    const f = fakeOneClick();
    const c = new OneClickClient({ fetch: f.fetch, ...noSleep });
    const tokens = await c.getTokens();
    expect(tokens.length).toBeGreaterThan(100);
    expect(tokens.find((t) => t.symbol === "USDC" && t.blockchain === "near")).toMatchObject({
      assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      decimals: 6,
    });
    expect(f.calls[0]).toMatchObject({ method: "GET", url: "https://1click.chaindefuser.com/v0/tokens" });
  });

  it("posts a quote and returns the typed recorded response (HTTP 201)", async () => {
    const f = fakeOneClick();
    const c = new OneClickClient({ fetch: f.fetch, ...noSleep });
    const r = await c.quote(reqBody());
    expect(r.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.signature).toMatch(/^ed25519:/);
    expect(r.quote.depositAddress).toBeUndefined(); // dry
    expect(f.calls[0].headers["content-type"]).toBe("application/json");
  });

  it("sends the optional JWT as X-API-Key and nothing when unset", async () => {
    const f = fakeOneClick();
    await new OneClickClient({ fetch: f.fetch, jwt: "jwt-from-env", ...noSleep }).getTokens();
    await new OneClickClient({ fetch: f.fetch, jwt: "", ...noSleep }).getTokens();
    expect(f.calls[0].headers["x-api-key"]).toBe("jwt-from-env");
    expect(f.calls[1].headers["x-api-key"]).toBeUndefined();
    expect(f.calls[1].headers.authorization).toBeUndefined();
  });

  it("4xx is not retried and surfaces the API message + correlationId", async () => {
    const f = fakeOneClick();
    const c = new OneClickClient({ fetch: f.fetch, attempts: 3, ...noSleep });
    const err = await c.quote({ ...reqBody(), recipient: "splitter.nearbi-agent.testnet" }).catch((e) => e);
    expect(err).toBeInstanceOf(OneClickHttpError);
    expect(err).toMatchObject({ status: 400, correlationId: expect.any(String) });
    expect(f.calls).toHaveLength(1);
  });

  it("404 on /status is an OneClickHttpError(404)", async () => {
    const f = fakeOneClick();
    const err = await new OneClickClient({ fetch: f.fetch, ...noSleep }).status("0xnope").catch((e) => e);
    expect(err).toMatchObject({ name: "OneClickHttpError", status: 404 });
    expect(f.calls[0].url).toBe("https://1click.chaindefuser.com/v0/status?depositAddress=0xnope");
  });

  it("retries 5xx/429 with backoff (honours Retry-After) and then succeeds", async () => {
    const f = fakeOneClick();
    let n = 0;
    f.on = () => (++n === 1 ? new Response("{}", { status: 503 }) : n === 2 ? new Response("{}", { status: 429, headers: { "retry-after": "1" } }) : undefined);
    const sleeps: number[] = [];
    const c = new OneClickClient({ fetch: f.fetch, attempts: 3, backoffMs: 200, sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 });
    expect((await c.getTokens()).length).toBeGreaterThan(0);
    expect(sleeps).toEqual([150, 1000]); // equal jitter of 200, then Retry-After 1 s
  });

  it("retries network errors and timeouts, then gives up with OneClickUnavailableError", async () => {
    let calls = 0;
    const failing: FetchFn = async () => {
      calls++;
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    };
    const err = await new OneClickClient({ fetch: failing, attempts: 2, ...noSleep }).getTokens().catch((e) => e);
    expect(err).toBeInstanceOf(OneClickUnavailableError);
    expect(err.message).toMatch(/timed out/);
    expect(calls).toBe(2);
  });

  it("aborts a hanging request after timeoutMs", async () => {
    const hanging: FetchFn = (_u, init) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    const err = await new OneClickClient({ fetch: hanging, attempts: 1, timeoutMs: 20 }).getTokens().catch((e) => e);
    expect(err).toBeInstanceOf(OneClickUnavailableError);
  });

  it("rejects bodies that don't match the spec", async () => {
    const f = fakeOneClick();
    f.on = (_m, url) => (url.pathname.endsWith("/quote") ? new Response(JSON.stringify({ quote: {} }), { status: 201 }) : undefined);
    await expect(new OneClickClient({ fetch: f.fetch, ...noSleep }).quote(reqBody())).rejects.toBeInstanceOf(OneClickUnavailableError);
  });

  it("a non-dry quote without a depositAddress is an error", async () => {
    const f = fakeOneClick();
    f.on = (_m, url) => (url.pathname.endsWith("/quote") ? new Response(JSON.stringify(fx.quoteBaseUsdc()), { status: 201 }) : undefined);
    await expect(new OneClickClient({ fetch: f.fetch, ...noSleep }).quote({ ...reqBody(), dry: false })).rejects.toThrow(/depositAddress/);
  });
});
