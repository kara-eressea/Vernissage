import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import { deriveSeed, hashEntrants, selectWinners } from "../../src/core/draw.js";
import { addEntry } from "../../src/db/repositories/entries.js";
import { setGuildConfig } from "../../src/db/repositories/guilds.js";
import {
  createDraft,
  getRaffle,
  setStatus,
  updateRaffleFields,
} from "../../src/db/repositories/raffles.js";
import { upsertMemberName } from "../../src/db/repositories/members.js";
import { activeWinnerIds, listWinsForRaffle } from "../../src/db/repositories/wins.js";
import { executeDraw, rerollWinner } from "../../src/draw/service.js";
import { buildVerification, listVerifiableRaffles } from "../../src/web/verify.js";

const GUILD = "g1";
const NOW = "2026-07-15T12:00:00.000Z";
const SECRET = "test-secret-abc123";
const gen = () => SECRET;

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
  setGuildConfig(db, GUILD, { announce_channel: "annc" }, NOW);
});

afterEach(() => {
  db.close();
});

function fakeAnnouncer() {
  return {
    editMessage: async (): Promise<void> => {},
    postAudit: async (): Promise<void> => {},
    postAnnouncement: async (): Promise<string | undefined> => "msg1",
  };
}

/** Seed a closed raffle with the given entrants and options. */
function seedClosedRaffle(
  entrants: string[],
  opts: { winnerCount?: number; guild?: string } = {},
): number {
  const raffleId = createDraft(db, opts.guild ?? GUILD, "creator", NOW);
  updateRaffleFields(db, raffleId, {
    name: "Summer Vinyl Giveaway",
    prize: "A record",
    winner_count: opts.winnerCount ?? 1,
    draw_mode: "manual",
  });
  for (const id of entrants) {
    addEntry(db, raffleId, id, NOW);
  }
  setStatus(db, raffleId, "closed");
  return raffleId;
}

/** Draw a freshly-seeded raffle with the fixed secret. */
async function drawRaffle(
  entrants: string[],
  opts: { winnerCount?: number; guild?: string } = {},
): Promise<number> {
  const raffleId = seedClosedRaffle(entrants, opts);
  await executeDraw(db, fakeAnnouncer(), raffleId, NOW, gen);
  return raffleId;
}

describe("buildVerification", () => {
  it("verifies a genuine single-winner draw and recomputes every value", async () => {
    const entrants = ["100", "200", "300", "400", "500"];
    const raffleId = await drawRaffle(entrants);

    const result = buildVerification(db, GUILD, raffleId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.state).toBe("verified");
    expect(result.entrantCount).toBe(5);
    expect(result.winnerCount).toBe(1);
    // The recomputed hash/seed match what the draw stored.
    const expectedSeed = deriveSeed(hashEntrants(entrants), SECRET);
    expect(result.entrantsHash).toBe(hashEntrants(entrants));
    expect(result.seed).toBe(expectedSeed);
    // The seed preimage is the colon-joined pair (the real deriveSeed formula).
    expect(result.seedPreimage).toBe(`${hashEntrants(entrants)}:${SECRET}`);
    // The reconstructed winner is the raffle's standing winner.
    expect(result.winners.map((w) => w.userId)).toEqual(activeWinnerIds(db, raffleId));
    expect(result.steps.every((s) => s.status === "ok")).toBe(true);
    expect(result.commitment.match).toBe(true);
  });

  it("marks the winning entrant in the full list at the seed-derived index", async () => {
    const entrants = ["100", "200", "300", "400", "500"];
    const raffleId = await drawRaffle(entrants);
    const result = buildVerification(db, GUILD, raffleId);
    if (!result.ok) throw new Error("expected ok");

    const seed = deriveSeed(hashEntrants(entrants), SECRET);
    const winnerIndex = Number(BigInt(`0x${seed}`) % BigInt(entrants.length));
    const winnerRow = result.entrants.find((e) => e.isWinner);
    expect(winnerRow?.index).toBe(winnerIndex);
    expect(result.winners[0]?.index).toBe(winnerIndex);
  });

  it("fails verification when the stored secret was tampered with", async () => {
    const raffleId = await drawRaffle(["100", "200", "300"]);
    // Tamper: replace the revealed secret so SHA-256(secret) != the commitment.
    db.prepare(`UPDATE raffles SET draw_secret = ? WHERE raffle_id = ?`).run("not-the-secret", raffleId);

    const result = buildVerification(db, GUILD, raffleId);
    if (!result.ok) throw new Error("expected ok");
    expect(result.state).toBe("failed");
    expect(result.commitment.match).toBe(false);
    // The commitment check fails; the seed and winner steps are blocked.
    expect(result.steps[2]!.status).toBe("fail");
    expect(result.steps[3]!.status).toBe("blocked");
    expect(result.steps[4]!.status).toBe("blocked");
  });

  it("reconstructs the committed list and verifies a multi-winner draw", async () => {
    const raffleId = await drawRaffle(["100", "200", "300", "400", "500"], { winnerCount: 3 });
    const result = buildVerification(db, GUILD, raffleId);
    if (!result.ok) throw new Error("expected ok");

    expect(result.state).toBe("verified");
    expect(result.winnerCount).toBe(3);
    expect(result.winners.map((w) => w.userId)).toEqual(activeWinnerIds(db, raffleId));
    expect(result.winners).toHaveLength(3);
  });

  it("verifies a draw whose failsafe removed a winner (committed list = active + disqualified)", async () => {
    const entrants = ["100", "200", "300", "400", "500"];
    const seed = deriveSeed(hashEntrants(entrants), SECRET);
    const firstPick = selectWinners(entrants, seed, 1)[0]!;
    // The failsafe reports the natural winner as having left the guild.
    const resolveMembers = async (_g: string, ids: string[]) =>
      new Set(ids.filter((id) => id !== firstPick));

    const raffleId = seedClosedRaffle(entrants);
    await executeDraw(db, fakeAnnouncer(), raffleId, NOW, gen, resolveMembers);

    const result = buildVerification(db, GUILD, raffleId);
    if (!result.ok) throw new Error("expected ok");
    expect(result.state).toBe("verified");
    // The removed id is frozen as excluded but still part of the committed 5.
    expect(result.excluded).toEqual([firstPick]);
    expect(result.entrantCount).toBe(5);
    const excludedRow = result.entrants.find((e) => e.userId === firstPick);
    expect(excludedRow?.isExcluded).toBe(true);
    expect(excludedRow?.isWinner).toBe(false);
  });

  it("still verifies after a reroll (rerolled winner excluded)", async () => {
    const raffleId = await drawRaffle(["100", "200", "300", "400", "500"]);
    const win = listWinsForRaffle(db, raffleId).find((w) => w.rerolled === 0)!;
    await rerollWinner(db, fakeAnnouncer(), raffleId, win.win_id, "left the server", NOW);

    const result = buildVerification(db, GUILD, raffleId);
    if (!result.ok) throw new Error("expected ok");
    expect(result.state).toBe("verified");
    // The standing winner is the replacement, and it is reproduced by the check.
    expect(result.winners.map((w) => w.userId)).toEqual(activeWinnerIds(db, raffleId));
    expect(result.winners[0]?.userId).not.toBe(win.user_id);
  });

  it("verifies a zero-entrant draw (no winner, but the chain still checks out)", async () => {
    const raffleId = await drawRaffle([]);
    const result = buildVerification(db, GUILD, raffleId);
    if (!result.ok) throw new Error("expected ok");
    expect(result.state).toBe("verified");
    expect(result.entrantCount).toBe(0);
    expect(result.winnerCount).toBe(1);
    expect(result.winners).toHaveLength(0);
  });

  it("labels entrants and the winner with cached names, falling back to the id", async () => {
    const entrants = ["100", "200", "300"];
    const raffleId = await drawRaffle(entrants);
    // Name two of the three; leave one uncached.
    upsertMemberName(db, { guildId: GUILD, userId: "100", username: "alice", displayName: "Alice", updatedAt: NOW });
    upsertMemberName(db, { guildId: GUILD, userId: "200", username: "bob", displayName: "Bob", updatedAt: NOW });

    const result = buildVerification(db, GUILD, raffleId);
    if (!result.ok) throw new Error("expected ok");

    const named = result.entrants.find((e) => e.userId === "100");
    const unnamed = result.entrants.find((e) => e.userId === "300");
    expect(named?.name).toBe("Alice");
    expect(unnamed?.name).toBeNull();
    // The winner row carries whatever name (or null) that id has.
    const winner = result.winners[0]!;
    const expectedName = { "100": "Alice", "200": "Bob", "300": null }[winner.userId];
    expect(winner.name).toBe(expectedName);
  });

  it("reports not_drawn for a raffle that hasn't been drawn", () => {
    const raffleId = seedClosedRaffle(["100", "200"]);
    const result = buildVerification(db, GUILD, raffleId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_drawn");
  });

  it("reports not_found for a raffle in another guild", async () => {
    const raffleId = await drawRaffle(["100", "200", "300"], { guild: "other" });
    const result = buildVerification(db, GUILD, raffleId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_found");
  });
});

describe("listVerifiableRaffles", () => {
  it("lists drawn raffles newest-first, scoped to the guild", async () => {
    const first = await drawRaffle(["100", "200", "300"]);
    const second = await drawRaffle(["100", "200", "300", "400"]);
    seedClosedRaffle(["100", "200"]); // closed, not drawn — excluded
    await drawRaffle(["100", "200"], { guild: "other" }); // other guild — excluded

    const cards = listVerifiableRaffles(db, GUILD);
    expect(cards.map((c) => c.id)).toEqual([second, first]);
    expect(cards[0]!.entrantCount).toBe(4);
    expect(cards[0]!.winnerCount).toBe(1);
    expect(cards[0]!.drawnDate).toBe(NOW);
    // The raffle's real winner from getRaffle isn't needed; the card is DB-only.
    expect(getRaffle(db, second)!.status).toBe("drawn");
  });
});
