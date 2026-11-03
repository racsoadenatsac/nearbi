import { describe, expect, it } from "vitest";
import { MemoryRepository } from "../src/adapters/memory-repository";
import { loadIntentsConfig } from "../src/config";
import { IntentsAdapter, OneClickClient } from "../src/intents";
import { isScheduledTask, runScheduledTask } from "../src/scheduled";
import { createCheckout, type BillingDeps } from "../src/services/billing";
import { fakeOneClick, statusBody } from "./helpers/oneclick";

const now = Math.floor(Date.parse("2026-11-02T00:00:00Z") / 1000);

function deps(mode: "live" | "dry" = "live") {
  const repo = new MemoryRepository();
  const f = fakeOneClick();
  const config = loadIntentsConfig(mode === "live" ? { INTENTS_MODE: "live", SETTLEMENT_RECIPIENT: "forwarder.nearbi.near" } : {});
  const intents = new IntentsAdapter(new OneClickClient({ fetch: f.fetch, sleep: async () => {} }), { settlementAsset: config.settlementAsset });
  return { d: { repo, intents, config } as BillingDeps, repo, f };
}

describe("scheduled tasks (EventBridge Scheduler input)", () => {
  it("recognises only the direct-invoke shape, never an HTTP event", () => {
    expect(isScheduledTask({ nearbiTask: "sweep-payments" })).toBe(true);
    expect(isScheduledTask({ nearbiTask: "sweep-payments", requestContext: {} })).toBe(false);
    expect(isScheduledTask({ nearbiTask: "sweep-payments", httpMethod: "GET" })).toBe(false);
    expect(isScheduledTask({ version: "2.0", rawPath: "/", requestContext: { http: { method: "GET" } } })).toBe(false);
    expect(isScheduledTask(null)).toBe(false);
    expect(isScheduledTask("sweep-payments")).toBe(false);
  });

  it("sweep-payments confirms a SUCCESS and logs one structured line", async () => {
    const { d, repo, f } = deps();
    const co = await createCheckout(d, { accountId: "alice.near", amountUsd: 49, nowSec: now, originAsset: "nep141:wrap.near" });
    f.statuses.set(co.depositAddress!, statusBody("SUCCESS", f.issued.get(co.depositAddress!)!));
    const r = await runScheduledTask({ nearbiTask: "sweep-payments" }, d, () => now + 60);
    expect(r).toMatchObject({ task: "sweep-payments", open: 1, paid: 1, closed: 1, errors: 0 });
    expect((await repo.getPayment(co.paymentId))?.status).toBe("paid");
    expect(await repo.listForwardQueue(5)).toHaveLength(1);
  });

  it("runs in dry mode too (nothing open) and rejects unknown tasks", async () => {
    const { d } = deps("dry");
    expect(await runScheduledTask({ nearbiTask: "sweep-payments" }, d, () => now)).toMatchObject({ open: 0, checked: 0 });
    expect(await runScheduledTask({ nearbiTask: "rm-rf" }, d, () => now)).toMatchObject({ error: "unknown task" });
  });
});
