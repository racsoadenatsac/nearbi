// Sign in with NEAR: challenge creation and verification of the NEP-413 signed response.
// Framework-agnostic: storage (one-time nonces) and the on-chain key check are injected.

import { isValidAccountId } from "./account";
import { base64Decode, base64Encode, randomBytes } from "./encoding";
import { verifyNep413Signature } from "./nep413";

export const CHALLENGE_TTL_SECONDS = 5 * 60;

export interface Challenge {
  nonce: string; // base64, 32 bytes
  message: string;
  recipient: string;
  expiresAt: number; // unix seconds
}

export interface StoredChallenge {
  nonce: string;
  message: string;
  expiresAt: number;
}

export type KeyCheck = { ok: true; permission: "FullAccess" | "FunctionCall" } | { ok: false; reason: string };
export type KeyCheckFn = (accountId: string, publicKey: string) => Promise<KeyCheck>;

export function newChallenge(recipient: string, nowSec: number): Challenge {
  return {
    nonce: base64Encode(randomBytes(32)),
    message: `Sign in to NearBI (${recipient}). This request does not cost anything and does not send a transaction.`,
    recipient,
    expiresAt: nowSec + CHALLENGE_TTL_SECONDS,
  };
}

export interface VerifyInput {
  accountId: string;
  publicKey: string;
  signature: string;
  nonce: string;
  message: string;
  recipient: string;
  callbackUrl?: string | null;
}

export type VerifyResult = { ok: true; accountId: string; publicKey: string } | { ok: false; status: 400 | 401; error: string };

export interface VerifyDeps {
  expectedRecipient: string;
  nowSec: number;
  /** Atomically delete the nonce and return what was stored for it (null if unknown or already used). */
  consumeChallenge: (nonce: string) => Promise<StoredChallenge | null>;
  keyCheck: KeyCheckFn;
}

export async function verifySignIn(input: Partial<VerifyInput>, deps: VerifyDeps): Promise<VerifyResult> {
  const { accountId, publicKey, signature, nonce, message, recipient } = input;
  if (![accountId, publicKey, signature, nonce, message, recipient].every((v) => typeof v === "string" && v.length > 0)) {
    return { ok: false, status: 400, error: "missing fields" };
  }
  if (!isValidAccountId(accountId)) return { ok: false, status: 400, error: "invalid accountId" };
  if (recipient !== deps.expectedRecipient) return { ok: false, status: 400, error: "wrong recipient" };

  let nonceBytes: Uint8Array;
  try {
    nonceBytes = base64Decode(nonce!);
  } catch {
    return { ok: false, status: 400, error: "nonce must be base64" };
  }
  if (nonceBytes.length !== 32) return { ok: false, status: 400, error: "nonce must be 32 bytes" };

  // Burn the nonce first so a captured signature can never be replayed, even concurrently.
  const stored = await deps.consumeChallenge(base64Encode(nonceBytes));
  if (!stored) return { ok: false, status: 401, error: "unknown or used nonce" };
  if (stored.expiresAt <= deps.nowSec) return { ok: false, status: 401, error: "challenge expired" };
  if (stored.message !== message) return { ok: false, status: 401, error: "message does not match challenge" };

  // Redirect wallets pass a callbackUrl; NEP-413 puts it in the signed payload, but not every wallet
  // implementation does. The callback URL carries no authority (nonce, message and recipient do), so
  // accept either form.
  const base = { message: message!, nonce: nonceBytes, recipient: recipient! };
  const cb = typeof input.callbackUrl === "string" && input.callbackUrl ? input.callbackUrl : null;
  const sigOk =
    (await verifyNep413Signature({ ...base, callbackUrl: cb }, publicKey!, signature!)) ||
    (cb !== null && (await verifyNep413Signature({ ...base, callbackUrl: null }, publicKey!, signature!)));
  if (!sigOk) return { ok: false, status: 401, error: "bad signature" };

  const key = await deps.keyCheck(accountId, publicKey!);
  if (!key.ok) return { ok: false, status: 401, error: `key not valid for account: ${key.reason}` };

  return { ok: true, accountId, publicKey: publicKey! };
}
