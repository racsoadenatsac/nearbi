import { describe, expect, it } from "vitest";
import { decide, parseReportPath, reportObjectKey, requiredAccess } from "../../src/core/gating";

const FREE = "near-users-vs-bots";
const active = { status: "active" as const, active: true, currentPeriodEnd: 2 };
const expired = { status: "expired" as const, active: false, currentPeriodEnd: 1 };
const none = { status: "none" as const, active: false, currentPeriodEnd: null };

describe("requiredAccess", () => {
  it.each([
    ["/", "public"],
    ["/login", "public"],
    ["/api/me", "public"],
    ["/auth/challenge", "public"],
    ["/billing/confirm", "public"], // admin-token protected inside the handler, not by session
    [`/reports/${FREE}/`, "public"],
    [`/reports/${FREE}/NEAR-real-users-or-bots.pdf`, "public"],
    [`/reports/${FREE}/charts/q1_daily_activity.png`, "public"],
    ["/members", "session"],
    ["/members/", "session"],
    ["/billing/checkout", "session"],
    ["/members/container", "subscriber"],
    ["/members/anything/else", "subscriber"],
    ["/registry/token", "subscriber"],
    ["/reports/near-defi-flows/", "subscriber"],
    ["/reports/near-defi-flows/report.pdf", "subscriber"],
    ["/reports/near-defi-flows", "subscriber"],
    ["/reports", "subscriber"],
    ["/reports/../members", "subscriber"],
    [`/reports/${FREE}-premium/`, "subscriber"],
    [`/reports/${FREE.toUpperCase()}/`, "subscriber"],
  ])("%s -> %s", (path, access) => {
    expect(requiredAccess(path, FREE)).toBe(access);
  });
});

describe("decide", () => {
  it("public is always allowed", () => expect(decide("public", null, null)).toEqual({ allow: true }));
  it("session requires sign-in only", () => {
    expect(decide("session", null, null)).toEqual({ allow: false, reason: "login" });
    expect(decide("session", "a.near", none)).toEqual({ allow: true });
  });
  it("subscriber requires sign-in, then an active subscription", () => {
    expect(decide("subscriber", null, null)).toEqual({ allow: false, reason: "login" });
    expect(decide("subscriber", "a.near", none)).toEqual({ allow: false, reason: "subscribe" });
    expect(decide("subscriber", "a.near", expired)).toEqual({ allow: false, reason: "subscribe" });
    expect(decide("subscriber", "a.near", active)).toEqual({ allow: true });
  });
});

describe("parseReportPath", () => {
  it("maps to report files", () => {
    expect(parseReportPath("/reports/x-1/")).toEqual({ slug: "x-1", file: "index.html" });
    expect(parseReportPath("/reports/x-1")).toEqual({ slug: "x-1", file: "index.html" });
    expect(parseReportPath("/reports/x-1/charts/a.png")).toEqual({ slug: "x-1", file: "charts/a.png" });
  });
  it("rejects traversal and invalid slugs", () => {
    expect(parseReportPath("/reports/x/../../secrets")).toBeNull();
    expect(parseReportPath("/reports/x/%2e%2e/y")).toBeNull();
    expect(parseReportPath("/reports/X_Y/")).toBeNull();
    expect(parseReportPath("/other")).toBeNull();
  });
});

describe("parseReportPath edge cases", () => {
  it("returns null on malformed percent-encoding instead of throwing", () => {
    expect(parseReportPath("/reports/%E0%A4%A/")).toBeNull();
    expect(parseReportPath("/reports/x/%E0%A4%A.png")).toBeNull();
  });
  it("reportObjectKey maps into the content bucket layout", () => {
    expect(reportObjectKey("x-1", "charts/a.png")).toBe("reports/x-1/charts/a.png");
  });
});
