import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import type { RaffleStatus } from "../../src/core/types.js";
import { openDb } from "../../src/db/index.js";
import {
  countRafflesSince,
  createDraft,
  maxReqDaysInUse,
  setStatus,
  updateRaffleFields,
} from "../../src/db/repositories/raffles.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

/** Seed a raffle in a given status with an optional req_days. */
function seed(status: RaffleStatus, reqDays: number | null): number {
  const id = createDraft(db, "g1", "mod", "2026-07-01T00:00:00.000Z");
  if (reqDays !== null) {
    updateRaffleFields(db, id, { req_days: reqDays });
  }
  setStatus(db, id, status);
  return id;
}

describe("maxReqDaysInUse", () => {
  it("returns null when nothing is scheduled or open", () => {
    expect(maxReqDaysInUse(db)).toBeNull();
    seed("draft", 30);
    seed("drawn", 90);
    seed("completed", 60);
    seed("cancelled", 45);
    expect(maxReqDaysInUse(db)).toBeNull();
  });

  it("returns the largest req_days across scheduled/open raffles only", () => {
    seed("scheduled", 7);
    seed("open", 14);
    seed("drawn", 90); // ignored — draw is done
    expect(maxReqDaysInUse(db)).toBe(14);
  });

  it("ignores null req_days", () => {
    seed("open", null);
    expect(maxReqDaysInUse(db)).toBeNull();
    seed("scheduled", 5);
    expect(maxReqDaysInUse(db)).toBe(5);
  });
});

describe("countRafflesSince", () => {
  /** A drawn raffle starting at `startsAt`, optionally a test raffle. */
  function drawnAt(startsAt: string, isTest = false): number {
    const id = createDraft(db, "g1", "mod", "2026-07-01T00:00:00.000Z");
    updateRaffleFields(db, id, { starts_at: startsAt, ...(isTest ? { is_test: 1 } : {}) });
    setStatus(db, id, "drawn");
    return id;
  }

  it("counts drawn/completed raffles that started after the given instant", () => {
    drawnAt("2026-07-05T00:00:00.000Z");
    drawnAt("2026-07-06T00:00:00.000Z");
    expect(countRafflesSince(db, "g1", "2026-07-04T00:00:00.000Z")).toBe(2);
    expect(countRafflesSince(db, "g1", "2026-07-05T00:00:00.000Z")).toBe(1);
  });

  it("excludes test raffles so a test draw never advances a count cooldown", () => {
    drawnAt("2026-07-05T00:00:00.000Z");
    drawnAt("2026-07-06T00:00:00.000Z", true); // test raffle, ignored
    expect(countRafflesSince(db, "g1", "2026-07-04T00:00:00.000Z")).toBe(1);
  });
});
