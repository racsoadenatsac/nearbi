import { describe, expect, it } from "vitest";
import { clearSessionCookie, sessionCookie, signSession, verifySession } from "../../src/core/session";

const NOW = 1_800_000_000;
const secret = "test-secret-at-least-32-bytes-long-xx";
const s = { sub: "alice.near", pk: "ed25519:x", iat: NOW, exp: NOW + 60 };

describe("session HMAC token", () => {
  it("round-trips", async () => {
    expect(await verifySession(secret, await signSession(secret, s), NOW)).toEqual(s);
  });
  it("rejects tampering, wrong secret, expiry and garbage", async () => {
    const t = await signSession(secret, s);
    const forged = btoa(JSON.stringify({ ...s, sub: "bob.near" })).replace(/=+$/, "") + "." + t.split(".")[1];
    expect(await verifySession(secret, forged, NOW)).toBeNull();
    expect(await verifySession(secret + "x", t, NOW)).toBeNull();
    expect(await verifySession(secret, t, NOW + 60)).toBeNull();
    expect(await verifySession(secret, "garbage", NOW)).toBeNull();
    expect(await verifySession(secret, `${t}.extra`, NOW)).toBeNull();
    expect(await verifySession(secret, undefined, NOW)).toBeNull();
  });
  it("refuses to sign with a short secret", async () => {
    await expect(signSession("short", s)).rejects.toThrow(/SESSION_SECRET/);
  });
  it("cookie attributes", () => {
    expect(sessionCookie("v")).toBe("nearbi_session=v; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800");
    expect(clearSessionCookie()).toContain("Max-Age=0");
  });
});
