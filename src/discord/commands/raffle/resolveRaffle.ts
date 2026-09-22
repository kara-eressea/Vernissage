/**
 * Resolving which raffle a command means.
 *
 * Most raffle subcommands take an optional id, because most of the time there is
 * only one raffle it could sensibly be about. This is that resolution, shared by
 * the member-facing commands and the moderator ones so a member and the
 * moderator helping them are never answered differently about the same raffle.
 *
 * It never guesses between several open raffles: picking one would be picking
 * wrong half the time, on an action that is not obviously reversible from the
 * member's point of view. It asks instead, listing them by id and name.
 *
 * An explicit id is returned whatever state that raffle is in — the caller knows
 * which states its own command accepts, and says so in its own words. Callers
 * must therefore still check the status themselves; `withdrawEntry` does exactly
 * this for both withdrawal paths.
 */

import { getGuildRaffle, listByStatus, type RaffleRow } from "../../../db/repositories/raffles.js";
import type { CommandContext } from "../index.js";

/**
 * The raffle an optional `raffle` option refers to: the one with that id, else
 * the single open raffle. Returns the row, or a string explaining why it could
 * not be resolved — ready to send back to the caller as-is.
 */
export function resolveOpenRaffle(
  db: CommandContext["db"],
  guildId: string,
  explicitId: number | null,
): RaffleRow | string {
  if (explicitId !== null) {
    return (
      getGuildRaffle(db, guildId, explicitId) ?? "No raffle with that id exists in this server."
    );
  }
  const open = listByStatus(db, guildId, ["open"]);
  if (open.length === 0) {
    return "There are no open raffles right now.";
  }
  if (open.length > 1) {
    const ids = open.map((r) => `#${r.raffle_id} (${r.name ?? "unnamed"})`).join(", ");
    return `More than one raffle is open — pick one with the \`raffle\` option: ${ids}.`;
  }
  return open[0]!;
}
