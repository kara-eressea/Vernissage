/**
 * Plain-language raffle summary (pure).
 *
 * Produces the human-readable lines shown on the wizard's summary card and,
 * later, in announcements — e.g. "To enter, members must have sent at least 20
 * messages in the 14 days before the raffle starts" (design.md "Raffle creation
 * wizard" step 5). Wording switches on the window anchor. Returns strings only;
 * the Discord layer assembles the embed. No discord.js/database import.
 */

import { discordTimestamp } from "./time.js";
import type { ResolvedRaffleSettings } from "./raffleValidation.js";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Build the summary lines for a resolved raffle configuration. */
export function describeRaffle(settings: ResolvedRaffleSettings): string[] {
  const lines: string[] = [];

  lines.push(`**${settings.name ?? "Untitled raffle"}**`);
  if (settings.prize) {
    lines.push(`Prize: ${settings.prize}`);
  }
  if (settings.description) {
    lines.push(settings.description);
  }

  if (settings.starts_at) {
    lines.push(`Opens ${discordTimestamp(settings.starts_at)}.`);
  }
  if (settings.ends_at) {
    lines.push(`Closes ${discordTimestamp(settings.ends_at)}.`);
  }

  // Eligibility sentence, switching on the window anchor.
  if (settings.req_messages && settings.req_days) {
    const window =
      settings.window_anchor === "rolling"
        ? `in the ${plural(settings.req_days, "day")} before they enter`
        : `in the ${plural(settings.req_days, "day")} before the raffle starts`;
    lines.push(
      `To enter, members must have sent at least ${plural(settings.req_messages, "message")} ${window}.`,
    );
  }

  if (settings.min_account_age_days) {
    lines.push(
      `Their Discord account must be at least ${plural(settings.min_account_age_days, "day")} old.`,
    );
  }

  if (settings.new_member_exempt === 1 && settings.new_member_days) {
    lines.push(
      `Members who joined in the last ${plural(settings.new_member_days, "day")} are exempt from the activity requirement.`,
    );
  }

  const winnerCount = settings.winner_count ?? 1;
  const drawMode = settings.draw_mode === "manual" ? "drawn manually by a mod" : "drawn automatically at close";
  lines.push(`${plural(winnerCount, "winner")} will be ${drawMode}.`);

  if (settings.cooldown_days || settings.cooldown_count) {
    const parts: string[] = [];
    if (settings.cooldown_days) parts.push(`${plural(settings.cooldown_days, "day")}`);
    if (settings.cooldown_count) parts.push(`${plural(settings.cooldown_count, "raffle")}`);
    lines.push(`Winners must wait ${parts.join(" and ")} before entering again.`);
  }

  return lines;
}
