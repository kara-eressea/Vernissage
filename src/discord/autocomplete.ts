/**
 * Raffle-id autocomplete.
 *
 * Every command option that takes a raffle id offers a picker instead of
 * demanding the number (issue #48). This module answers those requests: it works
 * out which raffles are plausible for the subcommand being typed, hands them to
 * the pure `raffleChoices` formatter, and replies.
 *
 * The candidate set is per subcommand and deliberately narrow — the raffles the
 * command could actually act on. `/raffle-mod draw` offers closed raffles, not
 * every raffle the server has ever run; `/raffle claim` offers only prizes the
 * caller has actually won and not yet claimed. A picker that lists options the
 * command will then refuse is worse than no picker, because it looks like an
 * endorsement of the choice.
 *
 * Suggestions are *not* authorisation. Everything here is a read, and every
 * handler re-checks on execute — a raffle that closed between the suggestion and
 * the submit is refused there, exactly as a hand-typed id would be. Two limits
 * do apply, both about not leaking what the caller cannot see: the guild is
 * always scoped to the one being typed in, and `/raffle-mod` suggestions are
 * withheld from non-moderators, so the picker never reports a raffle's existence
 * to someone the command itself would turn away.
 */

import type { AutocompleteInteraction } from "discord.js";
import { raffleChoices, type ChoosableRaffle } from "../core/raffleChoices.js";
import type { RaffleStatus } from "../core/types.js";
import { hasEntry } from "../db/repositories/entries.js";
import { getGuild } from "../db/repositories/guilds.js";
import { listByStatus } from "../db/repositories/raffles.js";
import { getActiveWinForUser } from "../db/repositories/wins.js";
import { RAFFLE_COMMAND, RAFFLE_MOD_COMMAND } from "./commands/raffle/index.js";
import type { CommandContext } from "./commands/index.js";
import { isModeratorInteraction } from "./commands/moderator.js";

/** The option name every raffle-id picker uses. */
const RAFFLE_OPTION = "raffle";

/** What a candidate source is given to work out which raffles to offer. */
interface CandidateQuery {
  db: CommandContext["db"];
  guildId: string;
  /** The member typing — the picker is personal where the command is. */
  userId: string;
}

/** Which raffles a subcommand should offer. */
type CandidateSource = (query: CandidateQuery) => ChoosableRaffle[];

/** Offer every raffle in the given statuses. */
function inStatus(...statuses: RaffleStatus[]): CandidateSource {
  return ({ db, guildId }) => listByStatus(db, guildId, statuses);
}

/** Offer the open raffles the caller currently holds an entry in. */
const enteredByCaller: CandidateSource = ({ db, guildId, userId }) =>
  listByStatus(db, guildId, ["open"]).filter((r) => hasEntry(db, r.raffle_id, userId));

/** Offer the drawn raffles where the caller has a prize still to claim. */
const claimableByCaller: CandidateSource = ({ db, guildId, userId }) =>
  listByStatus(db, guildId, ["drawn"]).filter((r) => {
    const win = getActiveWinForUser(db, r.raffle_id, userId);
    return win !== undefined && win.claim_deadline !== null && win.claimed_at === null;
  });

/**
 * The candidate set per subcommand, keyed `command:subcommand`.
 *
 * A subcommand absent from this table gets no suggestions rather than a
 * fallback of "every raffle": a new id option should have its candidates thought
 * about, and silence is the honest answer until someone does.
 */
const SOURCES: Record<string, CandidateSource> = {
  // Members: what they can act on, from where they stand.
  [`${RAFFLE_COMMAND}:enter`]: inStatus("open"),
  [`${RAFFLE_COMMAND}:withdraw`]: enteredByCaller,
  [`${RAFFLE_COMMAND}:status`]: inStatus("open", "scheduled"),
  [`${RAFFLE_COMMAND}:claim`]: claimableByCaller,
  // Moderators: what each command is valid on. These mirror the status checks
  // the handlers themselves apply.
  [`${RAFFLE_MOD_COMMAND}:edit`]: inStatus("draft", "scheduled", "open"),
  [`${RAFFLE_MOD_COMMAND}:cancel`]: inStatus("draft", "scheduled", "open", "closed"),
  [`${RAFFLE_MOD_COMMAND}:draw`]: inStatus("closed"),
  [`${RAFFLE_MOD_COMMAND}:announce`]: inStatus("drawn"),
  [`${RAFFLE_MOD_COMMAND}:reroll`]: inStatus("drawn"),
  [`${RAFFLE_MOD_COMMAND}:remove-entry`]: inStatus("open"),
};

/**
 * Whether this interaction should receive suggestions at all, and from where.
 * Returns the candidate source, or null to answer with an empty list.
 */
export function selectSource(
  commandName: string,
  subcommand: string | null,
  isModerator: boolean,
): CandidateSource | null {
  if (subcommand === null) {
    return null;
  }
  // The moderator surface is hidden from members by Discord; don't let the
  // picker describe it to anyone who reaches it anyway.
  if (commandName === RAFFLE_MOD_COMMAND && !isModerator) {
    return null;
  }
  return SOURCES[`${commandName}:${subcommand}`] ?? null;
}

/**
 * Answer one autocomplete interaction.
 *
 * Never throws: Discord gives a three-second window and no way to report a
 * failure to the member, so anything unexpected degrades to an empty list —
 * a picker that offers nothing, leaving the id typeable by hand — rather than
 * an unhandled rejection.
 */
export async function routeAutocomplete(
  interaction: AutocompleteInteraction,
  ctx: CommandContext,
): Promise<void> {
  try {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== RAFFLE_OPTION || !interaction.guildId) {
      await interaction.respond([]);
      return;
    }

    const modRole = getGuild(ctx.db, interaction.guildId)?.mod_role ?? null;
    const source = selectSource(
      interaction.commandName,
      interaction.options.getSubcommand(false),
      isModeratorInteraction(interaction, modRole),
    );
    if (!source) {
      await interaction.respond([]);
      return;
    }

    const candidates = source({
      db: ctx.db,
      guildId: interaction.guildId,
      userId: interaction.user.id,
    });
    await interaction.respond(raffleChoices(candidates, String(focused.value ?? "")));
  } catch (err) {
    console.error(`Error answering autocomplete for /${interaction.commandName}:`, err);
    // The window may already have closed, in which case this throws too.
    try {
      await interaction.respond([]);
    } catch {
      // Nothing left to do; the member sees no suggestions and types the id.
    }
  }
}
