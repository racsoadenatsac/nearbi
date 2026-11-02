// AWS Lambda entry (Node 22). Works behind an API Gateway HTTP API (payload v2) or a Lambda Function URL.
// Build: `npm run build` -> dist/lambda/index.mjs, handler `index.handler`.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handle } from "hono/aws-lambda";
import { DynamoRepository } from "./adapters/dynamo-repository";
import { S3ContentStore } from "./adapters/s3-content";
import { createApp } from "./app";
import { loadConfig } from "./config";

// Created once per execution environment (cold start). Region and credentials come from the Lambda role.
const config = loadConfig(process.env, { requireAws: true });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({});

export const app = createApp({
  config,
  repo: new DynamoRepository(ddb, config.tableName),
  content: new S3ContentStore(s3, config.contentBucket, config.contentPrefix),
});

export const handler = handle(app);
