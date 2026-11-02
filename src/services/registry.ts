// Registry pull tokens: issue (subscriber, via /registry/token) and validate (for the registry auth hook).
import { dockerInstructions, generateRegistryToken, hashToken, looksLikeRegistryToken, tokenAccount } from "../core/registry-token";
import type { Repository } from "../ports/repository";

export interface IssuedToken {
  token: string;
  expiresAt: number;
  username: string;
  registry: string;
  instructions: string[];
}

export async function issueRegistryToken(
  repo: Repository,
  opts: { accountId: string; expiresAt: number; nowSec: number; registryHost: string },
): Promise<IssuedToken> {
  const token = generateRegistryToken();
  await repo.replaceRegistryToken({
    tokenHash: await hashToken(token),
    accountId: opts.accountId,
    expiresAt: opts.expiresAt,
    revoked: false,
    createdAt: opts.nowSec,
  });
  return {
    token,
    expiresAt: opts.expiresAt,
    username: opts.accountId,
    registry: opts.registryHost,
    instructions: dockerInstructions(opts.registryHost, opts.accountId, token),
  };
}

/** The account a presented token belongs to, or null. Used by the (planned) registry token-auth endpoint. */
export async function validateRegistryToken(repo: Repository, token: string, nowSec: number): Promise<string | null> {
  if (!looksLikeRegistryToken(token)) return null;
  return tokenAccount(await repo.getRegistryToken(await hashToken(token)), nowSec);
}
