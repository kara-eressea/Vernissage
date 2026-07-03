/**
 * Member-presence resolver for the draw's left-guild failsafe.
 *
 * Supplies the draw service's `PresenceResolver` seam (src/draw/service.ts)
 * without pulling discord.js into the service. Only the pulled winners are
 * checked, so this does a handful of per-id REST fetches — no privileged
 * GuildMembers intent needed. Crucially, only a *confirmed* "Unknown Member"
 * counts as departed; any other error is treated as "present" so a transient
 * failure never removes a valid entrant's entry.
 */

import type { Client } from "discord.js";
import type { PresenceResolver } from "../draw/service.js";

/** Discord API error code for a member that is not in the guild. */
const UNKNOWN_MEMBER = 10007;

/** Build a presence resolver bound to a logged-in client. */
export function makePresenceResolver(client: Client): PresenceResolver {
  return async (guildId, candidateIds) => {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      return null; // Can't determine membership; treat no one as departed.
    }
    const present = new Set<string>();
    await Promise.all(
      candidateIds.map(async (id) => {
        try {
          await guild.members.fetch(id);
          present.add(id);
        } catch (err) {
          // Only a confirmed "Unknown Member" means they left. Any other error
          // is uncertain — keep them, never remove an entry we can't verify.
          if ((err as { code?: number })?.code !== UNKNOWN_MEMBER) {
            present.add(id);
          }
        }
      }),
    );
    return present;
  };
}
