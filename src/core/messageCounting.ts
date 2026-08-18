/**
 * Message-counting rules (pure).
 *
 * Decides whether a given message should count toward activity, based on the
 * guild's per-channel include/exclude configuration. Bot/webhook filtering and
 * the hourly cap are applied elsewhere (the gateway handler and the counter
 * service respectively); this module owns only the channel-inclusion rule so it
 * can be unit-tested in isolation. See design.md "Key constraint".
 */

import type { ChannelMode } from "./types.js";

export interface ChannelRule {
  channelId: string;
  mode: ChannelMode;
}

/**
 * Whether messages in `channelId` count, given the guild's channel rules.
 *
 * Precedence:
 *   1. An explicit exclude always wins — excluded channels never count.
 *   2. If any include rules exist, the channel counts only when explicitly
 *      included (an allowlist).
 *   3. Otherwise every non-excluded channel counts (the default).
 */
export function isChannelCounted(
  channelId: string,
  rules: readonly ChannelRule[],
): boolean {
  let hasIncludes = false;
  let included = false;

  for (const rule of rules) {
    if (rule.mode === "exclude" && rule.channelId === channelId) {
      return false;
    }
    if (rule.mode === "include") {
      hasIncludes = true;
      if (rule.channelId === channelId) {
        included = true;
      }
    }
  }

  return hasIncludes ? included : true;
}

/** The minimal channel shape the rule-key resolution reads. */
export interface RuleTargetChannel {
  id: string;
  isThread: boolean;
  /** The channel a thread hangs from, or null (also null for non-threads). */
  parentId: string | null;
}

/**
 * The channel id a counting rule is keyed on.
 *
 * Rules always live on the *parent* channel: a thread's messages count under the
 * channel it hangs from, so one rule on #general governs every thread in it.
 * Both sides go through this — the gateway path (deciding where an arriving
 * message counts) and `/raffle config channels` (deciding where a moderator's
 * chosen rule is stored) — so the two can never key on different ids. A rule
 * stored against a thread's own id would match nothing and silently do nothing.
 */
export function ruleChannelId(channel: RuleTargetChannel): string {
  if (channel.isThread && channel.parentId !== null) {
    return channel.parentId;
  }
  return channel.id;
}
