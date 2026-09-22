import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import type { BotConfig } from "../../src/config.js";
import { openDb } from "../../src/db/index.js";
import { addEntry } from "../../src/db/repositories/entries.js";
import { setGuildConfig } from "../../src/db/repositories/guilds.js";
import { createDraft, setStatus, updateRaffleFields } from "../../src/db/repositories/raffles.js";
import type { RaffleStatus } from "../../src/core/types.js";
import { addWin, claimWin } from "../../src/db/repositories/wins.js";
import { routeAutocomplete } from "../../src/discord/autocomplete.js";
import type { CommandContext } from "../../src/discord/commands/index.js";
import { makeFakeNotifier } from "../helpers/fakeNotifier.js";
import { fakeAutocomplete } from "../helpers/fakeInteraction.js";

/**
 * The raffle-id picker's routing (issue #48).
 *
 * The candidate set is per subcommand on purpose: a picker that offers raffles
 * the command will then refuse is worse than no picker, because presenting an
 * option reads as a promise it will work. These tests pin each subcommand to the
 * raffles it can actually act on, and pin the two things the picker must not
 * reveal — another guild's raffles, and the moderator surface's contents.
 */

let db: Database;
let ctx: CommandContext;

const NOW = "2026-07-15T12:00:00.000Z";

beforeEach(() => {
  db = openDb(":memory:");
  ctx = { db, config: {} as BotConfig, notifier: makeFakeNotifier() };
});

afterEach(() => {
  db.close();
});

function seed(status: RaffleStatus, name: string, guildId = "g1"): number {
  const id = createDraft(db, guildId, "mod1", NOW);
  updateRaffleFields(db, id, { name, prize: "P" });
  if (status !== "draft") {
    setStatus(db, id, status);
  }
  return id;
}

/** Run the picker and return the ids it offered, in order. */
async function suggest(opts: Parameters<typeof fakeAutocomplete>[0]): Promise<number[]> {
  const interaction = fakeAutocomplete(opts);
  await routeAutocomplete(interaction, ctx);
  const choices = interaction.respond.mock.calls[0]![0] as Array<{ value: number }>;
  return choices.map((c) => c.value);
}

/** Run the picker and return the labels it offered. */
async function suggestLabels(opts: Parameters<typeof fakeAutocomplete>[0]): Promise<string[]> {
  const interaction = fakeAutocomplete(opts);
  await routeAutocomplete(interaction, ctx);
  const choices = interaction.respond.mock.calls[0]![0] as Array<{ name: string }>;
  return choices.map((c) => c.name);
}

const asMod = { commandName: "raffle-mod", userId: "mod1", manageGuild: true } as const;

describe("member pickers", () => {
  it("offers open raffles for enter, and nothing else", async () => {
    const open = seed("open", "Open one");
    seed("scheduled", "Not yet");
    seed("drawn", "Over");

    expect(await suggest({ subcommand: "enter" })).toEqual([open]);
  });

  it("does not offer a raffle the caller has already entered, for enter", async () => {
    // Suggesting it would be suggesting an `already_entered` refusal.
    const entered = seed("open", "Already in");
    const free = seed("open", "Not yet");
    addEntry(db, entered, "u1", NOW);

    expect(await suggest({ subcommand: "enter", userId: "u1" })).toEqual([free]);
  });

  it("offers only the raffles the caller has actually entered, for withdraw", async () => {
    const entered = seed("open", "Mine");
    seed("open", "Someone else's");
    addEntry(db, entered, "u1", NOW);

    expect(await suggest({ subcommand: "withdraw", userId: "u1" })).toEqual([entered]);
  });

  it("offers nothing for withdraw when the caller has entered nothing", async () => {
    seed("open", "Open one");
    expect(await suggest({ subcommand: "withdraw", userId: "u1" })).toEqual([]);
  });

  it("offers open and upcoming raffles for status", async () => {
    const open = seed("open", "Now");
    const soon = seed("scheduled", "Soon");
    seed("drawn", "Over");

    expect((await suggest({ subcommand: "status" })).sort()).toEqual([open, soon].sort());
  });

  it("offers only unclaimed prizes the caller actually won, for claim", async () => {
    const won = seed("drawn", "Won it");
    const alsoDrawn = seed("drawn", "Someone else won");
    addWin(db, won, "u1", NOW, "2026-07-20T12:00:00.000Z");
    addWin(db, alsoDrawn, "u2", NOW, "2026-07-20T12:00:00.000Z");

    expect(await suggest({ subcommand: "claim", userId: "u1" })).toEqual([won]);
  });

  it("drops a prize once it has been claimed", async () => {
    const won = seed("drawn", "Won it");
    const winId = addWin(db, won, "u1", NOW, "2026-07-20T12:00:00.000Z");
    claimWin(db, winId, NOW);

    expect(await suggest({ subcommand: "claim", userId: "u1" })).toEqual([]);
  });
});

describe("moderator pickers", () => {
  it("offers closed raffles to draw", async () => {
    const closed = seed("closed", "Ready");
    seed("open", "Still running");
    seed("drawn", "Done");

    expect(await suggest({ ...asMod, subcommand: "draw" })).toEqual([closed]);
  });

  it("offers drawn raffles to announce and reroll", async () => {
    const drawn = seed("drawn", "Done");
    seed("closed", "Not yet");

    expect(await suggest({ ...asMod, subcommand: "announce" })).toEqual([drawn]);
    expect(await suggest({ ...asMod, subcommand: "reroll" })).toEqual([drawn]);
  });

  it("offers everything still editable to edit", async () => {
    const draft = seed("draft", "Draft");
    const scheduled = seed("scheduled", "Scheduled");
    const open = seed("open", "Open");
    seed("drawn", "Too late");

    expect((await suggest({ ...asMod, subcommand: "edit" })).sort()).toEqual(
      [draft, scheduled, open].sort(),
    );
  });

  it("offers everything pre-drawn to cancel, including a closed raffle", async () => {
    const closed = seed("closed", "Closed");
    seed("drawn", "Already drawn");

    expect(await suggest({ ...asMod, subcommand: "cancel" })).toContain(closed);
    expect(await suggest({ ...asMod, subcommand: "cancel" })).toHaveLength(1);
  });

  it("offers open raffles to remove-entry", async () => {
    const open = seed("open", "Open");
    seed("closed", "Closed");

    expect(await suggest({ ...asMod, subcommand: "remove-entry" })).toEqual([open]);
  });

  it("tells a non-moderator nothing about the moderator surface", async () => {
    seed("closed", "Secret prize name");

    expect(await suggest({ commandName: "raffle-mod", subcommand: "draw", manageGuild: false }))
      .toEqual([]);
  });

  it("answers a moderator holding only the configured mod role", async () => {
    const closed = seed("closed", "Ready");
    setGuildConfig(db, "g1", { mod_role: "role-mod" }, NOW);

    expect(
      await suggest({
        commandName: "raffle-mod",
        subcommand: "draw",
        manageGuild: false,
        roleIds: ["role-mod"],
      }),
    ).toEqual([closed]);
  });
});

describe("what the picker will not do", () => {
  it("never offers another guild's raffles", async () => {
    seed("open", "Theirs", "other-guild");
    expect(await suggest({ subcommand: "enter" })).toEqual([]);
  });

  it("answers empty for an option that is not a raffle id", async () => {
    seed("open", "Open");
    expect(await suggest({ subcommand: "enter", focused: { name: "reason", value: "" } })).toEqual(
      [],
    );
  });

  it("answers empty inside a subcommand group, rather than borrowing a top-level set", async () => {
    // `/raffle-mod config set` reports its subcommand as "set"; nothing should
    // let a future grouped name inherit the top-level candidates for that name.
    seed("open", "Open");
    expect(
      await suggest({
        ...asMod,
        subcommand: "cancel",
        subcommandGroup: "config",
      }),
    ).toEqual([]);
  });

  it("answers empty for a subcommand with no candidate set defined", async () => {
    seed("open", "Open");
    expect(await suggest({ subcommand: "list" })).toEqual([]);
  });

  it("answers empty outside a guild", async () => {
    seed("open", "Open");
    expect(await suggest({ subcommand: "enter", guildId: null })).toEqual([]);
  });

  it("never throws when responding fails — the member just types the id", async () => {
    seed("open", "Open");
    const interaction = fakeAutocomplete({ subcommand: "enter" });
    interaction.respond.mockRejectedValue(new Error("interaction expired"));

    await expect(routeAutocomplete(interaction, ctx)).resolves.toBeUndefined();
  });
});

describe("what the picker shows", () => {
  it("labels each choice with id, name and status", async () => {
    const id = seed("open", "Vinyl giveaway");
    expect(await suggestLabels({ subcommand: "enter" })).toEqual([
      `#${id} · Vinyl giveaway (open)`,
    ]);
  });

  it("narrows as the member types the name", async () => {
    seed("open", "Vinyl giveaway");
    const poster = seed("open", "Poster bundle");

    expect(await suggest({ subcommand: "enter", focused: { name: "raffle", value: "post" } }))
      .toEqual([poster]);
  });
});
