import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import { incrementActivity } from "../../src/db/repositories/activity.js";
import {
  hasActivitySnapshot,
  listActivitySnapshot,
} from "../../src/db/repositories/activitySnapshot.js";
import { getRaffle, createDraft, setStatus, updateRaffleFields } from "../../src/db/repositories/raffles.js";
import { applyDueTransitions } from "../../src/scheduler/transitions.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

/** A raffle scheduled to open at `startsAt`, with a 14-day activity window. */
function seedScheduled(startsAt: string, endsAt: string): number {
  const id = createDraft(db, "g1", "mod", "2026-07-01T00:00:00.000Z");
  updateRaffleFields(db, id, {
    name: "Summer Vinyl",
    starts_at: startsAt,
    ends_at: endsAt,
    req_messages: 10,
    req_days: 14,
    req_active_days: 3,
  });
  setStatus(db, id, "scheduled");
  return id;
}

describe("freezing the activity measurement at open", () => {
  it("freezes every member's measurement when the raffle opens", () => {
    incrementActivity(db, "g1", "uA", "2026-07-10", 8);
    incrementActivity(db, "g1", "uA", "2026-07-11", 4);
    incrementActivity(db, "g1", "uB", "2026-07-11", 2);
    const id = seedScheduled("2026-07-14T18:00:00.000Z", "2026-07-30T18:00:00.000Z");

    applyDueTransitions(db, "2026-07-14T18:00:05.000Z", "scheduled");

    expect(hasActivitySnapshot(db, id)).toBe(true);
    expect(listActivitySnapshot(db, id)).toEqual([
      { userId: "uA", messages: 12, activeDays: 2 },
      { userId: "uB", messages: 2, activeDays: 1 },
    ]);
    expect(getRaffle(db, id)!.activity_snapshot_at).toBe("2026-07-14T18:00:05.000Z");
  });

  it("measures the raffle's own window, not everything on record", () => {
    incrementActivity(db, "g1", "uA", "2026-06-01", 99); // long before the window
    incrementActivity(db, "g1", "uA", "2026-07-05", 3); // inside it
    const id = seedScheduled("2026-07-14T18:00:00.000Z", "2026-07-30T18:00:00.000Z");

    applyDueTransitions(db, "2026-07-14T18:00:05.000Z", "scheduled");

    expect(listActivitySnapshot(db, id)).toEqual([{ userId: "uA", messages: 3, activeDays: 1 }]);
  });

  it("leaves a raffle that was already open untouched", () => {
    // The deploy case: a raffle mid-flight when this shipped keeps measuring
    // live, exactly as before. The sweep must not retro-freeze it.
    const id = seedScheduled("2026-07-14T18:00:00.000Z", "2026-07-30T18:00:00.000Z");
    setStatus(db, id, "open");
    incrementActivity(db, "g1", "uA", "2026-07-10", 20);

    const applied = applyDueTransitions(db, "2026-07-20T12:00:00.000Z", "reconcile");

    expect(applied).toEqual([]);
    expect(hasActivitySnapshot(db, id)).toBe(false);
    expect(listActivitySnapshot(db, id)).toEqual([]);
  });

  it("does not freeze anything when a raffle closes", () => {
    const id = seedScheduled("2026-07-14T18:00:00.000Z", "2026-07-16T18:00:00.000Z");
    setStatus(db, id, "open");

    applyDueTransitions(db, "2026-07-16T18:00:05.000Z", "scheduled");

    expect(getRaffle(db, id)!.status).toBe("closed");
    expect(hasActivitySnapshot(db, id)).toBe(false);
  });

  it("warns when a raffle opens late, because the snapshot is taken late too", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seedScheduled("2026-07-14T18:00:00.000Z", "2026-07-30T18:00:00.000Z");

    // The bot was down at the open instant and catches up at startup.
    applyDueTransitions(db, "2026-07-15T09:00:00.000Z", "reconcile");

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("opened late"));
    warn.mockRestore();
  });
});
