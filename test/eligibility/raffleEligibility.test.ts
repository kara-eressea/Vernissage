import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import { incrementActivity } from "../../src/db/repositories/activity.js";
import { addBan } from "../../src/db/repositories/blacklist.js";
import { addEntry } from "../../src/db/repositories/entries.js";
import { setGuildConfig } from "../../src/db/repositories/guilds.js";
import { createDraft, setStatus, updateRaffleFields } from "../../src/db/repositories/raffles.js";
import { addWin } from "../../src/db/repositories/wins.js";
import { evaluateRaffleEligibility } from "../../src/eligibility/service.js";

const NOW = "2026-07-20T12:00:00.000Z";
/** The raffle opens here, so its window is the 14 days ending 2026-07-14. */
const START = "2026-07-14T18:00:00.000Z";
let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
  setGuildConfig(
    db,
    "g1",
    { default_req_messages: 10, default_req_days: 14, default_req_active_days: 3 },
    NOW,
  );
});

afterEach(() => {
  db.close();
});

/** A raffle open for entry, with its own bar unless overridden. */
function seedRaffle(fields: Record<string, unknown> = {}): number {
  const id = createDraft(db, "g1", "mod", "2026-07-01T00:00:00.000Z");
  updateRaffleFields(db, id, {
    name: "Summer Vinyl",
    starts_at: START,
    ends_at: "2026-07-30T18:00:00.000Z",
    req_messages: 10,
    req_days: 14,
    req_active_days: 3,
    ...fields,
  });
  setStatus(db, id, "open");
  return id;
}

/** Spread `days` distinct active days of activity ending 2026-07-13. */
function seedSpread(userId: string, days: number, perDay = 5): void {
  for (let i = 0; i < days; i++) {
    incrementActivity(db, "g1", userId, `2026-07-${String(13 - i).padStart(2, "0")}`, perDay);
  }
}

describe("evaluateRaffleEligibility", () => {
  it("returns null for a raffle in another guild", () => {
    const id = seedRaffle();
    expect(evaluateRaffleEligibility(db, "other", id, NOW)).toBeNull();
  });

  it("evaluates the raffle's own window, anchored at its start", () => {
    const id = seedRaffle();
    seedSpread("uA", 4); // 20 messages over 4 days, inside the window
    // Activity after the raffle opened must not count toward it.
    incrementActivity(db, "g1", "uB", "2026-07-18", 50);

    const report = evaluateRaffleEligibility(db, "g1", id, NOW)!;

    expect(report.window).toEqual({ startDay: "2026-07-01", endDay: "2026-07-14" });
    expect(report.anchoredAt).toBe(START);
    const a = report.members.find((m) => m.userId === "uA")!;
    expect(a).toMatchObject({ messages: 20, activeDays: 4, eligible: true, reasons: [] });
    // uB's only activity is outside the window, so they are not a candidate.
    expect(report.members.some((m) => m.userId === "uB")).toBe(false);
  });

  it("reports every failing gate, not just the first", () => {
    const id = seedRaffle();
    seedSpread("uA", 1, 2); // 2 messages on 1 day: misses both floors
    addBan(db, {
      guildId: "g1",
      userId: "uA",
      bannedBy: "mod",
      reason: "spam",
      bannedAt: NOW,
      expiresAt: null,
    });

    const report = evaluateRaffleEligibility(db, "g1", id, NOW)!;
    const a = report.members.find((m) => m.userId === "uA")!;

    expect(a.eligible).toBe(false);
    expect(a.reasons).toEqual(["blacklisted", "insufficient_activity"]);
    expect(a.missesVolume).toBe(true);
    expect(a.missesSpread).toBe(true);
  });

  it("separates a spread failure from a volume failure", () => {
    const id = seedRaffle();
    seedSpread("uVolume", 4, 1); // 4 messages over 4 days: enough spread, too few messages
    seedSpread("uSpread", 2, 30); // 60 messages over 2 days: plenty, too concentrated

    const report = evaluateRaffleEligibility(db, "g1", id, NOW)!;
    const volume = report.members.find((m) => m.userId === "uVolume")!;
    const spread = report.members.find((m) => m.userId === "uSpread")!;

    expect(volume).toMatchObject({ missesVolume: true, missesSpread: false, eligible: false });
    expect(spread).toMatchObject({ missesVolume: false, missesSpread: true, eligible: false });
    expect(spread.reasons).toEqual(["insufficient_activity"]);
  });

  it("marks who actually entered without hiding why they would have been blocked", () => {
    const id = seedRaffle();
    seedSpread("uA", 4);
    addEntry(db, id, "uA", NOW);

    const report = evaluateRaffleEligibility(db, "g1", id, NOW)!;
    const a = report.members.find((m) => m.userId === "uA")!;

    expect(a.entered).toBe(true);
    // "already_entered" is reported as a column, never as an ineligibility reason.
    expect(a.reasons).not.toContain("already_entered");
    expect(report.entered).toBe(1);
  });

  it("includes an entrant with no counted activity (an open-to-all raffle)", () => {
    const id = seedRaffle({ open_to_all: 1 });
    addEntry(db, id, "uGhost", NOW);

    const report = evaluateRaffleEligibility(db, "g1", id, NOW)!;
    const ghost = report.members.find((m) => m.userId === "uGhost")!;

    expect(ghost.entered).toBe(true);
    // Open to everyone waives the activity gate, so no counts is still eligible.
    expect(ghost.eligible).toBe(true);
  });

  it("does not let a win recorded after the raffle block a member retroactively", () => {
    const id = seedRaffle({ cooldown_days: 60 });
    seedSpread("uA", 4);
    // A different raffle they won *after* this one started.
    const later = createDraft(db, "g1", "mod", NOW);
    updateRaffleFields(db, later, { starts_at: "2026-07-18T00:00:00.000Z" });
    setStatus(db, later, "drawn");
    addWin(db, later, "uA", "2026-07-19T00:00:00.000Z");

    const report = evaluateRaffleEligibility(db, "g1", id, NOW)!;
    const a = report.members.find((m) => m.userId === "uA")!;

    expect(a.reasons).not.toContain("in_cooldown");
    expect(a.eligible).toBe(true);
  });

  it("applies a cooldown from a win that predates the raffle", () => {
    const id = seedRaffle({ cooldown_days: 60 });
    seedSpread("uA", 4);
    const earlier = createDraft(db, "g1", "mod", "2026-06-01T00:00:00.000Z");
    updateRaffleFields(db, earlier, { starts_at: "2026-06-20T00:00:00.000Z" });
    setStatus(db, earlier, "drawn");
    addWin(db, earlier, "uA", "2026-06-25T00:00:00.000Z");

    const report = evaluateRaffleEligibility(db, "g1", id, NOW)!;
    const a = report.members.find((m) => m.userId === "uA")!;

    expect(a.reasons).toContain("in_cooldown");
  });

  it("reads the activity bar off the raffle row, exactly as the entry gate does", () => {
    // The raffle row carries the bar resolved at creation, so a raffle with no
    // values of its own has no activity gate — not the guild's. Reporting the
    // guild default here would describe a bar the raffle never applied.
    const id = seedRaffle({ req_messages: null, req_days: null, req_active_days: null });
    const report = evaluateRaffleEligibility(db, "g1", id, NOW)!;
    expect(report.settings).toMatchObject({ reqMessages: 0, reqDays: 1, reqActiveDays: 0 });
  });

  it("still reports for a drawn raffle, so a moderator can look back", () => {
    const id = seedRaffle();
    setStatus(db, id, "drawn");
    seedSpread("uA", 4);

    const report = evaluateRaffleEligibility(db, "g1", id, NOW)!;

    expect(report.status).toBe("drawn");
    // The raffle being closed is not held against every member individually.
    expect(report.members[0]!.reasons).not.toContain("not_open");
    expect(report.eligible).toBe(1);
  });

  it("counts the totals the header shows", () => {
    const id = seedRaffle();
    seedSpread("uA", 4);
    seedSpread("uB", 4);
    seedSpread("uC", 1, 1);
    addEntry(db, id, "uA", NOW);

    const report = evaluateRaffleEligibility(db, "g1", id, NOW)!;

    expect(report).toMatchObject({ considered: 3, eligible: 2, entered: 1 });
  });
});
