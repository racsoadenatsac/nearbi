import { describe, expect, it, vi } from "vitest";
import { checkAccessKey } from "../../src/adapters/near-rpc";

describe("NEAR RPC view_access_key check (mocked fetch, no network)", () => {
  const rpc = "https://rpc.test";
  const reply = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
  const as = (f: unknown) => ({ fetchImpl: f as typeof fetch });

  it("sends a view_access_key query and accepts FullAccess", async () => {
    const f = reply({ result: { nonce: 1, permission: "FullAccess", block_height: 1 } });
    expect(await checkAccessKey(rpc, "alice.near", "ed25519:abc", as(f))).toEqual({ ok: true, permission: "FullAccess" });
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.params).toEqual({ request_type: "view_access_key", finality: "final", account_id: "alice.near", public_key: "ed25519:abc" });
  });

  it("rejects function-call keys by default", async () => {
    const f = reply({ result: { permission: { FunctionCall: { receiver_id: "x", method_names: [] } } } });
    expect(await checkAccessKey(rpc, "a.near", "k", as(f))).toMatchObject({ ok: false });
  });

  it("rejects unknown keys (top-level error and legacy result.error), HTTP errors and unreachable RPC", async () => {
    expect(await checkAccessKey(rpc, "a.near", "k", as(reply({ error: { cause: { name: "UNKNOWN_ACCESS_KEY" } } })))).toEqual({ ok: false, reason: "UNKNOWN_ACCESS_KEY" });
    expect(await checkAccessKey(rpc, "a.near", "k", as(reply({ result: { error: "does not exist" } })))).toMatchObject({ ok: false });
    expect(await checkAccessKey(rpc, "a.near", "k", as(reply({}, 503)))).toEqual({ ok: false, reason: "rpc http 503" });
    expect(await checkAccessKey(rpc, "a.near", "k", as(vi.fn(async () => { throw new Error("boom"); })))).toMatchObject({ ok: false, reason: expect.stringContaining("unreachable") });
  });
});
