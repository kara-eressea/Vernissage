/**
 * Discord client construction.
 *
 * Requests only the intents the bot actually needs: Guilds (lifecycle,
 * commands) and GuildMessages (to count messages via the gateway). The
 * privileged Message Content intent is deliberately NOT requested — counting
 * needs only the message events, not their content (see design.md "Key
 * constraint: message counting").
 */

import { Client, GatewayIntentBits } from "discord.js";

export function createClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });
}
