import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import type { RaffleStatus } from "../../src/core/types.js";
import { openDb } from "../../src/db/index.js";
import { incrementActivity } from "../../src/db/repositories/activity.js";
import { writeAudit } from "../../src/db/repositories/audit.js";
import { writeActivitySnapshot } from "../../src/db/repositories/activitySnapshot.js";
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
import { buildRaffleDetail } from "../../src/web/raffleDetail.js";
import { raffleDetailPage } from "../../src/web/views.js";

const GUILD = "g1";
const NOW = "2026-07-25T12:00:00.000Z";
const START = "2026-07-14T18:00:00.000Z";
/** Real snowflakes: the account-age gate parses ids, so fixtures must look real. */
const MOD = "100000000000000000";

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
      default_cooldown_days: 30,
      default_min_account_age_days: 7,
    },
    NOW,
  );
});

afterEach(() => {
  db.close();
});

/**
 * A raffle in `status`. The draw fields go through their own setters — they are
 * not patchable columns, so passing them to updateRaffleFields would silently do
 * nothing. `committed: false` seeds a raffle whose draw was never committed.
 */
function seedRaffle(
  fields: Record<string, unknown> = {},
  status: RaffleStatus = "drawn",
  opts: { guild?: string; committed?: boolean } = {},
): number {
  const id = createDraft(db, opts.guild ?? GUILD, MOD, "2026-07-01T00:00:00.000Z");
  updateRaffleFields(db, id, {
    name: "Summer Vinyl",
    prize: "A record",
    starts_at: START,
    ends_at: "2026-07-20T18:00:00.000Z",
    req_messages: 10,
    req_days: 14,
    req_active_days: 3,
    ...fields,
  });
  if (opts.committed !== false) {
    setEntrantsHash(db, id, "hash");
    setDrawCommitment(db, id, "commitment", "secret");
  }
  setStatus(db, id, status);
  return id;
}

/** `days` distinct active days of activity ending 2026-07-13. */
function seedSpread(userId: string, days: number, perDay = 5): void {
  for (let i = 0; i < days; i++) {
    incrementActivity(db, GUILD, userId, `2026-07-${String(13 - i).padStart(2, "0")}`, perDay);
  }
}

function detail(id: number, guild = GUILD) {
  const result = buildRaffleDetail(db, guild, id, NOW);
  if (!result.ok) throw new Error(`expected a detail view, got ${result.reason}`);
  return result;
}

describe("buildRaffleDetail", () => {
  it("refuses a raffle from another guild rather than leaking it", () => {
    const id = seedRaffle({}, "drawn", { guild: "g2" });
    expect(buildRaffleDetail(db, GUILD, id, NOW)).toEqual({ ok: false, reason: "not_found" });
  });

  it("reports an unknown id as not found", () => {
    expect(buildRaffleDetail(db, GUILD, 999, NOW)).toEqual({ ok: false, reason: "not_found" });
  });

  it("shows withdrawn and removed entrants with their reason", () => {
    const id = seedRaffle();
    addEntry(db, id, "200000000000000001", NOW);
    addEntry(db, id, "200000000000000002", NOW);
    removeEntry(db, id, "200000000000000002", "2026-07-16T00:00:00.000Z", "withdrawn");

    const view = detail(id);
    const left = view.entrants.find((e) => e.userId === "200000000000000002")!;

    // listEntrants drops removals for the draw; the record keeps them.
    expect(view.entrants).toHaveLength(2);
    expect(left).toMatchObject({ removedReason: "withdrawn", removedAt: "2026-07-16T00:00:00.000Z" });
    expect(view.activeEntrants).toBe(1);
    expect(view.removedEntrants).toBe(1);
  });

  it("marks entrants the draw failsafe removed", () => {
    const id = seedRaffle();
    addEntry(db, id, "200000000000000003", NOW);
    removeEntry(db, id, "200000000000000003", NOW, "blacklisted");
    setDrawDisqualified(db, id, ["200000000000000003"]);

    expect(detail(id).entrants[0]).toMatchObject({ disqualified: true });
  });

  it("keeps rerolled winners and their claim state", () => {
    const id = seedRaffle();
    const dropped = addWin(db, id, "200000000000000004", NOW);
    markRerolled(db, dropped);
    addWin(db, id, "200000000000000005", NOW, "2026-07-24T00:00:00.000Z");

    const view = detail(id);

    expect(view.winners.map((w) => w.userId)).toEqual(["200000000000000005", "200000000000000004"]);
    expect(view.winners[0]!.claim).toBe("forfeited");
    expect(view.winners[1]!.rerolled).toBe(true);
  });

  it("labels people by their cached name, falling back to the id", () => {
    const id = seedRaffle();
    upsertMemberName(db, {
      guildId: GUILD,
      userId: "200000000000000006",
      username: "alice",
      displayName: "Alice",
      updatedAt: NOW,
    });
    addEntry(db, id, "200000000000000006", NOW);
    addEntry(db, id, "200000000000000007", NOW);

    const view = detail(id);

    expect(view.entrants.find((e) => e.userId === "200000000000000006")!.name).toBe("Alice");
    expect(view.entrants.find((e) => e.userId === "200000000000000007")!.name).toBeNull();
  });

  it("renders the audit timeline with names, not Discord markup", () => {
    const id = seedRaffle();
    upsertMemberName(db, {
      guildId: GUILD,
      userId: "200000000000000008",
      username: "bob",
      displayName: "Bob",
      updatedAt: NOW,
    });
    writeAudit(db, {
      guildId: GUILD,
      raffleId: id,
      eventType: "entry_accepted",
      actorId: "200000000000000008",
      payload: { userId: "200000000000000008" },
      createdAt: "2026-07-15T09:00:00.000Z",
    });

    const line = detail(id).timeline.find((t) => t.text.includes("entered"))!;

    expect(line.text).toContain("Bob");
    // The audit-channel renderer would emit <@id> and <t:…>; neither belongs here.
    expect(line.text).not.toContain("<@");
    expect(line.text).not.toContain("<t:");
    expect(line.at).toBe("2026-07-15T09:00:00.000Z");
  });

  it("survives an audit row whose payload is not readable JSON", () => {
    const id = seedRaffle();
    db.prepare(
      `INSERT INTO audit_log (guild_id, raffle_id, event_type, actor_id, payload, created_at)
       VALUES (?, ?, 'entry_accepted', 'uX', 'not json', ?)`,
    ).run(GUILD, id, NOW);

    expect(() => detail(id)).not.toThrow();
    expect(detail(id).timeline).toHaveLength(1);
  });

  it("describes the activity bar as the gate reads it — a null is no floor, not the default", () => {
    // The guild default is 10 messages, but the gate reads `req_messages ?? 0`
    // off the row, so a null raffle has no message floor at all.
    const id = seedRaffle({ req_messages: null });

    const row = detail(id).settings.find((s) => s.label === "Messages required")!;

    expect(row.value).toBe("none");
    expect(row.note).toContain("not the server default");
  });

  it("marks the cooldown as inherited only when the raffle leaves it unset", () => {
    const inherited = detail(seedRaffle({ cooldown_days: null })).settings.find(
      (s) => s.label === "Win cooldown",
    )!;
    const own = detail(seedRaffle({ cooldown_days: 90 })).settings.find(
      (s) => s.label === "Win cooldown",
    )!;

    expect(inherited).toMatchObject({ value: "30", note: "from the server default" });
    expect(own).toMatchObject({ value: "90", note: "set on this raffle" });
  });

  it("states that account age and tenure have no per-raffle override", () => {
    const row = detail(seedRaffle()).settings.find((s) => s.label === "Minimum account age")!;
    expect(row).toMatchObject({ value: "7", note: "server-wide policy — no per-raffle override" });
  });

  it("summarises eligibility with a breakdown split by which floor was missed", () => {
    const id = seedRaffle();
    seedSpread("200000000000000009", 4); // 20 messages over 4 days: clears both floors
    seedSpread("200000000000000010", 2, 30); // plenty of messages, too few days
    seedSpread("200000000000000011", 4, 1); // enough days, too few messages

    const e = detail(id).eligibility!;
    const labels = e.breakdown.map((b) => b.label);

    expect(e.view.considered).toBe(3);
    expect(e.view.eligible).toBe(1);
    expect(e.blocked).toBe(2);
    expect(labels).toContain("Too few active days");
    expect(labels).toContain("Too few messages");
  });

  it("previews the blocked members, not the eligible ones", () => {
    const id = seedRaffle();
    seedSpread("200000000000000009", 4);
    seedSpread("200000000000000012", 1, 1);

    const e = detail(id).eligibility!;

    expect(e.preview.map((r) => r.userId)).toEqual(["200000000000000012"]);
    expect(e.preview[0]!.reasons.length).toBeGreaterThan(0);
  });

  it("calls the measurement locked when the raffle froze one", () => {
    const id = seedRaffle();
    seedSpread("200000000000000013", 4);
    writeActivitySnapshot(db, id, [{ userId: "200000000000000013", messages: 20, activeDays: 4 }], START);

    const e = detail(id).eligibility!;

    expect(e.view.measurement.frozen).toBe(true);
    // A frozen snapshot survives pruning, so the pruning caveat does not apply.
    expect(e.view.caveats.join(" ")).not.toContain("180 days");
  });

  it("warns that a raffle with no snapshot may have lost its activity to pruning", () => {
    const id = seedRaffle();
    seedSpread("200000000000000013", 4);

    const e = detail(id).eligibility!;

    expect(e.view.measurement.frozen).toBe(false);
    expect(e.view.caveats.join(" ")).toContain("180 days");
  });

  it("has no eligibility panel for a draft, which has no window to judge", () => {
    const id = createDraft(db, GUILD, MOD, NOW);
    expect(detail(id).eligibility).toBeNull();
  });

  it("links the announcement and the verifier only when they exist", () => {
    const withPost = detail(seedRaffle({ channel_id: "c1", message_id: "m1" }));
    const without = detail(seedRaffle({}, "cancelled", { committed: false }));

    expect(withPost.announceUrl).toBe(`https://discord.com/channels/${GUILD}/c1/m1`);
    expect(withPost.verifiable).toBe(true);
    expect(without.announceUrl).toBeNull();
    expect(without.verifiable).toBe(false);
  });
});

describe("raffleDetailPage", () => {
  const guild = { id: GUILD, name: "Musicorum", icon: null };
  const session = { uid: MOD, username: "Mod", guilds: [guild], iat: 0 };

  it("renders every panel and escapes moderator-supplied text", () => {
    const id = seedRaffle({ name: "<b>Vinyl</b>", channel_id: "c1", message_id: "m1" });
    seedSpread("200000000000000009", 4);
    addEntry(db, id, "200000000000000009", NOW);
    addWin(db, id, "200000000000000009", NOW, null);

    const out = raffleDetailPage(session, guild, detail(id), []);

    for (const panel of ["Who could enter", "Winners", "Entrants", "Settings it applied", "Timeline"]) {
      expect(out).toContain(panel);
    }
    expect(out).toContain(`/app/verify?raffle=${id}`);
    expect(out).toContain(`https://discord.com/channels/${GUILD}/c1/m1`);
    expect(out).toContain("&lt;b&gt;Vinyl&lt;/b&gt;");
    expect(out).not.toContain("<b>Vinyl</b>");
  });

  it("renders a draft, which has no eligibility panel to show", () => {
    const id = createDraft(db, GUILD, MOD, NOW);
    const out = raffleDetailPage(session, guild, detail(id), []);
    expect(out).toContain("Timeline");
    expect(out).not.toContain("Who could enter");
  });
});
