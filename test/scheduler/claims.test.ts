import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import { addEntry } from "../../src/db/repositories/entries.js";
import {
  createDraft,
  setStatus,
  updateRaffleFields,
} from "../../src/db/repositories/raffles.js";
import { activeWinnerIds } from "../../src/db/repositories/wins.js";
import { executeDraw } from "../../src/draw/service.js";
import { startClaimSweep } from "../../src/scheduler/claims.js";

let db: Database;
const NOW = "2026-07-15T12:00:00.000Z";
const AFTER = "2026-07-17T00:00:00.000Z"; // past a 24h window opened at NOW
const gen = () => "test-secret-000";

beforeEach(() => {
  db = openDb(":memory:");
});
afterEach(() => {
  db.close();
});

/** A no-op announcer capturing nothing; the sweep's posts are irrelevant here. */
function noopAnnouncer() {
  return {
    postAudit: async (): Promise<void> => {},
    postAnnouncement: async (): Promise<string | undefined> => "m",
    editMessage: async (): Promise<void> => {},
  };
}

/** Draw a raffle with a claim window so its single winner has a deadline. */
async function drawWithClaimWindow(): Promise<number> {
  const id = createDraft(db, "g1", "creator", NOW);
  updateRaffleFields(db, id, { name: "R", prize: "P", winner_count: 1, claim_window_hours: 24 });
  for (const e of ["a", "b", "c", "d", "e"]) {
    addEntry(db, id, e, NOW);
  }
  setStatus(db, id, "closed");
  await executeDraw(db, noopAnnouncer(), id, NOW, gen); // winner is "d"
  return id;
}

describe("startClaimSweep", () => {
  it("rerolls a lapsed unclaimed win on the startup sweep", async () => {
    const id = await drawWithClaimWindow();
    expect(activeWinnerIds(db, id)).toEqual(["d"]);

    const handle = startClaimSweep(db, noopAnnouncer(), { now: () => AFTER });
    // Let the fire-and-forget startup sweep settle, then assert the reroll.
    await handle.sweepNow();
    expect(activeWinnerIds(db, id)).toEqual(["c"]);
    handle.stop();
  });

  it("does nothing before any deadline lapses", async () => {
    const id = await drawWithClaimWindow();
    const handle = startClaimSweep(db, noopAnnouncer(), { now: () => NOW });
    expect(await handle.sweepNow()).toBe(0);
    expect(activeWinnerIds(db, id)).toEqual(["d"]);
    handle.stop();
  });
});
