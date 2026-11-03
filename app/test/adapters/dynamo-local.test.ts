// Runs the Repository contract against DynamoDB Local when DYNAMODB_ENDPOINT is set
// (bin/test-dynamo-local.sh starts amazon/dynamodb-local in Docker). Skipped otherwise: no network by default.
import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, it } from "vitest";
import { DynamoRepository, tableDefinition } from "../../src/adapters/dynamo-repository";
import { repositoryContract } from "../helpers/repo-contract";

const endpoint = process.env.DYNAMODB_ENDPOINT;

if (endpoint) {
  const client = new DynamoDBClient({ endpoint, region: "local", credentials: { accessKeyId: "local", secretAccessKey: "local" } });
  const doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  let n = 0;
  repositoryContract(`DynamoRepository @ ${endpoint}`, async () => {
    const table = `nearbi-test-${process.pid}-${Date.now()}-${n++}`;
    await client.send(new CreateTableCommand(tableDefinition(table)));
    return new DynamoRepository(doc, table);
  });
} else {
  describe.skip("Repository contract: DynamoRepository (set DYNAMODB_ENDPOINT; see bin/test-dynamo-local.sh)", () => {
    it("skipped", () => {});
  });
}
