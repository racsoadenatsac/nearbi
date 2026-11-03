// Checkout: pick a token from the live 1Click list, get an EXACT_OUTPUT quote for the product's price
// (subscription, Quick Answer or Deep Dive; the server sets the price), show where/what to pay
// (address, amount, QR, countdown) and poll the payment status. One-off products also send the brief.
import { api, $ } from "./api.js";
import { esc } from "./util.js";

const form = $("#checkout-form");
const mode = form?.dataset.mode ?? "dry";
const product = form?.dataset.product ?? "subscription";
const oneOff = product !== "subscription";
const select = $("#token");
const filter = $("#token-filter");
const btn = $("#quote");
const status = $("#status");
const out = $("#quote-out");
let tokens = [];
let pollTimer = null;
let countdownTimer = null;

const TERMINAL = new Set(["paid", "refunded", "failed", "expired"]);
const chain = (b) => ({ near: "NEAR", eth: "Ethereum", base: "Base", arb: "Arbitrum", sol: "Solana", btc: "Bitcoin", op: "Optimism", pol: "Polygon", bsc: "BNB Chain", avax: "Avalanche", tron: "Tron", ton: "TON", sui: "Sui" })[b] ?? b;

function renderOptions() {
  const q = filter.value.trim().toLowerCase();
  const shown = tokens.filter((t) => !q || `${t.symbol} ${t.blockchain} ${chain(t.blockchain)}`.toLowerCase().includes(q));
  const prev = select.value;
  select.innerHTML = shown
    .map((t) => `<option value="${esc(t.assetId)}">${t.popular ? "★ " : ""}${esc(t.symbol)} on ${esc(chain(t.blockchain))}</option>`)
    .join("");
  if (shown.some((t) => t.assetId === prev)) select.value = prev;
  else if (shown.length) select.selectedIndex = 0;
  btn.disabled = !select.value;
}

async function loadTokens() {
  try {
    const r = await api(`/billing/tokens?product=${encodeURIComponent(product)}`);
    tokens = r.tokens;
    renderOptions();
    status.textContent = `${tokens.length} tokens available through NEAR Intents.`;
  } catch (e) {
    select.innerHTML = "<option disabled>Token list unavailable</option>";
    status.textContent = `Could not load tokens: ${e.message}`;
  }
}

function countdown(deadline) {
  clearInterval(countdownTimer);
  const el = $("#countdown");
  if (!el || !deadline) return;
  const tick = () => {
    const s = Math.max(0, Math.floor((Date.parse(deadline) - Date.now()) / 1000));
    el.textContent = s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "expired";
    if (!s) clearInterval(countdownTimer);
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

function render(v) {
  const sym = v.origin ? v.origin.symbol : "";
  const where = v.origin ? ` on ${chain(v.origin.blockchain)}` : "";
  const preview = v.mode === "dry";
  out.hidden = false;
  out.innerHTML = `
    ${preview ? `<div class="stub-warning"><b>Preview: payments not enabled yet.</b> This is a real NEAR Intents price (DRY quote). There is no deposit address: do not send funds.</div>` : ""}
    <dl class="quote-grid">
      <dt>${preview ? "You would send" : "Send exactly"}</dt><dd><b>${esc(v.amountInFormatted)} ${esc(sym)}</b>${esc(where)}</dd>
      <dt>Minimum accepted</dt><dd>${esc(v.minAmountInFormatted ?? "-")} ${esc(sym)} <span class="muted small">(the quote includes a small slippage buffer; any excess is refunded)</span></dd>
      <dt>We receive</dt><dd>${esc(v.settlement.amountOutFormatted ?? "-")} ($${esc(v.amountUsd)})</dd>
      <dt>Deposit address</dt><dd>${v.depositAddress ? `<code id="dep">${esc(v.depositAddress)}</code> <button class="btn" id="copy">Copy</button>` : `<span class="muted">none (preview)</span>`}</dd>
      ${v.depositMemo ? `<dt>Memo (required)</dt><dd><code>${esc(v.depositMemo)}</code></dd>` : ""}
      <dt>${preview ? "Quote valid for" : "Time left"}</dt><dd><span class="countdown" id="countdown"></span></dd>
      <dt>Status</dt><dd id="pay-status">${esc(v.statusLabel)}${v.stale ? ' <span class="muted small">(could not reach NEAR Intents, retrying)</span>' : ""}</dd>
      <dt>Quote id</dt><dd class="small muted"><code>${esc(v.quoteId ?? "")}</code> · payment <code>${esc(v.paymentId)}</code></dd>
    </dl>
    ${v.qrSvg ? `<div class="qr" aria-label="QR code of the deposit address">${v.qrSvg}</div>` : ""}
    ${!preview && !TERMINAL.has(v.status) ? `<p class="muted small">You can close this page: the payment is also checked in the background every minute, and ${oneOff ? "your order is queued" : "your subscription starts"} once NEAR Intents reports it complete.</p>` : ""}
    ${v.status === "paid" ? `<p><a class="btn pri" href="/members">${oneOff ? "See your orders" : "Go to your reports"}</a></p>` : ""}`;
  $("#copy")?.addEventListener("click", () => navigator.clipboard?.writeText(v.depositAddress));
  countdown(TERMINAL.has(v.status) ? null : v.deadline);
}

async function poll(id) {
  clearTimeout(pollTimer);
  try {
    const v = await api(`/billing/status/${encodeURIComponent(id)}`);
    render(v);
    if (!TERMINAL.has(v.status) && v.mode === "live") pollTimer = setTimeout(() => poll(id), 10000);
  } catch (e) {
    status.textContent = `Status check failed: ${e.message}`;
    pollTimer = setTimeout(() => poll(id), 20000);
  }
}

async function quote() {
  btn.disabled = true;
  status.textContent = "Requesting a quote from NEAR Intents…";
  clearTimeout(pollTimer);
  try {
    const refundTo = $("#refund-to").value.trim();
    const body = { product, originAsset: select.value, ...(refundTo ? { refundTo } : {}) };
    if (oneOff) {
      const question = $("#brief-question").value.trim();
      if (!question) {
        status.textContent = "Please write your question first.";
        $("#brief-question").focus();
        return;
      }
      body.brief = { question, contact: $("#brief-contact")?.value.trim() ?? "", ...($("#brief-scope") ? { scope: $("#brief-scope").value.trim() } : {}) };
    }
    const v = await api("/billing/checkout", { method: "POST", body });
    status.textContent = "";
    render(v);
    if (v.mode === "live") pollTimer = setTimeout(() => poll(v.paymentId), 10000);
  } catch (e) {
    status.textContent = `Quote failed: ${e.message}`;
  } finally {
    btn.disabled = !select.value;
  }
}

if (form) {
  filter.addEventListener("input", renderOptions);
  select.addEventListener("change", () => (btn.disabled = !select.value));
  btn.addEventListener("click", quote);
  if (mode === "dry") btn.textContent = "Get preview quote";
  loadTokens();
}
