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
 */

import { AUDIT_EVENTS, type AuditEventType } from "./auditEvents.js";
import { userMention } from "./format.js";
import { discordTimestamp } from "./time.js";

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

/** Format one audit event as a single audit-channel line. */
export function formatAuditLine(event: AuditLineInput): string {
  const when = discordTimestamp(event.createdAt, "f");
  const raffle = event.raffleId !== null ? `raffle #${event.raffleId}` : "a raffle";
  const actor = event.actorId ? userMention(event.actorId) : "the system";
  // The user a member-scoped event is about: prefer an explicit payload id,
  // otherwise the actor performed it on themselves (e.g. entering a raffle).
  const subjectId = str(event.payload, "userId") ?? event.actorId;
  const subject = subjectId ? userMention(subjectId) : "a member";

  switch (event.eventType as AuditEventType) {
    case AUDIT_EVENTS.raffleCreated:
      return `📋 ${actor} created ${raffle} — ${when}`;
    case AUDIT_EVENTS.raffleEdited:
      return `✏️ ${actor} edited ${raffle} — ${when}`;
    case AUDIT_EVENTS.raffleScheduled:
      return `🗓️ ${actor} scheduled ${raffle} — ${when}`;
    case AUDIT_EVENTS.raffleOpened:
      return `🎉 ${raffle} is now open for entries — ${when}`;
    case AUDIT_EVENTS.raffleClosed:
      return `🔒 ${raffle} closed to entries — ${when}`;
    case AUDIT_EVENTS.raffleCancelled:
      return `🚫 ${actor} cancelled ${raffle} — ${when}`;
    case AUDIT_EVENTS.entryAccepted:
      return `✅ ${subject} entered ${raffle} — ${when}`;
    case AUDIT_EVENTS.entryRemoved:
      // Deliberately no reason: the audit channel shows that a removal happened,
      // not why (design.md "Blacklist").
      return `➖ ${subject} was removed from ${raffle} — ${when}`;
    case AUDIT_EVENTS.blacklistAdded:
      return `⛔ ${subject} was blacklisted by ${actor} — ${when}`;
    case AUDIT_EVENTS.blacklistRemoved:
      return `♻️ ${subject}'s blacklist was lifted by ${actor} — ${when}`;
    case AUDIT_EVENTS.drawCommitted:
      return `🎲 Draw commitment published for ${raffle} — ${when}`;
    case AUDIT_EVENTS.raffleDrawn:
    case AUDIT_EVENTS.drawResult: {
      const winners = strArray(event.payload, "winners").map(userMention);
      const who = winners.length ? winners.join(", ") : "no eligible entrants";
      return `🏆 ${raffle} drawn — winner(s): ${who} — ${when}`;
    }
    default:
      // Unknown type: emit only the type, raffle id, and timestamp — never the
      // raw payload, which could contain private detail.
      return `ℹ️ ${event.eventType} — ${raffle} — ${when}`;
  }
}
