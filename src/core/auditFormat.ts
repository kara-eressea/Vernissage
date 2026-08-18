/**
 * Audit-channel line formatting (pure).
 *
 * Turns an audit event into a single legible line for the read-only audit
 * channel. Privacy is enforced here by construction (design.md "Auditability",
 * "Blacklist"): this formatter only ever reads a small whitelist of non-sensitive
 * fields (ids, timestamps, winner ids). It never reads a `reason` and never
 * reads any activity/message-count field, so those can never leak into a public
 * post even if a caller includes them in the audit payload. Unknown event types
 * fall back to a safe generic line. No discord.js or database import.
 *
 * The sentence itself is rendered once, in `describeAuditEvent`, against a small
 * `AuditRenderer` seam: the audit channel renders mentions and timestamps as
 * Discord markup, the dashboard's per-raffle timeline renders the same events as
 * names and dates. One switch, two surfaces — so a new event type can never be
 * described one way in chat and another on the web.
 */

import { AUDIT_EVENTS, type AuditEventType } from "./auditEvents.js";
import { userMention } from "./format.js";
import { discordTimestamp } from "./time.js";

/**
 * How one surface renders the two dynamic pieces an audit sentence contains.
 * Everything else in the sentence is fixed copy.
 */
export interface AuditRenderer {
  /** A user, e.g. a Discord mention or a cached display name. */
  mention(userId: string): string;
}

/** The audit channel's renderer: Discord mention markup. */
const DISCORD_RENDERER: AuditRenderer = { mention: userMention };

export interface AuditLineInput {
  eventType: string;
  raffleId: number | null;
  actorId: string | null;
  /** Arbitrary event detail; only whitelisted, non-sensitive fields are read. */
  payload?: unknown;
  /** UTC ISO timestamp. */
  createdAt: string;
}

/** Safely read a string field from an unknown payload; undefined if absent. */
function str(payload: unknown, key: string): string | undefined {
  if (payload && typeof payload === "object" && key in payload) {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

/** Safely read an array of string ids from an unknown payload. */
function strArray(payload: unknown, key: string): string[] {
  if (payload && typeof payload === "object" && key in payload) {
    const value = (payload as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      return value.filter((v): v is string => typeof v === "string");
    }
  }
  return [];
}

/**
 * Describe one audit event as a sentence, with no timestamp — the shared body
 * both the audit channel line and the dashboard timeline are built from.
 */
export function describeAuditEvent(
  event: AuditLineInput,
  renderer: AuditRenderer = DISCORD_RENDERER,
): string {
  const raffle = event.raffleId !== null ? `raffle #${event.raffleId}` : "a raffle";
  const actor = event.actorId ? renderer.mention(event.actorId) : "the system";
  // The user a member-scoped event is about: prefer an explicit payload id,
  // otherwise the actor performed it on themselves (e.g. entering a raffle).
  const subjectId = str(event.payload, "userId") ?? event.actorId;
  const subject = subjectId ? renderer.mention(subjectId) : "a member";

  switch (event.eventType as AuditEventType) {
    case AUDIT_EVENTS.raffleCreated:
      return `📋 ${actor} created ${raffle}`;
    case AUDIT_EVENTS.raffleEdited:
      return `✏️ ${actor} edited ${raffle}`;
    case AUDIT_EVENTS.raffleScheduled:
      return `🗓️ ${actor} scheduled ${raffle}`;
    case AUDIT_EVENTS.raffleOpened:
      return `🎉 ${raffle} is now open for entries`;
    case AUDIT_EVENTS.raffleClosed:
      return `🔒 ${raffle} closed to entries`;
    case AUDIT_EVENTS.raffleCancelled:
      return `🚫 ${actor} cancelled ${raffle}`;
    case AUDIT_EVENTS.entryAccepted:
      return `✅ ${subject} entered ${raffle}`;
    case AUDIT_EVENTS.entryWithdrawn:
      return `↩️ ${subject} withdrew from ${raffle}`;
    case AUDIT_EVENTS.entryRemoved:
      // Deliberately no reason: the audit channel shows that a removal happened,
      // not why (design.md "Blacklist").
      return `➖ ${subject} was removed from ${raffle}`;
    case AUDIT_EVENTS.blacklistAdded:
      return `⛔ ${subject} was blacklisted by ${actor}`;
    case AUDIT_EVENTS.blacklistRemoved:
      return `♻️ ${subject}'s blacklist was lifted by ${actor}`;
    case AUDIT_EVENTS.drawCommitted:
      return `🎲 Draw commitment published for ${raffle}`;
    case AUDIT_EVENTS.raffleDrawn:
    case AUDIT_EVENTS.drawResult: {
      const winners = strArray(event.payload, "winners").map((id) => renderer.mention(id));
      const who = winners.length ? winners.join(", ") : "no eligible entrants";
      return `🏆 ${raffle} drawn — winner(s): ${who}`;
    }
    case AUDIT_EVENTS.drawReroll: {
      // The disqualified/replacement ids are safe to show; the mod-entered
      // reason stays in the DB payload only (mirrors the blacklist rule).
      const replacement = str(event.payload, "replacement");
      const to = replacement ? renderer.mention(replacement) : "no replacement available";
      return `♻️ ${raffle} winner rerolled → ${to}`;
    }
    case AUDIT_EVENTS.winClaimed:
      return `🎁 ${subject} claimed their prize in ${raffle}`;
    case AUDIT_EVENTS.eligibilityReset: {
      // Show what was reset (all/cooldown/activity) but never the counts, which
      // are activity-derived and stay in the DB payload (mirrors the privacy rule).
      const scope = str(event.payload, "scope");
      const what = scope ? ` (${scope})` : "";
      return `🧹 ${actor} reset ${subject}'s raffle eligibility${what}`;
    }
    case AUDIT_EVENTS.externalWinRecorded: {
      // The date is safe to show (it is what the cooldown is measured from), but
      // the moderator's free-text note is not — it is arbitrary text about a
      // member, so it stays in the DB payload, mirroring the blacklist rule.
      const wonAt = str(event.payload, "wonAt");
      const when = wonAt ? ` (won ${discordTimestamp(wonAt, "D")})` : "";
      return `📥 ${actor} recorded a past win for ${subject}${when}`;
    }
    default:
      // Unknown type: emit only the type, raffle id, and timestamp — never the
      // raw payload, which could contain private detail.
      return `ℹ️ ${event.eventType} — ${raffle}`;
  }
}

/** Format one audit event as a single audit-channel line. */
export function formatAuditLine(event: AuditLineInput): string {
  return `${describeAuditEvent(event)} — ${discordTimestamp(event.createdAt, "f")}`;
}
