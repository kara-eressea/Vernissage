import { existsSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import {
  createDraft,
  getRaffle,
  listDrafts,
  setStatus,
  updateRaffleFields,
} from "../../src/db/repositories/raffles.js";
import {
  clearWizardState,
  getWizardState,
  upsertWizardStep,
} from "../../src/db/repositories/wizardState.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("wizard_state table", () => {
  it("exists after migration", () => {
    const table = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='wizard_state'`)
      .get();
    expect(table).toBeDefined();
  });
});

describe("updateRaffleFields", () => {
  it("patches a subset of columns without clobbering others", () => {
    const id = createDraft(db, "g1", "mod1", "2026-07-01T00:00:00.000Z");
    updateRaffleFields(db, id, { name: "Giveaway", prize: "A record" });
    updateRaffleFields(db, id, { req_messages: 20, req_days: 14 });

    const row = getRaffle(db, id)!;
    expect(row.name).toBe("Giveaway"); // preserved
    expect(row.prize).toBe("A record");
    expect(row.req_messages).toBe(20); // added
    expect(row.status).toBe("draft"); // untouched
  });

  it("ignores an empty patch", () => {
    const id = createDraft(db, "g1", "mod1", "2026-07-01T00:00:00.000Z");
    updateRaffleFields(db, id, {});
    expect(getRaffle(db, id)?.name).toBeNull();
  });

  it("clears a column when the patch value is null", () => {
    const id = createDraft(db, "g1", "mod1", "2026-07-01T00:00:00.000Z");
    updateRaffleFields(db, id, { name: "temp" });
    updateRaffleFields(db, id, { name: null });
    expect(getRaffle(db, id)?.name).toBeNull();
  });
});

describe("listDrafts", () => {
  it("returns only draft raffles for the guild, newest first", () => {
    const a = createDraft(db, "g1", "mod1", "2026-07-01T00:00:00.000Z");
    const b = createDraft(db, "g1", "mod1", "2026-07-02T00:00:00.000Z");
    createDraft(db, "g2", "mod1", "2026-07-02T00:00:00.000Z"); // other guild
    setStatus(db, a, "scheduled"); // no longer a draft

    const drafts = listDrafts(db, "g1");
    expect(drafts.map((d) => d.raffle_id)).toEqual([b]);
  });
});

describe("wizard_state", () => {
  it("upserts, reads, and clears the step pointer", () => {
    const id = createDraft(db, "g1", "mod1", "2026-07-01T00:00:00.000Z");

    upsertWizardStep(db, id, "basics", "2026-07-01T00:00:01.000Z");
    expect(getWizardState(db, id)?.step).toBe("basics");

    upsertWizardStep(db, id, "schedule", "2026-07-01T00:00:02.000Z");
    const row = getWizardState(db, id)!;
    expect(row.step).toBe("schedule"); // advanced
    expect(row.updated_at).toBe("2026-07-01T00:00:02.000Z");

    clearWizardState(db, id);
    expect(getWizardState(db, id)).toBeUndefined();
  });

  it("survives a reopen of the same file-backed database (restart resume)", () => {
    // A file DB persists wizard_state across handles, unlike :memory:.
    const path = `${process.env.TMPDIR ?? "/tmp"}/vernissage-wizard-${process.pid}.db`;
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(path + suffix)) rmSync(path + suffix);
    }
    try {
      const first = openDb(path);
      const id = createDraft(first, "g1", "mod1", "2026-07-01T00:00:00.000Z");
      updateRaffleFields(first, id, { name: "Resumed" });
      upsertWizardStep(first, id, "eligibility", "2026-07-01T00:00:03.000Z");
      first.close();

      const second = openDb(path);
      expect(getWizardState(second, id)?.step).toBe("eligibility");
      expect(getRaffle(second, id)?.name).toBe("Resumed");
      second.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(path + suffix)) rmSync(path + suffix);
      }
    }
  });
});
