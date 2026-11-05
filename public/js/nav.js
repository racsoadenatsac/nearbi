// Static pages: make the header reflect the session. The pages are plain files on S3, so they always ship
// with "Sign in"; the session is an HttpOnly cookie only the app can read. Ask /api/me and, when signed in,
// swap "Sign in" for the account (links to /members) + "Sign out", like the app's own pages do.
(async () => {
  const signIn = document.querySelector('header.nav a[href="/login"]');
  if (!signIn) return;
  let me;
  try {
    const r = await fetch("/api/me", { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) return;
    me = await r.json();
  } catch {
    return;
  }
  if (!me || !me.authenticated || !me.accountId) return;
  const account = signIn.cloneNode(false); // keeps the link's class/inline style (the home page styles it as a button)
  account.href = "/members";
  account.textContent = me.accountId;
  account.title = "Signed in: your members page";
  const signOut = document.createElement("a");
  signOut.href = "#";
  signOut.textContent = "Sign out";
  const style = signIn.parentElement.querySelector('a[href="/members"]')?.getAttribute("style");
  if (style) signOut.setAttribute("style", style);
  signOut.addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
    } finally {
      location.reload();
    }
  });
  signIn.replaceWith(account, signOut);
})();
