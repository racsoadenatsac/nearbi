// AWS Lambda entry (Node 22). Works behind an API Gateway HTTP API (payload v2) or a Lambda Function URL,
// and as the target of the EventBridge Scheduler payment sweep (see src/scheduled.ts).
// Build: `npm run build` -> dist/lambda/index.mjs, handler `index.handler`.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handle } from "hono/aws-lambda";
import { DynamoRepository } from "./adapters/dynamo-repository";
import { S3ContentStore } from "./adapters/s3-content";
import { createApp, createIntentsAdapter } from "./app";
import { loadConfig } from "./config";
import { isScheduledTask, runScheduledTask } from "./scheduled";

// Created once per execution environment (cold start). Region and credentials come from the Lambda role.
const config = loadConfig(process.env, { requireAws: true });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({});
const repo = new DynamoRepository(ddb, config.tableName);
const intents = createIntentsAdapter(config);

export const app = createApp({
  config,
  repo,
  intents,
  content: new S3ContentStore(s3, config.contentBucket, config.contentPrefix),
});

const http = handle(app);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handler = async (event: any, context: any) => {
  if (isScheduledTask(event)) return runScheduledTask(event, { repo, intents, config: config.intents });
  return http(event, context);
};
