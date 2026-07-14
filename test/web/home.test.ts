import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import { incrementActivity } from "../../src/db/repositories/activity.js";
import { addEntry } from "../../src/db/repositories/entries.js";
import { setGuildConfig } from "../../src/db/repositories/guilds.js";
import { createDraft, setStatus, updateRaffleFields } from "../../src/db/repositories/raffles.js";
import { buildHomeView } from "../../src/web/home.js";

const NOW = "2026-07-14T12:00:00.000Z";
let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("buildHomeView", () => {
  it("produces a dense 28-day spark, zero-filling missing days", () => {
    incrementActivity(db, "g1", "uA", "2026-07-14", 3);
    incrementActivity(db, "g1", "uB", "2026-07-13", 2);
    incrementActivity(db, "g1", "uA", "2026-05-01", 99); // outside the 28-day window

    const view = buildHomeView(db, "g1", NOW);
    const spark = view.activity.spark;
    expect(spark).toHaveLength(28);
    expect(spark[spark.length - 1]).toEqual({ day: "2026-07-14", count: 3 });
    expect(spark[spark.length - 2]).toEqual({ day: "2026-07-13", count: 2 });
    // The out-of-window burst is excluded; only in-window counts total.
    const total = spark.reduce((n, p) => n + p.count, 0);
    expect(total).toBe(5);
    // Both days fall in the most recent week.
    expect(view.activity.weekMessages).toBe(5);
  });

  it("computes the week-over-week activity trend", () => {
    // This week (last 7 days ending 2026-07-14): 2026-07-08..14.
    incrementActivity(db, "g1", "uA", "2026-07-14", 30);
    // Prior week (2026-07-01..07): fewer messages, so the trend is up.
    incrementActivity(db, "g1", "uA", "2026-07-05", 10);

    const view = buildHomeView(db, "g1", NOW);
    expect(view.activity.weekMessages).toBe(30);
    expect(view.activity.trendUp).toBe(true);
    expect(view.activity.trendPct).toBe(200); // (30 - 10) / 10 = +200%
  });

  it("lists scheduled and open raffles with progress and entrant counts", () => {
    const id = createDraft(db, "g1", "modUser", NOW);
    updateRaffleFields(db, id, {
      name: "Summer Vinyl",
      starts_at: "2026-07-13T12:00:00.000Z", // opened 1 day before NOW
      ends_at: "2026-07-15T12:00:00.000Z", // closes 1 day after NOW
      draw_mode: "auto",
    });
    setStatus(db, id, "open");
    addEntry(db, id, "uA", NOW);
    addEntry(db, id, "uB", NOW);

    const view = buildHomeView(db, "g1", NOW);
    expect(view.liveRaffles).toHaveLength(1);
    expect(view.liveCount).toBe(1);
    expect(view.scheduledCount).toBe(0);
    expect(view.liveRaffles[0]).toMatchObject({
      id,
      name: "Summer Vinyl",
      status: "open",
      isLive: true,
      entrants: 2,
      drawMode: "auto",
      progressPct: 50, // exactly halfway through the run at NOW
    });
    expect(view.liveRaffles[0]!.timeNote).toMatch(/closes in/);
  });

  it("warns when the announce channel and activity defaults are unset", () => {
    const view = buildHomeView(db, "g1", NOW);
    const titles = view.warnings.map((w) => w.title).join(" ");
    expect(titles).toMatch(/announce channel/i);
    expect(titles).toMatch(/activity requirement/i);
    expect(view.pool.hasDefaults).toBe(false);
  });

  it("clears the warnings once announce channel and defaults are configured", () => {
    setGuildConfig(
      db,
      "g1",
      {
        announce_channel: "chan1",
        default_req_messages: 10,
        default_req_days: 14,
        default_req_active_days: 3,
      },
      NOW,
    );
    // 10 messages across 3 distinct days, so uA clears both the volume and the
    // distinct-active-days floor.
    incrementActivity(db, "g1", "uA", "2026-07-08", 4);
    incrementActivity(db, "g1", "uA", "2026-07-09", 3);
    incrementActivity(db, "g1", "uA", "2026-07-10", 3);

    const view = buildHomeView(db, "g1", NOW);
    expect(view.warnings).toEqual([]);
    expect(view.pool).toMatchObject({ hasDefaults: true, eligible: 1, considered: 1 });
    expect(view.pool.reqSummary).toBe("10 msgs / 14 days · 3 active days");
  });
});
