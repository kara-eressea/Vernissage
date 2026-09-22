import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { PermissionFlagsBits } from "discord.js";
import type { BotConfig } from "../../src/config.js";
import { openDb } from "../../src/db/index.js";
import { buildCommands, type CommandContext } from "../../src/discord/commands/index.js";
import {
  RAFFLE_COMMAND,
  RAFFLE_MOD_COMMAND,
} from "../../src/discord/commands/raffle/index.js";
import { makeFakeNotifier } from "../helpers/fakeNotifier.js";

/**
 * The registered command surface.
 *
 * Discord's `default_member_permissions` is a *command* level setting, inherited
 * by every subcommand and overridable by none. That is the whole reason the
 * surface is two commands rather than one: a single `/raffle` carrying both
 * audiences had to pick one visibility, and picking the moderator's hid
 * `/raffle withdraw` from the members who needed it (issue #49).
 *
 * These assertions are the regression guard. The interesting one is not that the
 * subcommands are sorted correctly but that `/raffle` carries *no* permission
 * default — a moderator subcommand added to the wrong builder would both leak
 * the capability and, worse, drag the member surface back behind the gate.
 */

let db: Database;
let ctx: CommandContext;

beforeEach(() => {
  db = openDb(":memory:");
  ctx = { db, config: {} as BotConfig, notifier: makeFakeNotifier() };
});

afterEach(() => {
  db.close();
});

/** One command as the JSON actually sent to Discord on registration. */
type CommandJson = {
  default_member_permissions?: string | null;
  options?: Array<{ name: string; type: number; options?: Array<{ name: string; type: number }> }>;
};

/** The built command set, keyed by command name. */
function surface(): Map<string, CommandJson> {
  return new Map(buildCommands(ctx).map((c) => [c.data.name, c.data.toJSON() as CommandJson]));
}

/** Every subcommand name a command exposes, including those nested in groups. */
function subcommandNames(command: CommandJson): string[] {
  const SUBCOMMAND = 1;
  const SUBCOMMAND_GROUP = 2;
  const names: string[] = [];
  for (const option of command.options ?? []) {
    if (option.type === SUBCOMMAND) {
      names.push(option.name);
    } else if (option.type === SUBCOMMAND_GROUP) {
      for (const child of option.options ?? []) {
        names.push(`${option.name} ${child.name}`);
      }
    }
  }
  return names.sort();
}

describe("the registered command surface", () => {
  it("registers exactly the member command and the moderator command", () => {
    expect([...surface().keys()].sort()).toEqual([RAFFLE_COMMAND, RAFFLE_MOD_COMMAND].sort());
  });

  it("leaves /raffle open to everyone, with no permission default", () => {
    // The bug in #49: any value here hides the member subcommands from the
    // members they exist for. discord.js omits the field when it is unset.
    expect(surface().get(RAFFLE_COMMAND)?.default_member_permissions ?? null).toBeNull();
  });

  it("hides /raffle-mod behind Manage Server", () => {
    expect(surface().get(RAFFLE_MOD_COMMAND)?.default_member_permissions).toBe(
      String(PermissionFlagsBits.ManageGuild),
    );
  });

  it("puts every member subcommand on /raffle", () => {
    expect(subcommandNames(surface().get(RAFFLE_COMMAND)!)).toEqual([
      "claim",
      "enter",
      "list",
      "status",
      "withdraw",
    ]);
  });

  it("puts every moderator subcommand on /raffle-mod", () => {
    expect(subcommandNames(surface().get(RAFFLE_MOD_COMMAND)!)).toEqual([
      "announce",
      "ban",
      "banlist",
      "cancel",
      "config channels",
      "config set",
      "config show",
      "create",
      "draw",
      "edit",
      "eligible",
      "from-design",
      "record-win",
      "reroll",
      "reset",
      "unban",
    ]);
  });

  it("never exposes the same subcommand on both commands", () => {
    const member = new Set(subcommandNames(surface().get(RAFFLE_COMMAND)!));
    const overlap = subcommandNames(surface().get(RAFFLE_MOD_COMMAND)!).filter((n) =>
      member.has(n),
    );
    expect(overlap).toEqual([]);
  });
});
