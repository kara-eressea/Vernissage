import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import { commitSecret, verifyCommitment } from "../../src/core/commitReveal.js";
import { addEntry } from "../../src/db/repositories/entries.js";
import { setGuildConfig } from "../../src/db/repositories/guilds.js";
import {
  createDraft,
  getRaffle,
  setStatus,
  updateRaffleFields,
} from "../../src/db/repositories/raffles.js";
import { activeWinnerIds, listWinsForRaffle } from "../../src/db/repositories/wins.js";
import {
  commitOnClose,
  executeDraw,
  reconcilePendingDraws,
  rerollWinner,
} from "../../src/draw/service.js";

const GUILD = "g1";
const NOW = "2026-07-15T12:00:00.000Z";
const SECRET = "test-secret-000";
const gen = () => SECRET;

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
  // A guild with an announce channel so the public winner post is attempted.
  setGuildConfig(db, GUILD, { announce_channel: "annc" }, NOW);
});

afterEach(() => {
  db.close();
});

/** Fake announcer capturing what the service posts, mirroring the Notifier subset. */
function fakeAnnouncer() {
  const auditPosts: string[] = [];
  const announcements: string[] = [];
  return {
    auditPosts,
    announcements,
    postAudit: async (_guildId: string, content: string): Promise<void> => {
      auditPosts.push(content);
    },
    postAnnouncement: async (_channelId: string, content: string): Promise<string | undefined> => {
      announcements.push(content);
      return "msg1";
    },
  };
}

/** Seed a closed raffle with the given entrants and options. */
function seedClosedRaffle(
  entrants: string[],
  opts: { winnerCount?: number; drawMode?: "auto" | "manual" } = {},
): number {
  const raffleId = createDraft(db, GUILD, "creator", NOW);
  updateRaffleFields(db, raffleId, {
    name: "Big One",
    prize: "A prize",
    winner_count: opts.winnerCount ?? 1,
    draw_mode: opts.drawMode ?? "manual",
    channel_id: null,
  });
  for (const id of entrants) {
    addEntry(db, raffleId, id, NOW);
  }
  setStatus(db, raffleId, "closed");
  return raffleId;
}

function auditTypes(raffleId: number): string[] {
  return (
    db
      .prepare(`SELECT event_type FROM audit_log WHERE raffle_id = ? ORDER BY event_id`)
      .all(raffleId) as Array<{ event_type: string }>
  ).map((r) => r.event_type);
}

describe("commitOnClose", () => {
  it("freezes entries, persists commitment + secret, audits, and publishes", async () => {
    const raffleId = seedClosedRaffle(["a", "b", "c", "d", "e"]);
    const announcer = fakeAnnouncer();

    await commitOnClose(db, announcer, raffleId, NOW, gen);

    const raffle = getRaffle(db, raffleId)!;
    expect(raffle.entrants_hash).toBe(
      "dbbc47f2a90b02153a78630eb0341612800f530bd3ae6dda5504e60ffbc64018",
    );
    expect(raffle.draw_secret).toBe(SECRET);
    expect(raffle.draw_commitment).toBe(commitSecret(SECRET));
    expect(auditTypes(raffleId)).toEqual(["draw_committed"]);
    // The commitment post carries the verification data.
    expect(announcer.auditPosts).toHaveLength(1);
    expect(announcer.auditPosts[0]).toContain(raffle.entrants_hash!);
    expect(announcer.auditPosts[0]).toContain(raffle.draw_commitment!);
  });

  it("is idempotent — a second call writes nothing new", async () => {
    const raffleId = seedClosedRaffle(["a", "b"]);
    const announcer = fakeAnnouncer();
    await commitOnClose(db, announcer, raffleId, NOW, gen);
    await commitOnClose(db, announcer, raffleId, NOW, gen);
    expect(auditTypes(raffleId)).toEqual(["draw_committed"]);
    expect(announcer.auditPosts).toHaveLength(1);
  });
});

describe("executeDraw", () => {
  it("selects the committed winner, records the win, and reveals verification data", async () => {
    const raffleId = seedClosedRaffle(["a", "b", "c", "d", "e"]);
    const announcer = fakeAnnouncer();

    const outcome = await executeDraw(db, announcer, raffleId, NOW, gen);

    // Fixed secret -> fixed seed -> deterministic winner "d".
    expect(outcome).toEqual({ ok: true, winners: ["d"] });
    expect(getRaffle(db, raffleId)!.status).toBe("drawn");
    expect(activeWinnerIds(db, raffleId)).toEqual(["d"]);
    expect(auditTypes(raffleId)).toEqual(["draw_committed", "raffle_drawn"]);

    // The result post reveals the secret and the seed, and the commitment
    // verifies against the revealed secret.
    const resultPost = announcer.auditPosts.at(-1)!;
    expect(resultPost).toContain(SECRET);
    expect(verifyCommitment(SECRET, getRaffle(db, raffleId)!.draw_commitment!)).toBe(true);
    // A public winner announcement was posted mentioning the winner.
    expect(announcer.announcements.at(-1)).toContain("<@d>");
  });

  it("draws a multi-winner raffle with distinct winners", async () => {
    const raffleId = seedClosedRaffle(["a", "b", "c", "d", "e"], { winnerCount: 3 });
    const announcer = fakeAnnouncer();
    const outcome = await executeDraw(db, announcer, raffleId, NOW, gen);
    expect(outcome).toEqual({ ok: true, winners: ["d", "c", "a"] });
    expect(new Set(activeWinnerIds(db, raffleId)).size).toBe(3);
  });

  it("marks a zero-entrant raffle drawn with no winner", async () => {
    const raffleId = seedClosedRaffle([]);
    const announcer = fakeAnnouncer();
    const outcome = await executeDraw(db, announcer, raffleId, NOW, gen);
    expect(outcome).toEqual({ ok: true, winners: [] });
    expect(getRaffle(db, raffleId)!.status).toBe("drawn");
    expect(listWinsForRaffle(db, raffleId)).toEqual([]);
    expect(auditTypes(raffleId)).toEqual(["draw_committed", "raffle_drawn"]);
    expect(announcer.announcements.at(-1)).toContain("no eligible entrants");
  });

  it("does not double-draw under concurrent invocations", async () => {
    // The scheduler's close path and the startup reconcile can both target the
    // same raffle. The in-transaction status recheck must let exactly one draw.
    const raffleId = seedClosedRaffle(["a", "b", "c", "d", "e"]);
    const announcer = fakeAnnouncer();
    const results = await Promise.all([
      executeDraw(db, announcer, raffleId, NOW, gen),
      executeDraw(db, announcer, raffleId, NOW, gen),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(activeWinnerIds(db, raffleId)).toEqual(["d"]);
    // Exactly one commitment and one draw were recorded.
    expect(auditTypes(raffleId)).toEqual(["draw_committed", "raffle_drawn"]);
  });

  it("refuses a raffle that is not closed and one already drawn", async () => {
    const raffleId = seedClosedRaffle(["a", "b"]);
    const announcer = fakeAnnouncer();
    setStatus(db, raffleId, "open");
    expect(await executeDraw(db, announcer, raffleId, NOW, gen)).toEqual({
      ok: false,
      reason: "not_closed",
    });
    setStatus(db, raffleId, "closed");
    await executeDraw(db, announcer, raffleId, NOW, gen);
    expect(await executeDraw(db, announcer, raffleId, NOW, gen)).toEqual({
      ok: false,
      reason: "already_drawn",
    });
  });
});

describe("rerollWinner", () => {
  it("disqualifies a winner and draws a reproducible replacement", async () => {
    const raffleId = seedClosedRaffle(["a", "b", "c", "d", "e"]);
    const announcer = fakeAnnouncer();
    await executeDraw(db, announcer, raffleId, NOW, gen);
    const winId = listWinsForRaffle(db, raffleId)[0]!.win_id; // the win for "d"

    const outcome = await rerollWinner(db, announcer, raffleId, winId, "did not claim", NOW);

    // Same base seed, "d" excluded -> replacement "c".
    expect(outcome).toEqual({ ok: true, disqualified: "d", replacement: "c" });
    expect(activeWinnerIds(db, raffleId)).toEqual(["c"]);
    expect(listWinsForRaffle(db, raffleId).find((w) => w.user_id === "d")!.rerolled).toBe(1);
    expect(auditTypes(raffleId)).toEqual(["draw_committed", "raffle_drawn", "draw_reroll"]);

    // The mod reason is stored on the audit row but never in the public post.
    const rerollRow = db
      .prepare(`SELECT payload FROM audit_log WHERE event_type = 'draw_reroll'`)
      .get() as { payload: string };
    expect(JSON.parse(rerollRow.payload).reason).toBe("did not claim");
    expect(announcer.auditPosts.at(-1)).not.toContain("did not claim");
  });

  it("rejects rerolling a non-winner or a raffle that is not drawn", async () => {
    const raffleId = seedClosedRaffle(["a", "b"]);
    const announcer = fakeAnnouncer();
    // Not drawn yet.
    expect(await rerollWinner(db, announcer, raffleId, 999, "x", NOW)).toEqual({
      ok: false,
      reason: "not_drawn",
    });
    await executeDraw(db, announcer, raffleId, NOW, gen);
    // No such win id.
    expect(await rerollWinner(db, announcer, raffleId, 999, "x", NOW)).toEqual({
      ok: false,
      reason: "invalid_win",
    });
  });
});

describe("reconcilePendingDraws", () => {
  it("commits and auto-draws an auto raffle left closed during downtime", async () => {
    const auto = seedClosedRaffle(["a", "b", "c", "d", "e"], { drawMode: "auto" });
    const manual = seedClosedRaffle(["a", "b"], { drawMode: "manual" });
    const announcer = fakeAnnouncer();

    await reconcilePendingDraws(db, announcer, NOW, gen);

    // Auto raffle drew; manual raffle only committed and awaits /raffle draw.
    expect(getRaffle(db, auto)!.status).toBe("drawn");
    expect(getRaffle(db, manual)!.status).toBe("closed");
    expect(getRaffle(db, manual)!.draw_commitment).not.toBeNull();
    expect(auditTypes(auto)).toEqual(["draw_committed", "raffle_drawn"]);
    expect(auditTypes(manual)).toEqual(["draw_committed"]);
  });
});
