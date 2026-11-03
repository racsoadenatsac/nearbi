// S3 ContentStore. The bucket is private (Block Public Access on); binary objects are handed out as
// short-lived presigned GET URLs, small HTML documents are read and proxied by the app.
import { GetObjectCommand, HeadObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ContentStore, PresignOptions } from "../ports/content";

const isNotFound = (e: unknown) => {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return err?.name === "NotFound" || err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404;
};

export class S3ContentStore implements ContentStore {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
    private readonly prefix = "",
  ) {}

  private key(k: string) {
    return this.prefix + k;
  }

  async exists(key: string) {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }

  async getText(key: string) {
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
      if (!r.Body) return null;
      return { body: await r.Body.transformToString("utf-8"), contentType: r.ContentType, etag: r.ETag };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async presignGet(key: string, opts: PresignOptions) {
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.key(key),
      ResponseContentType: opts.contentType,
      ResponseContentDisposition: opts.contentDisposition,
      ResponseCacheControl: "private, no-store",
    });
    return getSignedUrl(this.s3, cmd, { expiresIn: opts.expiresInSeconds });
  }
}
