import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { MessageCounter } from "../../src/counting/counter.js";
import { openDb } from "../../src/db/index.js";
import { getCountsInWindow } from "../../src/db/repositories/activity.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

const t = (iso: string) => iso;

describe("MessageCounter", () => {
  it("accumulates in memory and flushes day buckets to the database", () => {
    const counter = new MessageCounter();
    counter.record("g1", "u1", t("2026-07-03T10:00:00.000Z"), null);
    counter.record("g1", "u1", t("2026-07-03T10:05:00.000Z"), null);
    counter.record("g1", "u1", t("2026-07-04T09:00:00.000Z"), null);

    expect(counter.pendingWrites).toBe(2); // two distinct days
    const flushed = counter.flush(db);
    expect(flushed).toBe(2);
    expect(counter.pendingWrites).toBe(0);

    expect(getCountsInWindow(db, "g1", "u1", "2026-07-01", "2026-07-31")).toEqual([
      { day: "2026-07-03", count: 2 },
      { day: "2026-07-04", count: 1 },
    ]);
  });

  it("accumulates across successive flushes within the same day", () => {
    const counter = new MessageCounter();
    counter.record("g1", "u1", t("2026-07-03T10:00:00.000Z"), null);
    counter.flush(db);
    counter.record("g1", "u1", t("2026-07-03T10:30:00.000Z"), null);
    counter.flush(db);

    expect(getCountsInWindow(db, "g1", "u1", "2026-07-03", "2026-07-03")).toEqual([
      { day: "2026-07-03", count: 2 },
    ]);
  });

  it("enforces the hourly cap per user", () => {
    const counter = new MessageCounter();
    const cap = 3;
    let counted = 0;
    for (let i = 0; i < 10; i++) {
      if (counter.record("g1", "u1", t(`2026-07-03T10:${String(i).padStart(2, "0")}:00.000Z`), cap)) {
        counted++;
      }
    }
    expect(counted).toBe(3);
    counter.flush(db);
    expect(getCountsInWindow(db, "g1", "u1", "2026-07-03", "2026-07-03")).toEqual([
      { day: "2026-07-03", count: 3 },
    ]);
  });

  it("keeps the cap enforced across a flush within the same hour", () => {
    const counter = new MessageCounter();
    const cap = 2;
    expect(counter.record("g1", "u1", t("2026-07-03T10:00:00.000Z"), cap)).toBe(true);
    counter.flush(db); // flush must not reset the in-hour tally
    expect(counter.record("g1", "u1", t("2026-07-03T10:10:00.000Z"), cap)).toBe(true);
    expect(counter.record("g1", "u1", t("2026-07-03T10:20:00.000Z"), cap)).toBe(false);

    counter.flush(db);
    expect(getCountsInWindow(db, "g1", "u1", "2026-07-03", "2026-07-03")).toEqual([
      { day: "2026-07-03", count: 2 },
    ]);
  });

  it("resets the cap in a new hour", () => {
    const counter = new MessageCounter();
    const cap = 1;
    expect(counter.record("g1", "u1", t("2026-07-03T10:00:00.000Z"), cap)).toBe(true);
    expect(counter.record("g1", "u1", t("2026-07-03T10:30:00.000Z"), cap)).toBe(false);
    expect(counter.record("g1", "u1", t("2026-07-03T11:00:00.000Z"), cap)).toBe(true);
    counter.flush(db);
    expect(getCountsInWindow(db, "g1", "u1", "2026-07-03", "2026-07-03")).toEqual([
      { day: "2026-07-03", count: 2 },
    ]);
  });

  it("caps each user independently", () => {
    const counter = new MessageCounter();
    const cap = 1;
    expect(counter.record("g1", "u1", t("2026-07-03T10:00:00.000Z"), cap)).toBe(true);
    expect(counter.record("g1", "u2", t("2026-07-03T10:00:00.000Z"), cap)).toBe(true);
    expect(counter.record("g1", "u1", t("2026-07-03T10:01:00.000Z"), cap)).toBe(false);
    counter.flush(db);
    expect(getCountsInWindow(db, "g1", "u1", "2026-07-03", "2026-07-03")[0]!.count).toBe(1);
    expect(getCountsInWindow(db, "g1", "u2", "2026-07-03", "2026-07-03")[0]!.count).toBe(1);
  });

  it("flushing with nothing pending is a no-op", () => {
    const counter = new MessageCounter();
    expect(counter.flush(db)).toBe(0);
  });
});
