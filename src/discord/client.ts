/**
 * Discord client construction.
 *
 * Requests only the intents the bot actually needs: Guilds (lifecycle,
 * commands) and GuildMessages (to count messages via the gateway). The
 * privileged Message Content intent is deliberately NOT requested — counting
 * needs only the message events, not their content (see design.md "Key
 * constraint: message counting").
 */

import { Client, GatewayIntentBits, Options } from "discord.js";

/**
 * How long an archived thread stays in the channel cache. discord.js resolves a
 * message's channel from that cache and silently drops the event when it is
 * missing (see src/discord/droppedMessages.ts), and its default evicts archived
 * threads after four hours — so a week-old thread that someone revives can lose
 * a message. A week of headroom covers the way threads are actually used here;
 * the watchdog's recovery fetch handles anything older.
 */
const ARCHIVED_THREAD_CACHE_SECONDS = 7 * 24 * 60 * 60;

export function createClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    sweepers: {
      ...Options.DefaultSweeperSettings,
      threads: { interval: 3600, lifetime: ARCHIVED_THREAD_CACHE_SECONDS },
    },
  });
}
