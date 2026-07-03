import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import { getAuditForRaffle } from "../../src/db/repositories/audit.js";
import { getRaffle } from "../../src/db/repositories/raffles.js";
import { applyDueTransitions } from "../../src/scheduler/transitions.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

/** Insert a raffle row with explicit schedule fields; returns its id. */
function insertRaffle(opts: {
  guildId?: string;
  status: string;
  startsAt: string | null;
  endsAt: string | null;
  drawMode?: string;
}): number {
  const info = db
    .prepare(
      `INSERT INTO raffles (guild_id, status, starts_at, ends_at, draw_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.guildId ?? "g1",
      opts.status,
      opts.startsAt,
      opts.endsAt,
      opts.drawMode ?? "auto",
      "2026-07-01T00:00:00.000Z",
    );
  return Number(info.lastInsertRowid);
}

const START = "2026-07-10T12:00:00.000Z";
const END = "2026-07-17T12:00:00.000Z";

describe("applyDueTransitions", () => {
  it("opens a scheduled raffle once its start passes", () => {
    const id = insertRaffle({ status: "scheduled", startsAt: START, endsAt: END });
    const applied = applyDueTransitions(db, "2026-07-11T00:00:00.000Z", "scheduled");

    expect(getRaffle(db, id)?.status).toBe("open");
    expect(applied).toEqual([
      { raffleId: id, guildId: "g1", from: "scheduled", to: "open", drawMode: "auto" },
    ]);
    const audit = getAuditForRaffle(db, id);
    expect(audit.at(-1)?.event_type).toBe("raffle_opened");
    expect(JSON.parse(audit.at(-1)!.payload!)).toMatchObject({ from: "scheduled", to: "open" });
  });

  it("closes an open raffle once its end passes", () => {
    const id = insertRaffle({ status: "open", startsAt: START, endsAt: END });
    const applied = applyDueTransitions(db, "2026-07-18T00:00:00.000Z", "scheduled");

    expect(getRaffle(db, id)?.status).toBe("closed");
    expect(applied[0]?.to).toBe("closed");
    expect(getAuditForRaffle(db, id).at(-1)?.event_type).toBe("raffle_closed");
  });

  it("reconciles a scheduled raffle straight to closed when both times passed offline", () => {
    const id = insertRaffle({ status: "scheduled", startsAt: START, endsAt: END });
    const applied = applyDueTransitions(db, "2026-07-20T00:00:00.000Z", "reconcile");

    expect(getRaffle(db, id)?.status).toBe("closed");
    expect(applied[0]).toMatchObject({ from: "scheduled", to: "closed" });
    expect(JSON.parse(getAuditForRaffle(db, id).at(-1)!.payload!)).toMatchObject({
      reason: "reconcile",
    });
  });

  it("does nothing for a raffle that is not yet due", () => {
    const id = insertRaffle({ status: "scheduled", startsAt: START, endsAt: END });
    const applied = applyDueTransitions(db, "2026-07-09T00:00:00.000Z", "scheduled");

    expect(applied).toEqual([]);
    expect(getRaffle(db, id)?.status).toBe("scheduled");
    expect(getAuditForRaffle(db, id)).toHaveLength(0);
  });

  it("is idempotent — a second sweep applies nothing", () => {
    insertRaffle({ status: "scheduled", startsAt: START, endsAt: END });
    applyDueTransitions(db, "2026-07-11T00:00:00.000Z", "scheduled");
    const second = applyDueTransitions(db, "2026-07-11T00:05:00.000Z", "scheduled");
    expect(second).toEqual([]);
  });

  it("ignores raffles in non-driven statuses (draft, drawn, etc.)", () => {
    const id = insertRaffle({ status: "draft", startsAt: START, endsAt: END });
    const applied = applyDueTransitions(db, "2026-07-20T00:00:00.000Z", "scheduled");
    expect(applied).toEqual([]);
    expect(getRaffle(db, id)?.status).toBe("draft");
  });

  it("warns and skips a driven raffle missing a timestamp instead of transitioning it", () => {
    const id = insertRaffle({ status: "scheduled", startsAt: START, endsAt: null });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const applied = applyDueTransitions(db, "2026-07-20T00:00:00.000Z", "scheduled");

    expect(applied).toEqual([]);
    expect(getRaffle(db, id)?.status).toBe("scheduled");
    expect(getAuditForRaffle(db, id)).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain(String(id));

    warn.mockRestore();
  });

  it("sweeps multiple guilds in one pass", () => {
    const a = insertRaffle({ guildId: "g1", status: "scheduled", startsAt: START, endsAt: END });
    const b = insertRaffle({ guildId: "g2", status: "open", startsAt: START, endsAt: END });
    const applied = applyDueTransitions(db, "2026-07-18T00:00:00.000Z", "scheduled");

    expect(applied.map((t) => t.raffleId).sort()).toEqual([a, b].sort());
    expect(getRaffle(db, a)?.status).toBe("closed"); // scheduled -> closed (both passed)
    expect(getRaffle(db, b)?.status).toBe("closed");
  });
});
