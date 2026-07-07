/**
 * Shared bot-can-post-here check.
 *
 * A channel the bot cannot view or send to is accepted by Discord's pickers
 * (they show every channel the *mod* can see), and the failure then happens
 * later and silently — the audit mirror or the raffle's entry message just
 * never appears (issue #3). Both `/raffle config set` and the wizard's
 * announce-channel select gate their choices through this one helper.
 */

import { PermissionFlagsBits, type GuildMember } from "discord.js";

/** The minimal channel shape the check reads (real channels satisfy it). */
export interface PermissionCheckableChannel {
  id: string;
  permissionsFor?: (member: GuildMember) => { has(flags: bigint[]): boolean } | null;
}

/**
 * If the bot member cannot both see and post in `channel`, return a
 * human-readable error naming the channel's role. Returns undefined when the
 * channel is postable — or when the bot member / channel permissions are not
 * resolvable, so an unusual interaction shape degrades to accepting the choice
 * rather than raising a false error.
 */
export function channelAccessError(
  me: GuildMember | null | undefined,
  channel: PermissionCheckableChannel | null | undefined,
  purpose: string,
): string | undefined {
  if (!me || !channel || typeof channel.permissionsFor !== "function") {
    return undefined;
  }
  const perms = channel.permissionsFor(me);
  if (perms && !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    return `I can't post in <#${channel.id}>, so it won't work as the ${purpose} channel. Grant me **View Channel** and **Send Messages** there (or pick another channel) and try again.`;
  }
  return undefined;
}
