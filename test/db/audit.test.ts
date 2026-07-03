import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import { getAuditForRaffle, writeAudit } from "../../src/db/repositories/audit.js";
import { createDraft, setStatus } from "../../src/db/repositories/raffles.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("audit log", () => {
  it("records an event with a serialized JSON payload", () => {
    writeAudit(db, {
      guildId: "g1",
      raffleId: 1,
      eventType: "raffle_opened",
      actorId: "bot",
      payload: { from: "scheduled", to: "open" },
      createdAt: "2026-07-03T00:00:00.000Z",
    });
    const rows = getAuditForRaffle(db, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_type).toBe("raffle_opened");
    expect(JSON.parse(rows[0]!.payload!)).toEqual({ from: "scheduled", to: "open" });
  });

  it("stores a null payload when none is provided", () => {
    writeAudit(db, {
      guildId: "g1",
      raffleId: 2,
      eventType: "raffle_cancelled",
      actorId: "mod1",
      createdAt: "2026-07-03T00:00:00.000Z",
    });
    expect(getAuditForRaffle(db, 2)[0]!.payload).toBeNull();
  });

  it("captures a state change alongside its audit row, oldest first", () => {
    // Simulate the "every state change writes an audit_log row" convention.
    const raffleId = createDraft(db, "g1", "mod1", "2026-07-01T00:00:00.000Z");
    writeAudit(db, {
      guildId: "g1",
      raffleId,
      eventType: "raffle_created",
      actorId: "mod1",
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    setStatus(db, raffleId, "scheduled");
    writeAudit(db, {
      guildId: "g1",
      raffleId,
      eventType: "raffle_scheduled",
      actorId: "mod1",
      createdAt: "2026-07-01T00:05:00.000Z",
    });

    const events = getAuditForRaffle(db, raffleId).map((r) => r.event_type);
    expect(events).toEqual(["raffle_created", "raffle_scheduled"]);
  });
});
