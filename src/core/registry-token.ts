// Pull tokens for the private container registry (registry.nearbi.ai). Pure: generation, hashing, validity.
// Only the sha256 of a token is ever stored. A token expires at the end of the paid period, and issuing a
// new one revokes the account's previous token (enforced by the repository).

import { base64UrlEncode, hexEncode, randomBytes, sha256, utf8 } from "./encoding";

export const TOKEN_PREFIX = "nbr_";
const TOKEN_RE = /^nbr_[A-Za-z0-9_-]{43}$/;

export interface RegistryTokenRecord {
  tokenHash: string; // hex sha256
  accountId: string;
  expiresAt: number; // unix seconds
  revoked: boolean;
  createdAt: number;
}

export function generateRegistryToken(): string {
  return TOKEN_PREFIX + base64UrlEncode(randomBytes(32));
}

export const looksLikeRegistryToken = (t: string) => TOKEN_RE.test(t);

export async function hashToken(token: string): Promise<string> {
  return hexEncode(await sha256(utf8.encode(token)));
}

/** The account a stored token grants access for, or null if revoked/expired/missing. */
export function tokenAccount(rec: RegistryTokenRecord | null | undefined, nowSec: number): string | null {
  if (!rec || rec.revoked || rec.expiresAt <= nowSec) return null;
  return rec.accountId;
}

export function dockerInstructions(host: string, accountId: string, token: string): string[] {
  return [
    `echo '${token}' | docker login ${host} -u ${accountId} --password-stdin`,
    `docker pull ${host}/nearbi/<report-slug>:latest`,
    `docker run --rm -p 8888:8888 ${host}/nearbi/<report-slug>:latest   # then: make verify`,
  ];
}
