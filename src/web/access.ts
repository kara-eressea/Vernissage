/**
 * Per-request access re-check.
 *
 * Sign-in decides who a visitor is and which allowlisted guilds they manage, and
 * before this the answer was then trusted for the whole life of the cookie. That
 * meant a moderator who lost Manage Server — or was removed from the server
 * entirely — kept full read access to that guild's raffles, entrants, member
 * names and activity figures until their session expired (issue #40).
 *
 * So every `/app` request re-derives the answer from Discord, through the same
 * `selectManageableGuilds` the callback uses, and the request is authorised
 * against *that* rather than against the cookie's stale copy.
 *
 * Three deliberate choices:
 *
 *   - **A short cache**, keyed by user id. Without it every page load costs a
 *     Discord round trip and burns the per-token rate limit. Five minutes is the
 *     residual window in which a just-revoked moderator still gets in — orders of
 *     magnitude better than the days it was, and cheap enough to keep the page
 *     fast. Only successes are cached; a failure is never remembered.
 *   - **A transient Discord failure fails the request, not the session.** A blip
 *     or a rate limit returns `unavailable`, the visitor sees a retry page, and
 *     their session survives. Only a definitive rejection (the token is invalid,
 *     or they genuinely no longer manage the guild) returns `revoked` and clears
 *     it. Logging everyone out because Discord hiccuped would be its own outage.
 *   - **Never fall back to the cookie's list.** The whole point is that the stale
 *     list is not trustworthy; serving it when the check fails would reintroduce
 *     exactly the gap being closed.
 */

import { selectManageableGuilds } from "./auth.js";
import { fetchUserGuilds, TokenRejectedError } from "./oauth.js";
import type { Session, SessionGuild } from "./session.js";

/** How long a successful check is reused before Discord is asked again. */
export const ACCESS_CACHE_MS = 5 * 60 * 1000;

/** The outcome of re-checking one visitor's standing. */
export type AccessResult =
  /** Still a moderator; `guilds` is the freshly resolved list. */
  | { ok: true; guilds: SessionGuild[] }
  /** Definitively no longer allowed: clear the session and send them to login. */
  | { ok: false; reason: "revoked" }
  /** Could not ask Discord: fail this request, keep the session. */
  | { ok: false; reason: "unavailable" };

interface CacheEntry {
  guilds: SessionGuild[];
  at: number;
}

/**
 * The re-check, with its cache. An instance per server, so tests get a clean one
 * and nothing leaks between them.
 */
export class AccessChecker {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly allowlist: readonly string[],
    /** Injected for tests; defaults to the real Discord call. */
    private readonly fetchGuilds = fetchUserGuilds,
    private readonly ttlMs = ACCESS_CACHE_MS,
  ) {}

  /**
   * Re-resolve which allowlisted guilds `session` may view, as of `now`.
   *
   * A session with no stored access token cannot be re-checked at all, which is
   * true of one minted before this existed — treated as revoked, so the visitor
   * signs in again and gets a checkable session.
   */
  async check(session: Session, now: number): Promise<AccessResult> {
    const cached = this.cache.get(session.uid);
    if (cached && now - cached.at < this.ttlMs) {
      return cached.guilds.length > 0
        ? { ok: true, guilds: cached.guilds }
        : { ok: false, reason: "revoked" };
    }
    if (!session.at) {
      return { ok: false, reason: "revoked" };
    }

    let guilds: SessionGuild[];
    try {
      guilds = selectManageableGuilds(await this.fetchGuilds(session.at), this.allowlist);
    } catch (err) {
      if (err instanceof TokenRejectedError) {
        // Discord says the token is no longer good: revoked, deauthorised, or
        // expired. Not a transient failure — do not keep the session alive.
        this.cache.delete(session.uid);
        return { ok: false, reason: "revoked" };
      }
      console.error(`Could not re-check dashboard access for ${session.uid}:`, err);
      return { ok: false, reason: "unavailable" };
    }

    // Cache the empty result too: someone who has lost access should not cause a
    // Discord call on every request they make.
    this.cache.set(session.uid, { guilds, at: now });
    return guilds.length > 0 ? { ok: true, guilds } : { ok: false, reason: "revoked" };
  }

  /** Drop a cached answer, so the next request asks Discord again. */
  forget(userId: string): void {
    this.cache.delete(userId);
  }

  /** Discard entries past their TTL, so the map cannot grow unbounded. */
  sweep(now: number): void {
    for (const [uid, entry] of this.cache) {
      if (now - entry.at >= this.ttlMs) {
        this.cache.delete(uid);
      }
    }
  }
}

/**
 * Apply a successful check to the session: swap in the fresh guild list and drop
 * a selection that is no longer manageable.
 *
 * Returns the session to use for this request and whether it differs from what
 * the cookie held — the caller re-issues the cookie when it does, so a moderator
 * who gains or loses a server sees that reflected rather than carrying a stale
 * switcher around for hours.
 */
export function applyAccess(
  session: Session,
  guilds: SessionGuild[],
): { session: Session; changed: boolean } {
  const selected =
    session.selectedGuildId && guilds.some((g) => g.id === session.selectedGuildId)
      ? session.selectedGuildId
      : // Fall into the only remaining guild, as the callback does at sign-in.
        guilds.length === 1
        ? guilds[0]!.id
        : undefined;

  const changed =
    selected !== session.selectedGuildId ||
    guilds.length !== session.guilds.length ||
    guilds.some((g, i) => {
      const was = session.guilds[i];
      return !was || was.id !== g.id || was.name !== g.name || was.icon !== g.icon;
    });

  return { session: { ...session, guilds, selectedGuildId: selected }, changed };
}
