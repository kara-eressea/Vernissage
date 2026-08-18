import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { checkEligibility } from "../../src/core/eligibility.js";
import { openDb } from "../../src/db/index.js";
import { incrementActivity } from "../../src/db/repositories/activity.js";
import { getRaffle, createDraft, setStatus, updateRaffleFields } from "../../src/db/repositories/raffles.js";
import { getGuild } from "../../src/db/repositories/guilds.js";
import { gatherEligibilityInput } from "../../src/discord/entryFlow.js";
import { applyDueTransitions } from "../../src/scheduler/transitions.js";

let db: Database;
const START = "2026-07-14T18:00:00.000Z";

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

function seedScheduled(): number {
  const id = createDraft(db, "g1", "mod", "2026-07-01T00:00:00.000Z");
  updateRaffleFields(db, id, {
    starts_at: START,
    ends_at: "2026-07-30T18:00:00.000Z",
    req_messages: 10,
    req_days: 14,
    req_active_days: 3,
  });
  setStatus(db, id, "scheduled");
  return id;
}

/** Run the real gate for a member, the way the entry path does. */
function judge(raffleId: number, userId: string, now: string): ReturnType<typeof checkEligibility> {
  const raffle = getRaffle(db, raffleId)!;
  return checkEligibility(
    gatherEligibilityInput(db, {
      raffle,
      guild: getGuild(db, "g1"),
      userId,
      userRoleIds: [],
      joinedAt: null,
      now,
    }),
  );
}

describe("the entry gate and the frozen measurement", () => {
  it("ignores messages sent after the raffle opened, even the same UTC day", () => {
    // Four active days at open, against a floor of three but only 9 messages —
    // one short. This is the reported case: refused, then chatted, then entered.
    for (const day of ["2026-07-08", "2026-07-09", "2026-07-10", "2026-07-11"]) {
      incrementActivity(db, "g1", "uA", day, 2);
    }
    incrementActivity(db, "g1", "uA", "2026-07-12", 1); // 9 messages total
    const id = seedScheduled();
    applyDueTransitions(db, START, "scheduled");

    expect(judge(id, "uA", "2026-07-14T18:30:00.000Z")).toEqual({
      ok: false,
      reason: "insufficient_activity",
    });

    // They now chat 20 messages — on the raffle's own start day, which the
    // day-resolution window would otherwise count.
    incrementActivity(db, "g1", "uA", "2026-07-14", 20);

    expect(judge(id, "uA", "2026-07-14T20:00:00.000Z")).toEqual({
      ok: false,
      reason: "insufficient_activity",
    });
  });

  it("admits a member who already cleared the bar when the doors opened", () => {
    for (const day of ["2026-07-08", "2026-07-09", "2026-07-10"]) {
      incrementActivity(db, "g1", "uA", day, 5);
    }
    const id = seedScheduled();
    applyDueTransitions(db, START, "scheduled");

    expect(judge(id, "uA", "2026-07-15T09:00:00.000Z")).toEqual({ ok: true });
  });

  it("treats a member absent from the snapshot as having no activity, not as unmeasured", () => {
    incrementActivity(db, "g1", "uA", "2026-07-10", 20);
    const id = seedScheduled();
    applyDueTransitions(db, START, "scheduled");
    // uB posts only after the raffle opened, so they are not in the snapshot.
    incrementActivity(db, "g1", "uB", "2026-07-14", 50);

    expect(judge(id, "uB", "2026-07-14T21:00:00.000Z")).toEqual({
      ok: false,
      reason: "insufficient_activity",
    });
  });

  it("keeps measuring live for a raffle that was already open when this shipped", () => {
    // The deploy case: no snapshot exists, so the gate behaves exactly as before
    // — including counting same-day activity, which is the pre-existing rule.
    const id = seedScheduled();
    setStatus(db, id, "open"); // opened without ever passing through the freeze
    for (const day of ["2026-07-08", "2026-07-09", "2026-07-10"]) {
      incrementActivity(db, "g1", "uA", day, 5);
    }

    expect(getRaffle(db, id)!.activity_snapshot_at).toBeNull();
    expect(judge(id, "uA", "2026-07-15T09:00:00.000Z")).toEqual({ ok: true });
  });
});
