import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import {
  getPendingRaffle,
  markPendingRedeemed,
  parsePendingSpec,
  pendingTokenExists,
  stagePendingRaffle,
  sweepExpiredPendingRaffles,
  type PendingRaffleSpec,
} from "../../src/db/repositories/pendingRaffles.js";

const NOW = "2026-07-14T12:00:00.000Z";
const LATER = "2026-07-14T18:00:00.000Z";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

function spec(over: Partial<PendingRaffleSpec> = {}): PendingRaffleSpec {
  return {
    name: "Summer Vinyl Giveaway",
    prize: "A record",
    description: "Two days only.",
    starts_at: "2026-07-17T16:00:00.000Z",
    ends_at: "2026-07-19T16:00:00.000Z",
    winner_count: 1,
    draw_mode: "auto",
    is_test: false,
    claim_window_hours: 24,
    open_to_all: false,
    exclude_prior_winners: true,
    req_messages: 10,
    req_days: 14,
    req_active_days: 3,
    cooldown_days: 60,
    cooldown_count: null,
    ...over,
  };
}

function stage(token: string, over: Partial<PendingRaffleSpec> = {}, expiresAt = LATER): void {
  stagePendingRaffle(db, {
    token,
    guildId: "g1",
    stagedByUserId: "mod1",
    spec: spec(over),
    createdAt: NOW,
    expiresAt,
  });
}

describe("stagePendingRaffle / getPendingRaffle", () => {
  it("round-trips a staged spec", () => {
    stage("gentle-harbor-4821", { winner_count: 3, open_to_all: true });
    const row = getPendingRaffle(db, "gentle-harbor-4821");
    expect(row).toBeDefined();
    expect(row!.guild_id).toBe("g1");
    expect(row!.staged_by_user_id).toBe("mod1");
    expect(row!.redeemed_at).toBeNull();
    expect(row!.redeemed_raffle_id).toBeNull();

    const parsed = parsePendingSpec(row!);
    expect(parsed.winner_count).toBe(3);
    expect(parsed.open_to_all).toBe(true);
    expect(parsed.exclude_prior_winners).toBe(true);
    expect(parsed.starts_at).toBe("2026-07-17T16:00:00.000Z");
  });

  it("returns undefined for an unknown token", () => {
    expect(getPendingRaffle(db, "nope-nope-0000")).toBeUndefined();
  });

  it("reports token existence for collision checks", () => {
    stage("amber-cove-1234");
    expect(pendingTokenExists(db, "amber-cove-1234")).toBe(true);
    expect(pendingTokenExists(db, "amber-cove-9999")).toBe(false);
  });
});

describe("markPendingRedeemed", () => {
  it("records the consuming raffle and timestamp", () => {
    stage("swift-ridge-7777");
    markPendingRedeemed(db, "swift-ridge-7777", 42, LATER);
    const row = getPendingRaffle(db, "swift-ridge-7777")!;
    expect(row.redeemed_at).toBe(LATER);
    expect(row.redeemed_raffle_id).toBe(42);
  });
});

describe("sweepExpiredPendingRaffles", () => {
  it("removes rows past their expiry and keeps the rest", () => {
    stage("old-token-0001", {}, "2026-07-14T06:00:00.000Z"); // expired before NOW
    stage("live-token-0002", {}, "2026-07-15T06:00:00.000Z"); // still valid
    const removed = sweepExpiredPendingRaffles(db, NOW);
    expect(removed).toBe(1);
    expect(getPendingRaffle(db, "old-token-0001")).toBeUndefined();
    expect(getPendingRaffle(db, "live-token-0002")).toBeDefined();
  });
});
