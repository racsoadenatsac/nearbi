// Seed the report catalog into DynamoDB. Operator-run only (needs AWS credentials); never run by tests.
//   TABLE_NAME=nearbi npm run seed
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
