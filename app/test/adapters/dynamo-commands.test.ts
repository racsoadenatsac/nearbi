// Offline check of the DynamoDB single-table key patterns and conditions: a fake client records commands.
import { describe, expect, it } from "vitest";
import { DynamoRepository, keys } from "../../src/adapters/dynamo-repository";

function fakeClient(reply: (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => unknown = () => ({})) {
  const sent: { name: string; input: Record<string, any> }[] = [];
  return {
    sent,
    client: {
      send: async (cmd: any) => {
        sent.push({ name: cmd.constructor.name, input: cmd.input });
        const r = reply(cmd);
        if (r instanceof Error) throw r;
        return r;
      },
    } as any,
  };
}

const cancelled = (...codes: string[]) => Object.assign(new Error("cancelled"), { name: "TransactionCanceledException", CancellationReasons: codes.map((Code) => ({ Code })) });

describe("DynamoRepository key design", () => {
  it("key patterns", () => {
    expect(keys.challenge("n")).toEqual({ PK: "NONCE#n", SK: "CHALLENGE" });
    expect(keys.account("a.near")).toEqual({ PK: "ACCT#a.near", SK: "PROFILE" });
    expect(keys.subscription("a.near")).toEqual({ PK: "ACCT#a.near", SK: "SUB" });
    expect(keys.currentToken("a.near")).toEqual({ PK: "ACCT#a.near", SK: "RTOKEN" });
    expect(keys.payment("p")).toEqual({ PK: "PAY#p", SK: "PAYMENT" });
    expect(keys.tx("t")).toEqual({ PK: "TX#t", SK: "TX" });
    expect(keys.token("h")).toEqual({ PK: "RTOK#h", SK: "RTOKEN" });
    expect(keys.report("s")).toEqual({ PK: "CATALOG", SK: "REPORT#s" });
  });

  it("challenges carry a TTL and are consumed with a conditional DeleteItem ALL_OLD", async () => {
    const f = fakeClient((c) => (c.constructor.name === "DeleteCommand" ? { Attributes: { message: "m", expiresAt: 5 } } : {}));
    const r = new DynamoRepository(f.client, "T");
    await r.putChallenge({ nonce: "n", message: "m", expiresAt: 5 });
    expect(f.sent[0].input).toMatchObject({ TableName: "T", Item: { PK: "NONCE#n", SK: "CHALLENGE", ttl: 5 }, ConditionExpression: "attribute_not_exists(PK)" });
    expect(await r.consumeChallenge("n")).toEqual({ nonce: "n", message: "m", expiresAt: 5 });
    expect(f.sent[1]).toMatchObject({ name: "DeleteCommand", input: { Key: { PK: "NONCE#n", SK: "CHALLENGE" }, ConditionExpression: "attribute_exists(PK)", ReturnValues: "ALL_OLD" } });
  });

  it("a consumed/unknown nonce (ConditionalCheckFailed) is null, not an error", async () => {
    const r = new DynamoRepository(fakeClient(() => Object.assign(new Error("ccf"), { name: "ConditionalCheckFailedException" })).client, "T");
    expect(await r.consumeChallenge("n")).toBeNull();
  });

  it("applyPayment is one TransactWrite: payment condition, tx claim, subscription optimistic check", async () => {
    const f = fakeClient();
    const r = new DynamoRepository(f.client, "T");
    await r.applyPayment({ paymentId: "p", accountId: "a.near", txHash: "t", nowSec: 1, newPeriodEnd: 9, expected: { exists: true, currentPeriodEnd: 7 } });
    const items = f.sent[0].input.TransactItems;
    expect(f.sent[0].name).toBe("TransactWriteCommand");
    expect(items[0].Update).toMatchObject({ Key: { PK: "PAY#p" }, ConditionExpression: "#st IN (:open0, :open1, :open2, :open3, :open4)" });
    expect(items[0].Update.ExpressionAttributeValues).toMatchObject({ ":open0": "preview", ":open1": "pending", ":open4": "expired" });
    expect(items[1].Put).toMatchObject({ Item: { PK: "TX#t", SK: "TX" }, ConditionExpression: "attribute_not_exists(PK)" });
    expect(items[2].Update).toMatchObject({ Key: { PK: "ACCT#a.near", SK: "SUB" }, ConditionExpression: "currentPeriodEnd = :expectedEnd" });
    expect(items[2].Update.ExpressionAttributeValues[":expectedEnd"]).toBe(7);
  });

  it.each([
    [["ConditionalCheckFailed", "None", "None"], "not_pending"],
    [["None", "ConditionalCheckFailed", "None"], "tx_used"],
    [["None", "None", "ConditionalCheckFailed"], "conflict"],
    [["TransactionConflict", "None", "None"], "conflict"],
  ])("maps cancellation %j to %s", async (codes, reason) => {
    const r = new DynamoRepository(fakeClient(() => cancelled(...codes)).client, "T");
    expect(await r.applyPayment({ paymentId: "p", accountId: "a", txHash: "t", nowSec: 1, newPeriodEnd: 9, expected: { exists: false, currentPeriodEnd: null } })).toEqual({ ok: false, reason });
  });

  it("other errors propagate", async () => {
    const r = new DynamoRepository(fakeClient(() => new Error("throttled")).client, "T");
    await expect(r.getSubscription("a")).rejects.toThrow("throttled");
  });

  it("replaceRegistryToken writes token + pointer and revokes the previous token in one transaction", async () => {
    const f = fakeClient((c) => (c.constructor.name === "GetCommand" ? { Item: { tokenHash: "old" } } : {}));
    const r = new DynamoRepository(f.client, "T");
    await r.replaceRegistryToken({ tokenHash: "new", accountId: "a.near", expiresAt: 100, revoked: false, createdAt: 1 });
    const items = f.sent[1].input.TransactItems;
    expect(items[0].Put.Item).toMatchObject({ PK: "RTOK#new", accountId: "a.near", revoked: false, ttl: 100 + 90 * 86400 });
    expect(items[1].Put).toMatchObject({ Item: { PK: "ACCT#a.near", SK: "RTOKEN", tokenHash: "new" }, ConditionExpression: "tokenHash = :prev" });
    expect(items[2].Update).toMatchObject({ Key: { PK: "RTOK#old" }, UpdateExpression: "SET revoked = :t" });
  });
});
