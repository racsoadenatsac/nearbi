// Offline smoke test of the built bundle (dist/lambda/index.mjs) with synthetic HTTP API v2 events.
// Only exercises routes that touch no storage. Run with networking disabled:
//   docker run --rm --network none -v "$PWD":/app -w /app -e SESSION_SECRET=... -e ADMIN_TOKEN=x \
//     -e TABLE_NAME=t -e CONTENT_BUCKET=b -e AWS_REGION=us-east-1 node:22-slim node scripts/smoke-lambda.mjs
const { handler } = await import(new URL("../dist/lambda/index.mjs", import.meta.url));
const ev = (path) => ({
  version: "2.0",
  routeKey: "$default",
  rawPath: path,
  rawQueryString: "",
  headers: { host: "x.execute-api.us-east-1.amazonaws.com" },
  requestContext: { domainName: "x.execute-api.us-east-1.amazonaws.com", http: { method: "GET", path, protocol: "HTTP/1.1", sourceIp: "203.0.113.1", userAgent: "smoke" }, stage: "$default" },
  isBase64Encoded: false,
});
const expect = { "/api/me": 200, "/login": 200, "/members": 302, "/reports/some-premium-report/": 302 };
let failed = 0;
for (const [path, status] of Object.entries(expect)) {
  const r = await handler(ev(path), {});
  const ok = r.statusCode === status;
  failed += ok ? 0 : 1;
  console.log(`${ok ? "ok  " : "FAIL"} GET ${path} -> ${r.statusCode}${r.headers?.location ? ` (${r.headers.location})` : ""}`);
}
process.exit(failed ? 1 : 0);
