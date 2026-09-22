/**
 * Command registry.
 *
 * The single source of truth for which slash commands exist. Both registration
 * (deploy-commands) and dispatch (the interaction router) build the list from
 * `buildCommands`, passing the shared dependencies every handler needs.
 *
 * Commands are constructed rather than exported as a static array because their
 * handlers close over runtime dependencies (the database, the loaded config).
 * That is the `CommandContext` seam: new commands take `ctx` and read what they
 * need from it, keeping the handlers thin (parse → call core/repos → format).
 */

import type { Database } from "better-sqlite3";
import type { BotConfig } from "../../config.js";
import type { MessageCounter } from "../../counting/counter.js";
import type { DropWatchHandle } from "../droppedMessages.js";
import type { Notifier } from "../notifier.js";
import { buildRaffleCommand, buildRaffleModCommand } from "./raffle/index.js";
import type { Command } from "./types.js";

/** Dependencies handed to every command at construction time. */
export interface CommandContext {
  db: Database;
  config: BotConfig;
  /** The Discord-posting seam (audit mirror + announcements). */
  notifier: Notifier;
  /**
   * The live in-memory message counter, so `/raffle-mod reset` can drop a member's
   * not-yet-flushed counts. Optional: commands that don't touch activity (and
   * most tests) run without it.
   */
  counter?: MessageCounter;
  /**
   * The gateway watchdog, so `/raffle-mod config show` can report messages that were
   * dropped before counting (issue #28). Optional: absent in tests and in any
   * process that doesn't hold a gateway connection.
   */
  dropWatch?: DropWatchHandle;
}

/**
 * Build the full command set, wiring each handler to `ctx`.
 *
 * Two commands, split by audience: `/raffle` for members and `/raffle-mod` for
 * moderators. The split is forced by Discord — `default_member_permissions` is
 * per command, so the moderator surface can only be hidden from members by
 * living in a command of its own (see raffle/index.ts).
 */
export function buildCommands(ctx: CommandContext): Command[] {
  return [buildRaffleCommand(ctx), buildRaffleModCommand(ctx)];
}

/** Index a command list by name for O(1) dispatch. */
export function commandMap(list: readonly Command[]): Map<string, Command> {
  return new Map(list.map((command) => [command.data.name, command]));
}

export type { Command } from "./types.js";
