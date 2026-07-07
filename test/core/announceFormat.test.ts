import { describe, expect, it } from "vitest";
import {
  formatEntryMessage,
  resolveAnnounceChannelId,
  type EntryMessageInput,
} from "../../src/core/announceFormat.js";
import { discordTimestamp } from "../../src/core/time.js";

const base: EntryMessageInput = {
  name: "Summer Giveaway",
  prize: "A vinyl record",
  description: "Our yearly community giveaway.",
  reqMessages: 20,
  reqDays: 14,
  windowAnchor: "start",
  minAccountAgeDays: null,
  startsAt: "2026-07-10T12:00:00.000Z",
  endsAt: "2026-07-17T12:00:00.000Z",
  hostId: "host-1",
  entryCount: 7,
};

describe("formatEntryMessage — open card", () => {
  it("renders the heading, description, and detail stanza inside one blockquote", () => {
    const content = formatEntryMessage(base);
    expect(content).toContain("> ### 🎟️ Summer Giveaway");
    expect(content).toContain("> Our yearly community giveaway.");
    expect(content).toContain("> **Prize:** A vinyl record");
    expect(content).toContain("> **Hosted by:** <@host-1>");
    expect(content).toContain("> **Entries:** 7");
    // Every line stays quoted so the card renders unbroken.
    for (const line of content.split("\n")) {
      expect(line.startsWith(">")).toBe(true);
    }
  });

  it("shows the start absolute and the end as relative plus absolute", () => {
    const content = formatEntryMessage(base);
    expect(content).toContain(`**Starts:** ${discordTimestamp(base.startsAt!)}`);
    expect(content).toContain(`**Ends:** ${discordTimestamp(base.endsAt!, "R")}`);
    expect(content).toContain(discordTimestamp(base.endsAt!));
  });

  it("renders the requirements as subtext without the exact message count", () => {
    const content = formatEntryMessage({ ...base, windowAnchor: "start" });
    expect(content).toContain("> -# To enter, you must have been active");
    expect(content).toContain("in the 14 days before the raffle starts");
    // The exact count stays private so it cannot be gamed.
    expect(content).not.toContain("20");
    expect(content).not.toMatch(/message/i);
  });

  it("phrases the activity window for the 'rolling' anchor", () => {
    const content = formatEntryMessage({ ...base, windowAnchor: "rolling" });
    expect(content).toContain("active in the last 14 days");
    expect(content).not.toContain("before the raffle starts");
  });

  it("includes the account-age requirement only when set", () => {
    expect(formatEntryMessage({ ...base, minAccountAgeDays: 30 })).toContain(
      "account at least 30 days old",
    );
    expect(formatEntryMessage(base).toLowerCase()).not.toContain("account");
  });

  it("falls back to an open-to-everyone subtext with no requirements", () => {
    const content = formatEntryMessage({
      ...base,
      reqMessages: null,
      reqDays: null,
    });
    expect(content).toContain("-# Open to everyone");
  });

  it("omits the description and host lines when unset", () => {
    const content = formatEntryMessage({ ...base, description: null, hostId: null });
    expect(content).not.toContain("Hosted by");
    expect(content).not.toContain("community giveaway");
  });

  it("badges a test raffle prize-free", () => {
    const content = formatEntryMessage({ ...base, isTest: true });
    expect(content).toContain("🧪");
    expect(content).toContain("(TEST)");
    expect(content).toMatch(/no prize/i);
  });
});

describe("formatEntryMessage — closed and drawn cards", () => {
  it("closed: marks the title, switches to Ended, and drops the requirements", () => {
    const content = formatEntryMessage(base, { phase: "closed" });
    expect(content).toContain("Summer Giveaway (closed)");
    expect(content).toContain(`**Ended:** ${discordTimestamp(base.endsAt!, "R")}`);
    expect(content).not.toContain("**Starts:**");
    expect(content).not.toContain("To enter");
    expect(content).toContain("winner will be announced shortly");
  });

  it("drawn: replaces the closed notice with the winner mentions", () => {
    const content = formatEntryMessage(base, { phase: "drawn", winnerIds: ["w1"] });
    expect(content).toContain("**Winner:** <@w1>");
    expect(content).not.toContain("announced shortly");

    const two = formatEntryMessage(base, { phase: "drawn", winnerIds: ["w1", "w2"] });
    expect(two).toContain("**Winners:** <@w1>, <@w2>");
  });

  it("drawn with no winners states so", () => {
    const content = formatEntryMessage(base, { phase: "drawn", winnerIds: [] });
    expect(content).toContain("**No winner**");
  });
});

describe("resolveAnnounceChannelId", () => {
  it("prefers the raffle's own channel and falls back to the guild default", () => {
    expect(resolveAnnounceChannelId("r-chan", "g-chan")).toBe("r-chan");
    expect(resolveAnnounceChannelId(null, "g-chan")).toBe("g-chan");
    expect(resolveAnnounceChannelId(null, null)).toBeNull();
  });
});
