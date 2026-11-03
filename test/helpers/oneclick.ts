// Offline 1Click: a fake fetch that answers from the recorded fixtures (test/fixtures/1click, recorded
// from the live API with bin/smoke-1click.sh --record), plus synthetic non-dry quotes and status
// responses built from those recordings and the OpenAPI schema (dry quotes can't produce them).
import { readFileSync } from "node:fs";
import type { FetchFn, OneClickQuoteRequest, OneClickQuoteResponse, OneClickStatusResponse, OneClickToken } from "../../src/intents";

const load = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../fixtures/1click/${name}`, import.meta.url), "utf8")) as T;

export const fx = {
  tokens: () => load<OneClickToken[]>("tokens.json"),
  quoteBaseUsdc: () => load<OneClickQuoteResponse>("quote-dry-base-usdc.json"),
  quoteArbEth: () => load<OneClickQuoteResponse>("quote-dry-arb-eth.json"),
  quoteWrapNear: () => load<OneClickQuoteResponse>("quote-dry-wrap-near.json"),
  errTestnetRecipient: () => load<{ status: number; body: unknown }>("error-400-testnet-recipient.json"),
  errRefundTo: () => load<{ status: number; body: unknown }>("error-400-refund-to.json"),
  status404: () => load<{ status: number; body: unknown }>("status-404.json"),
};

const RECORDED_BY_ORIGIN: Record<string, () => OneClickQuoteResponse> = {
  "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near": fx.quoteBaseUsdc,
  "nep141:arb.omft.near": fx.quoteArbEth,
  "nep141:wrap.near": fx.quoteWrapNear,
};

export const SYNTH_DEPOSIT = "0x5Yn7hEt1cDep0s1tAddre55000000000000000001";

/** A recorded dry quote replayed for `req`; with dry=false it gains the fields a live quote has (synthetic). */
export function replayQuote(req: OneClickQuoteRequest, depositAddress = SYNTH_DEPOSIT): OneClickQuoteResponse {
  const pick = RECORDED_BY_ORIGIN[req.originAsset] ?? fx.quoteBaseUsdc;
  const r = pick();
  r.quoteRequest = { ...r.quoteRequest, ...req };
  if (req.swapType === "EXACT_OUTPUT" && /^\d+$/.test(req.amount) && req.amount !== r.quote.amountOut) {
    // The recordings are $49 quotes; other prices (Quick Answer $29, Deep Dive $499) scale linearly.
    const scale = (v: string) => ((BigInt(v) * BigInt(req.amount)) / BigInt(r.quote.amountOut)).toString();
    r.quote.amountIn = scale(r.quote.amountIn);
    r.quote.minAmountIn = scale(r.quote.minAmountIn);
    r.quote.amountOut = req.amount;
    r.quote.amountOutFormatted = String(Number(req.amount) / 1e6);
  }
  if (!req.dry) {
    r.quote.depositAddress = depositAddress;
    r.quote.deadline = req.deadline;
    r.quote.timeWhenInactive = req.deadline;
  }
  return r;
}

/** Synthetic GET /status body (shape from the OpenAPI GetExecutionStatusResponse). */
export function statusBody(status: string, quote: OneClickQuoteResponse, over: Partial<OneClickStatusResponse["swapDetails"]> = {}): OneClickStatusResponse {
  const done = status === "SUCCESS";
  return {
    correlationId: "status-" + quote.correlationId,
    quoteResponse: quote,
    status,
    updatedAt: "2026-11-02T00:05:00.000Z",
    swapDetails: {
      intentHashes: done ? ["intentHashSynthetic1"] : [],
      nearTxHashes: done ? ["NearTxSynthetic111111111111111111111111111"] : [],
      originChainTxHashes: status === "PENDING_DEPOSIT" ? [] : [{ hash: "0xorigintx", explorerUrl: "https://basescan.org/tx/0xorigintx" }],
      destinationChainTxHashes: done ? [{ hash: "DestTxSynthetic1111111111111111111111111111", explorerUrl: "https://nearblocks.io/txns/DestTxSynthetic1111111111111111111111111111" }] : [],
      ...(done ? { amountOut: quote.quote.amountOut, amountOutFormatted: quote.quote.amountOutFormatted } : {}),
      ...over,
    },
  };
}

export interface FakeOneClick {
  fetch: FetchFn;
  calls: { method: string; url: string; headers: Record<string, string>; body: unknown }[];
  /** Override handler: return a Response to short-circuit, or undefined to use the default fixtures. */
  on?: (method: string, url: URL, body: unknown) => Response | Promise<Response> | undefined;
  /** depositAddress -> 1Click status body (or an HTTP status code) for GET /status. */
  statuses: Map<string, OneClickStatusResponse | number>;
  /** Every non-dry quote handed out, keyed by deposit address. */
  issued: Map<string, OneClickQuoteResponse>;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function fakeOneClick(): FakeOneClick {
  let n = 0;
  const f: FakeOneClick = {
    calls: [],
    statuses: new Map(),
    issued: new Map(),
    fetch: async (input, init) => {
      const url = new URL(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      f.calls.push({ method, url: url.toString(), headers: { ...(init?.headers as Record<string, string>) }, body });
      const o = await f.on?.(method, url, body);
      if (o) return o;
      if (method === "GET" && url.pathname.endsWith("/tokens")) return json(200, fx.tokens());
      if (method === "POST" && url.pathname.endsWith("/quote")) {
        const req = body as OneClickQuoteRequest;
        if (req.recipient.endsWith(".testnet")) return json(fx.errTestnetRecipient().status, fx.errTestnetRecipient().body);
        const q = replayQuote(req, `0xSynthDeposit${String(++n).padStart(28, "0")}`);
        if (!req.dry) f.issued.set(q.quote.depositAddress!, q);
        return json(201, q);
      }
      if (method === "GET" && url.pathname.endsWith("/status")) {
        const addr = url.searchParams.get("depositAddress")!;
        const s = f.statuses.get(addr);
        if (s === undefined) return json(404, fx.status404().body);
        return typeof s === "number" ? json(s, { message: `HTTP ${s}` }) : json(200, s);
      }
      return json(404, { message: "no fixture" });
    },
  };
  return f;
}
