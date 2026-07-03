/**
 * Bot entry point.
 *
 * Wires the pieces together: load config, open (and migrate) the database,
 * build the Discord client, enforce the home-guild rule, route interactions,
 * and log in. Business logic lives in the core and command layers, not here.
 */

import { Events } from "discord.js";
import { loadConfig } from "./config.js";
import { MessageCounter } from "./counting/counter.js";
import { openDb } from "./db/index.js";
import { createClient } from "./discord/client.js";
import { commands } from "./discord/commands/index.js";
import { attachHomeGuildEnforcement } from "./discord/homeGuild.js";
import { attachMessageCounter } from "./discord/messageCounter.js";
import { routeInteraction } from "./discord/router.js";

async function main(): Promise<void> {
  const config = loadConfig();

  // Opening the database also runs migrations to the current schema version.
  const db = openDb(config.databasePath);

  const client = createClient();
  attachHomeGuildEnforcement(client, config.homeGuildId);

  // Start counting messages toward activity, flushed to the DB on an interval.
  const counter = new MessageCounter();
  const counting = attachMessageCounter(client, db, counter);

  client.once(Events.ClientReady, (ready) => {
    console.log(`Logged in as ${ready.user.tag}; serving guild ${config.homeGuildId}.`);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }
    void routeInteraction(interaction, commands);
  });

  const shutdown = (signal: string): void => {
    console.log(`Received ${signal}; shutting down.`);
    counting.stop();
    client.destroy();
    db.close();
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  await client.login(config.token);
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exitCode = 1;
});
