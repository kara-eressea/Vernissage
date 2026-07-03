/**
 * Counted-channels repository.
 *
 * Per-guild include/exclude rules controlling which channels' messages count
 * toward activity. Read into the pure isChannelCounted decision.
 */

import type { Database } from "better-sqlite3";
import type { ChannelRule } from "../../core/messageCounting.js";
import type { ChannelMode } from "../../core/types.js";

/** Add or update a channel's include/exclude rule for a guild. */
export function setChannelRule(
  db: Database,
  guildId: string,
  channelId: string,
  mode: ChannelMode,
): void {
  db.prepare(
    `INSERT INTO counted_channels (guild_id, channel_id, mode)
     VALUES (?, ?, ?)
     ON CONFLICT (guild_id, channel_id) DO UPDATE SET mode = excluded.mode`,
  ).run(guildId, channelId, mode);
}

/** Remove a channel's rule, if any. */
export function removeChannelRule(
  db: Database,
  guildId: string,
  channelId: string,
): void {
  db.prepare(
    `DELETE FROM counted_channels WHERE guild_id = ? AND channel_id = ?`,
  ).run(guildId, channelId);
}

/** All channel rules for a guild, as core ChannelRule objects. */
export function listChannelRules(db: Database, guildId: string): ChannelRule[] {
  const rows = db
    .prepare(
      `SELECT channel_id, mode FROM counted_channels WHERE guild_id = ?`,
    )
    .all(guildId) as Array<{ channel_id: string; mode: ChannelMode }>;
  return rows.map((r) => ({ channelId: r.channel_id, mode: r.mode }));
}
