/**
 * Public entry-message formatting (pure).
 *
 * Builds the announcement/entry message a raffle posts, rendered as one
 * blockquote card: a heading, the description, a Prize/Starts/Ends/Hosted
 * by/Entries stanza, then the phase line — the eligibility requirements while
 * open (design.md "Entry flow"), a closed notice after close, and the winners
 * once drawn. The same card is edited in place through the raffle's life, so
 * every phase shares this one builder. Times render via Discord timestamp
 * markup so each viewer sees their own timezone. No discord.js import; the
 * Discord adapter attaches the Enter button and sends this content.
 */

import { plural } from "./format.js";
import { discordTimestamp } from "./time.js";

/** The raffle fields the entry message needs (a plain projection of the row). */
export interface EntryMessageInput {
  name: string | null;
  prize: string | null;
  description: string | null;
  /** When true, anyone not blacklisted may enter — every gate below is waived. */
  openToAll: boolean;
  reqMessages: number | null;
  /** K: distinct active days required (kept vague on the public card). */
  reqActiveDays: number | null;
  reqDays: number | null;
  minAccountAgeDays: number | null;
  /** Minimum days in the server before entering (a non-gameable tenure floor). */
  minServerAgeDays: number | null;
  startsAt: string | null;
  endsAt: string | null;
  /** Winner cooldown (raffle override resolved against guild defaults). */
  cooldownDays: number | null;
  cooldownCount: number | null;
  /** Whether anyone who ever won here is barred from this raffle. */
  excludePriorWinners: boolean;
  /** The raffle's creator, shown as "Hosted by". */
  hostId: string | null;
  /** Current number of entries; the card is re-edited as this grows. */
  entryCount: number;
  /** A test raffle: badge the message prize-free (design.md "Test raffles"). */
  isTest?: boolean;
}

/** Which lifecycle phase the card is rendered for. */
export type EntryMessagePhase =
  | { phase: "open" }
  | { phase: "closed" }
  | { phase: "drawn"; winnerIds: string[] };

/**
 * Where a raffle's entry message is posted: the raffle's own channel override if
 * set, otherwise the guild's default announce channel. Null when neither is
 * configured (nothing to post to). Pure — the caller does the posting.
 */
export function resolveAnnounceChannelId(
  raffleChannelId: string | null,
  guildAnnounceChannel: string | null,
): string | null {
  return raffleChannelId ?? guildAnnounceChannel;
}

/**
 * The plain-language eligibility subtext shown while the raffle is open.
 * Rendered as Discord subtext ("-# "): present but unobtrusive, in the slot
 * the winner line takes over once the raffle is drawn. Non-gameable gates
 * (account age, server tenure, cooldowns, the prior-winner bar) are stated
 * exactly; the activity gate deliberately omits the message and active-day
 * counts — publishing the exact numbers would invite gaming them with a burst
 * of filler messages right before the raffle.
 */
function requirementsLines(raffle: EntryMessageInput): string[] {
  // An open-to-everyone raffle waives every gate; say so and stop.
  if (raffle.openToAll) {
    return ["-# Open to everyone — press Enter to join."];
  }

  const requirements: string[] = [];
  if ((raffle.reqMessages || raffle.reqActiveDays) && raffle.reqDays) {
    requirements.push(
      `have been active in the ${plural(raffle.reqDays, "day")} before the raffle starts`,
    );
  }
  if (raffle.minAccountAgeDays) {
    requirements.push(
      `have a Discord account at least ${plural(raffle.minAccountAgeDays, "day")} old`,
    );
  }
  if (raffle.minServerAgeDays) {
    requirements.push(
      `have been in the server at least ${plural(raffle.minServerAgeDays, "day")}`,
    );
  }

  const lines: string[] = [
    requirements.length
      ? `-# To enter, you must ${requirements.join(", and ")}.`
      : "-# Open to everyone — press Enter to join.",
  ];
  if (raffle.excludePriorWinners) {
    lines.push("-# Members who have won a raffle here before cannot enter this one.");
  } else if (raffle.cooldownDays || raffle.cooldownCount) {
    const waits: string[] = [];
    if (raffle.cooldownDays) {
      waits.push(`wait ${plural(raffle.cooldownDays, "day")}`);
    }
    if (raffle.cooldownCount) {
      waits.push(`sit out the next ${plural(raffle.cooldownCount, "raffle")}`);
    }
    lines.push(`-# Recent winners must ${waits.join(" and ")} before entering again.`);
  }
  return lines;
}

/**
 * Build the full entry-message card for a phase. Returned as a single string;
 * every line is blockquoted so the message reads as one card.
 */
export function formatEntryMessage(
  raffle: EntryMessageInput,
  phase: EntryMessagePhase = { phase: "open" },
): string {
  const badge = raffle.isTest ? "🧪" : "🎟️";
  const suffix =
    phase.phase === "open" ? (raffle.isTest ? " (TEST)" : "") : " (closed)";
  const lines: string[] = [`### ${badge} ${raffle.name ?? "Raffle"}${suffix}`];

  if (raffle.isTest) {
    lines.push("**This is a test raffle — there is no prize.**");
  }
  if (raffle.description) {
    lines.push(...raffle.description.split("\n"));
  }
  lines.push("");

  if (raffle.prize) {
    lines.push(`**Prize:** ${raffle.prize}`);
  }
  if (raffle.startsAt && phase.phase === "open") {
    lines.push(`**Starts:** ${discordTimestamp(raffle.startsAt)}`);
  }
  if (raffle.endsAt) {
    lines.push(
      phase.phase === "open"
        ? `**Ends:** ${discordTimestamp(raffle.endsAt, "R")} (${discordTimestamp(raffle.endsAt)})`
        : `**Ended:** ${discordTimestamp(raffle.endsAt, "R")}`,
    );
  }
  if (raffle.hostId) {
    lines.push(`**Hosted by:** <@${raffle.hostId}>`);
  }
  lines.push(`**Entries:** ${raffle.entryCount}`);
  lines.push("");

  switch (phase.phase) {
    case "open":
      lines.push(...requirementsLines(raffle));
      break;
    case "closed":
      lines.push("**Entries are now closed.** The winner will be announced shortly.");
      break;
    case "drawn": {
      const label = phase.winnerIds.length === 1 ? "Winner" : "Winners";
      lines.push(
        phase.winnerIds.length
          ? `**${label}:** ${phase.winnerIds.map((id) => `<@${id}>`).join(", ")}`
          : "**No winner** — there were no eligible entrants.",
      );
      break;
    }
  }

  // ">>> " quotes the entire rest of the message, blank lines included, so the
  // card renders as one unbroken block. (Per-line "> " breaks on blank lines:
  // a bare ">" renders as a literal ">" instead of an empty quoted line.)
  return `>>> ${lines.join("\n")}`;
}
