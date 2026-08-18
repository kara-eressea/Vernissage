import { describe, expect, it } from "vitest";
import {
  decodeSession,
  encodeSession,
  parseCookies,
  serializeCookie,
  SESSION_MAX_AGE_MS,
  type Session,
} from "../../src/web/session.js";

const SECRET = "test-secret-please-change";
const NOW = 1_700_000_000_000;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    uid: "111",
    username: "alice",
    guilds: [{ id: "g1", name: "Guild One", icon: null }],
    selectedGuildId: "g1",
    iat: NOW,
    ...overrides,
  };
}

describe("session encode/decode", () => {
  it("round-trips a valid session", () => {
    const session = makeSession();
    const cookie = encodeSession(session, SECRET);
    expect(decodeSession(cookie, SECRET, NOW)).toEqual(session);
  });

  it("rejects a tampered ciphertext", () => {
    const cookie = encodeSession(makeSession(), SECRET);
    const [fmt, iv, sealed] = cookie.split(".");
    // The GCM tag covers the ciphertext, so any edit fails authentication.
    expect(decodeSession(`${fmt}.${iv}.${sealed}AA`, SECRET, NOW)).toBeNull();
  });

  it("rejects a tampered nonce", () => {
    const cookie = encodeSession(makeSession(), SECRET);
    const [fmt, , sealed] = cookie.split(".");
    expect(decodeSession(`${fmt}.${"A".repeat(16)}.${sealed}`, SECRET, NOW)).toBeNull();
  });

  it("rejects a cookie sealed with a different secret", () => {
    const cookie = encodeSession(makeSession(), "other-secret");
    expect(decodeSession(cookie, SECRET, NOW)).toBeNull();
  });

  it("rejects a malformed cookie", () => {
    expect(decodeSession(undefined, SECRET, NOW)).toBeNull();
    expect(decodeSession("", SECRET, NOW)).toBeNull();
    expect(decodeSession("nodothere", SECRET, NOW)).toBeNull();
    expect(decodeSession(".onlysig", SECRET, NOW)).toBeNull();
    // Wrong scheme marker: a cookie from another format must not be guessed at.
    expect(decodeSession("v1.aaa.bbb", SECRET, NOW)).toBeNull();
  });

  it("keeps the access token out of a readable cookie", () => {
    // The reason the cookie is encrypted rather than merely signed: a readable
    // token would let cookie theft reach Discord directly, for longer than the
    // session lives (issue #40).
    const cookie = encodeSession(makeSession({ at: "super-secret-token" }), SECRET);
    expect(cookie).not.toContain("super-secret-token");
    for (const part of cookie.split(".").slice(1)) {
      const decoded = Buffer.from(part, "base64url").toString("utf8");
      expect(decoded).not.toContain("super-secret-token");
      expect(decoded).not.toContain("uid");
    }
    // But the server still reads it back.
    expect(decodeSession(cookie, SECRET, NOW)?.at).toBe("super-secret-token");
  });

  it("expires in hours, not days", () => {
    // The lifetime is the ceiling on a removed moderator's residual access when
    // the per-request re-check is switched off, and must stay under Discord's
    // ~7-day access-token life so no refresh handling is needed.
    expect(SESSION_MAX_AGE_MS).toBe(12 * 60 * 60 * 1000);
  });

  it("rejects an expired session", () => {
    const cookie = encodeSession(makeSession({ iat: NOW }), SECRET);
    const later = NOW + SESSION_MAX_AGE_MS + 1;
    expect(decodeSession(cookie, SECRET, later)).toBeNull();
    // Still valid at the edge of the window.
    expect(decodeSession(cookie, SECRET, NOW + SESSION_MAX_AGE_MS)).not.toBeNull();
  });
});

describe("cookie parse/serialize", () => {
  it("parses a Cookie header into a map", () => {
    const map = parseCookies("a=1; b=hello%20world; c=");
    expect(map.get("a")).toBe("1");
    expect(map.get("b")).toBe("hello world");
    expect(map.get("c")).toBe("");
  });

  it("returns an empty map for no header", () => {
    expect(parseCookies(undefined).size).toBe(0);
  });

  it("serializes secure httpOnly Lax cookies", () => {
    const c = serializeCookie("s", "v", { maxAgeMs: 60_000, secure: true });
    expect(c).toContain("s=v");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Max-Age=60");
    expect(c).toContain("Secure");
  });

  it("omits Secure when not requested (local http)", () => {
    const c = serializeCookie("s", "v", { maxAgeMs: 0, secure: false });
    expect(c).not.toContain("Secure");
    expect(c).toContain("Max-Age=0");
  });
});
