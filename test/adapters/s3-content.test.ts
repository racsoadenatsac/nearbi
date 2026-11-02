// Presigning is pure local crypto (SigV4): fake static credentials, no request is sent.
import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { S3ContentStore } from "../../src/adapters/s3-content";

const s3 = new S3Client({ region: "us-east-1", credentials: { accessKeyId: "test-access-key-id", secretAccessKey: "not-a-real-secret" } });

describe("S3ContentStore.presignGet (offline)", () => {
  it("produces a short-lived SigV4 GET URL with response overrides", async () => {
    const store = new S3ContentStore(s3, "nearbi-content");
    const url = new URL(
      await store.presignGet("reports/x-1/report.pdf", { expiresInSeconds: 300, contentType: "application/pdf", contentDisposition: 'inline; filename="report.pdf"' }),
    );
    expect(url.hostname).toBe("nearbi-content.s3.us-east-1.amazonaws.com");
    expect(url.pathname).toBe("/reports/x-1/report.pdf");
    const q = url.searchParams;
    expect(q.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(q.get("X-Amz-Expires")).toBe("300");
    expect(q.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(q.get("response-content-type")).toBe("application/pdf");
    expect(q.get("response-content-disposition")).toBe('inline; filename="report.pdf"');
    expect(q.get("response-cache-control")).toBe("private, no-store");
  });

  it("applies the key prefix", async () => {
    const url = new URL(await new S3ContentStore(s3, "nearbi-content", "prod/").presignGet("reports/a/b.png", { expiresInSeconds: 60 }));
    expect(url.pathname).toBe("/prod/reports/a/b.png");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
  });
});

describe("S3ContentStore reads (fake client)", () => {
  const fake = (reply: (name: string) => unknown) =>
    ({
      send: async (cmd: { constructor: { name: string } }) => {
        const r = reply(cmd.constructor.name);
        if (r instanceof Error) throw r;
        return r;
      },
      config: {},
    }) as unknown as S3Client;
  const notFound = (name: string) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });

  it("exists maps 404 to false and rethrows other errors", async () => {
    expect(await new S3ContentStore(fake(() => ({})), "b").exists("k")).toBe(true);
    expect(await new S3ContentStore(fake(() => notFound("NotFound")), "b").exists("k")).toBe(false);
    await expect(new S3ContentStore(fake(() => Object.assign(new Error("denied"), { name: "AccessDenied" })), "b").exists("k")).rejects.toThrow("denied");
  });

  it("getText returns body and metadata, null on NoSuchKey", async () => {
    const ok = fake(() => ({ Body: { transformToString: async () => "<h1>x</h1>" }, ContentType: "text/html", ETag: '"e"' }));
    expect(await new S3ContentStore(ok, "b").getText("k")).toEqual({ body: "<h1>x</h1>", contentType: "text/html", etag: '"e"' });
    expect(await new S3ContentStore(fake(() => notFound("NoSuchKey")), "b").getText("k")).toBeNull();
  });
});
