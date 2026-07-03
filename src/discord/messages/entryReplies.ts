/**
 * Entry reply copy (pure).
 *
 * Maps an eligibility outcome to the ephemeral message a member sees, quoting
 * the concrete numbers (activity have/need, cooldown remaining) so the reply is
 * actionable (design.md "Entry flow"). Blacklist rejections honor the guild's
 * generic-message toggle. No discord.js/database import.
 */

import { activityProgress } from "../../core/eligibility.js";
import { winCooldownStatus } from "../../core/cooldown.js";
import { discordTimestamp } from "../../core/time.js";
import type { EligibilityInput, IneligibleReason } from "../../core/types.js";

/** The message for a successful entry. */
export function entrySuccessMessage(raffleName: string | null): string {
  return `🎟️ You're entered into **${raffleName ?? "the raffle"}**. Good luck!`;
}

/**
 * The message for a failed entry. `input` is the same gathered eligibility
 * input, so activity/cooldown numbers can be quoted. `blacklistGeneric` hides
 * the blacklist reason behind a generic line when the guild opts in.
 */
export function entryFailureMessage(
  reason: IneligibleReason,
  input: EligibilityInput,
  blacklistGeneric: boolean,
): string {
  switch (reason) {
    case "not_open":
      return "This raffle isn't open for entries.";
    case "blacklisted":
      return blacklistGeneric
        ? "You're not eligible to enter this raffle."
        : "You're blacklisted from raffles in this server.";
    case "account_too_new":
      return "Your Discord account is too new to enter this raffle.";
    case "in_cooldown": {
      const status = winCooldownStatus({
        cooldownDays: input.cooldown.cooldownDays,
        cooldownCount: input.cooldown.cooldownCount,
        wins: input.wins,
        rafflesSinceLastWin: input.rafflesSinceLastWin,
        now: input.now,
      });
      const parts: string[] = [];
      if (status.endsAt && Date.parse(status.endsAt) > Date.parse(input.now)) {
        parts.push(`until ${discordTimestamp(status.endsAt, "R")}`);
      }
      if (status.rafflesRemaining && status.rafflesRemaining > 0) {
        parts.push(`for ${status.rafflesRemaining} more raffle(s)`);
      }
      const detail = parts.length ? ` (${parts.join(", ")})` : "";
      return `You're on a win cooldown${detail} and can't enter yet.`;
    }
    case "insufficient_activity": {
      const p = activityProgress(input);
      return `You need ${p.need} messages to enter — you have ${p.have}. Keep chatting!`;
    }
    case "already_entered":
      return "You're already entered into this raffle.";
  }
}
