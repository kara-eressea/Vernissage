import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import { getRaffle } from "../../src/db/repositories/raffles.js";
import { startScheduler } from "../../src/scheduler/runner.js";
import type { AppliedTransition } from "../../src/scheduler/transitions.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
  // The runner logs onTransition/sweep failures via console.error; keep quiet.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function insertScheduled(startsAt: string, endsAt: string): number {
  const info = db
    .prepare(
      `INSERT INTO raffles (guild_id, status, starts_at, ends_at, draw_mode, created_at)
       VALUES ('g1', 'scheduled', ?, ?, 'auto', '2026-07-01T00:00:00.000Z')`,
    )
    .run(startsAt, endsAt);
  return Number(info.lastInsertRowid);
}

const START = "2026-07-10T12:00:00.000Z";
const END = "2026-07-17T12:00:00.000Z";

describe("startScheduler", () => {
  it("reconciles missed transitions immediately on start", () => {
    const id = insertScheduled(START, END);
    const seen: AppliedTransition[] = [];

    const scheduler = startScheduler(db, {
      now: () => "2026-07-20T00:00:00.000Z", // long after end
      onTransition: (t) => seen.push(t),
    });

    expect(getRaffle(db, id)?.status).toBe("closed");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ raffleId: id, to: "closed" });
    scheduler.stop();
  });

  it("applies transitions on each interval tick as time advances", () => {
    vi.useFakeTimers();
    const id = insertScheduled(START, END);
    let current = "2026-07-09T00:00:00.000Z"; // before start

    const scheduler = startScheduler(db, {
      intervalMs: 1000,
      now: () => current,
    });

    // Startup reconcile saw nothing due yet.
    expect(getRaffle(db, id)?.status).toBe("scheduled");

    // Advance wall clock past the start, then let a tick fire.
    current = "2026-07-11T00:00:00.000Z";
    vi.advanceTimersByTime(1000);
    expect(getRaffle(db, id)?.status).toBe("open");

    scheduler.stop();
  });

  it("stops sweeping after stop()", () => {
    vi.useFakeTimers();
    const id = insertScheduled(START, END);
    let current = "2026-07-09T00:00:00.000Z";

    const scheduler = startScheduler(db, { intervalMs: 1000, now: () => current });
    scheduler.stop();

    current = "2026-07-11T00:00:00.000Z";
    vi.advanceTimersByTime(5000);
    expect(getRaffle(db, id)?.status).toBe("scheduled"); // no tick ran
  });

  it("does not throw when an onTransition handler throws", () => {
    insertScheduled(START, END);
    const scheduler = startScheduler(db, {
      now: () => "2026-07-20T00:00:00.000Z",
      onTransition: () => {
        throw new Error("handler boom");
      },
    });
    // The sweep still applied despite the handler throwing.
    expect(scheduler.sweepNow("scheduled")).toBeDefined();
    scheduler.stop();
  });
});
