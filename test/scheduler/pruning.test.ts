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

function openRaffleWithLookback(reqDays: number, startsAt: string = NOW): void {
  const id = createDraft(db, "g1", "mod", NOW);
  updateRaffleFields(db, id, { req_days: reqDays, starts_at: startsAt });
  setStatus(db, id, "open");
}

function remainingDays(): string[] {
  return getCountsInWindow(db, "g1", "u1", "2000-01-01", "2100-12-31").map((c) => c.day);
}

describe("startActivityPruning", () => {
  it("prunes rows past the retention horizon (+ safety) on startup", () => {
    openRaffleWithLookback(14); // needs 2026-07-02 onward; retention governs here
    for (const day of ["2026-06-20", "2026-06-29", "2026-06-30", "2026-07-01"]) {
      incrementActivity(db, "g1", "u1", day, 1);
    }

    // A 14-day horizon puts the cutoff at 2026-06-30 for now=2026-07-15, safety 1.
    const handle = startActivityPruning(db, { now: () => NOW, retentionDays: 14 });
    // Rows strictly before the cutoff day are gone; the cutoff day and later stay.
    expect(remainingDays()).toEqual(["2026-06-30", "2026-07-01"]);
    handle.stop();
  });

  it("keeps six months by default, with no raffle in play", () => {
    for (const day of ["2025-12-01", "2026-02-01", "2026-07-01"]) {
      incrementActivity(db, "g1", "u1", day, 1);
    }
    const handle = startActivityPruning(db, { now: () => NOW });
    // 180 days + 1 back from 2026-07-15 is 2026-01-15: only the older row goes.
    expect(remainingDays()).toEqual(["2026-02-01", "2026-07-01"]);
    handle.stop();
  });

  it("regression: never prunes days a still-open raffle is judging entrants on", () => {
    // The raffle opened on 2026-06-05 with a 14-day window, so it judges every
    // entrant on 2026-05-23..2026-06-05 for its whole run — including entrants
    // arriving today (2026-07-15), long after a now-relative horizon would have
    // deleted those days. Before the fix the horizon was measured from now, so
    // the window was eroded underneath the open raffle and late entrants were
    // judged on a truncated window (and wrongly rejected).
    openRaffleWithLookback(14, "2026-06-05T12:00:00.000Z");
    for (const day of ["2026-05-20", "2026-05-22", "2026-05-23", "2026-06-05", "2026-07-01"]) {
      incrementActivity(db, "g1", "u1", day, 1);
    }

    const handle = startActivityPruning(db, { now: () => NOW, retentionDays: 14 });

    // The raffle's whole window survives (2026-05-23 onward), plus the one-day
    // safety buffer below it; only what predates that is pruned.
    expect(remainingDays()).toEqual([
      "2026-05-22",
      "2026-05-23",
      "2026-06-05",
      "2026-07-01",
    ]);
    handle.stop();
  });

  it("prunes to the horizon once the raffle that needed those days is finished", () => {
    const id = createDraft(db, "g1", "mod", NOW);
    updateRaffleFields(db, id, { req_days: 14, starts_at: "2026-06-05T12:00:00.000Z" });
    setStatus(db, id, "drawn"); // no longer enterable, so its window is not protected
    for (const day of ["2026-05-23", "2026-07-01"]) {
      incrementActivity(db, "g1", "u1", day, 1);
    }

    const handle = startActivityPruning(db, { now: () => NOW, retentionDays: 14 });
    expect(remainingDays()).toEqual(["2026-07-01"]);
    handle.stop();
  });
});
