/**
 * Encrypted cookie sessions.
 *
 * The dashboard is read-only and stateless, so a cookie is enough — no
 * server-side session store. The payload says who the moderator is, which
 * allowlisted guilds they manage, and carries their Discord access token so the
 * server can re-check that standing on each request (see access.ts, design.md
 * "Dashboard access is re-checked").
 *
 * That token is why the cookie is **encrypted**, not merely signed. A signed
 * cookie is tamper-proof but readable, and a readable access token turns cookie
 * theft from "dashboard access until the session expires" into "Discord identity
 * and guild-list access for as long as the token lives" — an escalation that
 * outlives the session. AES-256-GCM over a key derived from the configured secret
 * gives confidentiality and integrity together, so no separate HMAC is needed.
 *
 * The session lifetime is deliberately **shorter than a Discord access token**
 * (which lives ~7 days), so a session never outlives its own token and no
 * refresh-token handling is required: an expired token simply fails the re-check
 * and the moderator signs in again.
 *
 * Cookies are `HttpOnly`, `SameSite=Lax` (so the OAuth redirect back carries
 * them), and `Secure` when served over https (docs/dashboard.md "Security and
 * operations").
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

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
  /**
   * The visitor's Discord OAuth access token, used only to re-check their guild
   * standing (access.ts). Confidential — the reason the cookie is encrypted.
   * Optional so a session minted before this existed simply fails the re-check
   * rather than crashing.
   */
  at?: string;
  /** Issued-at, epoch ms — drives session expiry. */
  iat: number;
}

/** The session cookie name and lifetime. */
export const SESSION_COOKIE = "tombola_session";
export const OAUTH_STATE_COOKIE = "tombola_oauth_state";
/**
 * How long a session lives before a fresh sign-in is required.
 *
 * This is the ceiling on how long a moderator who has *lost* their access keeps
 * it: the per-request re-check (access.ts) normally catches that within its cache
 * window, but if the re-check is disabled this lifetime is the only bound. Twelve
 * hours also keeps every session comfortably shorter than the ~7-day Discord
 * access token it carries, which is what lets us skip refresh-token handling.
 */
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

/** Cookie format marker, so a future scheme change is detectable, not silent. */
const FORMAT = "v2";
const IV_BYTES = 12; // GCM standard nonce length
const KEY_INFO = Buffer.from("tombola-dashboard-session-v2", "utf8");

/**
 * A 256-bit key derived from the configured secret. Derivation (rather than using
 * the secret bytes directly) means the secret can be any length or character set
 * and is never used as a raw key.
 */
function keyFor(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), KEY_INFO, 32));
}

/** Encrypt a session into a cookie value (`v2.<iv>.<ciphertext+tag>`). */
export function encodeSession(session: Session, secret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyFor(secret), iv);
  const body = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(session), "utf8")),
    cipher.final(),
  ]);
  const sealed = Buffer.concat([body, cipher.getAuthTag()]);
  return `${FORMAT}.${iv.toString("base64url")}.${sealed.toString("base64url")}`;
}

/**
 * Decrypt and validate a session cookie. Returns null when the cookie is absent,
 * malformed, from another scheme, forged or tampered with (the GCM tag fails), or
 * has expired past SESSION_MAX_AGE_MS.
 *
 * A cookie in the older signed-but-readable format does not parse here, so
 * existing sessions end at deploy and everyone signs in once. That is the
 * intended outcome of a change whose point is that stale sessions should not
 * survive.
 */
export function decodeSession(cookie: string | undefined, secret: string, now: number): Session | null {
  if (!cookie) return null;
  const parts = cookie.split(".");
  if (parts.length !== 3 || parts[0] !== FORMAT) return null;

  try {
    const iv = Buffer.from(parts[1]!, "base64url");
    const sealed = Buffer.from(parts[2]!, "base64url");
    if (iv.length !== IV_BYTES || sealed.length <= 16) return null;
    const tag = sealed.subarray(sealed.length - 16);
    const body = sealed.subarray(0, sealed.length - 16);

    const decipher = createDecipheriv("aes-256-gcm", keyFor(secret), iv);
    decipher.setAuthTag(tag);
    // `final()` throws when the tag does not verify — forgery and tampering both
    // land here, so no separate signature check is needed.
    const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");

    const session = JSON.parse(plain) as Session;
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
