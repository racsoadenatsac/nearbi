// Private report content (HTML, charts, PDFs). Implementations: MemoryContentStore (tests/dev), S3ContentStore.

export interface PresignOptions {
  expiresInSeconds: number;
  contentType?: string;
  contentDisposition?: string;
}

export interface ContentStore {
  exists(key: string): Promise<boolean>;
  /** Small text objects (report HTML) are proxied through the app so relative links keep working. */
  getText(key: string): Promise<{ body: string; contentType?: string; etag?: string } | null>;
  /** Short-lived GET URL for binary objects (charts, PDFs). Does not check existence. */
  presignGet(key: string, opts: PresignOptions): Promise<string>;
}
