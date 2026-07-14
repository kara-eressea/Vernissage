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
    expect(view.spark).toHaveLength(28);
    expect(view.spark[view.spark.length - 1]).toEqual({ day: "2026-07-14", count: 3 });
    expect(view.spark[view.spark.length - 2]).toEqual({ day: "2026-07-13", count: 2 });
    // The out-of-window burst is excluded; only in-window counts total.
    const total = view.spark.reduce((n, p) => n + p.count, 0);
    expect(total).toBe(5);
  });

  it("lists scheduled and open raffles with their entrant counts", () => {
    const id = createDraft(db, "g1", "modUser", NOW);
    updateRaffleFields(db, id, {
      name: "Summer Vinyl",
      starts_at: "2026-07-15T18:00:00.000Z",
      ends_at: "2026-07-17T18:00:00.000Z",
      draw_mode: "auto",
    });
    setStatus(db, id, "open");
    addEntry(db, id, "uA", NOW);
    addEntry(db, id, "uB", NOW);

    const view = buildHomeView(db, "g1", NOW);
    expect(view.liveRaffles).toHaveLength(1);
    expect(view.liveRaffles[0]).toMatchObject({
      id,
      name: "Summer Vinyl",
      status: "open",
      entrants: 2,
      drawMode: "auto",
    });
  });

  it("warns when the announce channel and activity defaults are unset", () => {
    const view = buildHomeView(db, "g1", NOW);
    expect(view.warnings.map((w) => w.message).join(" ")).toMatch(/announce channel/i);
    expect(view.warnings.map((w) => w.message).join(" ")).toMatch(/activity requirement/i);
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
        default_req_active_days: 0,
      },
      NOW,
    );
    incrementActivity(db, "g1", "uA", "2026-07-10", 10);

    const view = buildHomeView(db, "g1", NOW);
    expect(view.warnings).toEqual([]);
    expect(view.pool).toEqual({ hasDefaults: true, eligible: 1, considered: 1 });
  });
});
