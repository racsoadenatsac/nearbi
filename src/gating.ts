// Pure access-control decisions. Routing code asks: what does this path need, and does the visitor have it?

import type { SubscriptionState } from "./billing/subscription";

export type Access = "public" | "session" | "subscriber";
export type Decision = { allow: true } | { allow: false; reason: "login" | "subscribe" };

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/** Parse /reports/<slug>[/<file...>] into slug + object key; null if the path is not a report path or is unsafe. */
export function parseReportPath(pathname: string): { slug: string; file: string } | null {
  const m = /^\/reports\/([^/]+)(?:\/(.*))?$/.exec(pathname);
  if (!m) return null;
  const slug = decodeURIComponent(m[1]);
  if (!isValidSlug(slug)) return null;
  const rest = m[2] ? decodeURIComponent(m[2]) : "";
  const parts = rest.split("/").filter(Boolean);
  if (parts.some((p) => p === "." || p === ".." || p.includes("\\"))) return null;
  return { slug, file: parts.length ? parts.join("/") : "index.html" };
}

export function requiredAccess(pathname: string, freeSlug: string): Access {
  if (pathname === "/members" || pathname === "/members/") return "session";
  if (pathname.startsWith("/members/")) return "subscriber";
  if (pathname === "/registry/token") return "subscriber";
  if (pathname === "/billing/checkout" || pathname === "/auth/logout") return "session";
  if (pathname === "/reports" || pathname.startsWith("/reports/")) {
    const r = parseReportPath(pathname);
    if (r && r.slug === freeSlug) return "public";
    return "subscriber"; // unknown/invalid report paths are still gated: never leak what exists
  }
  return "public";
}

export function decide(access: Access, accountId: string | null, sub: SubscriptionState | null): Decision {
  if (access === "public") return { allow: true };
  if (!accountId) return { allow: false, reason: "login" };
  if (access === "session") return { allow: true };
  return sub?.active ? { allow: true } : { allow: false, reason: "subscribe" };
}
