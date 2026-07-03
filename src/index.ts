/**
 * Bot entry point.
 *
 * Wires the pieces together: load config, open (and migrate) the database,
 * build the Discord client, enforce the home-guild rule, route interactions,
 * and log in. Business logic lives in the core and command layers, not here.
 */

import { Events } from "discord.js";
import { loadConfig } from "./config.js";
import { AUDIT_EVENTS } from "./core/auditEvents.js";
import { MessageCounter } from "./counting/counter.js";
import { openDb } from "./db/index.js";
import { createClient } from "./discord/client.js";
import { buildCommands } from "./discord/commands/index.js";
import { EDIT_END_PREFIX, handleEditEnd } from "./discord/commands/raffle/editEnd.js";
import { attachHomeGuildEnforcement } from "./discord/homeGuild.js";
import {
  createInteractionRouter,
  isRoutableComponent,
  type CustomIdInteraction,
} from "./discord/interactions.js";
import { attachMessageCounter } from "./discord/messageCounter.js";
import { createNotifier } from "./discord/notifier.js";
import { routeInteraction } from "./discord/router.js";
import { createWizard, type WizardInteraction } from "./discord/wizard/index.js";
import { WIZARD_PREFIX } from "./discord/wizard/customId.js";
import { startScheduler } from "./scheduler/runner.js";

async function main(): Promise<void> {
  const config = loadConfig();

  // Opening the database also runs migrations to the current schema version.
  const db = openDb(config.databasePath);

  const client = createClient();
  attachHomeGuildEnforcement(client, config.homeGuildId);

  // The shared Discord-posting seam (audit-channel mirror + announcements).
  const notifier = createNotifier(client, db);

  // Build the command set with the dependencies handlers close over.
  const commands = buildCommands({ db, config, notifier });

  // Wizard component/modal interactions and the open-raffle end-extension modal
  // are dispatched by custom-id namespace.
  const wizard = createWizard({ db, notifier });
  const interactionRouter = createInteractionRouter();
  interactionRouter.register(WIZARD_PREFIX, (i) =>
    wizard.handle(i as unknown as WizardInteraction),
  );
  interactionRouter.register(EDIT_END_PREFIX, (i) =>
    handleEditEnd(i as never, { db, notifier }),
  );

  // Start counting messages toward activity, flushed to the DB on an interval.
  const counter = new MessageCounter();
  const counting = attachMessageCounter(client, db, counter);

  client.once(Events.ClientReady, (ready) => {
    console.log(`Logged in as ${ready.user.tag}; serving guild ${config.homeGuildId}.`);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isChatInputCommand()) {
      void routeInteraction(interaction, commands);
    } else if (isRoutableComponent(interaction)) {
      void interactionRouter.route(interaction as unknown as CustomIdInteraction);
    }
  });

  // Drive raffle state transitions on an interval, reconciling on startup. Each
  // opened/closed transition is mirrored to the guild's audit channel; the
  // audit_log row itself is already written inside the sweep transaction.
  const scheduler = startScheduler(db, {
    onTransition: (t) => {
      console.log(`Raffle ${t.raffleId}: ${t.from} -> ${t.to} (${t.guildId}).`);
      void notifier.mirrorAudit({
        guildId: t.guildId,
        raffleId: t.raffleId,
        eventType: t.to === "open" ? AUDIT_EVENTS.raffleOpened : AUDIT_EVENTS.raffleClosed,
        actorId: "scheduler",
        createdAt: new Date().toISOString(),
      });
    },
  });

  const shutdown = (signal: string): void => {
    console.log(`Received ${signal}; shutting down.`);
    scheduler.stop();
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
