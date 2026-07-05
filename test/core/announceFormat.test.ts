import { describe, expect, it } from "vitest";
import {
  formatClosedEntryMessage,
  formatEntryMessage,
  resolveAnnounceChannelId,
  type EntryMessageInput,
} from "../../src/core/announceFormat.js";
import { discordTimestamp } from "../../src/core/time.js";

const base: EntryMessageInput = {
  name: "Summer Giveaway",
  prize: "A vinyl record",
  reqMessages: 20,
  reqDays: 14,
  windowAnchor: "start",
  minAccountAgeDays: null,
  startsAt: "2026-07-10T12:00:00.000Z",
  endsAt: "2026-07-17T12:00:00.000Z",
};

describe("formatEntryMessage", () => {
  it("includes the name in the title and the prize in the body", () => {
    const { title, body } = formatEntryMessage(base);
    expect(title).toContain("Summer Giveaway");
    expect(body).toContain("A vinyl record");
  });

  it("phrases the activity window for the 'start' anchor", () => {
    const { body } = formatEntryMessage({ ...base, windowAnchor: "start" });
    expect(body).toContain("at least 20 messages");
    expect(body).toContain("in the 14 days before the raffle starts");
  });

  it("phrases the activity window for the 'rolling' anchor", () => {
    const { body } = formatEntryMessage({ ...base, windowAnchor: "rolling" });
    expect(body).toContain("in the last 14 days");
    expect(body).not.toContain("before the raffle starts");
  });

  it("omits the account-age requirement when unset", () => {
    const { body } = formatEntryMessage({ ...base, minAccountAgeDays: null });
    expect(body.toLowerCase()).not.toContain("account");
  });

  it("includes the account-age requirement when set", () => {
    const { body } = formatEntryMessage({ ...base, minAccountAgeDays: 30 });
    expect(body).toContain("account at least 30 days old");
  });

  it("renders start and end times via Discord timestamp markup", () => {
    const { body } = formatEntryMessage(base);
    expect(body).toContain(discordTimestamp(base.startsAt!));
    expect(body).toContain(discordTimestamp(base.endsAt!));
  });

  it("badges a test raffle prize-free in the title and body", () => {
    const { title, body } = formatEntryMessage({ ...base, isTest: true });
    expect(title).toContain("🧪");
    expect(title).toContain("TEST");
    expect(body).toMatch(/no prize/i);
  });

  it("shows the normal ticket badge for a non-test raffle", () => {
    const { title } = formatEntryMessage({ ...base, isTest: false });
    expect(title).toContain("🎟️");
    expect(title).not.toContain("TEST");
  });

  it("invites everyone when there are no requirements", () => {
    const { body } = formatEntryMessage({
      ...base,
      reqMessages: null,
      reqDays: null,
      minAccountAgeDays: null,
    });
    expect(body).toMatch(/open to everyone/i);
  });
});

describe("formatClosedEntryMessage", () => {
  it("marks the raffle closed and keeps the prize", () => {
    const { title, body } = formatClosedEntryMessage({ name: "Summer Giveaway", prize: "A vinyl record" });
    expect(title).toContain("Summer Giveaway");
    expect(title).toContain("(closed)");
    expect(body).toContain("A vinyl record");
    expect(body).toMatch(/entries are now closed/i);
  });

  it("falls back to a default name and omits the prize line when unset", () => {
    const { title, body } = formatClosedEntryMessage({ name: null, prize: null });
    expect(title).toContain("Raffle");
    expect(body).not.toMatch(/prize/i);
  });

  it("badges a closed test raffle prize-free", () => {
    const { title, body } = formatClosedEntryMessage({ name: "Trial", prize: null, isTest: true });
    expect(title).toContain("🧪");
    expect(body).toMatch(/test raffle/i);
  });
});

describe("resolveAnnounceChannelId", () => {
  it("prefers the per-raffle override", () => {
    expect(resolveAnnounceChannelId("raffle-chan", "guild-chan")).toBe("raffle-chan");
  });

  it("falls back to the guild default", () => {
    expect(resolveAnnounceChannelId(null, "guild-chan")).toBe("guild-chan");
  });

  it("is null when neither is set", () => {
    expect(resolveAnnounceChannelId(null, null)).toBeNull();
  });
});
