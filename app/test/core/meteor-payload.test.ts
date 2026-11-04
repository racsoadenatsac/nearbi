// Meteor Connect (near::sign_in_and_sign_message) output -> /auth/verify payload, checked against the real verifier.
import { describe, expect, it } from "vitest";
import { meteorSignedToPayload } from "../../public/js/meteor-payload.js";
import { base58Decode, base64Decode } from "../../src/core/encoding";
import { newChallenge, verifySignIn, type StoredChallenge, type VerifyDeps } from "../../src/core/signin";
import { generateTestKey } from "../helpers/keys";

const NOW = 1_800_000_000;

// Stand-in for @near-js/crypto PublicKey: the SDK hands back an object whose toString() is "ed25519:<base58>".
class FakePublicKey {
  constructor(private readonly s: string) {}
  toString() {
    return this.s;
  }
}

async function signedByMeteor() {
  const key = await generateTestKey();
  const ch = newChallenge("nearbi.ai", NOW);
  const sigB64 = await key.sign({ message: ch.message, nonce: base64Decode(ch.nonce), recipient: ch.recipient });
  // Shape of IMCAOutput_Near_SignInAndSignMessage (IMeteorConnectAccount + signedMessage: SignedMessage).
  const out = {
    identifier: { blockchain: "near", network: "mainnet", accountId: "alice.near" },
    publicKeys: [],
    connection: {},
    signedMessage: { accountId: "alice.near", publicKey: new FakePublicKey(key.publicKey), signature: base64Decode(sigB64) },
  };
  const store = new Map<string, StoredChallenge>([[ch.nonce, { nonce: ch.nonce, message: ch.message, expiresAt: ch.expiresAt }]]);
  const deps: VerifyDeps = {
    expectedRecipient: "nearbi.ai",
    nowSec: NOW,
    keyCheck: async () => ({ ok: true, permission: "FullAccess" }),
    consumeChallenge: async (n) => {
      const c = store.get(n) ?? null;
      store.delete(n);
      return c;
    },
  };
  return { key, ch, out, sigB64, deps };
}

describe("meteorSignedToPayload", () => {
  it("maps PublicKey + Uint8Array signature to strings the verifier accepts", async () => {
    const { key, ch, out, sigB64, deps } = await signedByMeteor();
    const p = meteorSignedToPayload(out);
    expect(p).toEqual({ accountId: "alice.near", publicKey: key.publicKey, signature: sigB64 });
    expect(base58Decode(p.publicKey.slice(8))).toHaveLength(32);
    const r = await verifySignIn({ ...p, nonce: ch.nonce, message: ch.message, recipient: ch.recipient, callbackUrl: null }, deps);
    expect(r).toEqual({ ok: true, accountId: "alice.near", publicKey: key.publicKey });
  });

  it("passes through already-stringified fields", async () => {
    const { key, out, sigB64 } = await signedByMeteor();
    const p = meteorSignedToPayload({ ...out, signedMessage: { accountId: "alice.near", publicKey: key.publicKey, signature: sigB64 } });
    expect(p.signature).toBe(sigB64);
    expect(p.publicKey).toBe(key.publicKey);
  });

  it("a mapped signature over a different challenge is still rejected", async () => {
    const { out, deps } = await signedByMeteor();
    const other = newChallenge("nearbi.ai", NOW);
    const r = await verifySignIn({ ...meteorSignedToPayload(out), nonce: other.nonce, message: other.message, recipient: "nearbi.ai" }, deps);
    expect(r.ok).toBe(false);
  });

  it("rejects missing or inconsistent output", async () => {
    const { out } = await signedByMeteor();
    expect(() => meteorSignedToPayload({ identifier: out.identifier })).toThrow(/signed message/);
    expect(() => meteorSignedToPayload({ ...out, signedMessage: { ...out.signedMessage, signature: undefined } })).toThrow(/incomplete/);
    expect(() => meteorSignedToPayload({ ...out, identifier: { ...out.identifier, accountId: "mallory.near" } })).toThrow(/mismatched/);
  });
});
