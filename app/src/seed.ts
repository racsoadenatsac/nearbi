// Seed the report catalog into DynamoDB. Operator-run only (needs AWS credentials); never run by tests.
//   TABLE_NAME=nearbi npm run seed
//   PRUNE=1 also deletes catalog entries that are no longer in src/catalog.ts.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoRepository } from "./adapters/dynamo-repository";
import { SEED_REPORTS } from "./catalog";

const table = process.env.TABLE_NAME;
if (!table) throw new Error("TABLE_NAME is required");
const repo = new DynamoRepository(
  DynamoDBDocumentClient.from(new DynamoDBClient({ endpoint: process.env.DYNAMODB_ENDPOINT || undefined })),
  table,
);
for (const r of SEED_REPORTS) {
  await repo.putReport(r);
  console.log(`seeded ${r.slug}`);
}
if (process.env.PRUNE === "1") {
  const keep = new Set(SEED_REPORTS.map((r) => r.slug));
  for (const r of await repo.listReports()) {
    if (keep.has(r.slug)) continue;
    await repo.deleteReport(r.slug);
    console.log(`pruned ${r.slug}`);
  }
}
