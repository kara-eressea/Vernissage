import { describe, expect, it } from "vitest";
import { generateToken, normalizeToken } from "../../src/core/friendlyToken.js";

/** A deterministic rng that replays a fixed list of values, then holds the last. */
function seq(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

describe("generateToken", () => {
  it("renders an adjective-noun-NNNN phrase", () => {
    const token = generateToken(seq([0, 0, 0]));
    expect(token).toMatch(/^[a-z]+-[a-z]+-\d{4}$/);
  });

  it("maps rng 0 to the first words and the lowest number", () => {
    const token = generateToken(seq([0, 0, 0]));
    const [, , num] = token.split("-");
    expect(num).toBe("1000");
  });

  it("keeps the numeric suffix in the 1000–9999 range", () => {
    // rng just below 1 selects the top of every range.
    const token = generateToken(seq([0.999999, 0.999999, 0.999999]));
    const num = Number(token.split("-")[2]);
    expect(num).toBeGreaterThanOrEqual(1000);
    expect(num).toBeLessThanOrEqual(9999);
  });

  it("varies with the rng so distinct draws differ", () => {
    const a = generateToken(seq([0.1, 0.2, 0.3]));
    const b = generateToken(seq([0.6, 0.7, 0.8]));
    expect(a).not.toBe(b);
  });

  it("defaults to Math.random and still produces a valid shape", () => {
    expect(generateToken()).toMatch(/^[a-z]+-[a-z]+-\d{4}$/);
  });
});

describe("normalizeToken", () => {
  it("lowercases, trims, and hyphenates whitespace", () => {
    expect(normalizeToken("  Gentle Harbor 4821 ")).toBe("gentle-harbor-4821");
  });

  it("collapses mixed spaces and hyphens", () => {
    expect(normalizeToken("gentle -  harbor--4821")).toBe("gentle-harbor-4821");
  });

  it("leaves an already-canonical token unchanged", () => {
    expect(normalizeToken("gentle-harbor-4821")).toBe("gentle-harbor-4821");
  });
});
