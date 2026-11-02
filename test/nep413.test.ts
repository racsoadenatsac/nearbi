import { describe, expect, it } from "vitest";
import {
  NEP413_TAG,
  nep413Hash,
  parseEd25519PublicKey,
  serializeNep413,
  verifyNep413Signature,
} from "../src/auth/nep413";
import { base58Decode, base58Encode, base64Encode, hexEncode } from "../src/lib/encoding";
import { generateTestKey } from "./helpers/keys";

const nonce = new Uint8Array(32).map((_, i) => i); // 00 01 02 ... 1f

describe("NEP-413 payload serialization", () => {
  it("uses tag 2^31 + 413", () => {
    expect(NEP413_TAG).toBe(2147484061);
  });

  it("serializes tag, message, nonce, recipient, None callback in borsh layout", () => {
    const bytes = serializeNep413({ message: "hi", nonce, recipient: "nearbi.ai" });
    const expected =
      "9d010080" + // u32 LE 2147484061
      "02000000" + "6869" + // string "hi"
      hexEncode(nonce) + // [u8;32] fixed, no length prefix
      "09000000" + "6e65617262692e6169" + // string "nearbi.ai"
      "00"; // Option::None
    expect(hexEncode(bytes)).toBe(expected);
    expect(bytes.length).toBe(4 + 4 + 2 + 32 + 4 + 9 + 1);
  });

  it("serializes Some(callbackUrl)", () => {
    const bytes = serializeNep413({ message: "", nonce, recipient: "a", callbackUrl: "x" });
    expect(hexEncode(bytes.slice(-6))).toBe("01" + "01000000" + "78");
  });

  it("encodes multi-byte UTF-8 lengths in bytes, not characters", () => {
    const bytes = serializeNep413({ message: "é", nonce, recipient: "r" });
    expect(hexEncode(bytes.slice(4, 10))).toBe("02000000c3a9");
  });

  it("rejects nonces that are not 32 bytes", () => {
    expect(() => serializeNep413({ message: "m", nonce: new Uint8Array(31), recipient: "r" })).toThrow();
  });

  it("hashes the serialized payload with sha256", async () => {
    const p = { message: "hi", nonce, recipient: "nearbi.ai" };
    const h = await nep413Hash(p);
    const direct = new Uint8Array(await crypto.subtle.digest("SHA-256", serializeNep413(p)));
    expect(hexEncode(h)).toBe(hexEncode(direct));
    expect(h.length).toBe(32);
  });
});

describe("base58", () => {
  it("round-trips, including leading zeros", () => {
    for (const b of [new Uint8Array([0, 0, 1, 2, 255]), new Uint8Array(32).fill(7), new Uint8Array([0, 0])]) {
      expect([...base58Decode(base58Encode(b))]).toEqual([...b]);
    }
  });
  it("matches a known vector", () => {
    expect(base58Encode(new TextEncoder().encode("hello world"))).toBe("StV1DL6CwTryKyV");
  });
});

describe("NEP-413 signature verification (local ed25519 keypair)", () => {
  const payload = { message: "Sign in to NearBI", nonce, recipient: "nearbi.ai" };

  it("accepts a valid signature", async () => {
    const key = await generateTestKey();
    const sig = await key.sign(payload);
    expect(parseEd25519PublicKey(key.publicKey).length).toBe(32);
    expect(await verifyNep413Signature(payload, key.publicKey, sig)).toBe(true);
  });

  it("rejects a signature from a different key", async () => {
    const [a, b] = [await generateTestKey(), await generateTestKey()];
    expect(await verifyNep413Signature(payload, b.publicKey, await a.sign(payload))).toBe(false);
  });

  it("rejects when any signed field changes", async () => {
    const key = await generateTestKey();
    const sig = await key.sign(payload);
    const otherNonce = new Uint8Array(nonce);
    otherNonce[0] ^= 1;
    for (const tampered of [
      { ...payload, message: "Sign in to NearBI!" },
      { ...payload, recipient: "evil.ai" },
      { ...payload, nonce: otherNonce },
      { ...payload, callbackUrl: "https://nearbi.ai/cb" },
    ]) {
      expect(await verifyNep413Signature(tampered, key.publicKey, sig)).toBe(false);
    }
  });

  it("rejects a signature over the raw (unhashed / untagged) message", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign"])) as CryptoKeyPair;
    const pk = `ed25519:${base58Encode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)))}`;
    const rawSig = await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(payload.message));
    expect(await verifyNep413Signature(payload, pk, base64Encode(new Uint8Array(rawSig)))).toBe(false);
  });

  it("returns false (not throw) on malformed keys and signatures", async () => {
    const key = await generateTestKey();
    expect(await verifyNep413Signature(payload, "secp256k1:abc", "AAAA")).toBe(false);
    expect(await verifyNep413Signature(payload, key.publicKey, "not-base64!!")).toBe(false);
    expect(await verifyNep413Signature(payload, key.publicKey, base64Encode(new Uint8Array(10)))).toBe(false);
  });
});
