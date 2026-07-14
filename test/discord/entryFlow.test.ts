import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import { incrementActivity } from "../../src/db/repositories/activity.js";
import { addBan } from "../../src/db/repositories/blacklist.js";
import { addEntry, hasEntry, removeEntry } from "../../src/db/repositories/entries.js";
import {
  countRafflesSince,
  createDraft,
  getRaffle,
  setStatus,
  updateRaffleFields,
  type RaffleFieldPatch,
} from "../../src/db/repositories/raffles.js";
import { addWin } from "../../src/db/repositories/wins.js";
import { announceOpenRaffle, attemptEntry, closeEntryMessage, refreshEntryMessage } from "../../src/discord/entryFlow.js";
import { makeFakeNotifier } from "../helpers/fakeNotifier.js";

let db: Database;
const notifier = makeFakeNotifier();

const NOW = "2026-07-15T12:00:00.000Z";
const DAY = "2026-07-15";

beforeEach(() => {
  db = openDb(":memory:");
  notifier.mirrorAudit.mockClear();
  notifier.editMessage.mockClear();
  notifier.postAudit.mockClear();
  notifier.postEntryMessage.mockReset();
  notifier.postEntryMessage.mockResolvedValue(undefined);
});
afterEach(() => db.close());

function seedOpenRaffle(overrides: RaffleFieldPatch = {}): number {
  const id = createDraft(db, "g1", "mod1", "2026-07-01T00:00:00.000Z");
  updateRaffleFields(db, id, {
    name: "R",
    prize: "P",
    starts_at: "2026-07-15T00:00:00.000Z",
    ends_at: "2026-07-30T00:00:00.000Z",
    req_messages: 5,
    req_days: 1,
    winner_count: 1,
    draw_mode: "auto",
    ...overrides,
  });
  setStatus(db, id, "open");
  return id;
}

function ctxFor(raffleId: number, userId = "u1") {
  return {
    raffle: getRaffle(db, raffleId)!,
    guild: undefined,
    userId,
    userRoleIds: [],
    joinedAt: null,
    now: NOW,
  };
}

function auditCount(eventType: string): number {
  return (
    db.prepare(`SELECT count(*) c FROM audit_log WHERE event_type = ?`).get(eventType) as {
      c: number;
    }
  ).c;
}

describe("attemptEntry", () => {
  it("accepts an eligible member: one entry row, one audit row, one mirror", () => {
    const id = seedOpenRaffle();
    incrementActivity(db, "g1", "u1", DAY, 5);

    const { result } = attemptEntry(db, notifier, ctxFor(id));

    expect(result.ok).toBe(true);
    expect(hasEntry(db, id, "u1")).toBe(true);
    expect(auditCount("entry_accepted")).toBe(1);
    expect(notifier.mirrorAudit).toHaveBeenCalledOnce();
  });

  it("rejects insufficient activity, writing nothing", () => {
    const id = seedOpenRaffle();
    // no messages recorded
    const { result } = attemptEntry(db, notifier, ctxFor(id));

    expect(result).toEqual({ ok: false, reason: "insufficient_activity" });
    expect(hasEntry(db, id, "u1")).toBe(false);
    expect(auditCount("entry_accepted")).toBe(0);
    expect(notifier.mirrorAudit).not.toHaveBeenCalled();
  });

  it("rejects a raffle that is not open", () => {
    const id = seedOpenRaffle();
    setStatus(db, id, "scheduled");
    incrementActivity(db, "g1", "u1", DAY, 5);
    expect(attemptEntry(db, notifier, ctxFor(id)).result).toEqual({
      ok: false,
      reason: "not_open",
    });
  });

  it("rejects a blacklisted member before any activity check", () => {
    const id = seedOpenRaffle();
    incrementActivity(db, "g1", "u1", DAY, 5);
    addBan(db, {
      guildId: "g1",
      userId: "u1",
      bannedBy: "mod1",
      reason: "spam",
      bannedAt: "2026-07-10T00:00:00.000Z",
      expiresAt: null,
    });
    expect(attemptEntry(db, notifier, ctxFor(id)).result).toEqual({
      ok: false,
      reason: "blacklisted",
    });
    expect(hasEntry(db, id, "u1")).toBe(false);
  });

  it("rejects the raffle's creator from entering their own raffle", () => {
    const id = seedOpenRaffle(); // created_by = "mod1"
    incrementActivity(db, "g1", "mod1", DAY, 5);
    expect(attemptEntry(db, notifier, ctxFor(id, "mod1")).result).toEqual({
      ok: false,
      reason: "is_creator",
    });
    expect(hasEntry(db, id, "mod1")).toBe(false);
  });

  it("enforces the required-role gate from the gathered member roles", () => {
    const id = seedOpenRaffle({ required_role_id: "vip" });
    incrementActivity(db, "g1", "u1", DAY, 5);
    // Missing the role: rejected.
    expect(attemptEntry(db, notifier, ctxFor(id)).result).toEqual({
      ok: false,
      reason: "missing_required_role",
    });
    // Holding the role: accepted.
    const ctx = { ...ctxFor(id), userRoleIds: ["vip"] };
    expect(attemptEntry(db, notifier, ctx).result.ok).toBe(true);
  });

  it("bars a prior winner only when the raffle excludes prior winners", () => {
    // A non-rerolled win in a completed raffle in the same guild.
    const past = seedOpenRaffle();
    setStatus(db, past, "completed");
    addWin(db, past, "u1", "2026-07-05T00:00:00.000Z");

    const off = seedOpenRaffle();
    incrementActivity(db, "g1", "u1", DAY, 5);
    expect(attemptEntry(db, notifier, ctxFor(off)).result.ok).toBe(true);

    const on = seedOpenRaffle({ exclude_prior_winners: 1 });
    expect(attemptEntry(db, notifier, ctxFor(on)).result).toEqual({
      ok: false,
      reason: "prior_winner",
    });
  });

  it("rejects a second entry as already_entered", () => {
    const id = seedOpenRaffle();
    incrementActivity(db, "g1", "u1", DAY, 5);
    attemptEntry(db, notifier, ctxFor(id));
    expect(attemptEntry(db, notifier, ctxFor(id)).result).toEqual({
      ok: false,
      reason: "already_entered",
    });
  });

  it("reinstates a soft-removed row on re-entry (withdrawal, lifted ban)", () => {
    const id = seedOpenRaffle();
    incrementActivity(db, "g1", "u1", DAY, 5);
    // A prior removed entry leaves a row; the eligible member re-enters and the
    // row is reinstated in place (design.md "open": withdrawal allows re-entry).
    addEntry(db, id, "u1", "2026-07-15T10:00:00.000Z");
    removeEntry(db, id, "u1", "2026-07-15T11:00:00.000Z", "withdrawn");
    expect(hasEntry(db, id, "u1")).toBe(false);

    const { result } = attemptEntry(db, notifier, ctxFor(id));
    expect(result).toEqual({ ok: true });
    expect(hasEntry(db, id, "u1")).toBe(true);
    expect(auditCount("entry_accepted")).toBe(1);
  });

  it("binds an entry to the specific raffle when several are open", () => {
    const a = seedOpenRaffle({ name: "A" });
    const b = seedOpenRaffle({ name: "B" });
    incrementActivity(db, "g1", "u1", DAY, 5);

    attemptEntry(db, notifier, ctxFor(a));
    expect(hasEntry(db, a, "u1")).toBe(true);
    expect(hasEntry(db, b, "u1")).toBe(false);

    attemptEntry(db, notifier, ctxFor(b));
    expect(hasEntry(db, b, "u1")).toBe(true);
  });
});

describe("countRafflesSince", () => {
  it("counts only drawn/completed raffles started after the timestamp", () => {
    const mk = (status: string, startsAt: string): number => {
      const id = createDraft(db, "g1", "mod1", "2026-07-01T00:00:00.000Z");
      updateRaffleFields(db, id, { starts_at: startsAt });
      setStatus(db, id, status as never);
      return id;
    };
    mk("drawn", "2026-07-10T00:00:00.000Z"); // after → counts
    mk("completed", "2026-07-12T00:00:00.000Z"); // after → counts
    mk("drawn", "2026-07-01T00:00:00.000Z"); // before → excluded
    mk("open", "2026-07-20T00:00:00.000Z"); // not drawn → excluded
    createDraft(db, "g2", "mod1", "2026-07-01T00:00:00.000Z"); // other guild

    expect(countRafflesSince(db, "g1", "2026-07-05T00:00:00.000Z")).toBe(2);
  });
});

describe("closeEntryMessage", () => {
  it("edits the stored entry message to drop the button and mark it closed", async () => {
    const id = seedOpenRaffle({ channel_id: "chan1", message_id: "msg1" });

    await closeEntryMessage(db, notifier, id);

    expect(notifier.editMessage).toHaveBeenCalledTimes(1);
    const [channelId, messageId, content, components] = notifier.editMessage.mock.calls[0]!;
    expect(channelId).toBe("chan1");
    expect(messageId).toBe("msg1");
    expect(content).toContain("(closed)");
    expect(content).toContain("Entries are now closed");
    expect(components).toEqual([]); // Enter button removed
  });

  it("is a no-op when the raffle never stored a message id", async () => {
    const id = seedOpenRaffle({ channel_id: "chan1" }); // no message_id
    await closeEntryMessage(db, notifier, id);
    expect(notifier.editMessage).not.toHaveBeenCalled();
  });

  it("is a no-op when no announce channel can be resolved", async () => {
    const id = seedOpenRaffle({ channel_id: null, message_id: "msg1" }); // no channel, no guild default
    await closeEntryMessage(db, notifier, id);
    expect(notifier.editMessage).not.toHaveBeenCalled();
  });
});

describe("announceOpenRaffle — failure surfacing", () => {
  it("warns the audit channel when no announce channel is configured", async () => {
    const id = seedOpenRaffle();

    await announceOpenRaffle(db, notifier, id);

    expect(notifier.postEntryMessage).not.toHaveBeenCalled();
    expect(notifier.postAudit).toHaveBeenCalledOnce();
    expect(notifier.postAudit.mock.calls[0]![1]).toMatch(/no announce channel is configured/);
  });

  it("warns the audit channel when the entry message fails to post", async () => {
    const id = seedOpenRaffle({ channel_id: "chan-1" });
    notifier.postEntryMessage.mockResolvedValue(undefined); // send failed

    await announceOpenRaffle(db, notifier, id);

    expect(notifier.postAudit).toHaveBeenCalledOnce();
    expect(notifier.postAudit.mock.calls[0]![1]).toMatch(/could not be posted to <#chan-1>/);
    expect(getRaffle(db, id)?.message_id).toBeNull();
  });

  it("posts no warning when the entry message succeeds", async () => {
    const id = seedOpenRaffle({ channel_id: "chan-1" });
    notifier.postEntryMessage.mockResolvedValue("msg-1");

    await announceOpenRaffle(db, notifier, id);

    expect(notifier.postAudit).not.toHaveBeenCalled();
    expect(getRaffle(db, id)?.message_id).toBe("msg-1");
  });
});

describe("entry-message card lifecycle", () => {
  it("posts the open card with host, entry count, and vague requirements", async () => {
    const id = seedOpenRaffle({ channel_id: "chan-1", description: "Come one, come all" });
    addEntry(db, id, "u1", NOW);
    notifier.postEntryMessage.mockResolvedValue("msg-1");

    await announceOpenRaffle(db, notifier, id);

    const content = notifier.postEntryMessage.mock.calls[0]![1] as string;
    expect(content).toContain(">>> ### 🎟️ R");
    expect(content).toContain("Come one, come all");
    expect(content).toContain("**Hosted by:** <@mod1>");
    expect(content).toContain("**Entries:** 1");
    expect(content).toContain("-# To enter, you must have been active");
    expect(content).not.toContain("5 messages"); // count stays private
  });

  it("refresh re-edits the card with the new count and keeps the Enter button", async () => {
    const id = seedOpenRaffle({ channel_id: "chan-1", message_id: "msg-1" });
    addEntry(db, id, "u1", NOW);
    addEntry(db, id, "u2", NOW);

    await refreshEntryMessage(db, notifier, id);

    const [channelId, messageId, content, components] = notifier.editMessage.mock.calls[0]!;
    expect(channelId).toBe("chan-1");
    expect(messageId).toBe("msg-1");
    expect(content).toContain("**Entries:** 2");
    expect(components).toHaveLength(1); // Enter button retained while open
  });

  it("close rewrites the card closed and drops the button", async () => {
    const id = seedOpenRaffle({ channel_id: "chan-1", message_id: "msg-1" });

    await closeEntryMessage(db, notifier, id);

    const [, , content, components] = notifier.editMessage.mock.calls[0]!;
    expect(content).toContain("(closed)");
    expect(content).toContain("Entries are now closed");
    expect(components).toHaveLength(0);
  });
});
