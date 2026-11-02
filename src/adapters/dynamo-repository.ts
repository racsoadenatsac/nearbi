// DynamoDB single-table Repository (see README "DynamoDB table design").
//
//   PK                  SK              entity
//   NONCE#<nonce>       CHALLENGE       one-time sign-in challenge (TTL: ttl)
//   ACCT#<accountId>    PROFILE         account (createdAt, lastLoginAt)
//   ACCT#<accountId>    SUB             subscription (status, currentPeriodEnd, lastPaymentTx, updatedAt)
//   ACCT#<accountId>    RTOKEN          pointer to the account's current registry token hash
//   PAY#<paymentId>     PAYMENT         payment
//   TX#<txHash>         TX              uniqueness claim for a payment tx hash
//   RTOK#<sha256>       RTOKEN          registry token (TTL: ttl)
//   CATALOG             REPORT#<slug>   report catalog entry
//
// Table: partition key PK (S), sort key SK (S), TTL attribute `ttl` (epoch seconds). No GSIs.

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type {
  AccountRecord,
  ApplyPaymentInput,
  ApplyPaymentResult,
  PaymentRecord,
  RegistryTokenRecord,
  ReportRecord,
  Repository,
  StoredChallenge,
  SubscriptionRecord,
} from "../ports/repository";

export const keys = {
  challenge: (nonce: string) => ({ PK: `NONCE#${nonce}`, SK: "CHALLENGE" }),
  account: (id: string) => ({ PK: `ACCT#${id}`, SK: "PROFILE" }),
  subscription: (id: string) => ({ PK: `ACCT#${id}`, SK: "SUB" }),
  currentToken: (id: string) => ({ PK: `ACCT#${id}`, SK: "RTOKEN" }),
  payment: (id: string) => ({ PK: `PAY#${id}`, SK: "PAYMENT" }),
  tx: (hash: string) => ({ PK: `TX#${hash}`, SK: "TX" }),
  token: (hash: string) => ({ PK: `RTOK#${hash}`, SK: "RTOKEN" }),
  report: (slug: string) => ({ PK: "CATALOG", SK: `REPORT#${slug}` }),
};

/** Registry token items linger this long after expiry before DynamoDB TTL removes them (audit trail). */
const TOKEN_TTL_GRACE_SECONDS = 90 * 86400;
const MAX_ATTEMPTS = 3;

type Send = Pick<DynamoDBDocumentClient, "send">;

function cancellationCodes(e: unknown): string[] | null {
  const err = e as { name?: string; CancellationReasons?: { Code?: string }[] };
  if (err?.name !== "TransactionCanceledException") return null;
  return (err.CancellationReasons ?? []).map((r) => r.Code ?? "None");
}

export class DynamoRepository implements Repository {
  constructor(
    private readonly db: Send,
    private readonly table: string,
  ) {}

  // ------------------------------------------------------------------ auth
  async putChallenge(c: StoredChallenge) {
    await this.db.send(
      new PutCommand({
        TableName: this.table,
        Item: { ...keys.challenge(c.nonce), type: "challenge", message: c.message, expiresAt: c.expiresAt, ttl: c.expiresAt },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  }

  async consumeChallenge(nonce: string): Promise<StoredChallenge | null> {
    // Conditional delete: exactly one concurrent consumer passes attribute_exists; the rest get
    // ConditionalCheckFailed. (An unconditional DeleteItem + ALL_OLD returned the item to every concurrent
    // caller on DynamoDB Local, so the condition is what enforces one-time use.)
    try {
      const r = await this.db.send(
        new DeleteCommand({
          TableName: this.table,
          Key: keys.challenge(nonce),
          ConditionExpression: "attribute_exists(PK)",
          ReturnValues: "ALL_OLD",
        }),
      );
      const a = r.Attributes;
      return a ? { nonce, message: a.message, expiresAt: a.expiresAt } : null;
    } catch (e) {
      if ((e as { name?: string })?.name === "ConditionalCheckFailedException") return null;
      throw e;
    }
  }

  async recordLogin(accountId: string, nowSec: number) {
    await this.db.send(
      new UpdateCommand({
        TableName: this.table,
        Key: keys.account(accountId),
        UpdateExpression: "SET #type = :type, accountId = :id, createdAt = if_not_exists(createdAt, :now), lastLoginAt = :now",
        ExpressionAttributeNames: { "#type": "type" },
        ExpressionAttributeValues: { ":type": "account", ":id": accountId, ":now": nowSec },
      }),
    );
  }

  async getAccount(accountId: string): Promise<AccountRecord | null> {
    const r = await this.db.send(new GetCommand({ TableName: this.table, Key: keys.account(accountId), ConsistentRead: true }));
    const a = r.Item;
    return a ? { accountId, createdAt: a.createdAt, lastLoginAt: a.lastLoginAt } : null;
  }

  // ------------------------------------------------------------------ billing
  async getSubscription(accountId: string): Promise<SubscriptionRecord | null> {
    const r = await this.db.send(new GetCommand({ TableName: this.table, Key: keys.subscription(accountId), ConsistentRead: true }));
    const s = r.Item;
    if (!s) return null;
    return {
      accountId,
      status: s.status,
      currentPeriodEnd: s.currentPeriodEnd ?? null,
      lastPaymentTx: s.lastPaymentTx ?? null,
      updatedAt: s.updatedAt,
    };
  }

  async createPayment(p: PaymentRecord) {
    await this.db.send(
      new PutCommand({
        TableName: this.table,
        Item: { ...keys.payment(p.id), type: "payment", ...p },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  }

  async getPayment(id: string): Promise<PaymentRecord | null> {
    const r = await this.db.send(new GetCommand({ TableName: this.table, Key: keys.payment(id), ConsistentRead: true }));
    const p = r.Item;
    if (!p) return null;
    return {
      id: p.id,
      accountId: p.accountId,
      amountUsd: p.amountUsd,
      token: p.token,
      depositAddress: p.depositAddress,
      status: p.status,
      txHash: p.txHash ?? null,
      createdAt: p.createdAt,
      paidAt: p.paidAt ?? null,
      quoteJson: p.quoteJson,
    };
  }

  async applyPayment(i: ApplyPaymentInput): Promise<ApplyPaymentResult> {
    const subCondition = i.expected.exists
      ? i.expected.currentPeriodEnd === null
        ? "attribute_exists(PK) AND attribute_not_exists(currentPeriodEnd)"
        : "currentPeriodEnd = :expectedEnd"
      : "attribute_not_exists(PK)";
    const subValues: Record<string, unknown> = {
      ":type": "subscription",
      ":active": "active",
      ":end": i.newPeriodEnd,
      ":tx": i.txHash,
      ":now": i.nowSec,
      ":id": i.accountId,
    };
    if (i.expected.exists && i.expected.currentPeriodEnd !== null) subValues[":expectedEnd"] = i.expected.currentPeriodEnd;

    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.table,
                Key: keys.payment(i.paymentId),
                UpdateExpression: "SET #st = :paid, txHash = :tx, paidAt = :now",
                ConditionExpression: "#st = :pending",
                ExpressionAttributeNames: { "#st": "status" },
                ExpressionAttributeValues: { ":paid": "paid", ":pending": "pending", ":tx": i.txHash, ":now": i.nowSec },
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { ...keys.tx(i.txHash), type: "tx", paymentId: i.paymentId, accountId: i.accountId, createdAt: i.nowSec },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Update: {
                TableName: this.table,
                Key: keys.subscription(i.accountId),
                UpdateExpression:
                  "SET #type = :type, accountId = :id, #st = :active, currentPeriodEnd = :end, lastPaymentTx = :tx, updatedAt = :now",
                ConditionExpression: subCondition,
                ExpressionAttributeNames: { "#st": "status", "#type": "type" },
                ExpressionAttributeValues: subValues,
              },
            },
          ],
        }),
      );
      return { ok: true };
    } catch (e) {
      const codes = cancellationCodes(e);
      if (!codes) throw e;
      if (codes[0] === "ConditionalCheckFailed") return { ok: false, reason: "not_pending" };
      if (codes[1] === "ConditionalCheckFailed") return { ok: false, reason: "tx_used" };
      if (codes[2] === "ConditionalCheckFailed" || codes.includes("TransactionConflict")) return { ok: false, reason: "conflict" };
      throw e;
    }
  }

  // ------------------------------------------------------------------ registry
  async replaceRegistryToken(rec: RegistryTokenRecord) {
    for (let attempt = 1; ; attempt++) {
      const cur = await this.db.send(new GetCommand({ TableName: this.table, Key: keys.currentToken(rec.accountId), ConsistentRead: true }));
      const prevHash: string | undefined = cur.Item?.tokenHash;
      const items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]> = [
        {
          Put: {
            TableName: this.table,
            Item: { ...keys.token(rec.tokenHash), type: "registryToken", ...rec, ttl: rec.expiresAt + TOKEN_TTL_GRACE_SECONDS },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        {
          Put: {
            TableName: this.table,
            Item: { ...keys.currentToken(rec.accountId), type: "registryTokenPointer", tokenHash: rec.tokenHash, updatedAt: rec.createdAt },
            ConditionExpression: prevHash ? "tokenHash = :prev" : "attribute_not_exists(PK)",
            ...(prevHash ? { ExpressionAttributeValues: { ":prev": prevHash } } : {}),
          },
        },
      ];
      if (prevHash) {
        items.push({
          Update: {
            TableName: this.table,
            Key: keys.token(prevHash),
            UpdateExpression: "SET revoked = :t",
            ConditionExpression: "attribute_exists(PK)",
            ExpressionAttributeValues: { ":t": true },
          },
        });
      }
      try {
        await this.db.send(new TransactWriteCommand({ TransactItems: items }));
        return;
      } catch (e) {
        const codes = cancellationCodes(e);
        if (!codes) throw e;
        // The old token item already expired out of the table: nothing to revoke, write without it.
        if (codes[2] === "ConditionalCheckFailed" && codes[1] !== "ConditionalCheckFailed") {
          items.pop();
          await this.db.send(new TransactWriteCommand({ TransactItems: items }));
          return;
        }
        // Someone else replaced the pointer concurrently: re-read and retry.
        if (attempt >= MAX_ATTEMPTS) throw e;
      }
    }
  }

  async getRegistryToken(tokenHash: string): Promise<RegistryTokenRecord | null> {
    const r = await this.db.send(new GetCommand({ TableName: this.table, Key: keys.token(tokenHash), ConsistentRead: true }));
    const t = r.Item;
    if (!t || !t.accountId) return null;
    return { tokenHash, accountId: t.accountId, expiresAt: t.expiresAt, revoked: !!t.revoked, createdAt: t.createdAt };
  }

  // ------------------------------------------------------------------ catalog
  async listReports(): Promise<ReportRecord[]> {
    const out: ReportRecord[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const r = await this.db.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
          ExpressionAttributeValues: { ":pk": "CATALOG", ":sk": "REPORT#" },
          ExclusiveStartKey: start,
        }),
      );
      for (const i of r.Items ?? []) {
        out.push({ slug: i.slug, title: i.title, summary: i.summary ?? "", publishedAt: i.publishedAt, isFree: !!i.isFree, pdfFile: i.pdfFile ?? null });
      }
      start = r.LastEvaluatedKey;
    } while (start);
    return out.sort((a, b) => (a.publishedAt === b.publishedAt ? a.slug.localeCompare(b.slug) : b.publishedAt.localeCompare(a.publishedAt)));
  }

  async putReport(r: ReportRecord) {
    await this.db.send(new PutCommand({ TableName: this.table, Item: { ...keys.report(r.slug), type: "report", ...r } }));
  }
}

/** CreateTable input for local testing (DynamoDB Local) and as the reference for the operator's IaC. */
export const tableDefinition = (TableName: string) => ({
  TableName,
  BillingMode: "PAY_PER_REQUEST" as const,
  AttributeDefinitions: [
    { AttributeName: "PK", AttributeType: "S" as const },
    { AttributeName: "SK", AttributeType: "S" as const },
  ],
  KeySchema: [
    { AttributeName: "PK", KeyType: "HASH" as const },
    { AttributeName: "SK", KeyType: "RANGE" as const },
  ],
});
