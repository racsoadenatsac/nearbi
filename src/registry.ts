// Pull tokens for the private container registry (registry.nearbi.ai).
// Only the sha256 of a token is stored. A token expires at the end of the paid period.
// Issuing a new token revokes the account's previous ones (one live token per account).

import { base64UrlEncode, hexEncode, randomBytes, sha256, utf8 } from "./lib/encoding";

export const TOKEN_PREFIX = "nbr_";

export async function hashToken(token: string): Promise<string> {
  return hexEncode(await sha256(utf8.encode(token)));
}

export interface IssuedToken {
  token: string;
  expiresAt: number;
  username: string;
  registry: string;
  instructions: string[];
}

export async function issueRegistryToken(
  db: D1Database,
  opts: { accountId: string; expiresAt: number; nowSec: number; registryHost: string },
): Promise<IssuedToken> {
  const token = TOKEN_PREFIX + base64UrlEncode(randomBytes(32));
  const tokenHash = await hashToken(token);
  await db.batch([
    db.prepare("UPDATE registry_tokens SET revoked = 1 WHERE account_id = ? AND revoked = 0").bind(opts.accountId),
    db
      .prepare("INSERT INTO registry_tokens (account_id, token_hash, expires_at, revoked, created_at) VALUES (?, ?, ?, 0, ?)")
      .bind(opts.accountId, tokenHash, opts.expiresAt, opts.nowSec),
  ]);
  const host = opts.registryHost;
  return {
    token,
    expiresAt: opts.expiresAt,
    username: opts.accountId,
    registry: host,
    instructions: [
      `echo '${token}' | docker login ${host} -u ${opts.accountId} --password-stdin`,
      `docker pull ${host}/nearbi/<report-slug>:latest`,
      `docker run --rm -p 8888:8888 ${host}/nearbi/<report-slug>:latest   # then: make verify`,
    ],
  };
}

/** For the registry's auth hook (next step): returns the account a token belongs to, or null. */
export async function validateRegistryToken(db: D1Database, token: string, nowSec: number): Promise<string | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const row = await db
    .prepare("SELECT account_id FROM registry_tokens WHERE token_hash = ? AND revoked = 0 AND expires_at > ?")
    .bind(await hashToken(token), nowSec)
    .first<{ account_id: string }>();
  return row?.account_id ?? null;
}
