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
import type { Notifier } from "../notifier.js";
import { buildRaffleCommand } from "./raffle/index.js";
import type { Command } from "./types.js";

/** Dependencies handed to every command at construction time. */
export interface CommandContext {
  db: Database;
  config: BotConfig;
  /** The Discord-posting seam (audit mirror + announcements). */
  notifier: Notifier;
  /**
   * The live in-memory message counter, so `/raffle reset` can drop a member's
   * not-yet-flushed counts. Optional: commands that don't touch activity (and
   * most tests) run without it.
   */
  counter?: MessageCounter;
}

/** Build the full command set, wiring each handler to `ctx`. */
export function buildCommands(ctx: CommandContext): Command[] {
  return [buildRaffleCommand(ctx)];
}

/** Index a command list by name for O(1) dispatch. */
export function commandMap(list: readonly Command[]): Map<string, Command> {
  return new Map(list.map((command) => [command.data.name, command]));
}

export type { Command } from "./types.js";
