import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import type { RaffleStatus } from "../../src/core/types.js";
import { openDb } from "../../src/db/index.js";
import { writeAudit } from "../../src/db/repositories/audit.js";
import { addEntry, removeEntry } from "../../src/db/repositories/entries.js";
import { setGuildConfig } from "../../src/db/repositories/guilds.js";
import { upsertMemberName } from "../../src/db/repositories/members.js";
import {
  createDraft,
  setDrawCommitment,
  setDrawDisqualified,
  setEntrantsHash,
  setStatus,
  updateRaffleFields,
} from "../../src/db/repositories/raffles.js";
import { addWin, markRerolled } from "../../src/db/repositories/wins.js";
import { buildHistoryView, claimStateOf, HISTORY_PAGE_SIZE } from "../../src/web/history.js";
import { historyPage } from "../../src/web/views.js";

const GUILD = "g1";
const NOW = "2026-08-01T12:00:00.000Z";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
  setGuildConfig(db, GUILD, { default_req_messages: 10 }, NOW);
});

afterEach(() => {
  db.close();
});

/**
 * A finished raffle. The draw fields go through their own setters — they are not
 * patchable columns, so updateRaffleFields would silently drop them.
 */
function seedRaffle(
  fields: Record<string, unknown> = {},
  status: RaffleStatus = "drawn",
  guild = GUILD,
): number {
  const id = createDraft(db, guild, "mod", "2026-07-01T00:00:00.000Z");
  updateRaffleFields(db, id, {
    name: "Summer Vinyl",
    prize: "A record",
    starts_at: "2026-07-10T00:00:00.000Z",
    ends_at: "2026-07-20T00:00:00.000Z",
    ...fields,
  });
  if (status !== "cancelled") {
    setEntrantsHash(db, id, "hash");
    setDrawCommitment(db, id, "commitment", "secret");
  }
  setStatus(db, id, status);
  return id;
}

describe("claimStateOf", () => {
  it("separates no-claim-needed from unclaimed and forfeited", () => {
    expect(claimStateOf({ claim_deadline: null, claimed_at: null }, NOW)).toBe("none");
    expect(claimStateOf({ claim_deadline: "2026-08-02T00:00:00.000Z", claimed_at: null }, NOW)).toBe(
      "unclaimed",
    );
    expect(claimStateOf({ claim_deadline: "2026-07-30T00:00:00.000Z", claimed_at: null }, NOW)).toBe(
      "forfeited",
    );
    expect(
      claimStateOf({ claim_deadline: "2026-07-30T00:00:00.000Z", claimed_at: "2026-07-29T00:00:00.000Z" }, NOW),
    ).toBe("claimed");
  });
});

describe("buildHistoryView", () => {
  it("lists finished raffles newest first and leaves live ones out", () => {
    const older = seedRaffle({ name: "June" });
    const newer = seedRaffle({ name: "July" });
    seedRaffle({ name: "Running" }, "open");

    const view = buildHistoryView(db, GUILD, NOW);

    expect(view.rows.map((r) => r.id)).toEqual([newer, older]);
    expect(view.rows.some((r) => r.name === "Running")).toBe(false);
  });

  it("hides test raffles but says how many it left out", () => {
    seedRaffle({ name: "Real" });
    seedRaffle({ name: "Trial", is_test: 1 });

    const view = buildHistoryView(db, GUILD, NOW);

    expect(view.rows.map((r) => r.name)).toEqual(["Real"]);
    // Silently dropping them would make the history look like the whole record.
    expect(view.hiddenTests).toBe(1);
  });

  it("includes cancelled raffles, badged and winner-less", () => {
    seedRaffle({ name: "Drawn one" });
    const id = seedRaffle({ name: "Called off" }, "cancelled");

    const row = buildHistoryView(db, GUILD, NOW).rows.find((r) => r.id === id)!;

    expect(row.cancelled).toBe(true);
    expect(row.winners).toEqual([]);
    // Nothing was drawn, so there is nothing to verify.
    expect(row.verifiable).toBe(false);
    // A drawn one, by contrast, links to the verifier.
    expect(buildHistoryView(db, GUILD, NOW).rows.find((r) => !r.cancelled)?.verifiable).toBe(true);
  });

  it("scopes to the guild", () => {
    seedRaffle({ name: "Ours" });
    seedRaffle({ name: "Theirs" }, "drawn", "g2");

    expect(buildHistoryView(db, GUILD, NOW).rows.map((r) => r.name)).toEqual(["Ours"]);
  });

  it("counts the committed entrant list the draw hashed, not just live entries", () => {
    const id = seedRaffle();
    addEntry(db, id, "u1", NOW);
    addEntry(db, id, "u2", NOW);
    addEntry(db, id, "u3", NOW);
    // u3 was removed by the draw failsafe: still part of the committed list.
    removeEntry(db, id, "u3", NOW, "blacklisted");
    setDrawDisqualified(db, id, ["u3"]);

    expect(buildHistoryView(db, GUILD, NOW).rows[0]!.entrants).toBe(3);
  });

  it("names winners from the cache and keeps rerolled ones in the record", () => {
    const id = seedRaffle();
    upsertMemberName(db, {
      guildId: GUILD,
      userId: "u1",
      username: "alice",
      displayName: "Alice",
      updatedAt: NOW,
    });
    const dropped = addWin(db, id, "u1", NOW);
    markRerolled(db, dropped);
    addWin(db, id, "u2", NOW);

    const row = buildHistoryView(db, GUILD, NOW).rows[0]!;

    // Standing winner first, the rerolled one kept after it.
    expect(row.winners.map((w) => w.userId)).toEqual(["u2", "u1"]);
    expect(row.winners[1]).toMatchObject({ rerolled: true, name: "Alice" });
    expect(row.winners[0]!.name).toBeNull();
  });

  it("prefers the audited drawn time over the scheduled end", () => {
    const id = seedRaffle();
    writeAudit(db, {
      guildId: GUILD,
      raffleId: id,
      eventType: "raffle_drawn",
      actorId: null,
      payload: { winners: [] },
      createdAt: "2026-07-20T06:30:00.000Z",
    });

    const row = buildHistoryView(db, GUILD, NOW).rows[0]!;

    expect(row.endedAt).toBe("2026-07-20T06:30:00.000Z");
    expect(row.endedIsDrawn).toBe(true);
  });

  it("reports the forfeit rate over wins that actually required a claim", () => {
    const id = seedRaffle();
    addWin(db, id, "u1", NOW, "2026-07-30T00:00:00.000Z"); // deadline passed, unclaimed
    addWin(db, id, "u2", NOW, "2026-08-05T00:00:00.000Z"); // still running
    addWin(db, id, "u3", NOW, null); // no claim window at all

    const totals = buildHistoryView(db, GUILD, NOW).totals;

    expect(totals).toMatchObject({ winners: 3, claimRequired: 2, forfeited: 1, forfeitPct: 50 });
  });

  it("reports no forfeit rate at all when no raffle used a claim window", () => {
    const id = seedRaffle();
    addWin(db, id, "u1", NOW, null);

    // A rate over nothing would read as "0% forfeited", implying claims are working.
    expect(buildHistoryView(db, GUILD, NOW).totals.forfeitPct).toBeNull();
  });

  it("aggregates over the whole history, not just the visible page", () => {
    for (let i = 0; i < HISTORY_PAGE_SIZE + 3; i++) {
      const id = seedRaffle({ name: `R${i}` });
      addWin(db, id, `u${i}`, NOW, null);
    }

    const first = buildHistoryView(db, GUILD, NOW, 0);

    expect(first.rows).toHaveLength(HISTORY_PAGE_SIZE);
    expect(first.pageCount).toBe(2);
    expect(first.totals.raffles).toBe(HISTORY_PAGE_SIZE + 3);
    expect(first.totals.winners).toBe(HISTORY_PAGE_SIZE + 3);
    expect(first.shownLabel).toBe(`${HISTORY_PAGE_SIZE} of ${HISTORY_PAGE_SIZE + 3} raffles`);
  });

  it("clamps an out-of-range page onto the last one", () => {
    for (let i = 0; i < HISTORY_PAGE_SIZE + 1; i++) {
      seedRaffle({ name: `R${i}` });
    }

    const view = buildHistoryView(db, GUILD, NOW, 99);

    expect(view.page).toBe(1);
    expect(view.rows).toHaveLength(1);
  });
});

describe("historyPage", () => {
  const guild = { id: GUILD, name: "Musicorum", icon: null };
  const session = { uid: "mod", username: "Mod", guilds: [guild], iat: 0 };

  it("renders the rows and escapes whatever a moderator typed", () => {
    const id = seedRaffle({ name: "<script>alert(1)</script>", prize: "A record" });
    addWin(db, id, "u1", NOW, null);

    const out = historyPage(session, guild, buildHistoryView(db, GUILD, NOW), []);

    expect(out).toContain("Raffle history");
    expect(out).toContain(`/app/raffle?id=${id}`);
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>alert");
  });

  it("renders the empty state without a page control", () => {
    const out = historyPage(session, guild, buildHistoryView(db, GUILD, NOW), []);
    expect(out).toContain("Nothing finished yet");
    expect(out).not.toContain("Page 1 of");
  });
});
