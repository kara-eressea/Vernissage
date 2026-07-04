import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/db/index.js";
import { applyColumnPatch } from "../../src/db/patch.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
  // A minimal table with an id and two writable columns.
  db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, a TEXT, b INTEGER)`);
  db.prepare(`INSERT INTO t (id, a, b) VALUES ('r1', 'x', 1)`).run();
});

afterEach(() => {
  db.close();
});

const ALLOW = new Set(["a", "b"]);

function row(): { a: string | null; b: number | null } {
  return db.prepare(`SELECT a, b FROM t WHERE id = 'r1'`).get() as {
    a: string | null;
    b: number | null;
  };
}

describe("applyColumnPatch", () => {
  it("writes the provided allowlisted columns and leaves the rest untouched", () => {
    applyColumnPatch(db, "t", "id", "r1", { a: "y" }, ALLOW);
    expect(row()).toEqual({ a: "y", b: 1 });
  });

  it("clears a column when the value is null", () => {
    applyColumnPatch(db, "t", "id", "r1", { a: null }, ALLOW);
    expect(row()).toEqual({ a: null, b: 1 });
  });

  it("skips undefined values (leave-as-is)", () => {
    applyColumnPatch(db, "t", "id", "r1", { a: undefined, b: 2 }, ALLOW);
    expect(row()).toEqual({ a: "x", b: 2 });
  });

  it("ignores keys not on the allowlist — the injection guard", () => {
    // A stray key must never reach the interpolated column list. It is dropped,
    // leaving only the allowlisted key written.
    applyColumnPatch(db, "t", "id", "r1", { a: "y", "b = 0; DROP TABLE t; --": "z" }, ALLOW);
    expect(row()).toEqual({ a: "y", b: 1 });
    // The table still exists and only `a` changed.
    expect(db.prepare(`SELECT count(*) AS n FROM t`).get()).toEqual({ n: 1 });
  });

  it("is a no-op when no allowlisted key is present", () => {
    applyColumnPatch(db, "t", "id", "r1", { nope: "z" }, ALLOW);
    expect(row()).toEqual({ a: "x", b: 1 });
  });
});
