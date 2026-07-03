import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deriveSeed,
  hashEntrants,
  nextSeed,
  selectWinners,
} from "../../src/core/draw.js";

describe("hashEntrants", () => {
  it("is independent of input order", () => {
    expect(hashEntrants(["3", "1", "2"])).toBe(hashEntrants(["1", "2", "3"]));
  });

  it("matches an independent SHA-256 of the sorted, newline-joined ids", () => {
    const ids = ["200", "100"];
    const expected = createHash("sha256").update("100\n200", "utf8").digest("hex");
    expect(hashEntrants(ids)).toBe(expected);
  });

  it("changes when the entrant set changes", () => {
    expect(hashEntrants(["1", "2"])).not.toBe(hashEntrants(["1", "2", "3"]));
  });
});

describe("deriveSeed", () => {
  it("is deterministic for the same inputs", () => {
    expect(deriveSeed("abc", "rand")).toBe(deriveSeed("abc", "rand"));
  });

  it("depends on both the entrant hash and the randomness", () => {
    expect(deriveSeed("abc", "rand")).not.toBe(deriveSeed("abd", "rand"));
    expect(deriveSeed("abc", "rand")).not.toBe(deriveSeed("abc", "r2"));
  });
});

describe("selectWinners", () => {
  const entrants = ["a", "b", "c", "d", "e"];
  const seed = deriveSeed(hashEntrants(entrants), "round-42");

  it("returns no winners for an empty entrant list", () => {
    expect(selectWinners([], seed, 1)).toEqual([]);
  });

  it("returns no winners when winnerCount is non-positive", () => {
    expect(selectWinners(entrants, seed, 0)).toEqual([]);
  });

  it("is deterministic: same seed yields the same winner", () => {
    expect(selectWinners(entrants, seed, 1)).toEqual(
      selectWinners(entrants, seed, 1),
    );
  });

  it("selects a winner that is actually an entrant", () => {
    const [winner] = selectWinners(entrants, seed, 1);
    expect(entrants).toContain(winner);
  });

  it("selects distinct winners for multi-winner draws", () => {
    const winners = selectWinners(entrants, seed, 3);
    expect(winners).toHaveLength(3);
    expect(new Set(winners).size).toBe(3);
  });

  it("caps at the entrant count when asked for more winners than entrants", () => {
    const winners = selectWinners(entrants, seed, 99);
    expect(winners).toHaveLength(entrants.length);
    expect(new Set(winners).size).toBe(entrants.length);
  });

  it("shares its prefix with a larger draw (iterated seed, stable order)", () => {
    // The first winner of a 3-winner draw is the sole winner of a 1-winner draw.
    expect(selectWinners(entrants, seed, 3)[0]).toBe(
      selectWinners(entrants, seed, 1)[0],
    );
  });

  it("reroll uses the next seed iteration and stays verifiable", () => {
    // Disqualify the first winner: reroll draws from the next seed, excluding
    // the disqualified id. The result must be reproducible from public data.
    const first = selectWinners(entrants, seed, 1)[0]!;
    const remaining = entrants.filter((e) => e !== first);
    const rerolled = selectWinners(remaining, nextSeed(seed), 1);
    expect(rerolled).toEqual(selectWinners(remaining, nextSeed(seed), 1));
    expect(remaining).toContain(rerolled[0]);
  });
});

describe("nextSeed", () => {
  it("is deterministic and advances the seed", () => {
    const s = deriveSeed("h", "r");
    expect(nextSeed(s)).toBe(nextSeed(s));
    expect(nextSeed(s)).not.toBe(s);
  });
});
