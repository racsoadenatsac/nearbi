// The server-rendered pages link to static scripts/styles in ./public; make sure every one exists.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { checkoutPage, containerPage, loginPage, membersPage } from "../src/pages";

const sub = { status: "active" as const, active: true, currentPeriodEnd: 1_900_000_000 };
const pages = [
  loginPage("/members"),
  membersPage({ accountId: "a.near", sub, priceUsd: 49, reports: [] }),
  containerPage({ accountId: "a.near", sub, registryHost: "registry.nearbi.ai" }),
  checkoutPage({ accountId: "a.near", sub, priceUsd: 49, mode: "dry" }),
  checkoutPage({ accountId: "a.near", sub, priceUsd: 49, mode: "live", product: loadConfig({ SESSION_SECRET: "x".repeat(32), ADMIN_TOKEN: "a" }).products.deep_dive }),
];

describe("static assets referenced by pages", () => {
  const refs = new Set(pages.flatMap((html) => [...html.matchAll(/(?:src|href)="(\/(?:js|assets)\/[^"]+)"/g)].map((m) => m[1])));
  it("finds references", () => expect(refs.size).toBeGreaterThanOrEqual(5));
  it.each([...refs])("%s exists in public/", (p) => expect(existsSync(`public${p}`)).toBe(true));
});

describe("landing page order section", () => {
  const html = readFileSync("public/index.html", "utf8");
  const order = html.slice(html.indexOf('<section id="order">'), html.indexOf("</section>", html.indexOf('<section id="order">')));
  it("Quick Answer and Deep Dive link to checkout; samples kept", () => {
    expect(order).toContain('<a class="btn pri" href="/members/checkout?product=quick_answer">Order: $29</a>');
    expect(order).toContain('<a class="btn pri" href="/members/checkout?product=deep_dive">Order: $499</a>');
    expect(order).toContain('href="/reports/near-users-vs-bots/">See a free sample');
    expect(order).toContain('href="/reports/near-thesis/">See a free sample');
    expect(order).toMatch(/within 24 hours/);
    expect(order).toMatch(/within 48 hours/);
  });
  it("Ecosystem stays a quote by email; the subscribe link stays", () => {
    expect(order).toMatch(/<a class="btn pri" href="mailto:hello@nearbi\.ai[^"]*">Request a custom report<\/a>/);
    expect(order).not.toContain("product=ecosystem");
    expect(order).toContain('href="#subscribe">Or subscribe: $49/month');
  });
});
