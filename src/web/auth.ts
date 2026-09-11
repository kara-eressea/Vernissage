/**
 * Dashboard authorization (Tier-1).
 *
 * Given the guilds a visitor is in (from the OAuth `guilds` scope) and the
 * configured allowlist, decide which guilds they may view. The rule mirrors the
 * bootstrap tier of the bot's `isModerator` (src/core/permissions.ts): a guild
 * qualifies when it is on the allowlist AND the visitor owns it or holds the
 * Manage Server permission there.
 *
 * On top of that sits one deliberate widening: a small configured list of
 * **support viewers** (DASHBOARD_SUPPORT_USER_IDS) who may *read* every
 * allowlisted guild without moderating it. The operator runs the bot for servers
 * they were invited to but do not moderate, and had no way to see what a
 * moderator was reporting; see `selectViewableGuilds` for why that stays
 * read-only.
 *
 * This under-grants on purpose: without the bot token the dashboard cannot see
 * the guild's configured mod-role or the visitor's roles, so a moderator whose
 * only authority is that mod-role (no Manage Server) cannot log in yet. That is
 * the deliberate Tier-1 gap — full `ensureModerator` parity needs the member
 * fetch carved out for Tier-2 in docs/dashboard.md. Better to exclude a real
 * moderator than to admit a non-moderator.
 */

import type { SessionGuild } from "./session.js";
import type { DiscordPartialGuild } from "./oauth.js";

/** The Manage Server (MANAGE_GUILD) permission bit, 1 << 5. */
const MANAGE_GUILD = 1n << 5n;

/** Whether a permission bitfield string includes Manage Server. */
function hasManageGuild(permissions: string): boolean {
  try {
    return (BigInt(permissions) & MANAGE_GUILD) === MANAGE_GUILD;
  } catch {
    return false;
  }
}

/**
 * The allowlisted guilds this visitor may manage, projected to what the session
 * needs. A guild is included when it is on `allowlist` and the visitor is its
 * owner or has Manage Server there.
 */
export function selectManageableGuilds(
  guilds: DiscordPartialGuild[],
  allowlist: readonly string[],
): SessionGuild[] {
  const allowed = new Set(allowlist);
  return guilds
    .filter((g) => allowed.has(g.id) && (g.owner || hasManageGuild(g.permissions)))
    .map((g) => ({ id: g.id, name: g.name, icon: g.icon }));
}

/**
 * The allowlisted guilds a visitor may *open*, moderator or support viewer.
 *
 * A support viewer (their id in `supportUserIds`) gets every allowlisted guild,
 * each flagged `viewOnly` unless they genuinely moderate it. The flag is what
 * the rest of the dashboard keys off: every page is a read, so they all serve
 * unchanged, and the single route that reaches back into Discord — the designer
 * handoff — refuses a `viewOnly` guild. The grant is therefore "see everything,
 * change nothing", which is what debugging someone else's server needs and no
 * more.
 *
 * Naming a guild the viewer is not a member of is the one rough edge: Discord's
 * `guilds` scope only describes the servers they are in, and the web tier holds
 * no bot token to look up the rest. Those fall back to `Server <id>` with no
 * icon — legible enough to pick from the switcher, and honest about being
 * second-hand.
 */
export function selectViewableGuilds(
  guilds: DiscordPartialGuild[],
  allowlist: readonly string[],
  viewer: { userId: string; supportUserIds: readonly string[] },
): SessionGuild[] {
  const manageable = selectManageableGuilds(guilds, allowlist);
  if (!viewer.supportUserIds.includes(viewer.userId)) {
    return manageable;
  }

  const managed = new Set(manageable.map((g) => g.id));
  // Their own guild list still supplies the name and icon for any allowlisted
  // server they are merely a member of — nicer than the id fallback.
  const known = new Map(guilds.map((g) => [g.id, g]));
  const supported = allowlist
    .filter((id) => !managed.has(id))
    .map((id) => {
      const g = known.get(id);
      return { id, name: g?.name ?? `Server ${id}`, icon: g?.icon ?? null, viewOnly: true };
    });

  // Guilds they moderate come first: a support viewer who is also a moderator
  // somewhere lands in their own server, not in someone else's.
  return [...manageable, ...supported];
}

export { hasManageGuild, MANAGE_GUILD };
