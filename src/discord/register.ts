/**
 * Slash command registration.
 *
 * Registers commands as guild commands in every allowlisted guild the bot is a
 * member of. Guild commands update instantly (unlike global commands, which
 * propagate slowly), which suits a private bot. Allowlisted guilds the bot has
 * not joined yet are skipped, not errors: the allowlist may be provisioned
 * ahead of time, and the bot registers its commands itself when it joins one
 * (see index.ts). Run via the deploy-commands script whenever the command set
 * changes.
 */

import { REST, Routes } from "discord.js";
import type { BotConfig } from "../config.js";
import type { Command } from "./commands/index.js";

/** The outcome of a registration sweep across the allowlist. */
export interface RegisterResult {
  /** Number of commands in the registered set. */
  commandCount: number;
  /** Allowlisted guilds the commands were registered to. */
  registered: string[];
  /** Allowlisted guilds skipped because the bot is not a member (yet). */
  skipped: string[];
}

/**
 * Split the allowlist into the guilds to register to (the bot is a member) and
 * the ones to skip (provisioned ahead of time, not yet joined). Pure, for
 * testability.
 */
export function partitionRegistrable(
  allowlistedGuildIds: readonly string[],
  memberGuildIds: ReadonlySet<string>,
): { registrable: string[]; skipped: string[] } {
  const registrable: string[] = [];
  const skipped: string[] = [];
  for (const guildId of allowlistedGuildIds) {
    (memberGuildIds.has(guildId) ? registrable : skipped).push(guildId);
  }
  return { registrable, skipped };
}

/** Fetch the ids of every guild the bot is currently a member of. */
async function fetchMemberGuildIds(rest: REST): Promise<Set<string>> {
  // A private bot serves a handful of guilds, so one unpaginated page (up to
  // 200 guilds) is plenty.
  const guilds = (await rest.get(Routes.userGuilds())) as Array<{ id: string }>;
  return new Set(guilds.map((guild) => guild.id));
}

/** Overwrite one guild's command set with `body`. */
function putGuildCommands(
  rest: REST,
  appId: string,
  guildId: string,
  body: unknown,
): Promise<unknown> {
  return rest.put(Routes.applicationGuildCommands(appId, guildId), { body });
}

/**
 * Register the given commands to every allowlisted guild the bot is a member
 * of, skipping the guilds it has not joined yet.
 */
export async function registerCommands(
  config: BotConfig,
  commands: readonly Command[],
): Promise<RegisterResult> {
  const rest = new REST().setToken(config.token);
  const body = commands.map((command) => command.data.toJSON());

  const memberGuildIds = await fetchMemberGuildIds(rest);
  const { registrable, skipped } = partitionRegistrable(config.guildIds, memberGuildIds);

  await Promise.all(
    registrable.map((guildId) => putGuildCommands(rest, config.appId, guildId, body)),
  );

  return { commandCount: body.length, registered: registrable, skipped };
}

/**
 * Register the given commands to a single guild. Used by the running bot when
 * it joins an allowlisted guild, so a guild provisioned ahead of time gets its
 * commands without a redeploy.
 */
export async function registerCommandsInGuild(
  config: BotConfig,
  commands: readonly Command[],
  guildId: string,
): Promise<number> {
  const rest = new REST().setToken(config.token);
  const body = commands.map((command) => command.data.toJSON());
  await putGuildCommands(rest, config.appId, guildId, body);
  return body.length;
}
