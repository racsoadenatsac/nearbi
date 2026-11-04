// Product catalog and order briefs. Prices are server-side only (env, with defaults): the client picks a
// product id, never an amount.

export type ProductId = "subscription" | "quick_answer" | "deep_dive";
export type OneOffProductId = Exclude<ProductId, "subscription">;

export interface Product {
  id: ProductId;
  name: string;
  priceUsd: number;
  kind: "subscription" | "one_off";
  /** Promised delivery time, shown on the checkout page (one-off products only). */
  delivery: string | null;
}

export type ProductCatalog = Record<ProductId, Product>;

export const PRODUCT_IDS: readonly ProductId[] = ["subscription", "quick_answer", "deep_dive"];

export function isProductId(v: unknown): v is ProductId {
  return typeof v === "string" && (PRODUCT_IDS as readonly string[]).includes(v);
}

export function isOneOff(id: ProductId | null | undefined): id is OneOffProductId {
  return id === "quick_answer" || id === "deep_dive";
}

export function buildCatalog(p: { monthlyPriceUsd: number; quickAnswerPriceUsd: number; deepDivePriceUsd: number }): ProductCatalog {
  return {
    subscription: { id: "subscription", name: "Subscription", priceUsd: p.monthlyPriceUsd, kind: "subscription", delivery: null },
    quick_answer: { id: "quick_answer", name: "Quick Answer", priceUsd: p.quickAnswerPriceUsd, kind: "one_off", delivery: "within 24 hours" },
    deep_dive: { id: "deep_dive", name: "Deep Dive", priceUsd: p.deepDivePriceUsd, kind: "one_off", delivery: "within 48 hours" },
  };
}

// ------------------------------------------------------------------------------------------ briefs

export const BRIEF_LIMITS = { question: 2000, contact: 200, scope: 2000 } as const;

/** What the customer asked for; stored on the payment and copied onto the order. */
export interface OrderBrief {
  question: string;
  /** Email or Telegram handle, optional. */
  contact: string | null;
  /** Deep Dive only: topic / scope, optional. */
  scope: string | null;
}

export type BriefResult = { ok: true; brief: OrderBrief } | { ok: false; error: string };

const EMAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[A-Za-z]{2,}$/;
const TELEGRAM_RE = /^(?:@|https?:\/\/t\.me\/)?[A-Za-z][A-Za-z0-9_]{4,31}$/;

/** Strip control characters (keep newlines and tabs) and trim. */
const clean = (s: string) => s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();

export function validateBrief(product: OneOffProductId, input: unknown): BriefResult {
  if (!input || typeof input !== "object") return { ok: false, error: "brief required: tell us your question" };
  const b = input as Record<string, unknown>;
  for (const k of ["question", "contact", "scope"]) {
    if (b[k] !== undefined && b[k] !== null && typeof b[k] !== "string") return { ok: false, error: `${k} must be text` };
  }
  const question = clean((b.question as string | undefined) ?? "");
  if (!question) return { ok: false, error: "question required" };
  if (question.length > BRIEF_LIMITS.question) return { ok: false, error: `question is too long (max ${BRIEF_LIMITS.question} characters)` };

  const contact = clean((b.contact as string | undefined) ?? "") || null;
  if (contact !== null) {
    if (contact.length > BRIEF_LIMITS.contact) return { ok: false, error: `contact is too long (max ${BRIEF_LIMITS.contact} characters)` };
    if (!EMAIL_RE.test(contact) && !TELEGRAM_RE.test(contact)) return { ok: false, error: "contact must be an email address or a Telegram handle (@name)" };
  }

  let scope: string | null = null;
  if (product === "deep_dive") {
    scope = clean((b.scope as string | undefined) ?? "") || null;
    if (scope && scope.length > BRIEF_LIMITS.scope) return { ok: false, error: `topic/scope is too long (max ${BRIEF_LIMITS.scope} characters)` };
  }
  return { ok: true, brief: { question, contact, scope } };
}

// ------------------------------------------------------------------------------------------ orders

/** paid: waiting to be picked up. in_progress: being worked on. delivered: deliveryUrl set and sent. */
export type OrderStatus = "paid" | "in_progress" | "delivered";
export const ORDER_STATUSES: readonly OrderStatus[] = ["paid", "in_progress", "delivered"];

export interface OrderRecord {
  /** Same as the payment id (one order per paid one-off payment). */
  paymentId: string;
  accountId: string;
  product: OneOffProductId;
  brief: OrderBrief;
  amountUsd: number;
  status: OrderStatus;
  deliveryUrl: string | null;
  /**
   * The report made for this order, if any. Stored in DynamoDB on the order (never in source code) and readable
   * only by the order's account at /reports/<slug>/ once delivered; everyone else gets 404.
   */
  deliverable: Deliverable | null;
  /** Explicit opt-in: also open the deliverable to active subscribers. Default false (buyer only). */
  shared: boolean;
  createdAt: number;
  updatedAt: number;
}

/** An order-specific report: what /reports/<slug>/ serves and how the buyer's members page lists it. */
export interface Deliverable {
  slug: string;
  title: string;
  summary: string;
  /** Object key prefix in the content bucket, under reports/ and ending in "/". Default reports/<slug>/. */
  contentPrefix: string;
  /** PDF file name inside contentPrefix, or null. */
  pdfFile: string | null;
}

export const DELIVERABLE_LIMITS = { title: 200, summary: 1000 } as const;
const DELIV_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const PREFIX_RE = /^reports\/[a-z0-9][a-z0-9_-]{0,80}(?:\/[a-z0-9][a-z0-9_.-]{0,80})*\/$/;
const PDF_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}\.pdf$/;

export type DeliverableResult = { ok: true; deliverable: Deliverable } | { ok: false; error: string };

/** Validate an admin-supplied deliverable ({slug, title, summary?, contentPrefix?, pdfFile?}). */
export function validateDeliverable(input: unknown): DeliverableResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "deliverable must be an object" };
  const d = input as Record<string, unknown>;
  for (const k of ["slug", "title", "summary", "contentPrefix", "pdfFile"]) {
    if (d[k] !== undefined && d[k] !== null && typeof d[k] !== "string") return { ok: false, error: `deliverable.${k} must be text` };
  }
  const slug = ((d.slug as string | undefined) ?? "").trim();
  if (!DELIV_SLUG_RE.test(slug)) return { ok: false, error: "deliverable.slug must be lowercase letters, digits and dashes" };
  const title = clean((d.title as string | undefined) ?? "");
  if (!title || title.length > DELIVERABLE_LIMITS.title) return { ok: false, error: `deliverable.title required (max ${DELIVERABLE_LIMITS.title} characters)` };
  const summary = clean((d.summary as string | undefined) ?? "");
  if (summary.length > DELIVERABLE_LIMITS.summary) return { ok: false, error: `deliverable.summary is too long (max ${DELIVERABLE_LIMITS.summary} characters)` };
  const contentPrefix = ((d.contentPrefix as string | undefined) ?? "").trim() || `reports/${slug}/`;
  if (!PREFIX_RE.test(contentPrefix)) return { ok: false, error: "deliverable.contentPrefix must look like reports/<name>/" };
  const pdfFile = ((d.pdfFile as string | undefined) ?? "").trim() || null;
  if (pdfFile !== null && !PDF_RE.test(pdfFile)) return { ok: false, error: "deliverable.pdfFile must be a plain .pdf file name" };
  return { ok: true, deliverable: { slug, title, summary, contentPrefix, pdfFile } };
}

/** Delivery links: https URLs, or a path on nearbi.ai (e.g. /reports/<slug>/). */
export function isValidDeliveryUrl(v: string): boolean {
  if (v.length > 500) return false;
  if (/^\/(?!\/)[^\s"'<>\\]*$/.test(v)) return true;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !/[\s"'<>]/.test(v);
  } catch {
    return false;
  }
}

/**
 * The report slug a delivery link points at on our own site (/reports/<slug>/... or https://<app origin>/reports/<slug>/...),
 * or null. A delivered order grants its buyer access to that one report without a subscription.
 */
export function deliveredReportSlug(deliveryUrl: string | null, appOrigins: readonly string[]): string | null {
  if (!deliveryUrl) return null;
  let path = deliveryUrl;
  if (!path.startsWith("/")) {
    try {
      const u = new URL(deliveryUrl);
      if (!appOrigins.includes(u.origin)) return null;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  const m = /^\/reports\/([a-z0-9][a-z0-9-]{0,80})(?:\/|$)/.exec(path);
  return m ? m[1]! : null;
}
