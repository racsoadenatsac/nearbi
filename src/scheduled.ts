// Scheduled tasks invoked directly (not through HTTP) by EventBridge Scheduler with a fixed JSON input:
//   {"nearbiTask": "sweep-payments"}
// API Gateway / Function URL events always carry `requestContext`, so an HTTP request can never be
// mistaken for a scheduled task; only principals allowed lambda:InvokeFunction (the scheduler role) can
// send this shape. The sweep is idempotent, so a duplicate or replayed invocation is harmless.
import type { BillingDeps, SweepResult } from "./services/billing";
import { sweepOpenPayments } from "./services/billing";

export const SWEEP_TASK = "sweep-payments";

export interface ScheduledEvent {
  nearbiTask: string;
}

export function isScheduledTask(event: unknown): event is ScheduledEvent {
  if (!event || typeof event !== "object") return false;
  const e = event as Record<string, unknown>;
  return !("requestContext" in e) && !("httpMethod" in e) && typeof e.nearbiTask === "string";
}

export async function runScheduledTask(
  event: ScheduledEvent,
  d: BillingDeps,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<{ task: string } & Partial<SweepResult> & { error?: string }> {
  if (event.nearbiTask !== SWEEP_TASK) {
    console.error(`scheduled: unknown task ${JSON.stringify(event.nearbiTask).slice(0, 64)}`);
    return { task: String(event.nearbiTask).slice(0, 64), error: "unknown task" };
  }
  // Runs in dry mode too: live payments opened before a switch back to dry must still confirm.
  const r = await sweepOpenPayments(d, now());
  // One structured line per run: the CloudWatch evidence that the schedule fires.
  console.log(JSON.stringify({ task: SWEEP_TASK, mode: d.config.mode, ...r }));
  return { task: SWEEP_TASK, ...r };
}
