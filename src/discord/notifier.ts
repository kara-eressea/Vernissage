/**
 * The notifier: the single Discord-posting seam.
 *
 * Two jobs, both resilient: mirror `audit_log` events to the guild's configured
 * audit channel, and post the public entry/announcement message. All wording
 * lives in the pure core formatters (auditFormat, announceFormat); this adapter
 * only resolves channels and sends, following the messageCounter.ts split of
 * pure-helper + thin-wiring.
 *
 * Nothing here throws or leaves an unhandled rejection: a missing/unset/non-text
 * channel, a fetch error, or a send rejection is logged and swallowed. A broken
 * audit channel must never take down a raffle transition or a command.
 */

import type { Client } from "discord.js";
import type { Database } from "better-sqlite3";
import { formatAuditLine } from "../core/auditFormat.js";
import type { EntryMessageContent } from "../core/announceFormat.js";
import type { AuditEvent } from "../db/repositories/audit.js";
import { getGuild } from "../db/repositories/guilds.js";

/** The minimal channel shape we need: a text channel we can send to. */
interface SendableChannel {
  send(payload: {
    content: string;
    allowedMentions?: { parse: [] | ["users"] };
    components?: readonly unknown[];
  }): Promise<{ id: string }>;
}

export interface Notifier {
  /** Resolve the guild's audit channel, or undefined if unset/missing/non-text. */
  resolveAuditChannel(guildId: string): Promise<SendableChannel | undefined>;
  /** Post an audit event to the guild's audit channel. Never throws. */
  mirrorAudit(event: AuditEvent): Promise<void>;
  /**
   * Post the entry message to a specific channel; returns the message id (for
   * the caller to store in `raffles.message_id`), or undefined on failure.
   */
  postEntryMessage(
    channelId: string,
    content: EntryMessageContent,
    components?: readonly unknown[],
  ): Promise<string | undefined>;
  /**
   * Post pre-formatted text to the guild's audit channel (mentions suppressed).
   * Used for the draw's provably-fair verification data, which the narrow
   * `mirrorAudit` ledger line intentionally omits. Never throws.
   */
  postAudit(guildId: string, content: string): Promise<void>;
  /**
   * Post a public announcement (e.g. the winner reveal) to a channel, allowing
   * user mentions so winners are pinged. Never throws; undefined on failure.
   */
  postAnnouncement(channelId: string, content: string): Promise<string | undefined>;
}

/**
 * Fetch a channel by id and return it only if it is a sendable text channel;
 * undefined on any error or unsuitable channel. Never throws.
 */
async function fetchSendable(
  client: Client,
  channelId: string,
): Promise<SendableChannel | undefined> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && channel.isTextBased() && "send" in channel) {
      return channel as unknown as SendableChannel;
    }
  } catch (err) {
    console.error(`Failed to fetch channel ${channelId}:`, err);
  }
  return undefined;
}

/** Build the notifier bound to a Discord client and the database. */
export function createNotifier(client: Client, db: Database): Notifier {
  async function resolveAuditChannel(
    guildId: string,
  ): Promise<SendableChannel | undefined> {
    const auditChannel = getGuild(db, guildId)?.audit_channel;
    if (!auditChannel) {
      return undefined;
    }
    return fetchSendable(client, auditChannel);
  }

  async function mirrorAudit(event: AuditEvent): Promise<void> {
    if (!event.guildId) {
      return;
    }
    const channel = await resolveAuditChannel(event.guildId);
    if (!channel) {
      return;
    }
    try {
      await channel.send({
        content: formatAuditLine({
          eventType: event.eventType,
          raffleId: event.raffleId,
          actorId: event.actorId,
          payload: event.payload,
          createdAt: event.createdAt,
        }),
        // Suppress pings: the audit channel is a quiet, read-only ledger; the
        // mention still renders as a name, it just doesn't notify anyone.
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      console.error("Failed to mirror audit event to channel:", err);
    }
  }

  async function postEntryMessage(
    channelId: string,
    content: EntryMessageContent,
    components?: readonly unknown[],
  ): Promise<string | undefined> {
    const channel = await fetchSendable(client, channelId);
    if (!channel) {
      return undefined;
    }
    try {
      const message = await channel.send({
        content: `**${content.title}**\n${content.body}`,
        allowedMentions: { parse: [] },
        components,
      });
      return message.id;
    } catch (err) {
      console.error(`Failed to post entry message to channel ${channelId}:`, err);
      return undefined;
    }
  }

  async function postAudit(guildId: string, content: string): Promise<void> {
    const channel = await resolveAuditChannel(guildId);
    if (!channel) {
      return;
    }
    try {
      await channel.send({ content, allowedMentions: { parse: [] } });
    } catch (err) {
      console.error("Failed to post to audit channel:", err);
    }
  }

  async function postAnnouncement(
    channelId: string,
    content: string,
  ): Promise<string | undefined> {
    const channel = await fetchSendable(client, channelId);
    if (!channel) {
      return undefined;
    }
    try {
      // Winners should actually be pinged, unlike the quiet audit ledger.
      const message = await channel.send({ content, allowedMentions: { parse: ["users"] } });
      return message.id;
    } catch (err) {
      console.error(`Failed to post announcement to channel ${channelId}:`, err);
      return undefined;
    }
  }

  return { resolveAuditChannel, mirrorAudit, postEntryMessage, postAudit, postAnnouncement };
}
