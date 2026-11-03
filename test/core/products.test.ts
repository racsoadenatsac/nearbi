import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { BRIEF_LIMITS, isOneOff, isProductId, isValidDeliveryUrl, validateBrief } from "../../src/core/products";

const BASE = { SESSION_SECRET: "x".repeat(32), ADMIN_TOKEN: "a" };

describe("product catalog (server-side prices)", () => {
  it("defaults: subscription $49, Quick Answer $29, Deep Dive $499", () => {
    const { products } = loadConfig(BASE);
    expect(products.subscription).toMatchObject({ priceUsd: 49, kind: "subscription" });
    expect(products.quick_answer).toMatchObject({ priceUsd: 29, kind: "one_off", delivery: "within 24 hours" });
    expect(products.deep_dive).toMatchObject({ priceUsd: 499, kind: "one_off", delivery: "within 48 hours" });
  });

  it("prices come from MONTHLY_PRICE_USD / QUICK_ANSWER_PRICE_USD / DEEP_DIVE_PRICE_USD", () => {
    const c = loadConfig({ ...BASE, MONTHLY_PRICE_USD: "59", QUICK_ANSWER_PRICE_USD: "35", DEEP_DIVE_PRICE_USD: "650" });
    expect([c.products.subscription.priceUsd, c.products.quick_answer.priceUsd, c.products.deep_dive.priceUsd]).toEqual([59, 35, 650]);
    expect(c.monthlyPriceUsd).toBe(59);
  });

  it("invalid / non-positive prices fall back to the defaults", () => {
    const c = loadConfig({ ...BASE, QUICK_ANSWER_PRICE_USD: "-5", DEEP_DIVE_PRICE_USD: "abc" });
    expect(c.products.quick_answer.priceUsd).toBe(29);
    expect(c.products.deep_dive.priceUsd).toBe(499);
  });

  it("product ids", () => {
    expect(["subscription", "quick_answer", "deep_dive"].every(isProductId)).toBe(true);
    for (const bad of ["ecosystem", "", "QUICK_ANSWER", 1, null, "__proto__", "constructor"]) expect(isProductId(bad)).toBe(false);
    expect(isOneOff("quick_answer") && isOneOff("deep_dive")).toBe(true);
    expect(isOneOff("subscription") || isOneOff(null)).toBe(false);
  });
});

describe("validateBrief", () => {
  it("requires a question; trims and strips control characters", () => {
    expect(validateBrief("quick_answer", undefined)).toEqual({ ok: false, error: expect.stringMatching(/brief required/) });
    expect(validateBrief("quick_answer", {})).toEqual({ ok: false, error: "question required" });
    expect(validateBrief("quick_answer", { question: "   \n " })).toEqual({ ok: false, error: "question required" });
    expect(validateBrief("quick_answer", { question: "  How many\u0000 users?\r\nReally? " })).toEqual({
      ok: true,
      brief: { question: "How many users?\nReally?", contact: null, scope: null },
    });
  });

  it("question max 2,000 characters", () => {
    expect(validateBrief("quick_answer", { question: "q".repeat(BRIEF_LIMITS.question) }).ok).toBe(true);
    expect(validateBrief("quick_answer", { question: "q".repeat(BRIEF_LIMITS.question + 1) })).toMatchObject({ ok: false, error: expect.stringMatching(/too long/) });
  });

  it("contact: optional email or Telegram handle, max 200", () => {
    for (const ok of ["me@example.com", "@nearbi_fan", "nearbi_fan", "https://t.me/nearbi_fan", ""]) {
      expect(validateBrief("quick_answer", { question: "q", contact: ok }).ok, ok).toBe(true);
    }
    expect(validateBrief("quick_answer", { question: "q", contact: "" })).toMatchObject({ brief: { contact: null } });
    for (const bad of ["not a contact", "<script>@x.com", "@ab", "javascript:alert(1)"]) {
      expect(validateBrief("quick_answer", { question: "q", contact: bad }), bad).toMatchObject({ ok: false });
    }
    expect(validateBrief("quick_answer", { question: "q", contact: `${"a".repeat(195)}@x.com` })).toMatchObject({ ok: false, error: expect.stringMatching(/too long/) });
  });

  it("scope only for deep_dive; type errors are rejected", () => {
    expect(validateBrief("deep_dive", { question: "q", scope: " DeFi on NEAR, last 90 days " })).toMatchObject({ ok: true, brief: { scope: "DeFi on NEAR, last 90 days" } });
    expect(validateBrief("quick_answer", { question: "q", scope: "ignored" })).toMatchObject({ ok: true, brief: { scope: null } });
    expect(validateBrief("deep_dive", { question: "q", scope: "s".repeat(BRIEF_LIMITS.scope + 1) })).toMatchObject({ ok: false });
    expect(validateBrief("quick_answer", { question: 42 })).toEqual({ ok: false, error: "question must be text" });
    expect(validateBrief("quick_answer", { question: "q", contact: ["x"] })).toEqual({ ok: false, error: "contact must be text" });
  });
});

describe("isValidDeliveryUrl", () => {
  it("accepts https URLs and local paths only", () => {
    for (const ok of ["https://nearbi.ai/reports/x/", "/reports/order-abc/", "https://example.com/a?b=c"]) expect(isValidDeliveryUrl(ok), ok).toBe(true);
    for (const bad of ["http://x.com", "javascript:alert(1)", "//evil.com/x", "data:text/html,x", "/a b", 'https://x.com/"><script>', "ftp://x"]) {
      expect(isValidDeliveryUrl(bad), bad).toBe(false);
    }
  });
});
