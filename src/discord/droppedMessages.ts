/**
 * Dropped-message watchdog (diagnostics for issue #28).
 *
 * discord.js resolves a message's channel from its cache *before* emitting
 * `messageCreate`: `MessageCreateAction` calls `Action.getChannel`, which returns
 * `client.channels.cache.get(id)` unless the `Channel` partial is enabled (we
 * enable no partials). When the channel is missing from the cache the action
 * returns early — no event, no error, no log line. Our counting listener never
 * runs and the message is simply never counted.
 *
 * That matters most for threads. A guild's *active* threads arrive with
 * GUILD_CREATE and are cached; archived ones are not, and discord.js sweeps
 * archived threads out of the cache on a timer. So a member reviving a
 * long-dormant thread can post into a channel the bot has no cache entry for.
 *
 * This watchdog listens on the raw gateway dispatch, which fires for every
 * packet *before* discord.js handles it — so it observes exactly the cache state
 * the message handler is about to see. When a message that we would have counted
 * arrives for an uncached channel, it:
 *   - counts it and logs it (so the failure stops being invisible), and
 *   - fetches the channel once, which populates the cache, so *subsequent*
 *     messages there are delivered and counted normally.
 *
 * The message that triggered the recovery is still not counted: recovering it
 * would mean re-deriving countability and the thread's parent from the raw
 * payload, i.e. a second implementation of the counting path. That is the
 * follow-up decision recorded on the issue, not something this watchdog does.
 */

import { Events, type Client } from "discord.js";

/**
 * Message types that are member activity, mirroring discord.js's
 * `NonSystemMessageTypes` (Default, Reply, ChatInputCommand, ContextMenuCommand)
 * — the exact set `Message#system` treats as non-system, which is what
 * `isCountableMessage` filters on. Anything else (joins, boosts, pins) is a
 * system message and never counted.
 */
const COUNTABLE_MESSAGE_TYPES = new Set([0, 19, 20, 23]);

/** How often the watchdog logs a running summary, when anything has dropped. */
export const DEFAULT_SUMMARY_INTERVAL_MS = 60 * 60 * 1000;

/** Cap on channels we track, so a pathological guild can't grow the maps. */
const MAX_TRACKED_CHANNELS = 500;

/** The fields the watchdog reads from a raw MESSAGE_CREATE payload. */
export interface RawMessagePayload {
  channel_id?: string;
  guild_id?: string;
  type?: number;
  webhook_id?: string;
  author?: { id?: string; bot?: boolean };
}

/** A raw gateway dispatch, as `Events.Raw` delivers it. */
export interface RawDispatch {
  t?: string | null;
  d?: unknown;
}

/**
 * Whether this raw payload is one the counting listener would have counted, had
 * the event reached it: a guild message in an allowlisted guild, from a human,
 * not a webhook, not a system message. Deliberately mirrors
 * `isCountableMessage`; channel rules and the hourly cap are *not* applied here,
 * because a dropped event never reached them either — this answers "would we
 * have looked at it", which is what makes a drop worth reporting.
 */
export function isCountableRawMessage(
  payload: RawMessagePayload,
  allowedGuildIds: ReadonlySet<string>,
): boolean {
  if (!payload.channel_id) {
    return false;
  }
  if (!payload.guild_id || !allowedGuildIds.has(payload.guild_id)) {
    return false;
  }
  if (payload.webhook_id !== undefined) {
    return false;
  }
  if (payload.author?.bot === true) {
    return false;
  }
  return COUNTABLE_MESSAGE_TYPES.has(payload.type ?? 0);
}

/** What the watchdog has seen since startup. */
export interface DropStats {
  /** Messages that arrived for a channel discord.js had not cached. */
  dropped: number;
  /** How many distinct channels those came from. */
  channels: number;
  /** Channels the recovery fetch could not resolve (no access, deleted, …). */
  unrecovered: number;
}

export interface DropWatchHandle {
  /** Stop the summary timer and log a final summary if anything dropped. */
  stop(): void;
  /** What has been observed so far. */
  stats(): DropStats;
}

/**
 * The watchdog's bookkeeping and recovery, independent of the gateway wiring so
 * it can be driven directly in tests. `fetchChannel` is the seam onto
 * `client.channels.fetch`.
 */
export class DroppedMessageWatch {
  /** Drops per channel id, in arrival order. */
  private readonly counts = new Map<string, number>();
  /** Channels a recovery fetch has already been attempted for. */
  private readonly attempted = new Set<string>();
  /** Channels whose recovery fetch failed; not retried. */
  private readonly failed = new Set<string>();

  constructor(
    private readonly allowed: ReadonlySet<string>,
    private readonly isCached: (channelId: string) => boolean,
    private readonly fetchChannel: (channelId: string) => Promise<unknown>,
  ) {}

  /**
   * Inspect one raw dispatch. Returns true when it was a countable message the
   * gateway is about to drop (and therefore recorded here).
   */
  async handle(packet: RawDispatch): Promise<boolean> {
    if (packet.t !== "MESSAGE_CREATE") {
      return false;
    }
    const payload = (packet.d ?? {}) as RawMessagePayload;
    if (!isCountableRawMessage(payload, this.allowed)) {
      return false;
    }
    const channelId = payload.channel_id as string;
    // The common case: discord.js has the channel and will deliver the event.
    if (this.isCached(channelId)) {
      return false;
    }

    const seen = this.counts.get(channelId);
    if (seen === undefined && this.counts.size >= MAX_TRACKED_CHANNELS) {
      // Tracking is capped; still report, just stop growing the map.
      console.warn(
        `Message counting: a message in uncached channel ${channelId} was dropped before counting (tracking cap reached).`,
      );
      return true;
    }
    this.counts.set(channelId, (seen ?? 0) + 1);
    if (seen === undefined) {
      console.warn(
        `Message counting: a message in channel ${channelId} (guild ${payload.guild_id}) arrived for a channel I had not cached, so it was dropped before counting. Fetching the channel so later messages there count.`,
      );
    }
    await this.recover(channelId);
    return true;
  }

  /**
   * Fetch an uncached channel once, which caches it, so the next message there
   * reaches the counting listener. Failures are recorded and never retried — a
   * channel we cannot see is not going to become visible by asking again.
   */
  private async recover(channelId: string): Promise<void> {
    if (this.attempted.has(channelId)) {
      return;
    }
    if (this.attempted.size >= MAX_TRACKED_CHANNELS) {
      return;
    }
    this.attempted.add(channelId);
    try {
      await this.fetchChannel(channelId);
    } catch (err) {
      this.failed.add(channelId);
      console.warn(`Message counting: could not fetch channel ${channelId} to recover counting:`, err);
    }
  }

  stats(): DropStats {
    let dropped = 0;
    for (const n of this.counts.values()) {
      dropped += n;
    }
    return { dropped, channels: this.counts.size, unrecovered: this.failed.size };
  }

  /** A one-line summary, or null when nothing has dropped. */
  summary(): string | null {
    const { dropped, channels, unrecovered } = this.stats();
    if (dropped === 0) {
      return null;
    }
    const tail = unrecovered > 0 ? `; ${unrecovered} channel(s) could not be fetched` : "";
    return `Message counting: ${dropped} message(s) across ${channels} channel(s) were dropped before counting since startup${tail}.`;
  }
}

/**
 * Attach the watchdog to the client's raw dispatch stream. Returns a handle
 * whose stop() clears the summary timer (call on shutdown).
 */
export function attachDroppedMessageWatch(
  client: Client,
  allowedGuildIds: readonly string[],
  summaryIntervalMs: number = DEFAULT_SUMMARY_INTERVAL_MS,
): DropWatchHandle {
  const watch = new DroppedMessageWatch(
    new Set(allowedGuildIds),
    (id) => client.channels.cache.has(id),
    (id) => client.channels.fetch(id),
  );

  client.on(Events.Raw, (packet: RawDispatch) => {
    // Fire and forget: the recovery fetch must not block packet handling, and a
    // watchdog failure must never take down the bot.
    void watch.handle(packet).catch((err) => console.error("Dropped-message watchdog failed:", err));
  });

  const timer = setInterval(() => {
    const line = watch.summary();
    if (line) {
      console.warn(line);
    }
  }, summaryIntervalMs);
  // Never keep the process alive for a diagnostic timer.
  timer.unref?.();

  return {
    stop(): void {
      clearInterval(timer);
      const line = watch.summary();
      if (line) {
        console.warn(line);
      }
    },
    stats: () => watch.stats(),
  };
}
