import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import { setGuildConfig } from "../../src/db/repositories/guilds.js";
import { getPendingRaffle, parsePendingSpec } from "../../src/db/repositories/pendingRaffles.js";
import type { DesignerSubmission } from "../../src/core/designerSpec.js";
import { handleStage, HANDOFF_TTL_MS } from "../../src/handoff/server.js";

const GUILD = "g1";
const SECRET = "shhh-secret";
const NOW = "2026-07-14T12:00:00.000Z";
const OPTS = { secret: SECRET, guildIds: [GUILD] };

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
  setGuildConfig(
    db,
    GUILD,
    {
      default_req_messages: 10,
      default_req_days: 14,
      default_req_active_days: 3,
      default_cooldown_days: 60,
      announce_channel: "chan",
      timezone: "Europe/Copenhagen",
    },
    NOW,
  );
});

afterEach(() => {
  db.close();
});

function submission(over: Partial<DesignerSubmission> = {}): DesignerSubmission {
  return {
    name: "Summer Vinyl Giveaway",
    prize: "A record",
    description: "Two days.",
    start: "2026-07-17T18:00",
    end: "2026-07-19T18:00",
    winnerCount: 1,
    drawMode: "auto",
    isTest: false,
    claimWindowHours: 24,
    openToAll: false,
    barPastWinners: true,
    reqMode: "defaults",
    reqMessages: 20,
    reqDays: 7,
    reqActiveDays: 2,
    cooldownDays: 30,
    ...over,
  };
}

function body(over: Partial<DesignerSubmission> = {}, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    guildId: GUILD,
    moderatorUserId: "mod1",
    submission: submission(over),
    ...extra,
  });
}

const AUTH = `Bearer ${SECRET}`;

describe("handleStage", () => {
  it("stages a valid submission and returns a token", () => {
    const result = handleStage(db, OPTS, AUTH, body(), NOW, () => "amber-cove-1234");
    expect(result.status).toBe(200);
    const out = result.body as { token: string; expiresAt: string };
    expect(out.token).toBe("amber-cove-1234");
    expect(out.expiresAt).toBe(new Date(Date.parse(NOW) + HANDOFF_TTL_MS).toISOString());

    const row = getPendingRaffle(db, "amber-cove-1234")!;
    expect(row.guild_id).toBe(GUILD);
    expect(row.staged_by_user_id).toBe("mod1");
    const spec = parsePendingSpec(row);
    // Defaults mode resolved the guild bar; schedule converted CEST → UTC.
    expect(spec.req_messages).toBe(10);
    expect(spec.starts_at).toBe("2026-07-17T16:00:00.000Z");
  });

  it("writes a pending_raffle_staged audit row without the token", () => {
    handleStage(db, OPTS, AUTH, body(), NOW, () => "amber-cove-1234");
    // Staged rows have no raffle id yet, so query the audit log directly. The
    // token is a capability, so it must not leak into the audit payload.
    const staged = db
      .prepare(`SELECT payload FROM audit_log WHERE event_type = 'pending_raffle_staged'`)
      .get() as { payload: string } | undefined;
    expect(staged).toBeDefined();
    expect(staged!.payload).not.toContain("amber-cove-1234");
  });

  it("rejects a missing or wrong bearer secret", () => {
    expect(handleStage(db, OPTS, undefined, body(), NOW).status).toBe(401);
    expect(handleStage(db, OPTS, "Bearer nope", body(), NOW).status).toBe(401);
  });

  it("rejects malformed JSON and the wrong shape", () => {
    expect(handleStage(db, OPTS, AUTH, "{not json", NOW).status).toBe(400);
    expect(handleStage(db, OPTS, AUTH, JSON.stringify({ guildId: GUILD }), NOW).status).toBe(400);
  });

  it("rejects a guild outside the allowlist", () => {
    const result = handleStage(db, OPTS, AUTH, body({}, { }), NOW);
    // Swap the guild to one not on the list.
    const otherBody = JSON.stringify({ guildId: "other", moderatorUserId: "m", submission: submission() });
    expect(handleStage(db, OPTS, AUTH, otherBody, NOW).status).toBe(403);
    expect(result.status).toBe(200); // sanity: the allowed one still worked
  });

  it("returns 422 with a message when the spec fails validation", () => {
    const result = handleStage(
      db,
      OPTS,
      AUTH,
      body({ start: "2026-07-19T18:00", end: "2026-07-17T18:00" }),
      NOW,
    );
    expect(result.status).toBe(422);
    expect((result.body as { message: string }).message).toMatch(/after the start/i);
  });

  it("retries token generation past a collision", () => {
    handleStage(db, OPTS, AUTH, body(), NOW, () => "taken-token-0001");
    const gens = ["taken-token-0001", "fresh-token-0002"];
    let i = 0;
    const result = handleStage(db, OPTS, AUTH, body(), NOW, () => gens[i++]!);
    expect(result.status).toBe(200);
    expect((result.body as { token: string }).token).toBe("fresh-token-0002");
  });
});
