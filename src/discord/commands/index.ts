/**
 * Command registry.
 *
 * The single source of truth for which slash commands exist. Both registration
 * (deploy-commands) and dispatch (the interaction router) read from here. It is
 * intentionally empty in this skeleton pass — the /raffle commands and creation
 * wizard land in a later pass; the plumbing that consumes this list is proven
 * now.
 */

import type { Command } from "./types.js";

export const commands: Command[] = [];

/** Index the command list by name for O(1) dispatch. */
export function commandMap(list: readonly Command[] = commands): Map<string, Command> {
  return new Map(list.map((command) => [command.data.name, command]));
}

export type { Command } from "./types.js";
