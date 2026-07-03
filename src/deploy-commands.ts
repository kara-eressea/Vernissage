/**
 * One-off script to register slash commands with Discord for the home guild.
 *
 * Usage: `npm run deploy-commands` (after setting the env vars). Safe to re-run;
 * it replaces the guild's command set with the current registry.
 */

import { loadConfig } from "./config.js";
import { registerCommands } from "./discord/register.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const count = await registerCommands(config);
  console.log(`Registered ${count} command(s) to guild ${config.homeGuildId}.`);
}

main().catch((err) => {
  console.error("Failed to register commands:", err);
  process.exitCode = 1;
});
