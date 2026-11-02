// Stateless session cookie: base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload)).

import { base64Decode, base64UrlEncode, timingSafeEqual, utf8 } from "../lib/encoding";

export const SESSION_COOKIE = "nearbi_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface Session {
  sub: string; // NEAR account id
  pk: string; // public key used to sign in
  iat: number; // unix seconds
  exp: number; // unix seconds
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  if (!secret || secret.length < 16) throw new Error("SESSION_SECRET missing or too short");
  const key = await crypto.subtle.importKey("raw", utf8.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8.encode(data)));
}

export async function signSession(secret: string, s: Session): Promise<string> {
  const body = base64UrlEncode(utf8.encode(JSON.stringify(s)));
  return `${body}.${base64UrlEncode(await hmac(secret, body))}`;
}

export async function verifySession(secret: string, token: string | undefined, nowSec: number): Promise<Session | null> {
  if (!token) return null;
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined) return null;
  let given: Uint8Array;
  try {
    given = base64Decode(mac);
  } catch {
    return null;
  }
  if (!timingSafeEqual(given, await hmac(secret, body))) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(base64Decode(body))) as Session;
    if (typeof s.sub !== "string" || typeof s.exp !== "number" || s.exp <= nowSec) return null;
    return s;
  } catch {
    return null;
  }
}

export function sessionCookie(token: string, maxAge = SESSION_TTL_SECONDS): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
