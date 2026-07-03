/**
 * Gateway wiring for message counting.
 *
 * Listens for guild messages, filters out anything that should not count
 * (bots, webhooks, non-counted channels), resolves the guild's hourly cap, and
 * records the message in the in-memory MessageCounter. A timer flushes the
 * accumulated counts to the database on an interval.
 *
 * Only counts are ever recorded; message content is never read or stored (the
 * Message Content intent is not even requested).
 */

import { Events, type Client, type Message } from "discord.js";
import type { Database } from "better-sqlite3";
import { isChannelCounted } from "../core/messageCounting.js";
import type { MessageCounter } from "../counting/counter.js";
import { listChannelRules } from "../db/repositories/countedChannels.js";
import { getHourlyCap } from "../db/repositories/guilds.js";

/** Default flush cadence: batch writes every 15 seconds. */
export const DEFAULT_FLUSH_INTERVAL_MS = 15_000;

export interface MessageCounterHandle {
  /** Flush any pending counts and stop the flush timer. */
  stop(): void;
}

/**
 * Whether a message is eligible to count, before applying channel rules.
 * Excludes non-guild messages, bots, webhooks, and system messages (server
 * boosts, join notices, etc.) — those are not member activity even though a
 * real user id may be attached.
 */
export function isCountableMessage(message: Message): boolean {
  if (!message.inGuild()) {
    return false;
  }
  if (message.system) {
    return false;
  }
  if (message.author.bot) {
    return false;
  }
  if (message.webhookId !== null) {
    return false;
  }
  return true;
}

/**
 * The channel id to match against counted-channel rules. For a message posted
 * in a thread, this is the parent channel's id, so rules configured on a
 * channel also govern its threads (a thread has its own distinct id otherwise).
 */
export function resolveCountedChannelId(message: Message): string {
  const channel = message.channel;
  if (channel.isThread() && channel.parentId !== null) {
    return channel.parentId;
  }
  return message.channelId;
}

/**
 * Attach the MessageCreate listener and start the flush timer. Returns a handle
 * whose stop() flushes remaining counts and clears the timer (call on shutdown).
 */
export function attachMessageCounter(
  client: Client,
  db: Database,
  counter: MessageCounter,
  homeGuildId: string,
  flushIntervalMs: number = DEFAULT_FLUSH_INTERVAL_MS,
): MessageCounterHandle {
  client.on(Events.MessageCreate, (message) => {
    if (!isCountableMessage(message)) {
      return;
    }
    // Only the home guild's activity is ever counted. A foreign guild is left
    // on join, but a message can arrive in the brief window before that
    // completes; dropping it here keeps stray rows out of the activity table.
    if (message.guildId !== homeGuildId) {
      return;
    }
    const guildId = message.guildId;
    const rules = listChannelRules(db, guildId);
    if (!isChannelCounted(resolveCountedChannelId(message), rules)) {
      return;
    }
    const cap = getHourlyCap(db, guildId);
    counter.record(guildId, message.author.id, message.createdAt, cap);
  });

  const timer = setInterval(() => {
    try {
      counter.flush(db);
    } catch (err) {
      console.error("Failed to flush message counts:", err);
    }
  }, flushIntervalMs);
  // Do not keep the process alive solely for the flush timer.
  timer.unref?.();

  return {
    stop(): void {
      clearInterval(timer);
      try {
        counter.flush(db);
      } catch (err) {
        console.error("Failed to flush message counts on shutdown:", err);
      }
    },
  };
}
