/**
 * Entry orchestration.
 *
 * The single code path shared by the Enter button and `/raffle enter`: gather
 * every `EligibilityInput` field from the repositories, run the pure
 * `checkEligibility`, and on success record the entry + audit row atomically,
 * then mirror it to the audit channel. Also posts a raffle's entry message (with
 * the Enter button) when it opens. All rules live in core; this only gathers,
 * calls, and persists.
 */

import type { Database } from "better-sqlite3";
import { AUDIT_EVENTS } from "../core/auditEvents.js";
import { resolveAnnounceChannelId, formatEntryMessage } from "../core/announceFormat.js";
import { checkEligibility } from "../core/eligibility.js";
import { resolveEntrySettings } from "../core/settings.js";
import { activityWindow } from "../core/time.js";
import type { EligibilityInput, EligibilityResult, WindowAnchor } from "../core/types.js";
import { writeAudit } from "../db/repositories/audit.js";
import { getCountsInWindow } from "../db/repositories/activity.js";
import { isBlacklisted } from "../db/repositories/blacklist.js";
import { addEntry, hasEntry } from "../db/repositories/entries.js";
import type { GuildRow } from "../db/repositories/guilds.js";
import { getGuild } from "../db/repositories/guilds.js";
import {
  countRafflesSince,
  getRaffle,
  updateRaffleFields,
  type RaffleRow,
} from "../db/repositories/raffles.js";
import { getUserWins } from "../db/repositories/wins.js";
import { buildEnterRow } from "./components/enterButton.js";
import type { Notifier } from "./notifier.js";

/** Everything the entry path needs that the Discord layer supplies. */
export interface EntryContext {
  raffle: RaffleRow;
  guild: GuildRow | undefined;
  userId: string;
  /** When the user joined the guild (UTC ISO), or null if unknown. */
  joinedAt: string | null;
  now: string;
}

/** Build the full eligibility input for a member's entry attempt. */
export function gatherEligibilityInput(db: Database, ctx: EntryContext): EligibilityInput {
  const { raffle, guild, userId, now } = ctx;
  const settings = resolveEntrySettings(raffle, {
    default_min_account_age_days: guild?.default_min_account_age_days ?? null,
    default_cooldown_days: guild?.default_cooldown_days ?? null,
    default_cooldown_count: guild?.default_cooldown_count ?? null,
  });

  const wins = getUserWins(db, userId);
  const latestWonAt = wins.reduce<string | null>(
    (latest, w) => (latest === null || w.wonAt > latest ? w.wonAt : latest),
    null,
  );
  const rafflesSinceLastWin =
    latestWonAt === null ? 0 : countRafflesSince(db, raffle.guild_id, latestWonAt);

  const reqMessages = raffle.req_messages ?? 0;
  const reqDays = raffle.req_days && raffle.req_days >= 1 ? raffle.req_days : 1;
  const windowAnchor = (raffle.window_anchor as WindowAnchor) ?? "start";
  const raffleStart = raffle.starts_at ?? now;

  // Counts are already scoped to counted channels at write time, so the window
  // read needs no per-channel filtering.
  const anchor = windowAnchor === "start" ? raffleStart : now;
  const window = activityWindow(anchor, reqDays);
  const dailyCounts = getCountsInWindow(db, raffle.guild_id, userId, window.startDay, window.endDay);

  return {
    status: raffle.status as EligibilityInput["status"],
    blacklisted: isBlacklisted(db, raffle.guild_id, userId, now),
    userSnowflake: userId,
    minAccountAgeDays: settings.minAccountAgeDays,
    cooldown: { cooldownDays: settings.cooldownDays, cooldownCount: settings.cooldownCount },
    wins,
    rafflesSinceLastWin,
    reqMessages,
    reqDays,
    windowAnchor,
    raffleStart,
    newMemberExempt: raffle.new_member_exempt === 1,
    newMemberDays: raffle.new_member_days,
    joinedAt: ctx.joinedAt,
    dailyCounts,
    alreadyEntered: hasEntry(db, raffle.raffle_id, userId),
    now,
  };
}

export interface AttemptResult {
  input: EligibilityInput;
  result: EligibilityResult;
}

/**
 * Attempt an entry: gather input, check eligibility, and on success write the
 * entry + audit row in one transaction and mirror it to the audit channel. The
 * gathered input is returned so the caller can quote numbers in a failure reply.
 */
export function attemptEntry(
  db: Database,
  notifier: Notifier,
  ctx: EntryContext,
): AttemptResult {
  const input = gatherEligibilityInput(db, ctx);
  const result = checkEligibility(input);
  if (!result.ok) {
    return { input, result };
  }

  const { raffle, userId, now } = ctx;
  try {
    db.transaction(() => {
      addEntry(db, raffle.raffle_id, userId, now);
      writeAudit(db, {
        guildId: raffle.guild_id,
        raffleId: raffle.raffle_id,
        eventType: AUDIT_EVENTS.entryAccepted,
        actorId: userId,
        payload: { userId },
        createdAt: now,
      });
    })();
  } catch {
    // A concurrent double-click loses the unique-constraint race; that user is
    // simply already entered.
    return { input, result: { ok: false, reason: "already_entered" } };
  }

  void notifier.mirrorAudit({
    guildId: raffle.guild_id,
    raffleId: raffle.raffle_id,
    eventType: AUDIT_EVENTS.entryAccepted,
    actorId: userId,
    payload: { userId },
    createdAt: now,
  });

  return { input, result: { ok: true } };
}

/**
 * Post a raffle's entry message (with the Enter button) to its resolved channel
 * when it opens, storing the message id. No-ops if the raffle is not open or no
 * announce channel is configured.
 */
export async function announceOpenRaffle(
  db: Database,
  notifier: Notifier,
  raffleId: number,
): Promise<void> {
  const raffle = getRaffle(db, raffleId);
  if (!raffle || raffle.status !== "open") {
    return;
  }
  const guild = getGuild(db, raffle.guild_id);
  const channelId = resolveAnnounceChannelId(raffle.channel_id, guild?.announce_channel ?? null);
  if (!channelId) {
    return;
  }

  const settings = resolveEntrySettings(raffle, {
    default_min_account_age_days: guild?.default_min_account_age_days ?? null,
    default_cooldown_days: guild?.default_cooldown_days ?? null,
    default_cooldown_count: guild?.default_cooldown_count ?? null,
  });
  const content = formatEntryMessage({
    name: raffle.name,
    prize: raffle.prize,
    reqMessages: raffle.req_messages,
    reqDays: raffle.req_days,
    windowAnchor: raffle.window_anchor,
    minAccountAgeDays: settings.minAccountAgeDays,
    startsAt: raffle.starts_at,
    endsAt: raffle.ends_at,
  });

  const messageId = await notifier.postEntryMessage(channelId, content, [
    buildEnterRow(raffleId).toJSON(),
  ]);
  if (messageId) {
    updateRaffleFields(db, raffleId, { message_id: messageId });
  }
}
