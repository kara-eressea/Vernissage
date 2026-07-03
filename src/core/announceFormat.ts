/**
 * Public entry-message formatting (pure).
 *
 * Builds the title and body of the announcement/entry message a raffle posts,
 * echoing the design's plain-language eligibility phrasing (design.md "Entry
 * flow" and "Raffle creation wizard" step 5). Times render via Discord
 * timestamp markup so each viewer sees their own timezone. No discord.js import;
 * the Discord adapter attaches the Enter button and sends this content.
 */

import { discordTimestamp } from "./time.js";

/** The raffle fields the entry message needs (a plain projection of the row). */
export interface EntryMessageInput {
  name: string | null;
  prize: string | null;
  reqMessages: number | null;
  reqDays: number | null;
  /** "start" (window ends at raffle start) or "rolling" (ends at entry time). */
  windowAnchor: string;
  minAccountAgeDays: number | null;
  startsAt: string | null;
  endsAt: string | null;
}

export interface EntryMessageContent {
  title: string;
  body: string;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Build the entry message's title and body. */
export function formatEntryMessage(raffle: EntryMessageInput): EntryMessageContent {
  const title = `🎟️ ${raffle.name ?? "Raffle"}`;
  const lines: string[] = [];

  if (raffle.prize) {
    lines.push(`**Prize:** ${raffle.prize}`);
  }
  if (raffle.startsAt) {
    lines.push(`**Opens:** ${discordTimestamp(raffle.startsAt)}`);
  }
  if (raffle.endsAt) {
    lines.push(`**Closes:** ${discordTimestamp(raffle.endsAt)}`);
  }

  const requirements: string[] = [];
  if (raffle.reqMessages && raffle.reqDays) {
    const window =
      raffle.windowAnchor === "rolling"
        ? `in the last ${plural(raffle.reqDays, "day")}`
        : `in the ${plural(raffle.reqDays, "day")} before the raffle starts`;
    requirements.push(
      `have sent at least ${plural(raffle.reqMessages, "message")} ${window}`,
    );
  }
  if (raffle.minAccountAgeDays) {
    requirements.push(
      `have a Discord account at least ${plural(raffle.minAccountAgeDays, "day")} old`,
    );
  }

  lines.push(
    requirements.length
      ? `**To enter, you must ${requirements.join(", and ")}.**`
      : "**Open to everyone — press Enter to join.**",
  );

  return { title, body: lines.join("\n") };
}
