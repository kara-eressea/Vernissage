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

// Golden vectors: pin the exact output for a fixed seed. The other tests check
// the draw against itself and would stay green if seedIndex or the seed
// derivation regressed (modulo bias, endianness, wrong base, changed
// concatenation). These lock the concrete bytes an independent verifier would
// reproduce from public data. Regenerate deliberately only if the scheme
// changes — and update design.md in the same commit.
describe("draw golden vectors", () => {
  it("deriveSeed / nextSeed produce known hex", () => {
    const s = deriveSeed("abc", "rand");
    expect(s).toBe(
      "9fc29f2a41a012d35610d401c97bbc09db61812d43c887ceaecbb6c026c2b95b",
    );
    expect(nextSeed(s)).toBe(
      "8d378a82adef77121596b9668fb57680e4284e27ae1ea3e5f69c6db113ad027f",
    );
  });

  it("selectWinners maps a fixed seed to known winners in order", () => {
    const entrants = ["a", "b", "c", "d", "e"];
    const seed = deriveSeed(hashEntrants(entrants), "round-42");
    expect(seed).toBe(
      "8ec0c9b155c345b67f0653861504d5ea51ec4e5a75c53a8bb5c1b824e6fa8b4c",
    );
    expect(selectWinners(entrants, seed, 1)).toEqual(["a"]);
    expect(selectWinners(entrants, seed, 3)).toEqual(["a", "b", "d"]);
    // Draining all five exercises the collision-skip path and pins its order.
    expect(selectWinners(entrants, seed, 5)).toEqual(["a", "b", "d", "c", "e"]);
  });
});
