import { describe, expect, it } from "vitest";
import {
  formatCommitmentPost,
  formatResultPost,
  formatRerollPost,
  formatWinnerAnnouncement,
} from "../../src/core/drawFormat.js";

const NOW = "2026-07-15T12:00:00.000Z";

describe("formatCommitmentPost", () => {
  it("publishes the entrant hash and commitment", () => {
    const post = formatCommitmentPost({
      raffleId: 7,
      raffleName: "Big One",
      entrantIds: ["a", "b"],
      entrantsHash: "HASH",
      commitment: "COMMIT",
      now: NOW,
    });
    expect(post).toContain("HASH");
    expect(post).toContain("COMMIT");
    expect(post).toContain("<@a>");
    expect(post).toContain("2"); // entrant count
  });
});

describe("formatResultPost", () => {
  it("reveals the secret and seed for verification", () => {
    const post = formatResultPost({
      raffleId: 7,
      raffleName: "Big One",
      winners: ["a"],
      entrantsHash: "HASH",
      commitment: "COMMIT",
      secret: "SECRET",
      seed: "SEED",
      now: NOW,
    });
    expect(post).toContain("SECRET");
    expect(post).toContain("SEED");
    expect(post).toContain("<@a>");
    // The published seed formula must state the exact colon-joined preimage
    // deriveSeed actually hashes, so a verifier recomputing it literally agrees.
    expect(post).toContain('SHA-256(hash + ":" + secret)');
  });

  it("states when there were no winners", () => {
    const post = formatResultPost({
      raffleId: 7,
      raffleName: null,
      winners: [],
      entrantsHash: "HASH",
      commitment: "COMMIT",
      secret: "SECRET",
      seed: "SEED",
      now: NOW,
    });
    expect(post).toContain("no eligible entrants");
  });
});

describe("formatRerollPost", () => {
  it("names the disqualified and replacement, never a reason", () => {
    const post = formatRerollPost({
      raffleId: 7,
      raffleName: "Big One",
      disqualified: "a",
      replacement: "b",
      now: NOW,
    });
    expect(post).toContain("<@a>");
    expect(post).toContain("<@b>");
  });

  it("handles no available replacement", () => {
    const post = formatRerollPost({
      raffleId: 7,
      raffleName: "Big One",
      disqualified: "a",
      replacement: null,
      now: NOW,
    });
    expect(post).toContain("no replacement available");
  });
});

describe("formatWinnerAnnouncement", () => {
  it("congratulates a single winner with the prize", () => {
    const msg = formatWinnerAnnouncement({
      raffleName: "Big One",
      prize: "A shirt",
      winners: ["a"],
    });
    expect(msg).toContain("Winner");
    expect(msg).toContain("<@a>");
    expect(msg).toContain("A shirt");
  });

  it("pluralizes for multiple winners", () => {
    const msg = formatWinnerAnnouncement({
      raffleName: "Big One",
      prize: null,
      winners: ["a", "b"],
    });
    expect(msg).toContain("Winners");
  });

  it("notes when there were no eligible entrants", () => {
    const msg = formatWinnerAnnouncement({ raffleName: "Big One", prize: null, winners: [] });
    expect(msg).toContain("no eligible entrants");
  });

  it("states a test raffle awards no prize and never quotes the prize text", () => {
    const msg = formatWinnerAnnouncement({
      raffleName: "Trial",
      prize: "A shirt",
      winners: ["a"],
      isTest: true,
    });
    expect(msg).toContain("🧪");
    expect(msg).toContain("<@a>");
    expect(msg).toMatch(/no prize is awarded/i);
    expect(msg).not.toContain("A shirt");
  });
});
