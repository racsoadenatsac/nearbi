// Local dev server: static ./public + the app, with in-memory storage and content. No AWS.
//   SESSION_SECRET=... ADMIN_TOKEN=... npm run dev     (see README "Local development")
// Sign-in still calls the real NEAR RPC (NEAR_RPC_URL) to check the access key.
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { MemoryContentStore } from "./adapters/memory-content";
import { MemoryRepository } from "./adapters/memory-repository";
import { createApp } from "./app";
import { SEED_REPORTS } from "./catalog";
import { loadConfig } from "./config";

const port = Number(process.env.PORT || 8787);
const origin = `http://localhost:${port}`;
const config = loadConfig({ APP_ORIGIN: origin, ...process.env });
const repo = new MemoryRepository({ reports: SEED_REPORTS });
const content = new MemoryContentStore(`${origin}/__dev/content`);
content.put("reports/dev-premium-sample/index.html", '<h1>Premium sample (dev)</h1><img src="charts/x.svg">', "text/html; charset=utf-8");
content.put("reports/dev-premium-sample/charts/x.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="40"><text y="25">gated chart</text></svg>');
void repo.putReport({ slug: "dev-premium-sample", title: "Dev premium sample", summary: "Gated test content", publishedAt: "2026-11-01", isFree: false, pdfFile: null });

const server = new Hono();
server.get("/__dev/content/*", async (c) => {
  const url = new URL(c.req.url);
  if (Number(url.searchParams.get("expires")) < Date.now() / 1000) return c.text("expired", 403);
  const key = decodeURIComponent(url.pathname.slice("/__dev/content/".length));
  const o = content.objects.get(key);
  if (!o) return c.text("not found", 404);
  return c.body(typeof o.body === "string" ? o.body : new Uint8Array(o.body), 200, {
    "content-type": url.searchParams.get("response-content-type") ?? o.contentType ?? "application/octet-stream",
  });
});
server.use("*", serveStatic({ root: "./public" }));
server.route("/", createApp({ config, repo, content }));

serve({ fetch: server.fetch, port, hostname: "0.0.0.0" }, () => console.log(`nearbi dev server on ${origin}`));
