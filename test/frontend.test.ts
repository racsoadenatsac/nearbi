// The server-rendered pages link to static scripts/styles in ./public; make sure every one exists.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkoutPage, containerPage, loginPage, membersPage } from "../src/pages";

const sub = { status: "active" as const, active: true, currentPeriodEnd: 1_900_000_000 };
const pages = [
  loginPage("/members"),
  membersPage({ accountId: "a.near", sub, priceUsd: 49, reports: [] }),
  containerPage({ accountId: "a.near", sub, registryHost: "registry.nearbi.ai" }),
  checkoutPage({ accountId: "a.near", sub, priceUsd: 49, mode: "dry" }),
];

describe("static assets referenced by pages", () => {
  const refs = new Set(pages.flatMap((html) => [...html.matchAll(/(?:src|href)="(\/(?:js|assets)\/[^"]+)"/g)].map((m) => m[1])));
  it("finds references", () => expect(refs.size).toBeGreaterThanOrEqual(5));
  it.each([...refs])("%s exists in public/", (p) => expect(existsSync(`public${p}`)).toBe(true));
});
