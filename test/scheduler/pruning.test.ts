import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import { getCountsInWindow, incrementActivity } from "../../src/db/repositories/activity.js";
import {
  createDraft,
  setStatus,
  updateRaffleFields,
} from "../../src/db/repositories/raffles.js";
import { startActivityPruning } from "../../src/scheduler/pruning.js";

let db: Database;
const NOW = "2026-07-15T12:00:00.000Z";

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

function openRaffleWithLookback(reqDays: number): void {
  const id = createDraft(db, "g1", "mod", NOW);
  updateRaffleFields(db, id, { req_days: reqDays });
  setStatus(db, id, "open");
}

function remainingDays(): string[] {
  return getCountsInWindow(db, "g1", "u1", "2000-01-01", "2100-12-31").map((c) => c.day);
}

describe("startActivityPruning", () => {
  it("prunes rows older than the longest lookback (+ safety) on startup", () => {
    openRaffleWithLookback(14); // cutoff at 2026-06-30 for now=2026-07-15, safety 1
    for (const day of ["2026-06-20", "2026-06-29", "2026-06-30", "2026-07-01"]) {
      incrementActivity(db, "g1", "u1", day, 1);
    }

    const handle = startActivityPruning(db, { now: () => NOW });
    // Rows strictly before the cutoff day (2026-06-30) are gone; the cutoff day
    // itself and later are kept.
    expect(remainingDays()).toEqual(["2026-06-30", "2026-07-01"]);
    handle.stop();
  });

  it("no-ops when no lookback is in use", () => {
    incrementActivity(db, "g1", "u1", "2020-01-01", 1);
    const handle = startActivityPruning(db, { now: () => NOW });
    // Nothing scheduled/open -> maxReqDaysInUse null -> keep everything.
    expect(remainingDays()).toEqual(["2020-01-01"]);
    expect(handle.pruneNow()).toBe(0);
    handle.stop();
  });
});
