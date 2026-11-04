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
//   OPENPAY             PAY#<paymentId> live payment the scheduled sweep still watches (removed when settled)
//   FWDQ                PAY#<paymentId> forward queue: 1Click SUCCESS, waiting for the forwarding agent
//   ACCT#<accountId>    ORDER#<paymentId> one-off order (Quick Answer / Deep Dive), created when its payment is paid
//   ORDERQ              ORDER#<paymentId> order awaiting delivery (status paid / in_progress; removed when delivered)
//   DELIV#<slug>        ORDER           report slug -> the order whose deliverable it is (buyer-only /reports/<slug>/)
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
import {
  PAYABLE_STATUSES,
  type AccountRecord,
  type ApplyOrderPaymentInput,
  type ApplyOrderPaymentResult,
  type ApplyPaymentInput,
  type OrderRecord,
  type OrderUpdate,
  type ApplyPaymentResult,
  type PaymentRecord,
  type PaymentStatus,
  type PaymentStatusPatch,
  type ForwardQueueEntry,
  type OpenPaymentRef,
  type RegistryTokenRecord,
  DeliverableSlugTaken,
  type ReportRecord,
  type Repository,
  type StoredChallenge,
  type SubscriptionRecord,
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
  openPayment: (id: string) => ({ PK: "OPENPAY", SK: `PAY#${id}` }),
  forwardQueue: (id: string) => ({ PK: "FWDQ", SK: `PAY#${id}` }),
  order: (accountId: string, id: string) => ({ PK: `ACCT#${accountId}`, SK: `ORDER#${id}` }),
  openOrder: (id: string) => ({ PK: "ORDERQ", SK: `ORDER#${id}` }),
  deliverable: (slug: string) => ({ PK: `DELIV#${slug}`, SK: "ORDER" }),
};

function orderFromItem(i: Record<string, any>): OrderRecord {
  return {
    paymentId: i.paymentId,
    accountId: i.accountId,
    product: i.product,
    brief: { question: i.brief?.question ?? "", contact: i.brief?.contact ?? null, scope: i.brief?.scope ?? null },
    amountUsd: i.amountUsd,
    status: i.status,
    deliveryUrl: i.deliveryUrl ?? null,
    deliverable: i.deliverable
      ? {
          slug: i.deliverable.slug,
          title: i.deliverable.title,
          summary: i.deliverable.summary ?? "",
          contentPrefix: i.deliverable.contentPrefix ?? `reports/${i.deliverable.slug}/`,
          pdfFile: i.deliverable.pdfFile ?? null,
        }
      : null,
    shared: i.shared === true,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

function reportFromItem(i: Record<string, any>): ReportRecord {
  return { slug: i.slug, title: i.title, summary: i.summary ?? "", publishedAt: i.publishedAt, isFree: !!i.isFree, pdfFile: i.pdfFile ?? null };
}

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
    const put = { TableName: this.table, Item: { ...keys.payment(p.id), type: "payment", ...p }, ConditionExpression: "attribute_not_exists(PK)" };
    if (!(p.mode === "live" && p.depositAddress)) {
      await this.db.send(new PutCommand(put));
      return;
    }
    // Live: the payment and its sweep index entry are written together, so no live payment is ever unwatched.
    await this.db.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: put },
          {
            Put: {
              TableName: this.table,
              Item: { ...keys.openPayment(p.id), type: "openpay", paymentId: p.id, createdAt: p.createdAt, deadline: p.deadline },
            },
          },
        ],
      }),
    );
  }

  async listOpenPayments(limit: number): Promise<OpenPaymentRef[]> {
    const r = await this.db.send(
      new QueryCommand({ TableName: this.table, KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": "OPENPAY" }, Limit: limit }),
    );
    return (r.Items ?? []).map((i) => ({ paymentId: i.paymentId, createdAt: i.createdAt, deadline: i.deadline ?? null }));
  }

  async closeOpenPayment(id: string) {
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: keys.openPayment(id) }));
  }

  async enqueueForward(e: ForwardQueueEntry) {
    try {
      await this.db.send(
        new PutCommand({
          TableName: this.table,
          Item: { ...keys.forwardQueue(e.paymentId), type: "fwdq", ...e },
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
    } catch (err) {
      if ((err as { name?: string }).name !== "ConditionalCheckFailedException") throw err; // already queued
    }
  }

  async listForwardQueue(limit: number): Promise<ForwardQueueEntry[]> {
    const r = await this.db.send(
      new QueryCommand({ TableName: this.table, KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": "FWDQ" }, Limit: limit, ConsistentRead: true }),
    );
    const n = <T>(v: T | undefined): T | null => (v === undefined ? null : v);
    return (r.Items ?? []).map((i) => ({
      paymentId: i.paymentId,
      amount: n(i.amount),
      recipient: i.recipient,
      destinationAsset: i.destinationAsset,
      depositAddress: i.depositAddress,
      settlementTx: n(i.settlementTx),
      enqueuedAt: i.enqueuedAt,
    }));
  }

  async getPayment(id: string): Promise<PaymentRecord | null> {
    const r = await this.db.send(new GetCommand({ TableName: this.table, Key: keys.payment(id), ConsistentRead: true }));
    const p = r.Item;
    if (!p) return null;
    const n = <T>(v: T | undefined): T | null => (v === undefined ? null : v);
    return {
      id: p.id,
      accountId: p.accountId,
      amountUsd: p.amountUsd,
      token: p.token,
      depositAddress: n(p.depositAddress),
      status: p.status,
      txHash: n(p.txHash),
      createdAt: p.createdAt,
      paidAt: n(p.paidAt),
      quoteJson: p.quoteJson,
      mode: n(p.mode),
      quoteId: n(p.quoteId),
      depositMemo: n(p.depositMemo),
      destinationAsset: n(p.destinationAsset),
      recipient: n(p.recipient),
      amountIn: n(p.amountIn),
      amountInFormatted: n(p.amountInFormatted),
      minAmountIn: n(p.minAmountIn),
      amountOut: n(p.amountOut),
      deadline: n(p.deadline),
      intentsStatus: n(p.intentsStatus),
      checkedAt: n(p.checkedAt),
      settlementTx: n(p.settlementTx),
      settledAmountOut: n(p.settledAmountOut),
      forwardedTx: n(p.forwardedTx),
      product: n(p.product),
      brief: p.brief ? { question: p.brief.question, contact: p.brief.contact ?? null, scope: p.brief.scope ?? null } : null,
    };
  }

  // ------------------------------------------------------------------ orders
  async applyOrderPayment(i: ApplyOrderPaymentInput): Promise<ApplyOrderPaymentResult> {
    const o = i.order;
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.table,
                Key: keys.payment(i.paymentId),
                UpdateExpression: "SET #st = :paid, txHash = :tx, paidAt = :now",
                ConditionExpression: `#st IN (${PAYABLE_STATUSES.map((_, k) => `:open${k}`).join(", ")}) AND accountId = :acct`,
                ExpressionAttributeNames: { "#st": "status" },
                ExpressionAttributeValues: { ":paid": "paid", ":tx": i.txHash, ":now": i.nowSec, ":acct": o.accountId, ...openValues() },
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { ...keys.tx(i.txHash), type: "tx", paymentId: i.paymentId, accountId: o.accountId, createdAt: i.nowSec },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { ...keys.order(o.accountId, o.paymentId), type: "order", ...o },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { ...keys.openOrder(o.paymentId), type: "orderq", paymentId: o.paymentId, accountId: o.accountId, createdAt: o.createdAt },
              },
            },
          ],
        }),
      );
      return { ok: true };
    } catch (e) {
      const codes = cancellationCodes(e);
      if (!codes) throw e;
      if (codes[1] === "ConditionalCheckFailed" && codes[0] !== "ConditionalCheckFailed") return { ok: false, reason: "tx_used" };
      if (codes[0] === "ConditionalCheckFailed" || codes[2] === "ConditionalCheckFailed" || codes.includes("TransactionConflict")) return { ok: false, reason: "not_pending" };
      throw e;
    }
  }

  async getOrder(paymentId: string): Promise<OrderRecord | null> {
    const pay = await this.db.send(new GetCommand({ TableName: this.table, Key: keys.payment(paymentId), ConsistentRead: true }));
    const accountId: string | undefined = pay.Item?.accountId;
    if (!accountId) return null;
    const r = await this.db.send(new GetCommand({ TableName: this.table, Key: keys.order(accountId, paymentId), ConsistentRead: true }));
    return r.Item ? orderFromItem(r.Item) : null;
  }

  async listOrders(accountId: string): Promise<OrderRecord[]> {
    const out: OrderRecord[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const r = await this.db.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
          ExpressionAttributeValues: { ":pk": `ACCT#${accountId}`, ":sk": "ORDER#" },
          ConsistentRead: true,
          ExclusiveStartKey: start,
        }),
      );
      for (const i of r.Items ?? []) out.push(orderFromItem(i));
      start = r.LastEvaluatedKey;
    } while (start);
    return out.sort((a, b) => b.createdAt - a.createdAt || a.paymentId.localeCompare(b.paymentId));
  }

  async listOpenOrders(limit: number): Promise<OrderRecord[]> {
    const refs: { paymentId: string; accountId: string }[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const r = await this.db.send(
        new QueryCommand({ TableName: this.table, KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": "ORDERQ" }, ConsistentRead: true, ExclusiveStartKey: start }),
      );
      for (const i of r.Items ?? []) refs.push({ paymentId: i.paymentId, accountId: i.accountId });
      start = r.LastEvaluatedKey;
    } while (start);
    const orders: OrderRecord[] = [];
    for (const ref of refs) {
      const r = await this.db.send(new GetCommand({ TableName: this.table, Key: keys.order(ref.accountId, ref.paymentId), ConsistentRead: true }));
      if (r.Item && r.Item.status !== "delivered") orders.push(orderFromItem(r.Item));
    }
    return orders.sort((a, b) => a.createdAt - b.createdAt || a.paymentId.localeCompare(b.paymentId)).slice(0, limit);
  }

  async updateOrder(paymentId: string, u: OrderUpdate): Promise<OrderRecord | null> {
    const cur = await this.getOrder(paymentId);
    if (!cur) return null;
    const values: Record<string, unknown> = { ":st": u.status, ":now": u.nowSec };
    let set = "SET #st = :st, updatedAt = :now";
    if (u.deliveryUrl !== undefined) {
      set += ", deliveryUrl = :url";
      values[":url"] = u.deliveryUrl;
    }
    if (u.deliverable !== undefined) {
      set += ", deliverable = :dl";
      values[":dl"] = u.deliverable;
    }
    if (u.shared !== undefined) {
      set += ", #sh = :sh"; // "shared" is a DynamoDB reserved word
      values[":sh"] = u.shared;
    }
    const items: any[] = [
      {
        Update: {
          TableName: this.table,
          Key: keys.order(cur.accountId, paymentId),
          UpdateExpression: set,
          ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeNames: { "#st": "status", ...(u.shared !== undefined ? { "#sh": "shared" } : {}) },
          ExpressionAttributeValues: values,
        },
      },
      u.status === "delivered"
        ? { Delete: { TableName: this.table, Key: keys.openOrder(paymentId) } }
        : {
            Put: {
              TableName: this.table,
              Item: { ...keys.openOrder(paymentId), type: "orderq", paymentId, accountId: cur.accountId, createdAt: cur.createdAt },
            },
          },
    ];
    let indexAt = -1;
    if (u.deliverable !== undefined) {
      if (u.deliverable) {
        indexAt = items.length;
        items.push({
          Put: {
            TableName: this.table,
            Item: { ...keys.deliverable(u.deliverable.slug), type: "deliverable", slug: u.deliverable.slug, paymentId, accountId: cur.accountId },
            ConditionExpression: "attribute_not_exists(PK) OR paymentId = :pid",
            ExpressionAttributeValues: { ":pid": paymentId },
          },
        });
      }
      if (cur.deliverable && cur.deliverable.slug !== u.deliverable?.slug) {
        items.push({
          Delete: {
            TableName: this.table,
            Key: keys.deliverable(cur.deliverable.slug),
            ConditionExpression: "attribute_not_exists(PK) OR paymentId = :pid",
            ExpressionAttributeValues: { ":pid": paymentId },
          },
        });
      }
    }
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (e) {
      const codes = cancellationCodes(e);
      if (codes && indexAt >= 0 && codes[indexAt] === "ConditionalCheckFailed") throw new DeliverableSlugTaken(u.deliverable!.slug);
      throw e;
    }
    return {
      ...cur,
      status: u.status,
      updatedAt: u.nowSec,
      ...(u.deliveryUrl !== undefined ? { deliveryUrl: u.deliveryUrl } : {}),
      ...(u.deliverable !== undefined ? { deliverable: u.deliverable } : {}),
      ...(u.shared !== undefined ? { shared: u.shared } : {}),
    };
  }

  async getOrderByDeliverable(slug: string): Promise<OrderRecord | null> {
    const ix = await this.db.send(new GetCommand({ TableName: this.table, Key: keys.deliverable(slug), ConsistentRead: true }));
    if (!ix.Item?.paymentId || !ix.Item.accountId) return null;
    const r = await this.db.send(new GetCommand({ TableName: this.table, Key: keys.order(ix.Item.accountId, ix.Item.paymentId), ConsistentRead: true }));
    return r.Item ? orderFromItem(r.Item) : null;
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
                ConditionExpression: `#st IN (${PAYABLE_STATUSES.map((_, k) => `:open${k}`).join(", ")})`,
                ExpressionAttributeNames: { "#st": "status" },
                ExpressionAttributeValues: { ":paid": "paid", ":tx": i.txHash, ":now": i.nowSec, ...openValues() },
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

  async updatePaymentStatus(id: string, from: readonly PaymentStatus[], patch: PaymentStatusPatch): Promise<boolean> {
    if ((patch.status as string) === "paid") throw new Error("use applyPayment to mark a payment paid");
    if (!from.length) return false;
    const values: Record<string, unknown> = { ":st": patch.status, ":is": patch.intentsStatus, ":ck": patch.checkedAt };
    from.forEach((f, k) => (values[`:from${k}`] = f));
    let set = "SET #st = :st, intentsStatus = :is, checkedAt = :ck";
    if (patch.settlementTx !== undefined) {
      set += ", settlementTx = :stx";
      values[":stx"] = patch.settlementTx;
    }
    if (patch.settledAmountOut !== undefined) {
      set += ", settledAmountOut = :sao";
      values[":sao"] = patch.settledAmountOut;
    }
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: this.table,
          Key: keys.payment(id),
          UpdateExpression: set,
          ConditionExpression: `attribute_exists(PK) AND #st IN (${from.map((_, k) => `:from${k}`).join(", ")})`,
          ExpressionAttributeNames: { "#st": "status" },
          ExpressionAttributeValues: values,
        }),
      );
      return true;
    } catch (e) {
      if ((e as { name?: string }).name === "ConditionalCheckFailedException") return false;
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
      for (const i of r.Items ?? []) out.push(reportFromItem(i));
      start = r.LastEvaluatedKey;
    } while (start);
    return out.sort((a, b) => (a.publishedAt === b.publishedAt ? a.slug.localeCompare(b.slug) : b.publishedAt.localeCompare(a.publishedAt)));
  }

  async getReport(slug: string): Promise<ReportRecord | null> {
    const r = await this.db.send(new GetCommand({ TableName: this.table, Key: keys.report(slug) }));
    return r.Item ? reportFromItem(r.Item) : null;
  }

  async putReport(r: ReportRecord) {
    await this.db.send(new PutCommand({ TableName: this.table, Item: { ...keys.report(r.slug), type: "report", ...r } }));
  }

  async deleteReport(slug: string) {
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: keys.report(slug) }));
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

function openValues(): Record<string, string> {
  return Object.fromEntries(PAYABLE_STATUSES.map((s, k) => [`:open${k}`, s]));
}
