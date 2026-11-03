// In-memory ContentStore for tests and local dev. presignGet returns a URL under `baseUrl` that carries
// the key and an expiry; the dev server serves it (see src/dev.ts). Not a security boundary.
import type { ContentStore, PresignOptions } from "../ports/content";

export interface MemoryObject {
  body: string | Uint8Array;
  contentType?: string;
}

export class MemoryContentStore implements ContentStore {
  readonly objects = new Map<string, MemoryObject>();
  constructor(
    private readonly baseUrl = "memory://content",
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  put(key: string, body: string | Uint8Array, contentType?: string) {
    this.objects.set(key, { body, contentType });
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
  async getText(key: string) {
    const o = this.objects.get(key);
    if (!o) return null;
    const body = typeof o.body === "string" ? o.body : new TextDecoder().decode(o.body);
    return { body, contentType: o.contentType, etag: `"mem-${key.length}-${body.length}"` };
  }
  async presignGet(key: string, opts: PresignOptions) {
    const q = new URLSearchParams({ expires: String(this.now() + opts.expiresInSeconds) });
    if (opts.contentType) q.set("response-content-type", opts.contentType);
    if (opts.contentDisposition) q.set("response-content-disposition", opts.contentDisposition);
    return `${this.baseUrl}/${key.split("/").map(encodeURIComponent).join("/")}?${q}`;
  }
}
