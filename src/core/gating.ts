// Pure access-control decisions. Routing code asks: what does this path need, and does the visitor have it?

import type { SubscriptionState } from "./subscription";

export type Access = "public" | "session" | "subscriber";
export type Decision = { allow: true } | { allow: false; reason: "login" | "subscribe" };

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/** Parse /reports/<slug>[/<file...>] into slug + file inside the report; null if not a report path or unsafe. */
export function parseReportPath(pathname: string): { slug: string; file: string } | null {
  const m = /^\/reports\/([^/]+)(?:\/(.*))?$/.exec(pathname);
  if (!m) return null;
  let slug: string, rest: string;
  try {
    slug = decodeURIComponent(m[1]);
    rest = m[2] ? decodeURIComponent(m[2]) : "";
  } catch {
    return null; // malformed percent-encoding
  }
  if (!isValidSlug(slug)) return null;
  const parts = rest.split("/").filter(Boolean);
  if (parts.some((p) => p === "." || p === ".." || p.includes("\\"))) return null;
  return { slug, file: parts.length ? parts.join("/") : "index.html" };
}

/** Free (public) report slugs: served from the static site, never gated. */
export const DEFAULT_FREE_REPORT_SLUGS = ["near-users-vs-bots", "near-thesis"] as const;

export function requiredAccess(pathname: string, freeSlugs: string | readonly string[]): Access {
  const free: readonly string[] = typeof freeSlugs === "string" ? [freeSlugs] : freeSlugs;
  if (pathname === "/members" || pathname === "/members/") return "session";
  if (pathname === "/members/checkout") return "session"; // you subscribe from here, so no subscription needed
  if (pathname.startsWith("/members/")) return "subscriber";
  if (pathname === "/registry/token") return "subscriber";
  if (pathname === "/auth/logout") return "session";
  // Everything under /billing/ needs a session, except the admin endpoints (bearer token, checked in the route).
  if (isAdminPath(pathname)) return "public";
  if (pathname.startsWith("/billing/")) return "session";
  if (pathname === "/reports" || pathname.startsWith("/reports/")) {
    const r = parseReportPath(pathname);
    if (r && free.includes(r.slug)) return "public";
    // Unknown/invalid report paths are still gated: never leak what exists. For signed-in visitors the app then
    // resolves the slug (catalog report, buyer-only order deliverable, or 404); see reportAccess in app.ts.
    return "subscriber";
  }
  return "public";
}

/** Admin-token endpoints: POST /billing/confirm and /billing/admin/*. The route checks the bearer token. */
export function isAdminPath(pathname: string): boolean {
  return pathname === "/billing/confirm" || pathname.startsWith("/billing/admin/");
}

export function decide(access: Access, accountId: string | null, sub: SubscriptionState | null): Decision {
  if (access === "public") return { allow: true };
  if (!accountId) return { allow: false, reason: "login" };
  if (access === "session") return { allow: true };
  return sub?.active ? { allow: true } : { allow: false, reason: "subscribe" };
}

/** Object key for a private report file in the content bucket. */
export const reportObjectKey = (slug: string, file: string) => `reports/${slug}/${file}`;
