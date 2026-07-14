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
  openToAll: false,
  reqMessages: 20,
  reqActiveDays: null,
  reqDays: 14,
  minAccountAgeDays: null,
  minServerAgeDays: null,
  startsAt: "2026-07-10T12:00:00.000Z",
  endsAt: "2026-07-17T12:00:00.000Z",
  cooldownDays: null,
  cooldownCount: null,
  excludePriorWinners: false,
  hostId: "host-1",
  entryCount: 7,
};

describe("formatEntryMessage — open card", () => {
  it("renders the heading, description, and detail stanza inside one blockquote", () => {
    const content = formatEntryMessage(base);
    // ">>> " quotes the whole message as one block — including blank separator
    // lines, which per-line "> " cannot do (a bare ">" renders literally).
    expect(content.startsWith(">>> ### 🎟️ Summer Giveaway")).toBe(true);
    expect(content).toContain("Our yearly community giveaway.");
    expect(content).toContain("**Prize:** A vinyl record");
    expect(content).toContain("**Hosted by:** <@host-1>");
    expect(content).toContain("**Entries:** 7");
    expect(content.split("\n")).not.toContain(">"); // no literal '>' lines
  });

  it("shows the start absolute and the end as relative plus absolute", () => {
    const content = formatEntryMessage(base);
    expect(content).toContain(`**Starts:** ${discordTimestamp(base.startsAt!)}`);
    expect(content).toContain(`**Ends:** ${discordTimestamp(base.endsAt!, "R")}`);
    expect(content).toContain(discordTimestamp(base.endsAt!));
  });

  it("renders the requirements as subtext without the exact message count", () => {
    const content = formatEntryMessage(base);
    expect(content).toContain("-# To enter, you must have been active");
    expect(content).toContain("in the 14 days before the raffle starts");
    // The exact count stays private so it cannot be gamed.
    expect(content).not.toContain("20");
    expect(content).not.toMatch(/message/i);
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

  it("states the winner cooldown exactly (non-gameable)", () => {
    expect(formatEntryMessage({ ...base, cooldownDays: 30 })).toContain(
      "-# Recent winners must wait 30 days before entering again.",
    );
    expect(formatEntryMessage({ ...base, cooldownDays: 30, cooldownCount: 2 })).toContain(
      "wait 30 days and sit out the next 2 raffles",
    );
  });

  it("states the prior-winner bar, which overrides the cooldown line", () => {
    const content = formatEntryMessage({
      ...base,
      excludePriorWinners: true,
      cooldownDays: 30,
    });
    expect(content).toContain("-# Members who have won a raffle here before cannot enter");
    expect(content).not.toContain("Recent winners");
  });

  it("states the server-tenure requirement exactly (non-gameable)", () => {
    expect(formatEntryMessage({ ...base, minServerAgeDays: 7 })).toContain(
      "have been in the server at least 7 days",
    );
  });

  it("open-to-everyone replaces the requirement subtext entirely", () => {
    const content = formatEntryMessage({
      ...base,
      openToAll: true,
      minAccountAgeDays: 30,
      cooldownDays: 30,
    });
    expect(content).toContain("-# Open to everyone — press Enter to join.");
    expect(content).not.toContain("To enter, you must");
    expect(content).not.toContain("Recent winners");
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
