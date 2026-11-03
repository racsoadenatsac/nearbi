// Server-rendered HTML for the dynamic pages. Reuses /assets/site.css from the static site.

import type { SubscriptionState } from "./core/subscription";
import type { ReportRecord } from "./ports/repository";

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const fmtDate = (sec: number | null) => (sec ? new Date(sec * 1000).toISOString().slice(0, 10) : "-");

function layout(title: string, body: string, opts: { accountId?: string | null; scripts?: string } = {}): string {
  const right = opts.accountId
    ? `<a href="/members">${esc(opts.accountId)}</a><a href="#" id="logout">Sign out</a>`
    : `<a href="/login">Sign in</a>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · NearBI</title>
<meta name="robots" content="noindex">
<link rel="stylesheet" href="/assets/site.css">
<link rel="stylesheet" href="/assets/app.css">
</head><body>
<header class="nav"><a class="brand" href="/">NearBI</a><a href="/#reports">Reports</a><a href="/ledger/">Ledger</a><a href="/members">Members</a>${right}</header>
<main class="page"><div class="wrap">
${body}
</div></main>
<footer class="foot">© 2026 NearBI · An autonomous research agent built at NEAR HACKATHON · #NEARHackathon</footer>
<script type="module" src="/js/app.js"></script>
${opts.scripts ?? ""}
</body></html>`;
}

export function loginPage(next: string): string {
  return layout(
    "Sign in",
    `<div class="panel narrow">
  <h1>Sign in with NEAR</h1>
  <p class="sub">No password. Your wallet signs a one-time message (NEP-413); nothing is sent onchain and it costs nothing.</p>
  <div id="wallets"><p class="muted">Loading wallets…</p></div>
  <p id="status" class="muted" role="status"></p>
  <input type="hidden" id="next" value="${esc(next)}">
</div>`,
    { scripts: `<script type="module" src="/js/login.js"></script>` },
  );
}

export function membersPage(p: {
  accountId: string;
  sub: SubscriptionState;
  priceUsd: number;
  reports: ReportRecord[];
}): string {
  const { sub } = p;
  const statusLine = sub.active
    ? `<span class="pill ok">Active</span> until ${fmtDate(sub.currentPeriodEnd)}${sub.status === "canceled" ? " (canceled, not renewing)" : ""}`
    : sub.status === "expired"
      ? `<span class="pill warn">Expired</span> on ${fmtDate(sub.currentPeriodEnd)}`
      : `<span class="pill">No subscription</span>`;
  const subscribeLabel = sub.active ? `Add another month ($${p.priceUsd})` : `Subscribe: $${p.priceUsd}/month`;
  const rows = p.reports
    .map((r) => {
      const locked = !r.isFree && !sub.active;
      const pdf = r.pdfFile ? ` · <a href="/reports/${esc(r.slug)}/${esc(r.pdfFile)}">PDF</a>` : "";
      return `<li class="card"><h3>${locked ? "🔒 " : ""}<a href="/reports/${esc(r.slug)}/">${esc(r.title)}</a>${r.isFree ? ' <span class="pill">Free</span>' : ""}</h3>
<p>${esc(r.summary)}</p><p class="muted">${esc(r.publishedAt)}${locked ? "" : pdf}</p></li>`;
    })
    .join("\n");
  return layout(
    "Members",
    `<h1>Members</h1>
<div class="panel">
  <p>Signed in as <b>${esc(p.accountId)}</b></p>
  <p>Subscription: ${statusLine}</p>
  <button class="btn pri" id="subscribe">${esc(subscribeLabel)}</button>
  ${sub.active ? `<a class="btn" href="/members/container">Container access</a>` : ""}
  <div id="checkout" class="muted"></div>
  <p class="muted small">Pay in any token through NEAR Intents; it settles as USDC on NEAR. Access starts when the payment is confirmed.</p>
</div>
<h2 class="sec">Reports</h2>
<ul class="reports">${rows || "<li>No reports yet.</li>"}</ul>`,
    { accountId: p.accountId, scripts: `<script type="module" src="/js/members.js"></script>` },
  );
}

export function containerPage(p: { accountId: string; sub: SubscriptionState; registryHost: string }): string {
  return layout(
    "Container access",
    `<h1>Container access</h1>
<div class="panel">
  <p>Every report ships a Docker + Jupyter reproduction pack in our private registry <code>${esc(p.registryHost)}</code>.
  Generate a pull token below. It is shown once, expires with your subscription (${fmtDate(p.sub.currentPeriodEnd)}),
  and generating a new one revokes the previous one.</p>
  <button class="btn pri" id="mint">Generate registry token</button>
  <pre id="token-out" class="code" hidden></pre>
</div>`,
    { accountId: p.accountId, scripts: `<script type="module" src="/js/container.js"></script>` },
  );
}

export function messagePage(title: string, message: string, accountId?: string | null, status = 200): [string, number] {
  return [layout(title, `<div class="panel narrow"><h1>${esc(title)}</h1><p>${message}</p></div>`, { accountId }), status];
}
