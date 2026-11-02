// Sign in with NEAR (NEP-413).
//   1. GET /auth/challenge -> { nonce (base64, 32 bytes), message, recipient }
//   2. The wallet signs it (wallet-selector signMessage). Redirect wallets come back to /login#accountId=...
//   3. POST /auth/verify -> session cookie, then go to ?next.
//
// Wallet-selector modules are loaded from esm.sh at runtime (no bundler in this repo).
// NOTE: this flow has not been exercised against a real wallet yet; the manual form below is the fallback
// (sign the challenge with any NEP-413 tool and paste accountId, publicKey and signature).
import { api, $, setStatus } from "./api.js";

const PENDING_KEY = "nearbi.pendingChallenge";
const next = $("#next")?.value || "/members";
const WS = "https://esm.sh/@near-wallet-selector";

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function verify(challenge, signed, callbackUrl) {
  setStatus("Verifying signature…");
  await api("/auth/verify", {
    method: "POST",
    body: {
      accountId: signed.accountId,
      publicKey: signed.publicKey,
      signature: signed.signature,
      nonce: challenge.nonce,
      message: challenge.message,
      recipient: challenge.recipient,
      callbackUrl: callbackUrl ?? null,
    },
  });
  sessionStorage.removeItem(PENDING_KEY);
  location.href = next;
}

// Redirect wallets (e.g. MyNearWallet) return with the signature in the URL hash.
async function resumeRedirect() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.get("signature")) return false;
  const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || "null");
  history.replaceState(null, "", location.pathname + location.search);
  if (!pending) {
    setStatus("Sign-in expired. Please try again.");
    return false;
  }
  try {
    await verify(pending.challenge, { accountId: h.get("accountId"), publicKey: h.get("publicKey"), signature: h.get("signature") }, pending.callbackUrl);
  } catch (e) {
    setStatus(`Sign-in failed: ${e.message}`);
  }
  return true;
}

async function signWith(selector, walletId) {
  const challenge = await api("/auth/challenge");
  const callbackUrl = location.origin + location.pathname + location.search;
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ challenge, callbackUrl }));
  setStatus("Waiting for your wallet…");
  const wallet = await selector.wallet(walletId);
  const signed = await wallet.signMessage({
    message: challenge.message,
    recipient: challenge.recipient,
    nonce: b64ToBytes(challenge.nonce),
    callbackUrl,
  });
  // Injected/popup wallets resolve here; redirect wallets navigate away and come back via resumeRedirect().
  if (signed) await verify(challenge, signed, callbackUrl);
}

async function loadWallets() {
  const box = $("#wallets");
  try {
    const [{ setupWalletSelector }, { setupMyNearWallet }, { setupMeteorWallet }] = await Promise.all([
      import(`${WS}/core@8`),
      import(`${WS}/my-near-wallet@8`),
      import(`${WS}/meteor-wallet@8`),
    ]);
    const selector = await setupWalletSelector({ network: "mainnet", modules: [setupMyNearWallet(), setupMeteorWallet()] });
    const modules = selector.store.getState().modules;
    box.innerHTML = "";
    for (const m of modules) {
      const b = document.createElement("button");
      b.className = "btn wallet-btn";
      b.textContent = m.metadata.name;
      b.addEventListener("click", () => signWith(selector, m.id).catch((e) => setStatus(`Sign-in failed: ${e.message}`)));
      box.appendChild(b);
    }
  } catch (e) {
    box.innerHTML = `<p class="muted">Could not load wallets (${e.message}). Use the manual option below.</p>`;
  }
  box.insertAdjacentHTML(
    "beforeend",
    `<details><summary class="muted">Manual sign-in (CLI / any NEP-413 signer)</summary>
     <button class="btn" id="get-challenge" type="button">Get challenge</button>
     <pre class="code" id="challenge-out" hidden></pre>
     <p><input id="m-account" placeholder="alice.near"> <input id="m-pk" placeholder="ed25519:..."> <input id="m-sig" placeholder="signature (base64)"></p>
     <button class="btn pri" id="m-submit" type="button">Verify</button></details>`,
  );
  let manual;
  $("#get-challenge").addEventListener("click", async () => {
    manual = await api("/auth/challenge");
    const out = $("#challenge-out");
    out.hidden = false;
    out.textContent = JSON.stringify(manual, null, 2);
  });
  $("#m-submit").addEventListener("click", () => {
    if (!manual) return setStatus("Get a challenge first.");
    verify(manual, { accountId: $("#m-account").value.trim(), publicKey: $("#m-pk").value.trim(), signature: $("#m-sig").value.trim() }).catch((e) =>
      setStatus(`Sign-in failed: ${e.message}`),
    );
  });
}

if (!(await resumeRedirect())) await loadWallets();
