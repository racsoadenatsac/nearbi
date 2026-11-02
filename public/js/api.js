// Tiny fetch helpers shared by the page scripts. Same-origin only; the session is an HttpOnly cookie.
export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

export const $ = (sel) => document.querySelector(sel);

export function setStatus(text) {
  const el = $("#status");
  if (el) el.textContent = text;
}
