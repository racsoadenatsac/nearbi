// Low-level 1Click HTTP client: one method per endpoint, typed + validated responses, per-attempt
// timeouts, retries with exponential backoff (network errors, timeouts, 429, 5xx; never other 4xx).
// The optional partner JWT only changes the fee schedule (unauthenticated quotes pay +25 bps); it is
// sent as `X-API-Key`, the header the docs recommend. It comes from the caller (env ONECLICK_JWT),
// never from code.

import type {
  OneClickErrorBody,
  OneClickQuoteRequest,
  OneClickQuoteResponse,
  OneClickStatusResponse,
  OneClickToken,
} from "./types";

export const ONECLICK_BASE_URL = "https://1click.chaindefuser.com/v0";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface OneClickClientOptions {
  baseUrl?: string;
  jwt?: string | null;
  fetch?: FetchFn;
  /** Per-attempt timeout. The Lambda (and API Gateway) give a request 10 s in total. */
  timeoutMs?: number;
  /** Total attempts including the first. */
  attempts?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** The API answered with a non-retryable status (or retries ran out on a retryable one). */
export class OneClickHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly correlationId: string | null,
    readonly path: string,
  ) {
    super(`1Click ${path} -> HTTP ${status}: ${message}`);
    this.name = "OneClickHttpError";
  }
}

/** No usable answer: network failure, timeout, or a body that doesn't match the spec. */
export class OneClickUnavailableError extends Error {
  constructor(message: string, readonly path: string, options?: { cause?: unknown }) {
    super(`1Click ${path}: ${message}`, options);
    this.name = "OneClickUnavailableError";
  }
}

export class OneClickClient {
  private readonly baseUrl: string;
  private readonly jwt: string | null;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(o: OneClickClientOptions = {}) {
    this.baseUrl = (o.baseUrl ?? ONECLICK_BASE_URL).replace(/\/+$/, "");
    this.jwt = o.jwt || null;
    this.fetchFn = o.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = o.timeoutMs ?? 4000;
    this.attempts = Math.max(1, o.attempts ?? 2);
    this.backoffMs = o.backoffMs ?? 300;
    this.maxBackoffMs = o.maxBackoffMs ?? 2000;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = o.random ?? Math.random;
  }

  get authenticated(): boolean {
    return this.jwt !== null;
  }

  async getTokens(): Promise<OneClickToken[]> {
    const body = await this.request("GET", "/tokens");
    if (!Array.isArray(body)) throw new OneClickUnavailableError("tokens response is not an array", "/tokens");
    return body.filter(isToken);
  }

  /** POST /quote. Quotes are not idempotent but are side-effect free until funds are sent, so retrying is safe. */
  async quote(req: OneClickQuoteRequest): Promise<OneClickQuoteResponse> {
    const body = await this.request("POST", "/quote", req);
    if (!isQuoteResponse(body)) throw new OneClickUnavailableError("quote response does not match the spec", "/quote");
    if (!req.dry && !body.quote.depositAddress) throw new OneClickUnavailableError("non-dry quote without depositAddress", "/quote");
    return body;
  }

  async status(depositAddress: string, depositMemo?: string): Promise<OneClickStatusResponse> {
    const q = new URLSearchParams({ depositAddress });
    if (depositMemo) q.set("depositMemo", depositMemo);
    const body = await this.request("GET", `/status?${q}`);
    if (!isStatusResponse(body)) throw new OneClickUnavailableError("status response does not match the spec", "/status");
    return body;
  }

  /** Optional speed-up after the user has sent funds. Not used by the server flow yet. */
  async submitDeposit(input: { depositAddress: string; txHash: string; nearSenderAccount?: string; memo?: string }): Promise<unknown> {
    return this.request("POST", "/deposit/submit", input);
  }

  private async request(method: "GET" | "POST", pathAndQuery: string, json?: unknown): Promise<unknown> {
    const path = pathAndQuery.split("?")[0];
    const headers: Record<string, string> = { accept: "application/json" };
    if (json !== undefined) headers["content-type"] = "application/json";
    if (this.jwt) headers["x-api-key"] = this.jwt;

    let lastErr: Error = new OneClickUnavailableError("no attempt made", path);
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(this.baseUrl + pathAndQuery, {
          method,
          headers,
          body: json === undefined ? undefined : JSON.stringify(json),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        lastErr = new OneClickUnavailableError(timedOut ? `timed out after ${this.timeoutMs} ms` : `network error: ${errMsg(e)}`, path, { cause: e });
        if (attempt < this.attempts) await this.sleep(this.delay(attempt, null));
        continue;
      }

      const text = await res.text().catch(() => "");
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (res.ok) {
        if (body === null) throw new OneClickUnavailableError(`HTTP ${res.status} with a non-JSON body`, path);
        return body;
      }
      const eb = (body ?? {}) as OneClickErrorBody;
      const err = new OneClickHttpError(res.status, eb.message || res.statusText || "error", eb.correlationId ?? null, path);
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable) throw err;
      lastErr = err;
      if (attempt < this.attempts) await this.sleep(this.delay(attempt, res.headers.get("retry-after")));
    }
    throw lastErr;
  }

  private delay(attempt: number, retryAfter: string | null): number {
    const ra = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : null;
    if (ra !== null) return Math.min(ra, this.maxBackoffMs);
    const exp = Math.min(this.backoffMs * 2 ** (attempt - 1), this.maxBackoffMs);
    return Math.round(exp / 2 + (this.random() * exp) / 2); // "equal jitter"
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";

export function isToken(v: unknown): v is OneClickToken {
  return isObj(v) && isStr(v.assetId) && typeof v.decimals === "number" && isStr(v.blockchain) && isStr(v.symbol) && typeof v.price === "number";
}

export function isQuoteResponse(v: unknown): v is OneClickQuoteResponse {
  if (!isObj(v) || !isStr(v.correlationId) || !isStr(v.timestamp) || !isStr(v.signature) || !isObj(v.quoteRequest) || !isObj(v.quote)) return false;
  const q = v.quote;
  return ["amountIn", "amountInFormatted", "minAmountIn", "amountOut", "amountOutFormatted", "minAmountOut"].every((k) => isStr(q[k]));
}

export function isStatusResponse(v: unknown): v is OneClickStatusResponse {
  return isObj(v) && isStr(v.status) && isStr(v.updatedAt) && isObj(v.swapDetails) && isObj(v.quoteResponse);
}
