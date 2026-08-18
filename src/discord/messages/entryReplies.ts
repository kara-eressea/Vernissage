/**
 * Entry reply copy (pure).
 *
 * Maps an eligibility outcome to the ephemeral message a member sees. Cooldown
 * timing (non-gameable) is quoted exactly, but the activity thresholds are kept
 * vague on every member-facing surface — publishing the message/active-day bar
 * would invite gaming it (design.md "Entry flow", activity-privacy rule). Which
 * of the two floors was missed *is* named, though: the dimension guides a member
 * toward the behaviour the gate rewards without revealing a number.
 * Blacklist rejections honor the guild's generic-message toggle. No
 * discord.js/database import.
 */

import { activityShortfall } from "../../core/eligibility.js";
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
    case "too_new_to_server":
      return "You haven't been in the server long enough to enter this raffle yet.";
    case "in_cooldown": {
      const status = winCooldownStatus({
        cooldownDays: input.cooldown.cooldownDays,
        cooldownCount: input.cooldown.cooldownCount,
        wins: input.wins,
        rafflesSinceLastWin: input.rafflesSinceLastWin,
        now: input.raffleStart,
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
    case "insufficient_activity":
      return `Sorry, you're not eligible for this raffle — ${activityShortfallCopy(input)}`;
    case "already_entered":
      return "You're already entered into this raffle. Changed your mind? Use `/raffle withdraw`.";
  }
}

/**
 * Which activity floor the member missed, as a phrase.
 *
 * Naming the *dimension* is not the same as publishing the *bar*: "on too few
 * separate days" points a member at posting a little across more days, which is
 * exactly the sustained participation the distinct-day floor exists to reward.
 * The numbers stay hidden either way (design.md "Entry flow", activity-privacy
 * rule) — so no count, threshold, or "N more" appears here.
 *
 * The distinction matters because the old single line ("not enough recent
 * activity") read as a message-count problem to every member who hit the spread
 * floor with plenty of messages, and sent them looking for a counting bug
 * instead of at the actual requirement.
 */
function activityShortfallCopy(input: EligibilityInput): string {
  const { missesVolume, missesSpread } = activityShortfall(input);
  // Spread only: they talked plenty, just in too few sittings. Saying "be more
  // active" here would be wrong and is what caused the confusion.
  if (missesSpread && !missesVolume) {
    return (
      "you were active here before it started, just not across enough separate days. " +
      "This raffle looks for activity spread over several days rather than one busy session — " +
      "chatting a little on more days will help you qualify for future ones."
    );
  }
  if (missesSpread && missesVolume) {
    return (
      "you weren't active enough here before it started, and what you did send landed on too few separate days. " +
      "Chatting a little on more days will help you qualify for future ones."
    );
  }
  // Volume only (and the defensive fallback if neither floor reports a miss):
  // activity is measured up to the raffle's start, so say so plainly rather than
  // inviting a futile burst of messages now ("keep chatting" would mislead —
  // posting after it opened can't help this raffle).
  return (
    "you weren't active enough here before it started. " +
    "Staying active will help you qualify for future ones."
  );
}

/** The `/raffle status` activity line, split by floor like the failure copy. */
function activityStatusLine(input: EligibilityInput): string {
  const { missesVolume, missesSpread } = activityShortfall(input);
  if (!missesVolume && !missesSpread) {
    return "- ✅ Activity: you've been active enough recently";
  }
  if (missesSpread && !missesVolume) {
    return "- ⬜ Activity: enough messages, but not spread across enough separate days yet";
  }
  if (missesSpread && missesVolume) {
    return "- ⬜ Activity: not enough recent activity, and not on enough separate days yet";
  }
  return "- ⬜ Activity: not enough recent activity yet";
}

/** The `/raffle status` card: the member's standing against one raffle's gates. */
export function statusMessage(raffleName: string | null, input: EligibilityInput): string {
  const cooldown = winCooldownStatus({
    cooldownDays: input.cooldown.cooldownDays,
    cooldownCount: input.cooldown.cooldownCount,
    wins: input.wins,
    rafflesSinceLastWin: input.rafflesSinceLastWin,
    now: input.raffleStart,
  });

  const lines = [`**Your status for ${raffleName ?? "the raffle"}**`];
  if (input.blacklisted) {
    lines.push("- ⛔ You're blacklisted from raffles in this server.");
  }
  if (input.isCreator) {
    lines.push("- ⛔ You created this raffle, so you can't enter it.");
  }
  // An open-to-everyone raffle waives every requirement below; there's nothing
  // more to report than whether they're in.
  if (input.openToAll) {
    lines.push("- ✅ This raffle is open to everyone.");
    lines.push(input.alreadyEntered ? "- 🎟️ You're already entered." : "- ⬜ Not entered yet.");
    return lines.join("\n");
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
  lines.push(activityStatusLine(input));
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
