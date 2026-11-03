// 1Click execution status -> our payment state. Statuses from the spec's GetExecutionStatusResponse enum
// and the "Status response" table in the Quickstart (docs.near-intents.org, checked 2026-11-02).

import type { PaymentStatus } from "../ports/repository";

export interface MappedStatus {
  status: PaymentStatus;
  terminal: boolean;
  /** Human text for the checkout page. */
  label: string;
}

export function mapOneClickStatus(s: string): MappedStatus | null {
  switch (s) {
    case "PENDING_DEPOSIT":
      return { status: "pending", terminal: false, label: "Waiting for your deposit" };
    case "KNOWN_DEPOSIT_TX":
      return { status: "processing", terminal: false, label: "Deposit transaction seen, waiting for confirmation" };
    case "PROCESSING":
      return { status: "processing", terminal: false, label: "Swap in progress" };
    case "INCOMPLETE_DEPOSIT":
      // Under EXACT_OUTPUT a deposit below minAmountIn is refunded after the deadline unless topped up.
      return { status: "incomplete", terminal: false, label: "Deposit below the quoted amount: send the rest before the deadline, or it is refunded" };
    case "SUCCESS":
      return { status: "paid", terminal: true, label: "Paid" };
    case "REFUNDED":
      return { status: "refunded", terminal: true, label: "Refunded to your refund address" };
    case "FAILED":
      return { status: "failed", terminal: true, label: "Swap failed" };
    default:
      return null; // unknown future status: leave the payment as it is and report the raw value
  }
}
