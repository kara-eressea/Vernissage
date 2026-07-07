/**
 * One-off script to register slash commands with Discord in every allowlisted guild.
 *
 * Usage: `npm run deploy-commands` (after setting the env vars). Safe to re-run;
 * it replaces the guild's command set with the current registry.
 */

import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { buildCommands } from "./discord/commands/index.js";
import type { Notifier } from "./discord/notifier.js";
import { registerCommands } from "./discord/register.js";

/**
 * Registration only reads each command's `.data` — no handler runs — so the
 * command context's notifier is never called here. A no-op stand-in avoids
 * needing a logged-in client just to register.
 */
const noopNotifier: Notifier = {
  resolveAuditChannel: async () => undefined,
  mirrorAudit: async () => undefined,
  postEntryMessage: async () => undefined,
  postAudit: async () => undefined,
  postAnnouncement: async () => undefined,
  editMessage: async () => undefined,
};

async function main(): Promise<void> {
  const config = loadConfig();
  // Command builders close over a context; opening the db (which also migrates)
  // gives us one. Building the real command set keeps registration identical to
  // what the bot runs.
  const db = openDb(config.databasePath);
  try {
    const commands = buildCommands({ db, config, notifier: noopNotifier });
    const result = await registerCommands(config, commands);
    console.log(
      `Registered ${result.commandCount} command(s) to ${result.registered.length} guild(s): ${result.registered.join(", ") || "none"}.`,
    );
    if (result.skipped.length > 0) {
      console.log(
        `Skipped ${result.skipped.length} allowlisted guild(s) the bot has not joined: ${result.skipped.join(", ")}. ` +
          "Commands register automatically when the bot joins them.",
      );
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error("Failed to register commands:", err);
  process.exitCode = 1;
});
