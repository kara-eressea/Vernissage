import { describe, expect, it } from "vitest";
import { isChannelCounted, type ChannelRule } from "../../src/core/messageCounting.js";

describe("isChannelCounted", () => {
  it("counts every channel when there are no rules", () => {
    expect(isChannelCounted("c1", [])).toBe(true);
  });

  it("excludes a channel that has an exclude rule", () => {
    const rules: ChannelRule[] = [{ channelId: "c1", mode: "exclude" }];
    expect(isChannelCounted("c1", rules)).toBe(false);
    expect(isChannelCounted("c2", rules)).toBe(true);
  });

  it("acts as an allowlist when any include rule exists", () => {
    const rules: ChannelRule[] = [{ channelId: "c1", mode: "include" }];
    expect(isChannelCounted("c1", rules)).toBe(true);
    expect(isChannelCounted("c2", rules)).toBe(false);
  });

  it("lets an exclude override an include for the same channel", () => {
    const rules: ChannelRule[] = [
      { channelId: "c1", mode: "include" },
      { channelId: "c1", mode: "exclude" },
    ];
    expect(isChannelCounted("c1", rules)).toBe(false);
  });

  it("supports an allowlist with additional excludes", () => {
    const rules: ChannelRule[] = [
      { channelId: "c1", mode: "include" },
      { channelId: "c2", mode: "include" },
      { channelId: "c3", mode: "exclude" },
    ];
    expect(isChannelCounted("c1", rules)).toBe(true);
    expect(isChannelCounted("c2", rules)).toBe(true);
    expect(isChannelCounted("c3", rules)).toBe(false);
    expect(isChannelCounted("c4", rules)).toBe(false);
  });
});
