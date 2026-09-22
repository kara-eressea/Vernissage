import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import type { BotConfig } from "../../../src/config.js";
import { openDb } from "../../../src/db/index.js";
import { addEntry, hasEntry, listEntryRows } from "../../../src/db/repositories/entries.js";
import { setGuildConfig } from "../../../src/db/repositories/guilds.js";
import {
  createDraft,
  setStatus,
  updateRaffleFields,
} from "../../../src/db/repositories/raffles.js";
import { handleRemoveEntry } from "../../../src/discord/commands/raffle/removeEntry.js";
import type { CommandContext } from "../../../src/discord/commands/index.js";
import { makeFakeNotifier } from "../../helpers/fakeNotifier.js";
import { fakeChatInput } from "../../helpers/fakeInteraction.js";

/**
 * `/raffle-mod remove-entry` (issue #47) — a moderator withdrawing a member's
 * entry for them. The point of these tests is that it stays *help*: the member
 * comes back out of the raffle but is not barred from it, and the audit row says
 * who actually did it rather than crediting the member with a withdrawal they
 * could not manage.
 */

let db: Database;
let notifier: ReturnType<typeof makeFakeNotifier>;
let ctx: CommandContext;

const NOW = "2026-07-15T12:00:00.000Z";

beforeEach(() => {
  db = openDb(":memory:");
  notifier = makeFakeNotifier();
  ctx = { db, config: {} as BotConfig, notifier };
});

afterEach(() => {
  db.close();
});

function seedRaffle(status: "open" | "closed", name = "R"): number {
  const id = createDraft(db, "g1", "mod1", NOW);
  updateRaffleFields(db, id, { name, prize: "P", channel_id: "chan-1", message_id: "msg-1" });
  setStatus(db, id, status);
  return id;
}

/** A mod (Manage Server) acting on `user`, unless overridden. */
function modInteraction(values: Record<string, unknown> = {}, manageGuild = true) {
  return fakeChatInput({
    subcommand: "remove-entry",
    userId: "mod1",
    manageGuild,
    values: { user: { id: "u1", toString: () => "<@u1>" }, ...values },
  });
}

function auditRows(): Array<{ event_type: string; actor_id: string | null; payload: string | null }> {
  return db.prepare(`SELECT event_type, actor_id, payload FROM audit_log`).all() as Array<{
    event_type: string;
    actor_id: string | null;
    payload: string | null;
  }>;
}

describe("handleRemoveEntry", () => {
  it("withdraws the member, audits it as the moderator's act, and refreshes the card", async () => {
    const id = seedRaffle("open");
    addEntry(db, id, "u1", NOW);

    const interaction = modInteraction();
    await handleRemoveEntry(interaction, ctx);

    expect(hasEntry(db, id, "u1")).toBe(false);
    // The moderator is the actor; the member is the subject. Recording it as a
    // plain `entry_withdrawn` would credit the member with doing it themselves.
    expect(auditRows()).toEqual([
      {
        event_type: "entry_withdrawn_by_mod",
        actor_id: "mod1",
        payload: JSON.stringify({ userId: "u1" }),
      },
    ]);
    expect(notifier.mirrorAudit).toHaveBeenCalledOnce();
    expect(notifier.editMessage).toHaveBeenCalledOnce();
    expect(notifier.editMessage.mock.calls[0]![2]).toContain("**Entries:** 0");
  });

  it("leaves the member free to re-enter — this is not a ban", async () => {
    const id = seedRaffle("open");
    addEntry(db, id, "u1", NOW);
    await handleRemoveEntry(modInteraction(), ctx);

    addEntry(db, id, "u1", "2026-07-15T13:00:00.000Z"); // reinstates
    expect(hasEntry(db, id, "u1")).toBe(true);
  });

  it("records the removal category as an assisted withdrawal, not a ban", async () => {
    const id = seedRaffle("open");
    addEntry(db, id, "u1", NOW);
    await handleRemoveEntry(modInteraction(), ctx);

    expect(listEntryRows(db, id)[0]?.removed_reason).toBe("withdrawn by mod");
  });

  it("tells the moderator the member is not notified, and points at ban for barring", async () => {
    const id = seedRaffle("open");
    addEntry(db, id, "u1", NOW);

    const interaction = modInteraction();
    await handleRemoveEntry(interaction, ctx);

    const { content } = interaction.reply.mock.calls[0]![0] as { content: string };
    expect(content).toContain("not notified");
    expect(content).toContain("/raffle-mod ban");
  });

  it("refuses a non-moderator, writing nothing", async () => {
    const id = seedRaffle("open");
    addEntry(db, id, "u1", NOW);

    const interaction = modInteraction({}, false);
    await handleRemoveEntry(interaction, ctx);

    expect(hasEntry(db, id, "u1")).toBe(true);
    expect(auditRows()).toEqual([]);
    const { content } = interaction.reply.mock.calls[0]![0] as { content: string };
    expect(content).toContain("do not have permission");
  });

  it("honours the configured mod role, not just Manage Server", async () => {
    const id = seedRaffle("open");
    addEntry(db, id, "u1", NOW);
    setGuildConfig(db, "g1", { mod_role: "role-mod" }, NOW);

    const interaction = fakeChatInput({
      subcommand: "remove-entry",
      userId: "mod2",
      manageGuild: false,
      roleIds: ["role-mod"],
      values: { user: { id: "u1", toString: () => "<@u1>" } },
    });
    await handleRemoveEntry(interaction, ctx);

    expect(hasEntry(db, id, "u1")).toBe(false);
  });

  it("refuses when the raffle is not open, leaving the entry in place", async () => {
    const id = seedRaffle("closed");
    addEntry(db, id, "u1", NOW);

    const interaction = modInteraction({ raffle: id });
    await handleRemoveEntry(interaction, ctx);

    expect(hasEntry(db, id, "u1")).toBe(true);
    expect(auditRows()).toEqual([]);
    const { content } = interaction.reply.mock.calls[0]![0] as { content: string };
    expect(content).toContain("only be withdrawn while the raffle is open");
  });

  it("reports a member who never entered, writing nothing", async () => {
    seedRaffle("open");

    const interaction = modInteraction();
    await handleRemoveEntry(interaction, ctx);

    expect(auditRows()).toEqual([]);
    const { content } = interaction.reply.mock.calls[0]![0] as { content: string };
    expect(content).toContain("hasn't entered");
  });

  it("asks which raffle when more than one is open, rather than guessing", async () => {
    const a = seedRaffle("open", "First");
    const b = seedRaffle("open", "Second");
    addEntry(db, a, "u1", NOW);
    addEntry(db, b, "u1", NOW);

    const interaction = modInteraction();
    await handleRemoveEntry(interaction, ctx);

    expect(hasEntry(db, a, "u1")).toBe(true);
    expect(hasEntry(db, b, "u1")).toBe(true);
    const { content } = interaction.reply.mock.calls[0]![0] as { content: string };
    expect(content).toContain("More than one raffle is open");
  });

  it("rejects a raffle id from another guild", async () => {
    const id = createDraft(db, "other-guild", "mod1", NOW);
    updateRaffleFields(db, id, { name: "Theirs", prize: "P" });
    setStatus(db, id, "open");
    addEntry(db, id, "u1", NOW);

    const interaction = modInteraction({ raffle: id });
    await handleRemoveEntry(interaction, ctx);

    expect(hasEntry(db, id, "u1")).toBe(true);
    const { content } = interaction.reply.mock.calls[0]![0] as { content: string };
    expect(content).toContain("No raffle with that id");
  });
});
