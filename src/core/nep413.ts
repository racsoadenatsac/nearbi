// NEP-413 "signMessage" verification.
// Spec: https://github.com/near/NEPs/blob/master/neps/nep-0413.md
//
// The wallet signs sha256( borsh(u32 tag) || borsh(Payload) ) with an ed25519 key, where
//   tag     = 2**31 + 413 = 2147484061
//   Payload = { message: string, nonce: [u8; 32], recipient: string, callbackUrl: Option<string> }

import { base58Decode, base64Decode, concatBytes, sha256, utf8, type Bytes } from "./encoding";

export const NEP413_TAG = 2 ** 31 + 413;

export interface Nep413Payload {
  message: string;
  nonce: Uint8Array; // exactly 32 bytes
  recipient: string;
  callbackUrl?: string | null;
}

function borshU32(n: number): Bytes {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function borshString(s: string): Bytes {
  const bytes = utf8.encode(s);
  return concatBytes(borshU32(bytes.length), bytes);
}

/** Borsh-serialize tag + payload. This is the exact pre-image that gets sha256-hashed and signed. */
export function serializeNep413(p: Nep413Payload): Bytes {
  if (p.nonce.length !== 32) throw new Error("NEP-413 nonce must be exactly 32 bytes");
  const cb =
    p.callbackUrl === undefined || p.callbackUrl === null
      ? new Uint8Array([0])
      : concatBytes(new Uint8Array([1]), borshString(p.callbackUrl));
  return concatBytes(borshU32(NEP413_TAG), borshString(p.message), p.nonce, borshString(p.recipient), cb);
}

export async function nep413Hash(p: Nep413Payload): Promise<Bytes> {
  return sha256(serializeNep413(p));
}

/** Parse "ed25519:<base58>" into 32 raw key bytes. Only ed25519 is supported (secp256k1 keys are rejected). */
export function parseEd25519PublicKey(pk: string): Bytes {
  const [curve, data] = pk.includes(":") ? pk.split(":", 2) : ["ed25519", pk];
  if (curve !== "ed25519") throw new Error(`unsupported key type: ${curve}`);
  const raw = base58Decode(data);
  if (raw.length !== 32) throw new Error("ed25519 public key must be 32 bytes");
  return raw;
}

/** Signatures arrive base64 from wallet-selector; also accept "ed25519:<base58>" for CLI-style tooling. */
export function parseSignature(sig: string): Bytes {
  const raw = sig.startsWith("ed25519:") ? base58Decode(sig.slice(8)) : base64Decode(sig);
  if (raw.length !== 64) throw new Error("ed25519 signature must be 64 bytes");
  return raw;
}

export async function verifyNep413Signature(
  payload: Nep413Payload,
  publicKey: string,
  signature: string,
): Promise<boolean> {
  let pk: Bytes, sig: Bytes;
  try {
    pk = parseEd25519PublicKey(publicKey);
    sig = parseSignature(signature);
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey("raw", pk, { name: "Ed25519" }, false, ["verify"]);
  const digest = await nep413Hash(payload);
  return crypto.subtle.verify({ name: "Ed25519" }, key, sig, digest);
}
