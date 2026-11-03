// Checks that a public key is an access key of a NEAR account via JSON-RPC `query/view_access_key`.

import type { KeyCheck, KeyCheckFn } from "../core/signin";

export type { KeyCheck };

export interface KeyCheckOptions {
  /** NEP-413 recommends only trusting full-access keys for sign-in. Default true. */
  requireFullAccess?: boolean;
  fetchImpl?: typeof fetch;
}

export async function checkAccessKey(
  rpcUrl: string,
  accountId: string,
  publicKey: string,
  opts: KeyCheckOptions = {},
): Promise<KeyCheck> {
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "nearbi",
        method: "query",
        params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey },
      }),
    });
  } catch (e) {
    return { ok: false, reason: `rpc unreachable: ${(e as Error).message}` };
  }
  if (!res.ok) return { ok: false, reason: `rpc http ${res.status}` };
  const body = (await res.json()) as {
    result?: { permission?: unknown; error?: string };
    error?: { cause?: { name?: string }; message?: string };
  };
  // Older nodes report unknown keys as result.error; newer ones as a top-level error.
  if (body.error) return { ok: false, reason: body.error.cause?.name ?? body.error.message ?? "rpc error" };
  if (!body.result || body.result.error) return { ok: false, reason: body.result?.error ?? "no result" };
  const perm = body.result.permission;
  const permission = perm === "FullAccess" ? "FullAccess" : "FunctionCall";
  if ((opts.requireFullAccess ?? true) && permission !== "FullAccess") {
    return { ok: false, reason: "key is not a full-access key" };
  }
  return { ok: true, permission };
}

/** KeyCheckFn bound to an RPC endpoint (full-access keys only). */
export function rpcKeyCheck(rpcUrl: string, fetchImpl?: typeof fetch): KeyCheckFn {
  return (accountId, publicKey) => checkAccessKey(rpcUrl, accountId, publicKey, { fetchImpl });
}
