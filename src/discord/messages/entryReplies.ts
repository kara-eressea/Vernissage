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
    case "is_creator":
      return "You can't enter a raffle you created.";
    case "missing_required_role":
      return input.requiredRoleId
        ? `You need the <@&${input.requiredRoleId}> role to enter this raffle.`
        : "You don't have the role required to enter this raffle.";
    case "has_excluded_role":
      return input.excludedRoleId
        ? `Members with the <@&${input.excludedRoleId}> role can't enter this raffle.`
        : "Your role makes you ineligible for this raffle.";
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
    case "prior_winner":
      return "This raffle is only open to members who haven't won here before.";
    case "insufficient_activity": {
      const p = activityProgress(input);
      return `You need ${p.need} messages to enter — you have ${p.have}. Keep chatting!`;
    }
    case "already_entered":
      return "You're already entered into this raffle.";
  }
}

/** The `/raffle status` card: the member's standing against one raffle's gates. */
export function statusMessage(raffleName: string | null, input: EligibilityInput): string {
  const progress = activityProgress(input);
  const cooldown = winCooldownStatus({
    cooldownDays: input.cooldown.cooldownDays,
    cooldownCount: input.cooldown.cooldownCount,
    wins: input.wins,
    rafflesSinceLastWin: input.rafflesSinceLastWin,
    now: input.now,
  });

  const lines = [`**Your status for ${raffleName ?? "the raffle"}**`];
  if (input.blacklisted) {
    lines.push("- ⛔ You're blacklisted from raffles in this server.");
  }
  if (input.isCreator) {
    lines.push("- ⛔ You created this raffle, so you can't enter it.");
  }
  if (input.requiredRoleId) {
    lines.push(
      input.userRoleIds.includes(input.requiredRoleId)
        ? `- ✅ You have the required <@&${input.requiredRoleId}> role.`
        : `- ⛔ Requires the <@&${input.requiredRoleId}> role.`,
    );
  }
  if (input.excludedRoleId && input.userRoleIds.includes(input.excludedRoleId)) {
    lines.push(`- ⛔ Your <@&${input.excludedRoleId}> role blocks entry.`);
  }
  if (input.excludePriorWinners) {
    lines.push(
      input.hasPriorWin
        ? "- ⛔ Past winners can't enter this one."
        : "- ✅ Limited to members who haven't won here before.",
    );
  }
  lines.push(
    progress.exempt
      ? "- ✅ Activity: exempt (new member)"
      : `- ${progress.have >= progress.need ? "✅" : "⬜"} Activity: ${progress.have}/${progress.need} messages`,
  );
  lines.push(
    cooldown.active
      ? `- ⏳ Win cooldown active${cooldown.endsAt ? ` until ${discordTimestamp(cooldown.endsAt, "R")}` : ""}`
      : "- ✅ No win cooldown",
  );
  lines.push(input.alreadyEntered ? "- 🎟️ You're already entered." : "- ⬜ Not entered yet.");
  return lines.join("\n");
}

/** The raffle fields `/raffle list` needs (a plain projection of the row). */
export interface RaffleListItem {
  raffle_id: number;
  name: string | null;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
}

/** The `/raffle list` reply: one line per open/upcoming raffle. */
export function raffleListMessage(raffles: RaffleListItem[]): string {
  const lines = raffles.map((r) => {
    const when =
      r.status === "open"
        ? r.ends_at
          ? `open, closes ${discordTimestamp(r.ends_at, "R")}`
          : "open"
        : r.starts_at
          ? `opens ${discordTimestamp(r.starts_at, "R")}`
          : "upcoming";
    return `- **${r.name ?? `Raffle #${r.raffle_id}`}** (#${r.raffle_id}) — ${when}`;
  });
  return `**Raffles**\n${lines.join("\n")}`;
}
