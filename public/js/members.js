// Members page: start a checkout and show where to pay.
import { api, $ } from "./api.js";
import { esc } from "./util.js";

const btn = $("#subscribe");
const out = $("#checkout");

async function checkout() {
  btn.disabled = true;
  out.textContent = "Requesting a deposit address…";
  try {
    const co = await api("/billing/checkout", { method: "POST", body: {} });
    out.innerHTML = co.stub
      ? `<div class="stub-warning"><b>Test mode.</b> Payments are not live yet: this is a placeholder, not a real deposit address. Do not send funds.<br><code>${esc(co.depositAddress)}</code></div>`
      : `<p>Send <b>$${esc(co.amountUsd)}</b> worth of the selected token to:</p><pre class="code">${esc(co.depositAddress)}</pre>
         <p class="muted small">Quote valid until ${esc(co.deadline)}. Payment id <code>${esc(co.paymentId)}</code>. Access starts when the payment is confirmed.</p>`;
  } catch (e) {
    out.textContent = `Checkout failed: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

btn?.addEventListener("click", checkout);
if (new URLSearchParams(location.search).get("subscribe") === "1") btn?.scrollIntoView({ block: "center" });
