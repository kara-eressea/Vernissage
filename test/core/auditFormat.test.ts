import { describe, expect, it } from "vitest";
import { AUDIT_EVENTS } from "../../src/core/auditEvents.js";
import {
  describeAuditEvent,
  formatAuditLine,
  type AuditLineInput,
} from "../../src/core/auditFormat.js";

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

  it("shows the reset scope and subject but never the counts", () => {
    const out = line({
      eventType: AUDIT_EVENTS.eligibilityReset,
      actorId: "mod1",
      payload: { userId: "u2", scope: "all", winsWaived: 4242, activityRowsDeleted: 7777 },
    });
    expect(out).toContain("<@mod1>");
    expect(out).toContain("<@u2>");
    expect(out).toContain("(all)");
    // The activity-derived counts stay in the DB payload, never the public line.
    expect(out).not.toContain("4242");
    expect(out).not.toContain("7777");
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

  it("renders the same event for another surface through the renderer seam", () => {
    // The dashboard timeline reuses this switch with a name-resolving renderer,
    // so a new event type can never be described one way in chat and another on
    // the web. Only the mention differs — and the timestamp is the caller's.
    const event = {
      eventType: AUDIT_EVENTS.entryAccepted,
      raffleId: 7,
      actorId: "1234",
      createdAt: "2026-07-15T09:00:00.000Z",
    };
    const web = describeAuditEvent(event, { mention: (id) => (id === "1234" ? "Alice" : id) });

    expect(web).toContain("Alice");
    expect(web).toContain("entered");
    expect(web).not.toContain("<@");
    // No timestamp: the sentence is the shared part, the surface adds the time.
    expect(web).not.toContain("<t:");
    expect(formatAuditLine(event)).toContain("<@1234>");
  });

  it("keeps the payload privacy rule whatever renderer is used", () => {
    const web = describeAuditEvent(
      {
        eventType: AUDIT_EVENTS.blacklistAdded,
        raffleId: null,
        actorId: "1",
        payload: { userId: "2", reason: "being awful" },
        createdAt: "2026-07-15T09:00:00.000Z",
      },
      { mention: (id) => `M${id}` },
    );
    expect(web).not.toContain("being awful");
  });
});
