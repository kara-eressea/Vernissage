import { describe, expect, it } from "vitest";
import {
  MAX_CHOICES,
  matchesQuery,
  raffleChoices,
  raffleLabel,
  type ChoosableRaffle,
} from "../../src/core/raffleChoices.js";

/**
 * The raffle-id picker's contents (issue #48). Two things matter here: the
 * member can find the raffle they mean by typing what they know, and the
 * response cannot breach Discord's limits — an over-long label or a 26th choice
 * is rejected wholesale at the API, which shows up as a picker that silently
 * never appears.
 */

function raffle(over: Partial<ChoosableRaffle> = {}): ChoosableRaffle {
  return { raffle_id: 1, name: "Vinyl giveaway", status: "open", ...over };
}

describe("raffleLabel", () => {
  it("leads with the id and names the status", () => {
    expect(raffleLabel(raffle({ raffle_id: 42 }))).toBe("#42 · Vinyl giveaway (open)");
  });

  it("marks a test raffle, so it is not mistaken for a live one", () => {
    expect(raffleLabel(raffle({ is_test: 1 }))).toContain("(open, test)");
  });

  it("falls back to 'unnamed' for a raffle with no name yet", () => {
    expect(raffleLabel(raffle({ name: null, status: "draft" }))).toBe("#1 · unnamed (draft)");
    expect(raffleLabel(raffle({ name: "   " }))).toContain("unnamed");
  });

  it("truncates a label that would breach Discord's 100-character limit", () => {
    const label = raffleLabel(raffle({ name: "x".repeat(200) }));
    expect(label.length).toBeLessThanOrEqual(100);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("matchesQuery", () => {
  it("matches everything on an empty query — the first keystroke shows what there is", () => {
    expect(matchesQuery(raffle(), "")).toBe(true);
    expect(matchesQuery(raffle(), "   ")).toBe(true);
  });

  it("matches the name case-insensitively, anywhere in it", () => {
    expect(matchesQuery(raffle(), "vinyl")).toBe(true);
    expect(matchesQuery(raffle(), "GIVEAWAY")).toBe(true);
    expect(matchesQuery(raffle(), "cassette")).toBe(false);
  });

  it("matches an id by prefix, so typing 4 does not surface 14 and 24", () => {
    expect(matchesQuery(raffle({ raffle_id: 4, name: null }), "4")).toBe(true);
    expect(matchesQuery(raffle({ raffle_id: 14, name: null }), "4")).toBe(false);
    expect(matchesQuery(raffle({ raffle_id: 142, name: null }), "14")).toBe(true);
  });

  it("tolerates a leading # on an id, since the labels show one", () => {
    expect(matchesQuery(raffle({ raffle_id: 42, name: null }), "#42")).toBe(true);
  });

  it("does not match an unnamed raffle on a name query", () => {
    expect(matchesQuery(raffle({ name: null }), "vinyl")).toBe(false);
  });
});

describe("raffleChoices", () => {
  it("returns id-valued choices, newest first", () => {
    const choices = raffleChoices(
      [raffle({ raffle_id: 1 }), raffle({ raffle_id: 7 }), raffle({ raffle_id: 3 })],
      "",
    );
    expect(choices.map((c) => c.value)).toEqual([7, 3, 1]);
  });

  it("caps the response at Discord's limit", () => {
    const many = Array.from({ length: 60 }, (_, i) => raffle({ raffle_id: i + 1 }));
    const choices = raffleChoices(many, "");
    expect(choices).toHaveLength(MAX_CHOICES);
    // The cap keeps the newest, not an arbitrary 25.
    expect(choices[0]!.value).toBe(60);
  });

  it("filters to the query before capping", () => {
    const choices = raffleChoices(
      [raffle({ raffle_id: 1, name: "Vinyl" }), raffle({ raffle_id: 2, name: "Poster" })],
      "poster",
    );
    expect(choices).toEqual([{ name: "#2 · Poster (open)", value: 2 }]);
  });

  it("returns an empty list rather than everything when nothing matches", () => {
    expect(raffleChoices([raffle()], "nothing like this")).toEqual([]);
  });
});
