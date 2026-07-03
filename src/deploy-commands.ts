/**
 * One-off script to register slash commands with Discord for the home guild.
 *
 * Usage: `npm run deploy-commands` (after setting the env vars). Safe to re-run;
 * it replaces the guild's command set with the current registry.
 */

import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { buildCommands } from "./discord/commands/index.js";
import { registerCommands } from "./discord/register.js";

async function main(): Promise<void> {
  const config = loadConfig();
  // Command builders close over a context; opening the db (which also migrates)
  // gives us one. Registration only reads each command's `.data`, but building
  // the real context keeps the command set identical to what the bot runs.
  const db = openDb(config.databasePath);
  try {
    const count = await registerCommands(config, buildCommands({ db, config }));
    console.log(`Registered ${count} command(s) to guild ${config.homeGuildId}.`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error("Failed to register commands:", err);
  process.exitCode = 1;
});
