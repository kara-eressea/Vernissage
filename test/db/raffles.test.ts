import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import type { RaffleStatus } from "../../src/core/types.js";
import { validateDraw } from "../../src/core/raffleValidation.js";
import { openDb } from "../../src/db/index.js";
import {
  countRafflesSince,
  createDraft,
  getRaffle,
  earliestActivityWindowStart,
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

describe("createDraft", () => {
  it("starts a draft at draw_mode 'auto', matching the wizard's pre-selected default", () => {
    // Repro of the 'draw mode must be auto or manual' error on an untouched
    // draw step: the select showed 'auto' while the row held NULL.
    const id = createDraft(db, "g1", "mod", "2026-07-01T00:00:00.000Z");
    const raffle = getRaffle(db, id)!;
    expect(raffle.draw_mode).toBe("auto");
    expect(validateDraw(raffle).ok).toBe(true);
  });
});

describe("earliestActivityWindowStart", () => {
  /** Seed a raffle with a status, req_days, and an explicit start. */
  function seedStarting(status: RaffleStatus, reqDays: number | null, startsAt: string): number {
    const id = seed(status, reqDays);
    updateRaffleFields(db, id, { starts_at: startsAt });
    return id;
  }

  it("returns null when nothing is scheduled or open", () => {
    expect(earliestActivityWindowStart(db)).toBeNull();
    seedStarting("draft", 30, "2026-07-01T00:00:00.000Z");
    seedStarting("drawn", 90, "2026-07-01T00:00:00.000Z");
    seedStarting("completed", 60, "2026-07-01T00:00:00.000Z");
    seedStarting("cancelled", 45, "2026-07-01T00:00:00.000Z");
    expect(earliestActivityWindowStart(db)).toBeNull();
  });

  it("returns the window start: the raffle's start day less req_days - 1", () => {
    seedStarting("open", 14, "2026-07-15T12:00:00.000Z");
    expect(earliestActivityWindowStart(db)).toBe("2026-07-02");
  });

  it("takes the earliest across scheduled/open raffles, ignoring finished ones", () => {
    seedStarting("open", 7, "2026-07-15T12:00:00.000Z"); // 2026-07-09
    seedStarting("scheduled", 30, "2026-07-20T12:00:00.000Z"); // 2026-06-21
    seedStarting("drawn", 90, "2026-07-01T00:00:00.000Z"); // ignored — draw is done
    expect(earliestActivityWindowStart(db)).toBe("2026-06-21");
  });

  it("treats a null or sub-1 req_days as a single-day window, like the entry check", () => {
    seedStarting("open", null, "2026-07-15T12:00:00.000Z");
    expect(earliestActivityWindowStart(db)).toBe("2026-07-15");
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
