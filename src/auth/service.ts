// Sign-in flow: issue a challenge, then verify the NEP-413 signed response.

import { base64Decode, base64Encode, randomBytes } from "../lib/encoding";
import { checkAccessKey, isValidAccountId, type KeyCheck } from "./near-rpc";
import { verifyNep413Signature } from "./nep413";

export const CHALLENGE_TTL_SECONDS = 5 * 60;

export interface Challenge {
  nonce: string; // base64, 32 bytes
  message: string;
  recipient: string;
  expiresAt: number;
}

export async function createChallenge(db: D1Database, recipient: string, nowSec: number): Promise<Challenge> {
  const nonce = base64Encode(randomBytes(32));
  const message = `Sign in to NearBI (${recipient}). This request does not cost anything and does not send a transaction.`;
  const expiresAt = nowSec + CHALLENGE_TTL_SECONDS;
  await db.batch([
    db.prepare("DELETE FROM auth_nonces WHERE expires_at <= ?").bind(nowSec),
    db.prepare("INSERT INTO auth_nonces (nonce, message, expires_at) VALUES (?, ?, ?)").bind(nonce, message, expiresAt),
  ]);
  return { nonce, message, recipient, expiresAt };
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

export type VerifyResult = { ok: true; accountId: string; publicKey: string } | { ok: false; status: number; error: string };

export interface VerifyDeps {
  db: D1Database;
  expectedRecipient: string;
  nowSec: number;
  keyCheck: (accountId: string, publicKey: string) => Promise<KeyCheck>;
}

export function rpcKeyCheck(rpcUrl: string, fetchImpl?: typeof fetch) {
  return (accountId: string, publicKey: string) => checkAccessKey(rpcUrl, accountId, publicKey, { fetchImpl });
}

export async function verifySignIn(input: Partial<VerifyInput>, deps: VerifyDeps): Promise<VerifyResult> {
  const { accountId, publicKey, signature, nonce, message, recipient } = input;
  if (![accountId, publicKey, signature, nonce, message, recipient].every((v) => typeof v === "string" && v.length > 0)) {
    return { ok: false, status: 400, error: "missing fields" };
  }
  if (!isValidAccountId(accountId!)) return { ok: false, status: 400, error: "invalid accountId" };
  if (recipient !== deps.expectedRecipient) return { ok: false, status: 400, error: "wrong recipient" };

  let nonceBytes: Uint8Array;
  try {
    nonceBytes = base64Decode(nonce!);
  } catch {
    return { ok: false, status: 400, error: "nonce must be base64" };
  }
  if (nonceBytes.length !== 32) return { ok: false, status: 400, error: "nonce must be 32 bytes" };

  // Burn the nonce first so a captured signature can never be replayed, even concurrently.
  const row = await deps.db
    .prepare("DELETE FROM auth_nonces WHERE nonce = ? RETURNING message, expires_at")
    .bind(base64Encode(nonceBytes))
    .first<{ message: string; expires_at: number }>();
  if (!row) return { ok: false, status: 401, error: "unknown or used nonce" };
  if (row.expires_at <= deps.nowSec) return { ok: false, status: 401, error: "challenge expired" };
  if (row.message !== message) return { ok: false, status: 401, error: "message does not match challenge" };

  const sigOk = await verifyNep413Signature(
    { message: message!, nonce: nonceBytes, recipient: recipient!, callbackUrl: input.callbackUrl ?? null },
    publicKey!,
    signature!,
  );
  if (!sigOk) return { ok: false, status: 401, error: "bad signature" };

  const key = await deps.keyCheck(accountId!, publicKey!);
  if (!key.ok) return { ok: false, status: 401, error: `key not valid for account: ${key.reason}` };

  return { ok: true, accountId: accountId!, publicKey: publicKey! };
}
