import { describe, expect, it } from "vitest";
import { AUDIT_EVENTS } from "../../src/core/auditEvents.js";
import { formatAuditLine, type AuditLineInput } from "../../src/core/auditFormat.js";

const AT = "2026-07-03T12:00:00.000Z";
const EPOCH = Math.floor(Date.parse(AT) / 1000);

function line(overrides: Partial<AuditLineInput>): string {
  return formatAuditLine({
    eventType: AUDIT_EVENTS.raffleOpened,
    raffleId: 7,
    actorId: null,
    createdAt: AT,
    ...overrides,
  });
}

describe("formatAuditLine", () => {
  it("renders the timestamp as Discord markup", () => {
    expect(line({})).toContain(`<t:${EPOCH}:f>`);
  });

  it("renders actor and subject ids as mentions", () => {
    const created = line({ eventType: AUDIT_EVENTS.raffleCreated, actorId: "mod1" });
    expect(created).toContain("<@mod1>");
    expect(created).toContain("raffle #7");
  });

  it("names the entrant on entry_accepted (payload userId, else actor)", () => {
    expect(line({ eventType: AUDIT_EVENTS.entryAccepted, actorId: "u9" })).toContain("<@u9>");
    expect(
      line({ eventType: AUDIT_EVENTS.entryAccepted, actorId: "mod", payload: { userId: "u5" } }),
    ).toContain("<@u5>");
  });

  it("never leaks a blacklist reason", () => {
    const out = line({
      eventType: AUDIT_EVENTS.blacklistAdded,
      actorId: "mod1",
      payload: { userId: "u2", reason: "spamming raffles constantly" },
    });
    expect(out).toContain("<@u2>");
    expect(out).not.toContain("spamming");
    expect(out.toLowerCase()).not.toContain("reason");
  });

  it("never leaks an entry-removal reason", () => {
    const out = line({
      eventType: AUDIT_EVENTS.entryRemoved,
      payload: { userId: "u2", reason: "banned mid-raffle" },
    });
    expect(out).not.toContain("banned mid-raffle");
  });

  it("never emits an activity/message count even if present in payload", () => {
    const out = line({
      eventType: AUDIT_EVENTS.entryAccepted,
      actorId: "u1",
      payload: { userId: "u1", messageCount: 4242, activity: 4242 },
    });
    expect(out).not.toContain("4242");
  });

  it("lists draw winners as mentions", () => {
    const out = line({
      eventType: AUDIT_EVENTS.raffleDrawn,
      payload: { winners: ["a", "b"] },
    });
    expect(out).toContain("<@a>");
    expect(out).toContain("<@b>");
  });

  it("handles a drawn raffle with no winners", () => {
    const out = line({ eventType: AUDIT_EVENTS.raffleDrawn, payload: { winners: [] } });
    expect(out).toMatch(/no eligible entrants/i);
  });

  it("falls back to a safe generic line for an unknown event type", () => {
    const out = line({
      eventType: "mystery_event",
      payload: { reason: "secret", count: 99 },
    });
    expect(out).toContain("mystery_event");
    expect(out).toContain("raffle #7");
    expect(out).not.toContain("secret");
    expect(out).not.toContain("99");
  });

  it("says 'the system' when there is no actor", () => {
    expect(line({ eventType: AUDIT_EVENTS.raffleCreated, actorId: null })).toContain(
      "the system",
    );
  });
});
