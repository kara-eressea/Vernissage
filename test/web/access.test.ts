import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessChecker, applyAccess, ACCESS_CACHE_MS } from "../../src/web/access.js";
import { TokenRejectedError, type DiscordPartialGuild } from "../../src/web/oauth.js";
import type { Session } from "../../src/web/session.js";

const ALLOWLIST = ["g1", "g2"];
const NOW = 1_760_000_000_000;

function session(overrides: Partial<Session> = {}): Session {
  return {
    uid: "mod-1",
    username: "Mod",
    guilds: [{ id: "g1", name: "Musicorum", icon: null }],
    selectedGuildId: "g1",
    at: "token-abc",
    iat: NOW,
    ...overrides,
  };
}

/** A guild as Discord reports it, manageable unless told otherwise. */
function guild(id: string, opts: { manage?: boolean; name?: string } = {}): DiscordPartialGuild {
  return {
    id,
    name: opts.name ?? "Musicorum",
    icon: null,
    owner: false,
    // Manage Server is bit 1 << 5 = 32.
    permissions: opts.manage === false ? "0" : "32",
  } as DiscordPartialGuild;
}

describe("AccessChecker", () => {
  // A transient failure logs; the tests that exercise it expect that, so keep the
  // suite output clean rather than asserting on noise.
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes a moderator through with a freshly resolved guild list", async () => {
    const fetchGuilds = vi.fn().mockResolvedValue([guild("g1"), guild("nope")]);
    const checker = new AccessChecker(ALLOWLIST, fetchGuilds);

    const result = await checker.check(session(), NOW);

    expect(result).toEqual({ ok: true, guilds: [{ id: "g1", name: "Musicorum", icon: null }] });
    expect(fetchGuilds).toHaveBeenCalledWith("token-abc");
  });

  it("revokes a moderator who has lost Manage Server", async () => {
    // The whole point of the issue: this used to keep working for days.
    const checker = new AccessChecker(ALLOWLIST, vi.fn().mockResolvedValue([guild("g1", { manage: false })]));
    expect(await checker.check(session(), NOW)).toEqual({ ok: false, reason: "revoked" });
  });

  it("revokes a moderator removed from the server entirely", async () => {
    const checker = new AccessChecker(ALLOWLIST, vi.fn().mockResolvedValue([]));
    expect(await checker.check(session(), NOW)).toEqual({ ok: false, reason: "revoked" });
  });

  it("revokes when Discord rejects the token", async () => {
    const checker = new AccessChecker(
      ALLOWLIST,
      vi.fn().mockRejectedValue(new TokenRejectedError(401)),
    );
    expect(await checker.check(session(), NOW)).toEqual({ ok: false, reason: "revoked" });
  });

  it("revokes a session with no token, which cannot be checked at all", async () => {
    const fetchGuilds = vi.fn();
    const checker = new AccessChecker(ALLOWLIST, fetchGuilds);
    expect(await checker.check(session({ at: undefined }), NOW)).toEqual({
      ok: false,
      reason: "revoked",
    });
    expect(fetchGuilds).not.toHaveBeenCalled();
  });

  it("reports a transient failure as unavailable, not as a revocation", async () => {
    // A Discord blip or rate limit must not log every moderator out.
    const checker = new AccessChecker(ALLOWLIST, vi.fn().mockRejectedValue(new Error("503")));
    expect(await checker.check(session(), NOW)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("never remembers a failure", async () => {
    const fetchGuilds = vi
      .fn()
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValueOnce([guild("g1")]);
    const checker = new AccessChecker(ALLOWLIST, fetchGuilds);

    expect(await checker.check(session(), NOW)).toMatchObject({ reason: "unavailable" });
    // The next request tries again rather than serving a cached failure.
    expect(await checker.check(session(), NOW)).toMatchObject({ ok: true });
    expect(fetchGuilds).toHaveBeenCalledTimes(2);
  });

  it("caches a success so a page load is not a Discord round trip", async () => {
    const fetchGuilds = vi.fn().mockResolvedValue([guild("g1")]);
    const checker = new AccessChecker(ALLOWLIST, fetchGuilds);

    await checker.check(session(), NOW);
    await checker.check(session(), NOW + 1000);

    expect(fetchGuilds).toHaveBeenCalledTimes(1);
  });

  it("re-asks Discord once the cache window passes", async () => {
    const fetchGuilds = vi.fn().mockResolvedValue([guild("g1")]);
    const checker = new AccessChecker(ALLOWLIST, fetchGuilds);

    await checker.check(session(), NOW);
    await checker.check(session(), NOW + ACCESS_CACHE_MS);

    expect(fetchGuilds).toHaveBeenCalledTimes(2);
  });

  it("caches a revocation too, so a rejected visitor cannot hammer Discord", async () => {
    const fetchGuilds = vi.fn().mockResolvedValue([]);
    const checker = new AccessChecker(ALLOWLIST, fetchGuilds);

    await checker.check(session(), NOW);
    expect(await checker.check(session(), NOW + 1000)).toEqual({ ok: false, reason: "revoked" });
    expect(fetchGuilds).toHaveBeenCalledTimes(1);
  });

  it("forgets on demand, so a fresh sign-in is authoritative", async () => {
    const fetchGuilds = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([guild("g1")]);
    const checker = new AccessChecker(ALLOWLIST, fetchGuilds);

    expect(await checker.check(session(), NOW)).toMatchObject({ reason: "revoked" });
    checker.forget("mod-1");
    // Someone who just regained access is not held out by a stale answer.
    expect(await checker.check(session(), NOW + 1000)).toMatchObject({ ok: true });
  });

  it("sweeps stale entries so the cache cannot grow forever", async () => {
    const fetchGuilds = vi.fn().mockResolvedValue([guild("g1")]);
    const checker = new AccessChecker(ALLOWLIST, fetchGuilds);

    await checker.check(session(), NOW);
    checker.sweep(NOW + ACCESS_CACHE_MS);
    await checker.check(session(), NOW + ACCESS_CACHE_MS);

    expect(fetchGuilds).toHaveBeenCalledTimes(2);
  });

  it("only ever admits allowlisted guilds", async () => {
    const checker = new AccessChecker(ALLOWLIST, vi.fn().mockResolvedValue([guild("elsewhere")]));
    expect(await checker.check(session(), NOW)).toEqual({ ok: false, reason: "revoked" });
  });
});

describe("applyAccess", () => {
  const g1 = { id: "g1", name: "Musicorum", icon: null };
  const g2 = { id: "g2", name: "Second", icon: null };

  it("reports no change when the fresh list matches the cookie", () => {
    const applied = applyAccess(session({ guilds: [g1], selectedGuildId: "g1" }), [g1]);
    expect(applied.changed).toBe(false);
    expect(applied.session.selectedGuildId).toBe("g1");
  });

  it("drops a selection that is no longer manageable", () => {
    const applied = applyAccess(session({ guilds: [g1, g2], selectedGuildId: "g2" }), [g1]);
    // Only one guild left, so it selects that rather than stranding the visitor.
    expect(applied.session.selectedGuildId).toBe("g1");
    expect(applied.changed).toBe(true);
  });

  it("clears the selection when several guilds remain and the chosen one is gone", () => {
    const g3 = { id: "g3", name: "Third", icon: null };
    const applied = applyAccess(session({ guilds: [g1, g2, g3], selectedGuildId: "g1" }), [g2, g3]);
    expect(applied.session.selectedGuildId).toBeUndefined();
    expect(applied.changed).toBe(true);
  });

  it("notices a renamed server, so the switcher does not stay stale", () => {
    const applied = applyAccess(session({ guilds: [g1] }), [{ ...g1, name: "Musicorum HQ" }]);
    expect(applied.changed).toBe(true);
    expect(applied.session.guilds[0]!.name).toBe("Musicorum HQ");
  });

  it("notices a newly gained server", () => {
    const applied = applyAccess(session({ guilds: [g1], selectedGuildId: "g1" }), [g1, g2]);
    expect(applied.changed).toBe(true);
    expect(applied.session.guilds).toHaveLength(2);
    expect(applied.session.selectedGuildId).toBe("g1");
  });

  it("keeps the access token on the refreshed session", () => {
    // Losing it would make every later request unverifiable.
    expect(applyAccess(session(), [g1]).session.at).toBe("token-abc");
  });
});
