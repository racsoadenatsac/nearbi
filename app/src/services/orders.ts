// One-off orders (Quick Answer / Deep Dive) after payment: listing and the admin status update.
// Orders are created by confirmPayment (services/billing.ts) when their payment is paid.
import { ORDER_STATUSES, isValidDeliveryUrl, type OrderRecord, type OrderStatus } from "../core/products";
import type { Repository } from "../ports/repository";

export type OrderUpdateResult = { ok: true; order: OrderRecord } | { ok: false; status: 400 | 404; error: string };

/**
 * Admin: set an order's status and/or delivery URL. Body: {status?, deliveryUrl?}. "delivered" requires a
 * delivery URL (given now or already stored). deliveryUrl: https URL or a nearbi.ai path; "" or null clears it.
 */
export async function updateOrderAdmin(repo: Repository, paymentId: string, body: unknown, nowSec: number): Promise<OrderUpdateResult> {
  if (!/^[0-9a-f-]{36}$/.test(paymentId)) return { ok: false, status: 404, error: "order not found" };
  const b = (body && typeof body === "object" ? body : {}) as { status?: unknown; deliveryUrl?: unknown };
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
  if (b.status === undefined && deliveryUrl === undefined) return { ok: false, status: 400, error: "nothing to update: give status and/or deliveryUrl" };

  const cur = await repo.getOrder(paymentId);
  if (!cur) return { ok: false, status: 404, error: "order not found" };
  const status = (b.status as OrderStatus | undefined) ?? cur.status;
  const finalUrl = deliveryUrl === undefined ? cur.deliveryUrl : deliveryUrl;
  if (status === "delivered" && !finalUrl) return { ok: false, status: 400, error: "a delivered order needs a deliveryUrl" };
  const order = await repo.updateOrder(paymentId, { status, deliveryUrl, nowSec });
  return order ? { ok: true, order } : { ok: false, status: 404, error: "order not found" };
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
    brief: o.brief,
    createdAt: new Date(o.createdAt * 1000).toISOString(),
    updatedAt: new Date(o.updatedAt * 1000).toISOString(),
  };
}
