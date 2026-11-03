// Container access: mint a registry pull token (shown once).
import { api, $ } from "./api.js";

const btn = $("#mint");
const out = $("#token-out");

btn?.addEventListener("click", async () => {
  if (out.textContent && !confirm("Generating a new token revokes the previous one. Continue?")) return;
  btn.disabled = true;
  try {
    const t = await api("/registry/token", { method: "POST", body: {} });
    out.hidden = false;
    out.textContent = [`# expires ${t.expiresAt}; shown once, store it now`, ...t.instructions].join("\n");
  } catch (e) {
    out.hidden = false;
    out.textContent = `Could not generate a token: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
});
