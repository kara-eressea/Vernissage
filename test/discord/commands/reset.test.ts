import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import type { BotConfig } from "../../../src/config.js";
import { MessageCounter } from "../../../src/counting/counter.js";
import { openDb } from "../../../src/db/index.js";
import {
  deleteUserActivity,
  getCountsInWindow,
  incrementActivity,
} from "../../../src/db/repositories/activity.js";
import {
  createDraft,
  setStatus,
  updateRaffleFields,
} from "../../../src/db/repositories/raffles.js";
import { listActivitySnapshot } from "../../../src/db/repositories/activitySnapshot.js";
import { applyDueTransitions } from "../../../src/scheduler/transitions.js";
import { addWin, getUserWins } from "../../../src/db/repositories/wins.js";
import { handleReset } from "../../../src/discord/commands/raffle/reset.js";
import type { CommandContext } from "../../../src/discord/commands/index.js";
import { makeFakeNotifier } from "../../helpers/fakeNotifier.js";
import { fakeChatInput } from "../../helpers/fakeInteraction.js";

let db: Database;
let counter: MessageCounter;
let ctx: CommandContext;

beforeEach(() => {
  db = openDb(":memory:");
  counter = new MessageCounter();
  ctx = { db, config: {} as BotConfig, notifier: makeFakeNotifier(), counter };
});

afterEach(() => {
  db.close();
});

function auditRows(): Array<{ event_type: string; actor_id: string | null; payload: string | null }> {
  return db.prepare(`SELECT event_type, actor_id, payload FROM audit_log`).all() as Array<{
    event_type: string;
    actor_id: string | null;
    payload: string | null;
  }>;
}

/** A mod invoking `/raffle reset` on `target` with a given scope. */
function reset(scope: string, target = "target") {
  return fakeChatInput({
    subcommand: "reset",
    manageGuild: true,
    userId: "mod-1",
    values: { user: { id: target }, scope },
  });
}

/** Give `user` a real (gating) win in guild g1. */
function winFor(user: string): void {
  const r = createDraft(db, "g1", "creator", "2026-07-01T00:00:00.000Z");
  addWin(db, r, user, "2026-07-02T00:00:00.000Z");
}

describe("handleReset", () => {
  it("rejects a non-moderator and writes nothing", async () => {
    winFor("target");
    const interaction = fakeChatInput({
      subcommand: "reset",
      manageGuild: false,
      ownerId: "someone-else",
      roleIds: [],
      values: { user: { id: "target" }, scope: "all" },
    });

    await handleReset(interaction, ctx);

    expect(interaction.reply).toHaveBeenCalledOnce();
    expect(getUserWins(db, "g1", "target")).toHaveLength(1); // untouched
    expect(auditRows()).toHaveLength(0);
  });

  it("cooldown scope waives the user's wins and leaves activity alone", async () => {
    winFor("target");
    incrementActivity(db, "g1", "target", "2026-07-03", 5);

    await handleReset(reset("cooldown"), ctx);

    expect(getUserWins(db, "g1", "target")).toEqual([]);
    // Activity is out of scope for a cooldown reset.
    expect(getCountsInWindow(db, "g1", "target", "2026-07-01", "2026-07-31")).toEqual([
      { day: "2026-07-03", count: 5 },
    ]);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_type).toBe("eligibility_reset");
    expect(rows[0]!.actor_id).toBe("mod-1");
    expect(JSON.parse(rows[0]!.payload!)).toMatchObject({
      userId: "target",
      scope: "cooldown",
      winsWaived: 1,
    });
  });

  it("activity scope deletes counts, clears the buffer, and leaves wins alone", async () => {
    winFor("target");
    incrementActivity(db, "g1", "target", "2026-07-03", 5);
    // A count still buffered in memory must not survive the reset.
    counter.record("g1", "target", "2026-07-03T12:00:00.000Z", null);

    await handleReset(reset("activity"), ctx);

    expect(getCountsInWindow(db, "g1", "target", "2026-07-01", "2026-07-31")).toEqual([]);
    // The buffered count was dropped, so a later flush re-creates nothing.
    counter.flush(db);
    expect(getCountsInWindow(db, "g1", "target", "2026-07-01", "2026-07-31")).toEqual([]);
    // Wins are out of scope for an activity reset.
    expect(getUserWins(db, "g1", "target")).toHaveLength(1);
    expect(JSON.parse(auditRows()[0]!.payload!)).toMatchObject({
      scope: "activity",
      activityRowsDeleted: 1,
    });
  });

  it("all scope clears both wins and activity", async () => {
    winFor("target");
    incrementActivity(db, "g1", "target", "2026-07-03", 5);

    await handleReset(reset("all"), ctx);

    expect(getUserWins(db, "g1", "target")).toEqual([]);
    expect(getCountsInWindow(db, "g1", "target", "2026-07-01", "2026-07-31")).toEqual([]);
    expect(JSON.parse(auditRows()[0]!.payload!)).toMatchObject({
      scope: "all",
      winsWaived: 1,
      activityRowsDeleted: 1,
    });
  });

  it("only affects the named user, not others", async () => {
    winFor("target");
    winFor("bystander");
    incrementActivity(db, "g1", "bystander", "2026-07-03", 9);

    await handleReset(reset("all"), ctx);

    expect(getUserWins(db, "g1", "bystander")).toHaveLength(1);
    expect(getCountsInWindow(db, "g1", "bystander", "2026-07-01", "2026-07-31")).toEqual([
      { day: "2026-07-03", count: 9 },
    ]);
  });

  it("still runs (and audits) when there is nothing to clear", async () => {
    await handleReset(reset("all"), ctx);
    expect(auditRows()).toHaveLength(1);
    expect(JSON.parse(auditRows()[0]!.payload!)).toMatchObject({
      winsWaived: 0,
      activityRowsDeleted: 0,
    });
  });

  it("works without a counter wired in (activity DB delete still happens)", async () => {
    incrementActivity(db, "g1", "target", "2026-07-03", 5);
    const ctxNoCounter: CommandContext = { db, config: {} as BotConfig, notifier: makeFakeNotifier() };

    await handleReset(reset("activity"), ctxNoCounter);

    expect(getCountsInWindow(db, "g1", "target", "2026-07-01", "2026-07-31")).toEqual([]);
  });
});

/** Guard: the repository delete used by the handler is guild-scoped. */
describe("reset relies on guild-scoped deletes", () => {
  it("deleteUserActivity does not cross guilds", () => {
    incrementActivity(db, "g1", "u1", "2026-07-03", 1);
    incrementActivity(db, "g2", "u1", "2026-07-03", 1);
    expect(deleteUserActivity(db, "g1", "u1")).toBe(1);
    expect(getCountsInWindow(db, "g2", "u1", "2026-07-01", "2026-07-31")).toHaveLength(1);
  });
});

describe("resetting activity while a raffle is open", () => {
  /** An open raffle whose activity measurement was frozen when it opened. */
  function openFrozenRaffle(): number {
    const id = createDraft(db, "g1", "mod-1", "2026-07-01T00:00:00.000Z");
    updateRaffleFields(db, id, {
      starts_at: "2026-07-14T18:00:00.000Z",
      ends_at: "2026-07-30T18:00:00.000Z",
      req_messages: 10,
      req_days: 14,
      req_active_days: 3,
    });
    setStatus(db, id, "scheduled");
    applyDueTransitions(db, "2026-07-14T18:00:00.000Z", "scheduled");
    return id;
  }

  it("re-measures the member's frozen row, so the reset still bites mid-raffle", async () => {
    // A spam wave inflated their counts; the mod resets them while the raffle
    // runs. A pure freeze would leave the inflated figure standing.
    incrementActivity(db, "g1", "target", "2026-07-10", 40);
    incrementActivity(db, "g1", "other", "2026-07-10", 12);
    const id = openFrozenRaffle();
    expect(listActivitySnapshot(db, id)).toContainEqual({
      userId: "target",
      messages: 40,
      activeDays: 1,
    });

    await handleReset(reset("activity"), ctx);

    // Their frozen row is gone (nothing left to measure)...
    expect(listActivitySnapshot(db, id).map((r) => r.userId)).toEqual(["other"]);
    // ...and everyone else's is untouched.
    expect(listActivitySnapshot(db, id)).toContainEqual({
      userId: "other",
      messages: 12,
      activeDays: 1,
    });
  });

  it("leaves frozen rows alone when only the cooldown is reset", async () => {
    incrementActivity(db, "g1", "target", "2026-07-10", 40);
    const id = openFrozenRaffle();

    await handleReset(reset("cooldown"), ctx);

    expect(listActivitySnapshot(db, id)).toContainEqual({
      userId: "target",
      messages: 40,
      activeDays: 1,
    });
  });
});
