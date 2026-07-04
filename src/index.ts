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
import { buildCommands, type CommandContext } from "./discord/commands/index.js";
import { EDIT_END_PREFIX, handleEditEnd } from "./discord/commands/raffle/editEnd.js";
import { handleEnterButton } from "./discord/commands/raffle/entry.js";
import { ENTER_PREFIX } from "./discord/components/enterButton.js";
import { announceOpenRaffle, closeEntryMessage } from "./discord/entryFlow.js";
import { makePresenceResolver } from "./discord/memberPresence.js";
import { onRaffleClosed, reconcilePendingDraws } from "./draw/service.js";
import { startClaimSweep } from "./scheduler/claims.js";
import { startActivityPruning } from "./scheduler/pruning.js";
import { attachGuildAllowlist } from "./discord/guildAllowlist.js";
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
import type { ButtonInteraction } from "discord.js";
import { startScheduler } from "./scheduler/runner.js";

async function main(): Promise<void> {
  const config = loadConfig();

  // Opening the database also runs migrations to the current schema version.
  const db = openDb(config.databasePath);

  const client = createClient();
  attachGuildAllowlist(client, config.guildIds);

  // The shared Discord-posting seam (audit-channel mirror + announcements).
  const notifier = createNotifier(client, db);

  // Build the command set with the dependencies handlers close over.
  const commandCtx: CommandContext = { db, config, notifier };
  const commands = buildCommands(commandCtx);

  // Component/modal interactions are dispatched by custom-id namespace: the
  // wizard ("wiz"), the end-extension modal ("editend"), and the Enter button
  // ("raffle").
  const wizard = createWizard({ db, notifier });
  const interactionRouter = createInteractionRouter();
  interactionRouter.register(WIZARD_PREFIX, (i) =>
    wizard.handle(i as unknown as WizardInteraction),
  );
  interactionRouter.register(EDIT_END_PREFIX, (i) =>
    handleEditEnd(i as never, { db, notifier }),
  );
  interactionRouter.register(ENTER_PREFIX, (i) =>
    handleEnterButton(i as unknown as ButtonInteraction, commandCtx),
  );

  // Start counting messages toward activity, flushed to the DB on an interval.
  const counter = new MessageCounter();
  const counting = attachMessageCounter(client, db, counter, config.guildIds);

  // The draw's left-guild / blacklist failsafe checks pulled winners against
  // current membership via REST (only winners, so a handful of lookups).
  const resolveMembers = makePresenceResolver(client);

  // Prune activity rows older than the longest lookback in use, daily.
  const pruning = startActivityPruning(db);

  // Reroll winners who let their claim window lapse, and reconcile any that
  // expired while the bot was offline.
  const claimSweep = startClaimSweep(db, notifier);

  client.once(Events.ClientReady, (ready) => {
    console.log(
      `Logged in as ${ready.user.tag}; serving ${config.guildIds.length} guild(s): ${config.guildIds.join(", ")}.`,
    );
  });

  client.on(Events.InteractionCreate, (interaction) => {
    // routeInteraction / route contain their own try/catch, but their returned
    // promise can still reject (e.g. the error-path reply itself fails). Swallow
    // that here so a single bad interaction never becomes an unhandled rejection.
    if (interaction.isChatInputCommand()) {
      void routeInteraction(interaction, commands).catch((err) =>
        console.error("Unhandled interaction error:", err),
      );
    } else if (isRoutableComponent(interaction)) {
      void interactionRouter
        .route(interaction as unknown as CustomIdInteraction)
        .catch((err) => console.error("Unhandled interaction error:", err));
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
      // On open, post the public entry message with the Enter button. Guarded
      // so a transient DB/Discord error here never crashes the scheduler tick.
      if (t.to === "open") {
        void announceOpenRaffle(db, notifier, t.raffleId).catch((err) =>
          console.error(`Failed to announce raffle ${t.raffleId}:`, err),
        );
      }
      // On close, freeze entries and publish the commitment; auto-draw if the
      // raffle draws automatically. Manual raffles wait for `/raffle draw`.
      if (t.to === "closed") {
        // Retire the entry message's Enter button so it can't be pressed after
        // entries close. Independent of the draw; guarded so it can't crash the tick.
        void closeEntryMessage(db, notifier, t.raffleId).catch((err) =>
          console.error(`Failed to close entry message for raffle ${t.raffleId}:`, err),
        );
        void onRaffleClosed(
          db,
          notifier,
          t.raffleId,
          t.drawMode,
          new Date().toISOString(),
          undefined,
          resolveMembers,
        ).catch((err) => console.error(`Failed to close/draw raffle ${t.raffleId}:`, err));
      }
    },
  });

  // The scheduler's startup sweep only emits transitions for raffles still
  // scheduled/open; a raffle already `closed` in the DB (closed just before a
  // shutdown, commit/draw missed) emits none. Reconcile those once at startup.
  void reconcilePendingDraws(
    db,
    notifier,
    new Date().toISOString(),
    undefined,
    resolveMembers,
  ).catch((err) => console.error("Failed to reconcile pending draws on startup:", err));

  const shutdown = (signal: string): void => {
    console.log(`Received ${signal}; shutting down.`);
    scheduler.stop();
    counting.stop();
    pruning.stop();
    claimSweep.stop();
    client.destroy();
    db.close();
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  await client.login(config.token);
}

// Last-resort net: this bot must run 24/7, so a stray rejection from a
// fire-and-forget async path should be logged, not fatal. Node otherwise
// terminates the process on an unhandled rejection.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exitCode = 1;
});
