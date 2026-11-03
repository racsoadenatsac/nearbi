import { describe, expect, it } from "vitest";
import {
  DRY_QUOTE_RECIPIENT,
  fromBaseUnits,
  IntentsAdapter,
  isMainnetAccount,
  mapOneClickStatus,
  OneClickClient,
  ONECLICK_STATUSES,
  QuoteInputError,
  quoteDeadline,
  splitterMsg,
  toBaseUnits,
  USDC_ON_NEAR,
} from "../../src/intents";
import { fakeOneClick } from "../helpers/oneclick";

const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";

function make(nowMs = () => 0) {
  const f = fakeOneClick();
  const client = new OneClickClient({ fetch: f.fetch, sleep: async () => {} });
  return { f, a: new IntentsAdapter(client, { settlementAsset: USDC_ON_NEAR, nowMs }) };
}

describe("IntentsAdapter.quote", () => {
  it("asks for EXACT_OUTPUT of the price in the settlement asset and maps the recorded dry quote", async () => {
    const { f, a } = make();
    const q = await a.quote({
      originAsset: BASE_USDC,
      amountUsd: 49,
      refundTo: "alice.near",
      refundType: "INTENTS",
      recipient: DRY_QUOTE_RECIPIENT,
      deadline: new Date("2026-11-02T00:30:00Z"),
      dry: true,
    });
    const sent = f.calls.find((c) => c.url.endsWith("/quote"))!.body as Record<string, unknown>;
    expect(sent).toMatchObject({
      dry: true,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: 100,
      originAsset: BASE_USDC,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: USDC_ON_NEAR,
      amount: "49000000",
      refundTo: "alice.near",
      refundType: "INTENTS",
      recipientType: "DESTINATION_CHAIN",
      deadline: "2026-11-02T00:30:00.000Z",
      referral: "nearbi",
    });
    expect(sent.customRecipientMsg).toBeUndefined();
    expect(q).toMatchObject({ dry: true, depositAddress: null, amountOut: "49000000", origin: { symbol: "USDC", blockchain: "base", decimals: 6 }, deadline: "2026-11-02T00:30:00.000Z" });
    expect(BigInt(q.amountIn)).toBeGreaterThan(BigInt(q.minAmountIn)); // slippage buffer on the input side
    expect(q.quoteId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("passes the splitter msg through customRecipientMsg when asked", async () => {
    const { f, a } = make();
    await a.quote({ originAsset: "nep141:arb.omft.near", amountUsd: 49, refundTo: "a.near", refundType: "INTENTS", recipient: "splitter.nearbi.near", deadline: new Date(1e12), dry: true, customRecipientMsg: splitterMsg("order-1") });
    expect((f.calls.at(-1)!.body as Record<string, unknown>).customRecipientMsg).toBe('{"order_id":"order-1"}');
  });

  it("rejects tokens 1Click doesn't list, without calling /quote", async () => {
    const { f, a } = make();
    await expect(a.quote({ originAsset: "nep141:nope.near", amountUsd: 49, refundTo: "a.near", refundType: "INTENTS", recipient: "x.near", deadline: new Date(1e12), dry: true })).rejects.toBeInstanceOf(QuoteInputError);
    expect(f.calls.some((c) => c.url.endsWith("/quote"))).toBe(false);
  });

  it("prices a non-stable settlement asset through its 1Click USD price", async () => {
    const { a } = make();
    const wnear = (await a.findToken("nep141:wrap.near"))!;
    expect(a.settlementAmount({ ...wnear, price: 2 }, 49)).toBe(toBaseUnits("24.5", 24));
  });
});

describe("token cache", () => {
  it("caches for the TTL, refreshes after, serves stale on error", async () => {
    let t = 0;
    const { f, a } = make(() => t);
    await a.listTokens();
    await a.listTokens();
    expect(f.calls.filter((c) => c.url.endsWith("/tokens"))).toHaveLength(1);
    t = 5 * 60_000 + 1;
    f.on = () => new Response("{}", { status: 503 });
    expect((await a.listTokens()).length).toBeGreaterThan(100); // stale-if-error
    t = 2 * 60 * 60_000;
    await expect(a.listTokens()).rejects.toThrow();
  });

  it("concurrent callers share one request", async () => {
    const { f, a } = make();
    await Promise.all([a.listTokens(), a.listTokens(), a.listTokens()]);
    expect(f.calls).toHaveLength(1);
  });
});

describe("amounts", () => {
  it.each([
    [49, 6, "49000000"],
    ["49.5", 6, "49500000"],
    ["0.0000001", 6, "1"], // rounds up, never under-charges
    ["13.025283101944989938496136", 24, "13025283101944989938496136"],
  ])("toBaseUnits(%s, %i) = %s", (v, d, out) => expect(toBaseUnits(v as string, d)).toBe(out));
  it("fromBaseUnits", () => {
    expect(fromBaseUnits("49504951", 6)).toBe("49.504951");
    expect(fromBaseUnits("49000000", 6)).toBe("49");
    expect(fromBaseUnits("5", 6)).toBe("0.000005");
  });
  it("rejects junk", () => {
    expect(() => toBaseUnits("-1", 6)).toThrow();
    expect(() => toBaseUnits("1e3", 6)).toThrow();
  });
});

describe("settlement rules", () => {
  it.each([
    ["nearbi.near", true],
    ["splitter.nearbi.near", true],
    ["a".repeat(64).replace(/a/g, "f"), true],
    [DRY_QUOTE_RECIPIENT, false],
    ["splitter.nearbi-agent.testnet", false],
    ["0x2527D02599Ba641c19FEa793cD0F167589a0f10D", false],
    ["Nearbi.near", false],
    ["", false],
  ])("isMainnetAccount(%s) = %s", (s, ok) => expect(isMainnetAccount(s)).toBe(ok));
  it("splitter msg matches the rs-payments ft_on_transfer contract", () => {
    expect(JSON.parse(splitterMsg("abc"))).toEqual({ order_id: "abc" });
    expect(() => splitterMsg("x".repeat(129))).toThrow();
  });
  it("slow chains get a longer deadline", () => {
    const now = new Date("2026-11-02T00:00:00Z");
    expect(quoteDeadline(now, "base").toISOString()).toBe("2026-11-02T00:30:00.000Z");
    expect(quoteDeadline(now, "btc").toISOString()).toBe("2026-11-02T01:00:00.000Z");
  });
});

describe("status mapping", () => {
  it("covers every status in the spec", () => {
    for (const s of ONECLICK_STATUSES) expect(mapOneClickStatus(s)).not.toBeNull();
  });
  it.each([
    ["PENDING_DEPOSIT", "pending", false],
    ["KNOWN_DEPOSIT_TX", "processing", false],
    ["PROCESSING", "processing", false],
    ["INCOMPLETE_DEPOSIT", "incomplete", false],
    ["SUCCESS", "paid", true],
    ["REFUNDED", "refunded", true],
    ["FAILED", "failed", true],
  ])("%s -> %s (terminal %s)", (s, ours, terminal) => expect(mapOneClickStatus(s)).toMatchObject({ status: ours, terminal }));
  it("unknown future statuses map to null (leave the payment alone)", () => expect(mapOneClickStatus("SOMETHING_NEW")).toBeNull());
});
