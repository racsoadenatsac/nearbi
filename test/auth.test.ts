import { describe, expect, it, vi } from "vitest";
import { createChallenge, verifySignIn, type VerifyDeps } from "../src/auth/service";
import { checkAccessKey } from "../src/auth/near-rpc";
import { signSession, verifySession } from "../src/auth/session";
import { base64Decode } from "../src/lib/encoding";
import { createTestD1 } from "./helpers/d1";
import { generateTestKey } from "./helpers/keys";

const NOW = 1_800_000_000;

async function setup(keyOk = true) {
  const db = createTestD1();
  const key = await generateTestKey();
  const keyCheck = vi.fn(async () => (keyOk ? ({ ok: true, permission: "FullAccess" } as const) : ({ ok: false, reason: "UNKNOWN_ACCESS_KEY" } as const)));
  const deps: VerifyDeps = { db, expectedRecipient: "nearbi.ai", nowSec: NOW, keyCheck };
  const ch = await createChallenge(db, "nearbi.ai", NOW);
  const signature = await key.sign({ message: ch.message, nonce: base64Decode(ch.nonce), recipient: ch.recipient });
  const input = { accountId: "alice.near", publicKey: key.publicKey, signature, nonce: ch.nonce, message: ch.message, recipient: "nearbi.ai" };
  return { db, key, deps, ch, input, keyCheck };
}

describe("sign-in verification", () => {
  it("accepts a correctly signed challenge and checks the key on-chain", async () => {
    const { deps, input, keyCheck } = await setup();
    const r = await verifySignIn(input, deps);
    expect(r).toEqual({ ok: true, accountId: "alice.near", publicKey: input.publicKey });
    expect(keyCheck).toHaveBeenCalledWith("alice.near", input.publicKey);
  });

  it("burns the nonce: the same signature cannot be replayed", async () => {
    const { deps, input } = await setup();
    expect((await verifySignIn(input, deps)).ok).toBe(true);
    const again = await verifySignIn(input, deps);
    expect(again).toMatchObject({ ok: false, status: 401, error: "unknown or used nonce" });
  });

  it("rejects an expired challenge", async () => {
    const { deps, input } = await setup();
    const r = await verifySignIn(input, { ...deps, nowSec: NOW + 301 });
    expect(r).toMatchObject({ ok: false, error: "challenge expired" });
  });

  it("rejects a nonce the server never issued", async () => {
    const { deps, input, key } = await setup();
    const nonce = new Uint8Array(32).fill(9);
    const signature = await key.sign({ message: input.message, nonce, recipient: "nearbi.ai" });
    const r = await verifySignIn({ ...input, nonce: btoa(String.fromCharCode(...nonce)), signature }, deps);
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it("rejects a different message than the one issued", async () => {
    const { deps, input, key, ch } = await setup();
    const message = "Transfer everything";
    const signature = await key.sign({ message, nonce: base64Decode(ch.nonce), recipient: "nearbi.ai" });
    expect(await verifySignIn({ ...input, message, signature }, deps)).toMatchObject({ ok: false, error: "message does not match challenge" });
  });

  it("rejects the wrong recipient", async () => {
    const { deps, input } = await setup();
    expect(await verifySignIn({ ...input, recipient: "evil.ai" }, deps)).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects a bad signature without calling RPC", async () => {
    const { deps, input, keyCheck } = await setup();
    const other = await generateTestKey();
    const r = await verifySignIn({ ...input, publicKey: other.publicKey }, deps);
    expect(r).toMatchObject({ ok: false, error: "bad signature" });
    expect(keyCheck).not.toHaveBeenCalled();
  });

  it("rejects a valid signature from a key that does not belong to the account", async () => {
    const { deps, input } = await setup(false);
    const r = await verifySignIn(input, { ...deps, keyCheck: async () => ({ ok: false, reason: "UNKNOWN_ACCESS_KEY" }) });
    expect(r).toMatchObject({ ok: false, status: 401 });
    expect((r as { error: string }).error).toContain("UNKNOWN_ACCESS_KEY");
  });

  it("validates input shape", async () => {
    const { deps, input } = await setup();
    expect(await verifySignIn({ ...input, signature: undefined }, deps)).toMatchObject({ status: 400 });
    expect(await verifySignIn({ ...input, accountId: "Not Valid!" }, deps)).toMatchObject({ status: 400 });
    expect(await verifySignIn({ ...input, nonce: btoa("short") }, deps)).toMatchObject({ status: 400 });
  });
});

describe("NEAR RPC view_access_key check (mocked fetch, no network)", () => {
  const rpc = "https://rpc.test";
  const reply = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

  it("sends a view_access_key query and accepts FullAccess", async () => {
    const f = reply({ result: { nonce: 1, permission: "FullAccess", block_height: 1 } });
    const r = await checkAccessKey(rpc, "alice.near", "ed25519:abc", { fetchImpl: f as unknown as typeof fetch });
    expect(r).toEqual({ ok: true, permission: "FullAccess" });
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.params).toEqual({ request_type: "view_access_key", finality: "final", account_id: "alice.near", public_key: "ed25519:abc" });
  });

  it("rejects function-call keys by default", async () => {
    const f = reply({ result: { permission: { FunctionCall: { receiver_id: "x", method_names: [] } } } });
    expect(await checkAccessKey(rpc, "a.near", "k", { fetchImpl: f as unknown as typeof fetch })).toMatchObject({ ok: false });
  });

  it("rejects unknown keys (top-level error and legacy result.error)", async () => {
    const f1 = reply({ error: { cause: { name: "UNKNOWN_ACCESS_KEY" } } });
    const f2 = reply({ result: { error: "access key ed25519:x does not exist while viewing" } });
    expect(await checkAccessKey(rpc, "a.near", "k", { fetchImpl: f1 as unknown as typeof fetch })).toEqual({ ok: false, reason: "UNKNOWN_ACCESS_KEY" });
    expect(await checkAccessKey(rpc, "a.near", "k", { fetchImpl: f2 as unknown as typeof fetch })).toMatchObject({ ok: false });
  });
});

describe("session cookie", () => {
  const secret = "test-secret-at-least-16-bytes-long";
  const s = { sub: "alice.near", pk: "ed25519:x", iat: NOW, exp: NOW + 60 };

  it("round-trips", async () => {
    expect(await verifySession(secret, await signSession(secret, s), NOW)).toEqual(s);
  });
  it("rejects tampering, wrong secret and expiry", async () => {
    const t = await signSession(secret, s);
    const forged = btoa(JSON.stringify({ ...s, sub: "bob.near" })).replace(/=+$/, "") + "." + t.split(".")[1];
    expect(await verifySession(secret, forged, NOW)).toBeNull();
    expect(await verifySession(secret + "x", t, NOW)).toBeNull();
    expect(await verifySession(secret, t, NOW + 60)).toBeNull();
    expect(await verifySession(secret, "garbage", NOW)).toBeNull();
  });
});
