// Sign in with NEAR (NEP-413).
//   1. GET /auth/challenge -> { nonce (base64, 32 bytes), message, recipient, expiresAt }
//   2. The wallet signs it. Redirect wallets come back to /login#accountId=...
//   3. POST /auth/verify -> session cookie, then go to ?next.
//
// Wallets (all loaded from esm.sh at runtime; there is no bundler in this repo):
//   - Meteor Wallet: Meteor Connect (@meteorwallet/sdk@3), action near::sign_in_and_sign_message.
//     Its popup offers Meteor Mobile (QR on desktop, deep link / "Open Meteor Mobile" on phones),
//     Meteor Web and the extension. The wallet-selector meteor module pins the old SDK (web + extension only).
//   - MyNearWallet: @near-wallet-selector (redirect flow).
// The manual form below is the fallback (sign the challenge with any NEP-413 tool and paste the result).
import { api, $, setStatus } from "./api.js";
import { meteorSignedToPayload } from "./meteor-payload.js";

const PENDING_KEY = "nearbi.pendingChallenge";
const next = $("#next")?.value || "/members";
const WS = "https://esm.sh/@near-wallet-selector";
const METEOR_SDK = "https://esm.sh/@meteorwallet/sdk@3.24.1";
const NETWORK = "mainnet";

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// ---------------------------------------------------------------- challenge prefetch
// Meteor Mobile can only be opened automatically while the user's tap is still "live", so the
// tap handler must not wait on the network before prompting. Keep a fresh challenge ready instead.
// Challenges live 5 minutes server-side and are single-use.
let prefetched = null;
let prefetching = null;
const challengeFresh = (c) => c && (!c.expiresAt || c.expiresAt - Date.now() / 1000 > 60);

function prefetchChallenge() {
  prefetching ??= api("/auth/challenge")
    .then((c) => (prefetched = c))
    .catch(() => null)
    .finally(() => (prefetching = null));
  return prefetching;
}

/** Take the prefetched challenge (sync when available) and start fetching the next one. */
function takeChallenge() {
  const c = challengeFresh(prefetched) ? prefetched : null;
  prefetched = null;
  prefetchChallenge();
  return c;
}

setInterval(() => {
  if (!challengeFresh(prefetched)) prefetchChallenge();
}, 60_000);

// ---------------------------------------------------------------- verify
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

// ---------------------------------------------------------------- MyNearWallet (wallet-selector)
async function signWithSelector(selector, walletId) {
  const challenge = takeChallenge() ?? (await api("/auth/challenge"));
  const callbackUrl = location.origin + location.pathname + location.search;
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ challenge, callbackUrl }));
  setStatus("Waiting for your wallet…");
  const wallet = await selector.wallet(walletId);
  // wallet-selector validates the nonce with Buffer.isBuffer(), so a plain Uint8Array is rejected
  // ("Invalid nonce. It must be a Buffer with a length of 32 bytes"). Use the browser Buffer polyfill.
  const { Buffer } = await import("https://esm.sh/node/buffer.mjs");
  if (!globalThis.Buffer) globalThis.Buffer = Buffer;
  const signed = await wallet.signMessage({
    message: challenge.message,
    recipient: challenge.recipient,
    nonce: Buffer.from(b64ToBytes(challenge.nonce)),
    callbackUrl,
  });
  // Injected/popup wallets resolve here; redirect wallets navigate away and come back via resumeRedirect().
  if (signed) await verify(challenge, signed, callbackUrl);
}

// ---------------------------------------------------------------- Meteor Wallet (Meteor Connect)
async function initMeteor() {
  const { MeteorConnect, webpage_local_storage } = await import(METEOR_SDK);
  const mc = new MeteorConnect();
  await mc.initialize({
    storage: webpage_local_storage,
    mobileBridge: {
      enabled: true,
      partnerMetadata: {
        name: "NearBI",
        description: "Sign in to NearBI research",
        iconUrl: `${location.origin}/favicon.ico`,
        originUrl: location.origin,
      },
    },
  });
  return mc;
}

async function signWithMeteor(mc) {
  // Keep everything before promptForExecution() free of network waits (see prefetch note above).
  let challenge = takeChallenge();
  if (!challenge) {
    setStatus("Preparing sign-in…");
    challenge = await api("/auth/challenge");
  }
  setStatus("Approve the sign-in in Meteor…");
  const action = await mc.createAction({
    id: "near::sign_in_and_sign_message",
    input: {
      target: { blockchain: "near", network: NETWORK },
      messageParams: { message: challenge.message, recipient: challenge.recipient, nonce: b64ToBytes(challenge.nonce) },
    },
  });
  let out;
  try {
    out = await action.promptForExecution();
  } catch (e) {
    if (/cancel/i.test(e?.message ?? "")) return setStatus("Sign-in cancelled.");
    throw e;
  }
  await verify(challenge, meteorSignedToPayload(out), null);
}

// ---------------------------------------------------------------- UI
function addWalletButton(box, label, onClick) {
  const b = document.createElement("button");
  b.className = "btn wallet-btn";
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", () => onClick().catch((e) => setStatus(`Sign-in failed: ${e.message}`)));
  box.appendChild(b);
  return b;
}

async function loadWallets() {
  const box = $("#wallets");
  prefetchChallenge();
  const [meteor, selector] = await Promise.allSettled([
    initMeteor(),
    Promise.all([import(`${WS}/core@8`), import(`${WS}/my-near-wallet@8`)]).then(([{ setupWalletSelector }, { setupMyNearWallet }]) =>
      setupWalletSelector({ network: NETWORK, modules: [setupMyNearWallet()] }),
    ),
  ]);
  box.innerHTML = "";
  if (meteor.status === "fulfilled") addWalletButton(box, "Meteor Wallet", () => signWithMeteor(meteor.value));
  if (selector.status === "fulfilled") {
    for (const m of selector.value.store.getState().modules) addWalletButton(box, m.metadata.name, () => signWithSelector(selector.value, m.id));
  }
  const failed = [meteor, selector].filter((r) => r.status === "rejected");
  if (failed.length) {
    for (const f of failed) console.error("wallet load failed", f.reason);
    box.insertAdjacentHTML(
      "beforeend",
      `<p class="muted">Some wallets could not load (${failed.map((f) => f.reason?.message ?? f.reason).join("; ")}). Use the manual option below.</p>`,
    );
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
