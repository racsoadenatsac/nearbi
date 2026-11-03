// NEP-413 sign-in flow in the core: one-time challenges (injected store) and on-chain key check (injected).
import { describe, expect, it, vi } from "vitest";
import { isValidAccountId } from "../../src/core/account";
import { base64Decode } from "../../src/core/encoding";
import { CHALLENGE_TTL_SECONDS, newChallenge, verifySignIn, type StoredChallenge, type VerifyDeps } from "../../src/core/signin";
import { generateTestKey } from "../helpers/keys";

const NOW = 1_800_000_000;

async function setup(keyOk = true) {
  const store = new Map<string, StoredChallenge>();
  const key = await generateTestKey();
  const keyCheck = vi.fn(async () => (keyOk ? ({ ok: true, permission: "FullAccess" } as const) : ({ ok: false, reason: "UNKNOWN_ACCESS_KEY" } as const)));
  const deps: VerifyDeps = {
    expectedRecipient: "nearbi.ai",
    nowSec: NOW,
    keyCheck,
    consumeChallenge: async (n) => {
      const c = store.get(n) ?? null;
      store.delete(n);
      return c;
    },
  };
  const ch = newChallenge("nearbi.ai", NOW);
  store.set(ch.nonce, { nonce: ch.nonce, message: ch.message, expiresAt: ch.expiresAt });
  const signature = await key.sign({ message: ch.message, nonce: base64Decode(ch.nonce), recipient: ch.recipient });
  const input = { accountId: "alice.near", publicKey: key.publicKey, signature, nonce: ch.nonce, message: ch.message, recipient: "nearbi.ai" };
  return { store, key, deps, ch, input, keyCheck };
}

describe("newChallenge", () => {
  it("issues a 32-byte random nonce with a 5 minute expiry", () => {
    const a = newChallenge("nearbi.ai", NOW);
    expect(base64Decode(a.nonce)).toHaveLength(32);
    expect(a.expiresAt).toBe(NOW + CHALLENGE_TTL_SECONDS);
    expect(a.message).toContain("nearbi.ai");
    expect(newChallenge("nearbi.ai", NOW).nonce).not.toBe(a.nonce);
  });
});

describe("verifySignIn", () => {
  it("accepts a correctly signed challenge and checks the key on-chain", async () => {
    const { deps, input, keyCheck } = await setup();
    expect(await verifySignIn(input, deps)).toEqual({ ok: true, accountId: "alice.near", publicKey: input.publicKey });
    expect(keyCheck).toHaveBeenCalledWith("alice.near", input.publicKey);
  });

  it("burns the nonce: the same signature cannot be replayed", async () => {
    const { deps, input } = await setup();
    expect((await verifySignIn(input, deps)).ok).toBe(true);
    expect(await verifySignIn(input, deps)).toMatchObject({ ok: false, status: 401, error: "unknown or used nonce" });
  });

  it("rejects an expired challenge", async () => {
    const { deps, input } = await setup();
    expect(await verifySignIn(input, { ...deps, nowSec: NOW + 301 })).toMatchObject({ ok: false, error: "challenge expired" });
  });

  it("rejects a nonce the server never issued", async () => {
    const { deps, input, key } = await setup();
    const nonce = new Uint8Array(32).fill(9);
    const signature = await key.sign({ message: input.message, nonce, recipient: "nearbi.ai" });
    expect(await verifySignIn({ ...input, nonce: btoa(String.fromCharCode(...nonce)), signature }, deps)).toMatchObject({ ok: false, status: 401 });
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
    expect(await verifySignIn({ ...input, publicKey: other.publicKey }, deps)).toMatchObject({ ok: false, error: "bad signature" });
    expect(keyCheck).not.toHaveBeenCalled();
  });

  it("rejects a valid signature from a key that does not belong to the account", async () => {
    const { deps, input } = await setup(false);
    const r = await verifySignIn(input, deps);
    expect(r).toMatchObject({ ok: false, status: 401 });
    expect((r as { error: string }).error).toContain("UNKNOWN_ACCESS_KEY");
  });

  it("accepts signatures with and without callbackUrl in the signed payload", async () => {
    const a = await setup();
    const withCb = await a.key.sign({ message: a.ch.message, nonce: base64Decode(a.ch.nonce), recipient: "nearbi.ai", callbackUrl: "https://nearbi.ai/login" });
    expect((await verifySignIn({ ...a.input, signature: withCb, callbackUrl: "https://nearbi.ai/login" }, a.deps)).ok).toBe(true);
    const b = await setup(); // wallet passed callbackUrl but signed without it
    expect((await verifySignIn({ ...b.input, callbackUrl: "https://nearbi.ai/login" }, b.deps)).ok).toBe(true);
  });

  it("validates input shape", async () => {
    const { deps, input } = await setup();
    expect(await verifySignIn({ ...input, signature: undefined }, deps)).toMatchObject({ status: 400 });
    expect(await verifySignIn({ ...input, accountId: "Not Valid!" }, deps)).toMatchObject({ status: 400 });
    expect(await verifySignIn({ ...input, nonce: btoa("short") }, deps)).toMatchObject({ status: 400 });
  });
});

describe("isValidAccountId", () => {
  it.each(["alice.near", "a1", "sub.alice.near", "relay_1-x.tg", "0".repeat(64)])("accepts %s", (id) => expect(isValidAccountId(id)).toBe(true));
  it.each(["A.near", "a", "alice..near", ".near", "x".repeat(65), "al ice.near", 42])("rejects %s", (id) => expect(isValidAccountId(id)).toBe(false));
});
