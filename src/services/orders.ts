// One-off orders (Quick Answer / Deep Dive) after payment: listing and the admin status update.
// Orders are created by confirmPayment (services/billing.ts) when their payment is paid.
import { ORDER_STATUSES, isValidDeliveryUrl, validateDeliverable, type Deliverable, type OrderRecord, type OrderStatus } from "../core/products";
import { DeliverableSlugTaken, type Repository } from "../ports/repository";

export type OrderUpdateResult = { ok: true; order: OrderRecord } | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Admin: set an order's status, delivery URL and/or deliverable. Body: {status?, deliveryUrl?, deliverable?, shared?}.
 * "delivered" requires a delivery URL (given now, already stored, or implied by the deliverable).
 * deliveryUrl: https URL or a nearbi.ai path; "" or null clears it.
 * deliverable: {slug, title, summary?, contentPrefix?, pdfFile?} — the order's own report, served buyer-only at
 * /reports/<slug>/ (null detaches it). Its slug can't be a free or catalog report, or another order's.
 * shared: true also opens the deliverable to active subscribers (default false).
 */
export async function updateOrderAdmin(
  repo: Repository,
  paymentId: string,
  body: unknown,
  nowSec: number,
  opts: { freeSlugs?: readonly string[] } = {},
): Promise<OrderUpdateResult> {
  if (!/^[0-9a-f-]{36}$/.test(paymentId)) return { ok: false, status: 404, error: "order not found" };
  const b = (body && typeof body === "object" ? body : {}) as { status?: unknown; deliveryUrl?: unknown; deliverable?: unknown; shared?: unknown };
  if (b.status !== undefined && !(ORDER_STATUSES as readonly unknown[]).includes(b.status)) {
    return { ok: false, status: 400, error: `status must be one of ${ORDER_STATUSES.join(", ")}` };
  }
  let deliveryUrl: string | null | undefined;
  if (b.deliveryUrl === null || b.deliveryUrl === "") deliveryUrl = null;
  else if (b.deliveryUrl !== undefined) {
    if (typeof b.deliveryUrl !== "string" || !isValidDeliveryUrl(b.deliveryUrl.trim())) {
      return { ok: false, status: 400, error: "deliveryUrl must be an https URL or a path on nearbi.ai" };
    }
    deliveryUrl = b.deliveryUrl.trim();
  }
  let deliverable: Deliverable | null | undefined;
  if (b.deliverable === null) deliverable = null;
  else if (b.deliverable !== undefined) {
    const d = validateDeliverable(b.deliverable);
    if (!d.ok) return { ok: false, status: 400, error: d.error };
    deliverable = d.deliverable;
  }
  if (b.shared !== undefined && typeof b.shared !== "boolean") return { ok: false, status: 400, error: "shared must be true or false" };
  const shared = b.shared as boolean | undefined;
  if (b.status === undefined && deliveryUrl === undefined && deliverable === undefined && shared === undefined) {
    return { ok: false, status: 400, error: "nothing to update: give status, deliveryUrl, deliverable and/or shared" };
  }

  const cur = await repo.getOrder(paymentId);
  if (!cur) return { ok: false, status: 404, error: "order not found" };
  if (deliverable) {
    if (opts.freeSlugs?.includes(deliverable.slug) || (await repo.getReport(deliverable.slug))) {
      return { ok: false, status: 409, error: `report slug ${deliverable.slug} is a catalog report; pick another slug` };
    }
    // The deliverable's own page is the natural delivery link.
    if (deliveryUrl === undefined && (!cur.deliveryUrl || cur.deliverable)) deliveryUrl = `/reports/${deliverable.slug}/`;
  }
  const status = (b.status as OrderStatus | undefined) ?? cur.status;
  const finalUrl = deliveryUrl === undefined ? cur.deliveryUrl : deliveryUrl;
  if (status === "delivered" && !finalUrl) return { ok: false, status: 400, error: "a delivered order needs a deliveryUrl" };
  try {
    const order = await repo.updateOrder(paymentId, { status, deliveryUrl, deliverable, shared, nowSec });
    return order ? { ok: true, order } : { ok: false, status: 404, error: "order not found" };
  } catch (e) {
    if (e instanceof DeliverableSlugTaken) return { ok: false, status: 409, error: e.message };
    throw e;
  }
}

/** JSON shape for admins / the agent (full brief) and for the owner (same; it is their own brief). */
export function orderJson(o: OrderRecord) {
  return {
    orderId: o.paymentId,
    accountId: o.accountId,
    product: o.product,
    amountUsd: o.amountUsd,
    status: o.status,
    deliveryUrl: o.deliveryUrl,
    deliverable: o.deliverable,
    shared: o.shared,
    brief: o.brief,
    createdAt: new Date(o.createdAt * 1000).toISOString(),
    updatedAt: new Date(o.updatedAt * 1000).toISOString(),
  };
}
