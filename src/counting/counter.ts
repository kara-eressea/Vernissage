/**
 * In-memory message counter with batched flush.
 *
 * The gateway fires a MessageCreate for every message; writing each one to
 * SQLite would be wasteful on a busy server. Instead we accumulate counts in
 * memory and flush them to the daily activity buckets on an interval (design.md
 * "Rate limits"). A per-user, per-hour tally enforces the optional anti-spam
 * cap at record time.
 *
 * This service holds no Discord dependency: callers pass plain ids, a
 * timestamp, and the resolved cap, which keeps it unit-testable. Counts held in
 * memory at shutdown are lost — acceptable per the design's downtime note.
 */

import type { Database } from "better-sqlite3";
import { cappedIncrement } from "../core/activity.js";
import { utcDay, utcHour } from "../core/time.js";
import { incrementActivity } from "../db/repositories/activity.js";

interface PendingDay {
  guildId: string;
  userId: string;
  day: string;
  count: number;
}

const SEP = "|";

export class MessageCounter {
  /** Day buckets awaiting flush, keyed by guild|user|day. */
  private readonly pendingDays = new Map<string, PendingDay>();
  /** Per-hour tallies for cap enforcement, keyed by guild|user|hour. */
  private readonly hourly = new Map<string, number>();
  /** The newest hour seen, used to prune stale hourly tallies on flush. */
  private latestHour = "";

  /**
   * Record one message. Returns true if it counted, false if the hourly cap
   * (when set) had already been reached for that user this hour.
   */
  record(
    guildId: string,
    userId: string,
    at: string | Date,
    cap: number | null,
  ): boolean {
    const hour = utcHour(at);
    if (hour > this.latestHour) {
      this.latestHour = hour;
    }

    const hourKey = `${guildId}${SEP}${userId}${SEP}${hour}`;
    const soFar = this.hourly.get(hourKey) ?? 0;
    const counted = cappedIncrement(soFar, 1, cap);
    if (counted <= 0) {
      return false;
    }
    this.hourly.set(hourKey, soFar + counted);

    const day = utcDay(at);
    const dayKey = `${guildId}${SEP}${userId}${SEP}${day}`;
    const existing = this.pendingDays.get(dayKey);
    if (existing) {
      existing.count += counted;
    } else {
      this.pendingDays.set(dayKey, { guildId, userId, day, count: counted });
    }
    return true;
  }

  /** Number of distinct day buckets currently awaiting flush. */
  get pendingWrites(): number {
    return this.pendingDays.size;
  }

  /**
   * Write all pending day buckets to the database in a single transaction and
   * clear them. Returns the number of buckets written. Stale hourly tallies
   * (from an hour older than the latest) are pruned to bound memory.
   */
  flush(db: Database): number {
    const rows = [...this.pendingDays.values()];
    if (rows.length > 0) {
      const write = db.transaction((items: PendingDay[]) => {
        for (const it of items) {
          incrementActivity(db, it.guildId, it.userId, it.day, it.count);
        }
      });
      write(rows);
      this.pendingDays.clear();
    }
    this.pruneHourly();
    return rows.length;
  }

  /** Drop hourly tallies whose hour is no longer the current one. */
  private pruneHourly(): void {
    for (const key of this.hourly.keys()) {
      const hour = key.slice(key.lastIndexOf(SEP) + 1);
      if (hour !== this.latestHour) {
        this.hourly.delete(key);
      }
    }
  }
}
