/**
 * Dashboard authorization (Tier-1).
 *
 * Given the guilds a visitor is in (from the OAuth `guilds` scope) and the
 * configured allowlist, decide which guilds they may view. The rule mirrors the
 * bootstrap tier of the bot's `isModerator` (src/core/permissions.ts): a guild
 * qualifies when it is on the allowlist AND the visitor owns it or holds the
 * Manage Server permission there.
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

export { hasManageGuild, MANAGE_GUILD };
