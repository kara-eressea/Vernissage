import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import { commitSecret, verifyCommitment } from "../../src/core/commitReveal.js";
import { deriveSeed, hashEntrants, selectWinners } from "../../src/core/draw.js";
import { addBan } from "../../src/db/repositories/blacklist.js";
import { addEntry } from "../../src/db/repositories/entries.js";
import { setGuildConfig } from "../../src/db/repositories/guilds.js";
import {
  createDraft,
  disqualifiedEntrants,
  getRaffle,
  setStatus,
  updateRaffleFields,
} from "../../src/db/repositories/raffles.js";
import {
  activeWinnerIds,
  getActiveWinForUser,
  listWinsForRaffle,
} from "../../src/db/repositories/wins.js";
import {
  commitOnClose,
  executeDraw,
  expireUnclaimedWins,
  reconcilePendingDraws,
  recordClaim,
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
  const edits: string[] = [];
  return {
    auditPosts,
    announcements,
    edits,
    editMessage: async (
      _channelId: string,
      _messageId: string,
      content: string,
    ): Promise<void> => {
      edits.push(content);
    },
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
  opts: { winnerCount?: number; drawMode?: "auto" | "manual"; claimWindowHours?: number } = {},
): number {
  const raffleId = createDraft(db, GUILD, "creator", NOW);
  updateRaffleFields(db, raffleId, {
    name: "Big One",
    prize: "A prize",
    winner_count: opts.winnerCount ?? 1,
    draw_mode: opts.drawMode ?? "manual",
    claim_window_hours: opts.claimWindowHours ?? null,
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

/** The `reason` field of the raffle_drawn audit payload (present on a no-winner draw). */
function drawnReason(raffleId: number): string | undefined {
  const row = db
    .prepare(`SELECT payload FROM audit_log WHERE raffle_id = ? AND event_type = 'raffle_drawn'`)
    .get(raffleId) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload).reason as string | undefined) : undefined;
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

  it("edits the entry card's closed notice into the winner line", async () => {
    const raffleId = seedClosedRaffle(["a", "b", "c", "d", "e"]);
    updateRaffleFields(db, raffleId, { message_id: "msg-1" });
    const announcer = fakeAnnouncer();

    await executeDraw(db, announcer, raffleId, NOW, gen);

    expect(announcer.edits.at(-1)).toContain("**Winner:** <@d>");
    expect(announcer.edits.at(-1)).not.toContain("announced shortly");
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

describe("executeDraw winner failsafe", () => {
  function removedReason(raffleId: number, userId: string): string | null {
    const row = db
      .prepare(`SELECT removed_reason FROM entries WHERE raffle_id = ? AND user_id = ?`)
      .get(raffleId, userId) as { removed_reason: string | null } | undefined;
    return row?.removed_reason ?? null;
  }

  it("skips a winner who left the guild, removes their entry, and re-draws", async () => {
    const raffleId = seedClosedRaffle(["a", "b", "c", "d", "e"]);
    const announcer = fakeAnnouncer();
    // "d" is the natural winner; report everyone present except "d".
    const resolveMembers = async (_g: string, ids: string[]) =>
      new Set(ids.filter((id) => id !== "d"));

    const outcome = await executeDraw(db, announcer, raffleId, NOW, gen, resolveMembers);

    // "d" excluded -> replacement "c" (same base seed).
    expect(outcome).toEqual({ ok: true, winners: ["c"] });
    expect(activeWinnerIds(db, raffleId)).toEqual(["c"]);
    expect(removedReason(raffleId, "d")).toBe("left_guild");
    // The removal is audited and the excluded id is published for verification.
    expect(auditTypes(raffleId)).toEqual(["draw_committed", "entry_removed", "raffle_drawn"]);
    expect(announcer.auditPosts.at(-1)).toContain("<@d>"); // result post lists excluded
  });

  it("skips a winner blacklisted before the draw, even with no member resolver", async () => {
    const raffleId = seedClosedRaffle(["a", "b", "c", "d", "e"]);
    const announcer = fakeAnnouncer();
    addBan(db, {
      guildId: GUILD,
      userId: "d",
      bannedBy: "mod",
      reason: "sockpuppet",
      bannedAt: NOW,
      expiresAt: null,
    });

    const outcome = await executeDraw(db, announcer, raffleId, NOW, gen);

    expect(outcome).toEqual({ ok: true, winners: ["c"] });
    expect(removedReason(raffleId, "d")).toBe("blacklisted");
    expect(auditTypes(raffleId)).toEqual(["draw_committed", "entry_removed", "raffle_drawn"]);
  });

  it("freezes the disqualified set for reroll and publishes it", async () => {
    const raffleId = seedClosedRaffle(["a", "b", "c", "d", "e"]);
    const announcer = fakeAnnouncer();
    const resolveMembers = async (_g: string, ids: string[]) =>
      new Set(ids.filter((id) => id !== "d"));

    await executeDraw(db, announcer, raffleId, NOW, gen, resolveMembers);

    // The removed winner is persisted so a later reroll can reconstruct the
    // committed entrant list, and is published in the result post.
    expect(disqualifiedEntrants(getRaffle(db, raffleId)!)).toEqual(["d"]);
    expect(announcer.auditPosts.at(-1)).toContain("Excluded");
  });

  it("draws no winner (not 'no_entrants') when every eligible winner is disqualified", async () => {
    const raffleId = seedClosedRaffle(["a", "b"]);
    const announcer = fakeAnnouncer();
    // Nobody is still present: the failsafe drains the pool to empty.
    const resolveMembers = async () => new Set<string>();

    const outcome = await executeDraw(db, announcer, raffleId, NOW, gen, resolveMembers);

    expect(outcome).toEqual({ ok: true, winners: [] });
    expect(getRaffle(db, raffleId)!.status).toBe("drawn");
    // Entrants existed, so the reason distinguishes this from a truly empty raffle.
    expect(drawnReason(raffleId)).toBe("no_eligible_winners");
    expect(new Set(disqualifiedEntrants(getRaffle(db, raffleId)!))).toEqual(new Set(["a", "b"]));
    expect(announcer.announcements.at(-1)).toContain("no eligible entrants");
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

  it("does not reroll the same win twice under concurrent invocations", async () => {
    const raffleId = seedClosedRaffle(["a", "b", "c", "d", "e"]);
    const announcer = fakeAnnouncer();
    await executeDraw(db, announcer, raffleId, NOW, gen);
    const winId = listWinsForRaffle(db, raffleId)[0]!.win_id; // the win for "d"

    // Two concurrent rerolls of the same win: the in-transaction rerolled-check
    // must let exactly one through.
    const results = await Promise.all([
      rerollWinner(db, announcer, raffleId, winId, "double click", NOW),
      rerollWinner(db, announcer, raffleId, winId, "double click", NOW),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    // "d" is rerolled once; a single replacement "c" is active; one reroll audit.
    expect(activeWinnerIds(db, raffleId)).toEqual(["c"]);
    expect(auditTypes(raffleId)).toEqual(["draw_committed", "raffle_drawn", "draw_reroll"]);
  });

  it("reproduces over the frozen committed list after a draw-time disqualification", async () => {
    // Regression: the draw failsafe soft-removes a winner who left, shrinking the
    // live entry list. A later reroll must still select over the *committed* list
    // (all 5 entrants), not the shrunk one, or the result is unverifiable and the
    // entrant count (and every index) shifts.
    const raffleId = seedClosedRaffle(["a", "b", "c", "d", "e"]);
    const announcer = fakeAnnouncer();
    // "d" is the natural winner; report everyone present except "d" so the
    // failsafe disqualifies "d" and draws "c" as the replacement.
    const resolveMembers = async (_g: string, ids: string[]) =>
      new Set(ids.filter((id) => id !== "d"));
    await executeDraw(db, announcer, raffleId, NOW, gen, resolveMembers);
    expect(activeWinnerIds(db, raffleId)).toEqual(["c"]); // "d" removed from entries
    const cWinId = listWinsForRaffle(db, raffleId).find((w) => w.user_id === "c")!.win_id;

    const outcome = await rerollWinner(db, announcer, raffleId, cWinId, "no show", NOW);

    // Independently reproduce from public data: the committed list is all five
    // entrants (the published hash covers them), excluding the disqualified "d"
    // and the rerolled "c". The next eligible id is "a".
    const committed = ["a", "b", "c", "d", "e"];
    const seed = deriveSeed(hashEntrants(committed), SECRET);
    const expected = selectWinners(committed, seed, 1, new Set(["c", "d"]))[0];
    expect(expected).toBe("a");
    expect(outcome).toEqual({ ok: true, disqualified: "c", replacement: "a" });

    // Sanity: selecting over the shrunk live list (the bug) would not give "a",
    // so this scenario genuinely discriminates the fix from the regression.
    const shrunk = ["a", "b", "c", "e"];
    expect(selectWinners(shrunk, seed, 1, new Set(["c"]))[0]).not.toBe("a");
  });

  it("returns no replacement when the eligible pool is exhausted", async () => {
    const raffleId = seedClosedRaffle(["a"]);
    const announcer = fakeAnnouncer();
    await executeDraw(db, announcer, raffleId, NOW, gen);
    const winId = listWinsForRaffle(db, raffleId)[0]!.win_id; // the win for "a"
    const before = announcer.announcements.length;

    const outcome = await rerollWinner(db, announcer, raffleId, winId, "left", NOW);

    // Only entrant is disqualified -> no replacement, no public announcement.
    expect(outcome).toEqual({ ok: true, disqualified: "a", replacement: null });
    expect(announcer.announcements.length).toBe(before);
    expect(announcer.auditPosts.at(-1)).toContain("no replacement available");
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

describe("claim window", () => {
  // NOW = 2026-07-15T12:00Z; a 24h window makes the deadline 2026-07-16T12:00Z.
  const DEADLINE = "2026-07-16T12:00:00.000Z";
  const AFTER = "2026-07-17T00:00:00.000Z";

  it("stamps a claim deadline on winners and notes it in the announcement", async () => {
    const raffleId = seedClosedRaffle(["a", "b", "c", "d", "e"], { claimWindowHours: 24 });
    const announcer = fakeAnnouncer();

    await executeDraw(db, announcer, raffleId, NOW, gen);

    const win = getActiveWinForUser(db, raffleId, "d")!; // "d" is the deterministic winner
    expect(win.claim_deadline).toBe(DEADLINE);
    expect(win.claimed_at).toBeNull();
    expect(announcer.announcements.at(-1)).toContain("/raffle claim");
  });

  it("leaves winners unstamped when the raffle has no claim window", async () => {
    const raffleId = seedClosedRaffle(["a", "b", "c", "d", "e"]);
    const announcer = fakeAnnouncer();
    await executeDraw(db, announcer, raffleId, NOW, gen);
    expect(getActiveWinForUser(db, raffleId, "d")!.claim_deadline).toBeNull();
    expect(announcer.announcements.at(-1)).not.toContain("/raffle claim");
  });

  describe("recordClaim", () => {
    it("records a winner's claim and audits it", async () => {
      const raffleId = seedClosedRaffle(["a", "b", "c", "d", "e"], { claimWindowHours: 24 });
      const announcer = fakeAnnouncer();
      await executeDraw(db, announcer, raffleId, NOW, gen);

      expect(await recordClaim(db, announcer, raffleId, "d", NOW)).toEqual({ ok: true });
      expect(getActiveWinForUser(db, raffleId, "d")!.claimed_at).toBe(NOW);
      expect(auditTypes(raffleId)).toContain("win_claimed");
    });

    it("rejects a non-winner, a double claim, and a no-window raffle", async () => {
      const withWindow = seedClosedRaffle(["a", "b", "c", "d", "e"], { claimWindowHours: 24 });
      const announcer = fakeAnnouncer();
      await executeDraw(db, announcer, withWindow, NOW, gen);

      expect(await recordClaim(db, announcer, withWindow, "z", NOW)).toEqual({
        ok: false,
        reason: "not_winner",
      });
      await recordClaim(db, announcer, withWindow, "d", NOW);
      expect(await recordClaim(db, announcer, withWindow, "d", NOW)).toEqual({
        ok: false,
        reason: "already_claimed",
      });

      const noWindow = seedClosedRaffle(["a", "b", "c", "d", "e"]);
      await executeDraw(db, announcer, noWindow, NOW, gen);
      expect(await recordClaim(db, announcer, noWindow, "d", NOW)).toEqual({
        ok: false,
        reason: "no_claim_required",
      });
    });
  });

  describe("expireUnclaimedWins", () => {
    it("rerolls a lapsed unclaimed win to the next entrant with a fresh deadline", async () => {
      const raffleId = seedClosedRaffle(["a", "b", "c", "d", "e"], { claimWindowHours: 24 });
      const announcer = fakeAnnouncer();
      await executeDraw(db, announcer, raffleId, NOW, gen);

      const rerolled = await expireUnclaimedWins(db, announcer, AFTER);

      expect(rerolled).toBe(1);
      // "d" forfeits (rerolled), "c" is the reproducible replacement.
      expect(activeWinnerIds(db, raffleId)).toEqual(["c"]);
      expect(listWinsForRaffle(db, raffleId).find((w) => w.user_id === "d")!.rerolled).toBe(1);
      // The replacement starts its own window from the sweep instant.
      const cWin = getActiveWinForUser(db, raffleId, "c")!;
      expect(cWin.claim_deadline).toBe("2026-07-18T00:00:00.000Z");
      expect(auditTypes(raffleId)).toEqual(["draw_committed", "raffle_drawn", "draw_reroll"]);
    });

    it("does nothing before the deadline or once claimed", async () => {
      const raffleId = seedClosedRaffle(["a", "b", "c", "d", "e"], { claimWindowHours: 24 });
      const announcer = fakeAnnouncer();
      await executeDraw(db, announcer, raffleId, NOW, gen);

      // Before the deadline: no reroll.
      expect(await expireUnclaimedWins(db, announcer, NOW)).toBe(0);

      // Claimed in time: the sweep leaves it alone even after the deadline.
      await recordClaim(db, announcer, raffleId, "d", NOW);
      expect(await expireUnclaimedWins(db, announcer, AFTER)).toBe(0);
      expect(activeWinnerIds(db, raffleId)).toEqual(["d"]);
    });

    it("ignores raffles with no claim window", async () => {
      const raffleId = seedClosedRaffle(["a", "b", "c", "d", "e"]);
      const announcer = fakeAnnouncer();
      await executeDraw(db, announcer, raffleId, NOW, gen);
      expect(await expireUnclaimedWins(db, announcer, AFTER)).toBe(0);
      expect(activeWinnerIds(db, raffleId)).toEqual(["d"]);
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
