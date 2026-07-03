import { describe, expect, it } from "vitest";
import {
  buildEnterButtonId,
  parseEnterButtonId,
} from "../../src/discord/components/enterButton.js";

describe("enter button custom id", () => {
  it("round-trips build and parse", () => {
    expect(buildEnterButtonId(42)).toBe("raffle:enter:42");
    expect(parseEnterButtonId("raffle:enter:42")).toBe(42);
  });

  it("returns null for malformed or foreign ids", () => {
    expect(parseEnterButtonId("raffle:enter")).toBeNull();
    expect(parseEnterButtonId("wiz:basics:submit:1")).toBeNull();
    expect(parseEnterButtonId("raffle:cancel:1")).toBeNull();
    expect(parseEnterButtonId("raffle:enter:notanumber")).toBeNull();
  });
});
