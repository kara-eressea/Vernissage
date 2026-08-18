import { describe, expect, it } from "vitest";
import {
  isChannelCounted,
  ruleChannelId,
  type ChannelRule,
} from "../../src/core/messageCounting.js";

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

describe("ruleChannelId", () => {
  it("keys a rule on the channel itself when it is not a thread", () => {
    expect(ruleChannelId({ id: "c1", isThread: false, parentId: null })).toBe("c1");
  });

  it("keys a thread's rule on its parent channel", () => {
    expect(ruleChannelId({ id: "t9", isThread: true, parentId: "c1" })).toBe("c1");
  });

  it("falls back to the thread's own id when it has no parent", () => {
    expect(ruleChannelId({ id: "t9", isThread: true, parentId: null })).toBe("t9");
  });

  it("agrees with the counting rules: a thread counts under its parent's rule", () => {
    const rules = [{ channelId: "c1", mode: "include" as const }];
    // A rule stored on the parent governs the thread...
    expect(isChannelCounted(ruleChannelId({ id: "t9", isThread: true, parentId: "c1" }), rules)).toBe(true);
    // ...whereas one stored against the thread's own id would match nothing,
    // which is why /raffle config channels resolves a picked thread to its parent.
    const threadRule = [{ channelId: "t9", mode: "include" as const }];
    expect(isChannelCounted(ruleChannelId({ id: "t9", isThread: true, parentId: "c1" }), threadRule)).toBe(false);
  });
});
