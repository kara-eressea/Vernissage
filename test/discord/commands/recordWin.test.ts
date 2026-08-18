import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import type { BotConfig } from "../../../src/config.js";
import { openDb } from "../../../src/db/index.js";
import { setGuildConfig } from "../../../src/db/repositories/guilds.js";
import { getUserWins, listExternalWins } from "../../../src/db/repositories/wins.js";
import { handleRecordWin } from "../../../src/discord/commands/raffle/recordWin.js";
import type { CommandContext } from "../../../src/discord/commands/index.js";
import { makeFakeNotifier } from "../../helpers/fakeNotifier.js";
import { fakeChatInput } from "../../helpers/fakeInteraction.js";

let db: Database;
let ctx: CommandContext;

beforeEach(() => {
  db = openDb(":memory:");
  setGuildConfig(db, "g1", { default_cooldown_days: 30 }, "2026-01-01T00:00:00.000Z");
  ctx = { db, config: {} as BotConfig, notifier: makeFakeNotifier() };
});

afterEach(() => {
  db.close();
});

function auditRows(): Array<{ event_type: string; payload: string | null }> {
  return db.prepare(`SELECT event_type, payload FROM audit_log`).all() as Array<{
    event_type: string;
    payload: string | null;
  }>;
}

/** A mod invoking `/raffle record-win`. */
function record(values: Record<string, unknown>, manageGuild = true) {
  return fakeChatInput({
    subcommand: "record-win",
    manageGuild,
    userId: "mod-1",
    values: { user: { id: "target" }, ...values },
  });
}

/** The text of the ephemeral reply. */
function replyText(interaction: ReturnType<typeof record>): string {
  return (interaction.reply.mock.calls[0]![0] as { content: string }).content;
}

describe("handleRecordWin", () => {
  it("rejects a non-moderator and writes nothing", async () => {
    const interaction = record({ "won-at": "2026-06-15" }, false);

    await handleRecordWin(interaction, ctx);

    expect(listExternalWins(db, "g1")).toEqual([]);
    expect(auditRows()).toEqual([]);
  });

  it("records the win so it gates the cooldown", async () => {
    const interaction = record({ "won-at": "2026-06-15", note: "Summer art contest" });

    await handleRecordWin(interaction, ctx);

    const wins = listExternalWins(db, "g1");
    expect(wins).toHaveLength(1);
    expect(wins[0]).toMatchObject({
      user_id: "target",
      source: "external",
      note: "Summer art contest",
      raffle_id: null,
      guild_id: "g1",
    });
    // The whole point: it reaches the eligibility read.
    expect(getUserWins(db, "g1", "target")).toHaveLength(1);
  });

  it("refuses a date in the future rather than storing it", async () => {
    // A future date pushes the cooldown further out the later it is — the wrong
    // shape of mistake to accept silently.
    const interaction = record({ "won-at": "2099-01-01" });

    await handleRecordWin(interaction, ctx);

    expect(listExternalWins(db, "g1")).toEqual([]);
    expect(replyText(interaction).toLowerCase()).toContain("future");
  });

  it("reports an unparseable date without writing", async () => {
    const interaction = record({ "won-at": "whenever-ish" });

    await handleRecordWin(interaction, ctx);

    expect(listExternalWins(db, "g1")).toEqual([]);
    expect(interaction.reply).toHaveBeenCalledTimes(1);
  });

  it("writes an audit row carrying the note, and mirrors one without it", async () => {
    const interaction = record({ "won-at": "2026-06-15", note: "private detail" });

    await handleRecordWin(interaction, ctx);

    const row = auditRows().find((r) => r.event_type === "external_win_recorded")!;
    expect(JSON.parse(row.payload!)).toMatchObject({ userId: "target", note: "private detail" });

    // The audit channel is readable by everyone, so free moderator text about a
    // member must not be mirrored (same rule as a blacklist reason).
    const mirrored = ctx.notifier.mirrorAudit as unknown as {
      mock: { calls: Array<[{ payload: Record<string, unknown> }]> };
    };
    const payload = mirrored.mock.calls[0]![0].payload;
    expect(payload).toMatchObject({ userId: "target" });
    expect(payload).not.toHaveProperty("note");
  });

  it("tells the moderator the cooldown the import produced", async () => {
    const interaction = record({ "won-at": "2026-06-15" });

    await handleRecordWin(interaction, ctx);

    const text = replyText(interaction);
    expect(text).toContain("Recorded a past win");
    // A 30-day default cooldown from a date long past has already lapsed, and
    // saying so is the point — the mod can see the import did nothing gating.
    expect(text.toLowerCase()).toContain("no win cooldown");
  });

  it("reports an active cooldown when the win is recent enough to still bite", async () => {
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const interaction = record({ "won-at": recent });

    await handleRecordWin(interaction, ctx);

    expect(replyText(interaction).toLowerCase()).toContain("cooldown");
    expect(replyText(interaction)).toContain("/raffle reset");
  });

  it("stores no note when none is given", async () => {
    await handleRecordWin(record({ "won-at": "2026-06-15" }), ctx);
    expect(listExternalWins(db, "g1")[0]!.note).toBeNull();
  });
});
