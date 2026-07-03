import { describe, expect, it } from "vitest";
import { channelMention, userMention } from "../../src/core/format.js";

describe("mentions", () => {
  it("renders a user mention", () => {
    expect(userMention("123")).toBe("<@123>");
  });

  it("renders a channel mention", () => {
    expect(channelMention("456")).toBe("<#456>");
  });
});
