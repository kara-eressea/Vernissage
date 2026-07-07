import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import type { BotConfig } from "../../../src/config.js";
import { openDb } from "../../../src/db/index.js";
import { addEntry, hasEntry } from "../../../src/db/repositories/entries.js";
import {
  createDraft,
  setStatus,
  updateRaffleFields,
} from "../../../src/db/repositories/raffles.js";
import { handleWithdraw } from "../../../src/discord/commands/raffle/entry.js";
import type { CommandContext } from "../../../src/discord/commands/index.js";
import { makeFakeNotifier } from "../../helpers/fakeNotifier.js";
import { fakeChatInput } from "../../helpers/fakeInteraction.js";

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

function seedRaffle(status: "open" | "closed", withMessage = true): number {
  const id = createDraft(db, "g1", "mod1", NOW);
  updateRaffleFields(db, id, {
    name: "R",
    prize: "P",
    channel_id: "chan-1",
    message_id: withMessage ? "msg-1" : null,
  });
  setStatus(db, id, status);
  return id;
}

function withdrawInteraction(userId = "u1", raffle?: number) {
  return fakeChatInput({
    subcommand: "withdraw",
    userId,
    values: raffle === undefined ? {} : { raffle },
  });
}

function auditTypes(): string[] {
  return (db.prepare(`SELECT event_type FROM audit_log`).all() as Array<{ event_type: string }>).map(
    (r) => r.event_type,
  );
}

describe("handleWithdraw", () => {
  it("removes the entry, audits + mirrors it, and refreshes the card", async () => {
    const id = seedRaffle("open");
    addEntry(db, id, "u1", NOW);

    const interaction = withdrawInteraction("u1");
    await handleWithdraw(interaction, ctx);

    expect(hasEntry(db, id, "u1")).toBe(false);
    expect(auditTypes()).toEqual(["entry_withdrawn"]);
    expect(notifier.mirrorAudit).toHaveBeenCalledOnce();
    // The card refresh recounts and re-edits the message.
    expect(notifier.editMessage).toHaveBeenCalledOnce();
    expect(notifier.editMessage.mock.calls[0]![2]).toContain("**Entries:** 0");
    const { content } = interaction.reply.mock.calls[0]![0] as { content: string };
    expect(content).toContain("withdrawn");
    expect(content).toContain("re-enter");
  });

  it("allows re-entering after a withdrawal", async () => {
    const id = seedRaffle("open");
    addEntry(db, id, "u1", NOW);
    await handleWithdraw(withdrawInteraction("u1"), ctx);

    addEntry(db, id, "u1", "2026-07-15T13:00:00.000Z"); // reinstates
    expect(hasEntry(db, id, "u1")).toBe(true);
  });

  it("rejects a withdrawal with no entry, writing nothing", async () => {
    seedRaffle("open");

    const interaction = withdrawInteraction("u1");
    await handleWithdraw(interaction, ctx);

    expect(auditTypes()).toEqual([]);
    const { content } = interaction.reply.mock.calls[0]![0] as { content: string };
    expect(content).toContain("haven't entered");
  });

  it("rejects a withdrawal from a raffle that is not open", async () => {
    const id = seedRaffle("closed");
    addEntry(db, id, "u1", NOW);

    const interaction = withdrawInteraction("u1", id);
    await handleWithdraw(interaction, ctx);

    expect(hasEntry(db, id, "u1")).toBe(true); // untouched
    const { content } = interaction.reply.mock.calls[0]![0] as { content: string };
    expect(content).toContain("only withdraw while the raffle is open");
  });
});
