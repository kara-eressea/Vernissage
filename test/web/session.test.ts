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

  it("rejects a tampered payload", () => {
    const cookie = encodeSession(makeSession(), SECRET);
    const [payload, sig] = cookie.split(".");
    // Flip the payload but keep the old signature.
    const forged = `${payload}x.${sig}`;
    expect(decodeSession(forged, SECRET, NOW)).toBeNull();
  });

  it("rejects a signature made with a different secret", () => {
    const cookie = encodeSession(makeSession(), "other-secret");
    expect(decodeSession(cookie, SECRET, NOW)).toBeNull();
  });

  it("rejects a malformed cookie", () => {
    expect(decodeSession(undefined, SECRET, NOW)).toBeNull();
    expect(decodeSession("", SECRET, NOW)).toBeNull();
    expect(decodeSession("nodothere", SECRET, NOW)).toBeNull();
    expect(decodeSession(".onlysig", SECRET, NOW)).toBeNull();
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
