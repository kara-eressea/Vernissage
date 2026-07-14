/**
 * Signed cookie sessions.
 *
 * The dashboard is read-only and stateless, so a signed cookie is enough — no
 * server-side session store. The session payload (who the moderator is and which
 * allowlisted guilds they manage) is JSON, base64url-encoded, and HMAC-signed
 * with the configured secret so it cannot be forged or tampered with. Cookies
 * are `HttpOnly`, `SameSite=Lax` (so the OAuth redirect back carries them), and
 * `Secure` when served over https (docs/dashboard.md "Security and operations").
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** An allowlisted guild this moderator may view, as resolved at login. */
export interface SessionGuild {
  id: string;
  name: string;
  /** Discord icon hash, or null — used to render the guild avatar. */
  icon: string | null;
}

/** What we persist about a logged-in moderator, all client-side in the cookie. */
export interface Session {
  /** Discord user id. */
  uid: string;
  /** Display name for the account menu (global name or username). */
  username: string;
  /** The allowlisted guilds this user manages (owner or Manage Server). */
  guilds: SessionGuild[];
  /** The guild currently selected, if any (must be one of `guilds`). */
  selectedGuildId?: string;
  /** Issued-at, epoch ms — drives session expiry. */
  iat: number;
}

/** The session cookie name and lifetime. */
export const SESSION_COOKIE = "tombola_session";
export const OAUTH_STATE_COOKIE = "tombola_oauth_state";
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(value: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(value).digest());
}

/** Serialize + sign a session into a cookie value (`payload.signature`). */
export function encodeSession(session: Session, secret: string): string {
  const payload = b64url(Buffer.from(JSON.stringify(session), "utf8"));
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Verify and decode a session cookie. Returns null if the signature is missing,
 * malformed, forged, or the session has expired past SESSION_MAX_AGE_MS.
 */
export function decodeSession(cookie: string | undefined, secret: string, now: number): Session | null {
  if (!cookie) return null;
  const dot = cookie.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = cookie.slice(0, dot);
  const signature = cookie.slice(dot + 1);

  const expected = sign(payload, secret);
  // Constant-time compare; length-mismatched buffers can't be compared by
  // timingSafeEqual, so guard first (a length mismatch is already a failure).
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return null;
  }

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
    if (typeof session.iat !== "number" || now - session.iat > SESSION_MAX_AGE_MS) {
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

/** Parse a Cookie header into a name→value map. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out.set(name, decodeURIComponent(value));
  }
  return out;
}

/** Build a Set-Cookie header value. `maxAgeMs` of 0 expires the cookie now. */
export function serializeCookie(
  name: string,
  value: string,
  opts: { maxAgeMs: number; secure: boolean; sameSite?: "Lax" | "Strict" },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${opts.sameSite ?? "Lax"}`,
    `Max-Age=${Math.floor(opts.maxAgeMs / 1000)}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export { SESSION_MAX_AGE_MS };
