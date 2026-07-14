/**
 * Member-name resolution and startup backfill (the Discord side of the name
 * cache; the DB side is db/repositories/members.ts).
 *
 * The dashboard shows ids because the web process has no gateway or token; this
 * lets the *bot* — which does see user objects — cache a friendly name so the
 * dashboard can label those ids (design.md "Member name cache"). Names are read
 * off the objects the bot already has (a message author, an entry interaction),
 * and past entrants who predate the cache are filled once at startup via a
 * per-id REST lookup (which needs only the bot token, not the privileged
 * GuildMembers intent). Only a handle and a display name are ever stored.
 */

import type { APIInteractionGuildMember } from "discord.js";
import type { Client, GuildMember, Message, User } from "discord.js";
import type { Database } from "better-sqlite3";
import {
  listUnnamedRaffleMemberIds,
  upsertMemberNames,
  type MemberName,
  type MemberNameUpsert,
} from "../db/repositories/members.js";

/** Cap one backfill run so a large first-time fill can't storm the REST API. */
const BACKFILL_CAP = 750;

/** The best name to show for a message's author (server nick, else global name). */
export function nameFromMessage(message: Message): MemberName {
  const username = message.author.username ?? null;
  // member.displayName = nickname ?? global name; author.displayName = global
  // name ?? username. Prefer the guild nickname when discord.js attached a member.
  const display = message.member?.displayName ?? message.author.displayName ?? username;
  return { username, displayName: display ?? null };
}

/** The best name from an interaction's user + (possibly raw) guild member. */
export function nameFromMember(
  user: User,
  member: GuildMember | APIInteractionGuildMember | null,
): MemberName {
  const username = user.username ?? null;
  let display: string | null = null;
  if (member) {
    // A full GuildMember exposes a displayName getter; the raw API member only
    // carries a `nick` string. Handle both without assuming which we got.
    const gm = member as Partial<GuildMember> & { nick?: string | null };
    display = (typeof gm.displayName === "string" ? gm.displayName : null) ?? gm.nick ?? null;
  }
  display = display ?? user.globalName ?? username;
  return { username, displayName: display };
}

/** Resolve a name for one id: the guild member if present, else the bare user. */
async function resolveName(
  client: Client,
  guild: { members: { fetch: (opts: { user: string; force: boolean }) => Promise<GuildMember> } } | null,
  userId: string,
): Promise<MemberName | null> {
  if (guild) {
    try {
      const m = await guild.members.fetch({ user: userId, force: false });
      return { username: m.user.username, displayName: m.displayName };
    } catch {
      // Not a current member (they left); fall through to a plain user fetch.
    }
  }
  try {
    const u = await client.users.fetch(userId);
    return { username: u.username, displayName: u.globalName ?? u.username };
  } catch {
    return null;
  }
}

/**
 * Fill cached names for past entrants/winners that have none yet (e.g. raffles
 * drawn before this cache existed, or entrants who never posted a counted
 * message). Runs detached at startup; returns how many names it stored. Bounded
 * per run so a large backlog is caught across a few restarts rather than in one
 * burst.
 */
export async function backfillMemberNames(
  client: Client,
  db: Database,
  guildIds: readonly string[],
  now: string,
): Promise<number> {
  let filled = 0;
  for (const guildId of guildIds) {
    const missing = listUnnamedRaffleMemberIds(db, guildId).slice(0, BACKFILL_CAP);
    if (missing.length === 0) {
      continue;
    }
    const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
    const batch: MemberNameUpsert[] = [];
    for (const userId of missing) {
      const name = await resolveName(client, guild, userId);
      if (name) {
        batch.push({ guildId, userId, username: name.username, displayName: name.displayName, updatedAt: now });
      }
    }
    filled += upsertMemberNames(db, batch);
  }
  return filled;
}
