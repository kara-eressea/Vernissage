import { type Message } from "discord.js";
import { describe, expect, it } from "vitest";
import {
  isCountableMessage,
  resolveCountedChannelId,
} from "../../src/discord/messageCounter.js";

/** Build a fake Message with only the fields the helpers read. */
function fakeMessage(overrides: {
  inGuild?: boolean;
  system?: boolean;
  bot?: boolean;
  webhookId?: string | null;
  channelId?: string;
  thread?: { parentId: string | null } | null;
}): Message {
  const isThread = overrides.thread !== undefined && overrides.thread !== null;
  return {
    inGuild: () => overrides.inGuild ?? true,
    system: overrides.system ?? false,
    author: { bot: overrides.bot ?? false, id: "u1" },
    webhookId: overrides.webhookId ?? null,
    channelId: overrides.channelId ?? "chan",
    channel: {
      isThread: () => isThread,
      parentId: isThread ? (overrides.thread as { parentId: string | null }).parentId : null,
    },
  } as unknown as Message;
}

describe("isCountableMessage", () => {
  it("counts a normal guild message from a human", () => {
    expect(isCountableMessage(fakeMessage({}))).toBe(true);
  });

  it("ignores non-guild messages", () => {
    expect(isCountableMessage(fakeMessage({ inGuild: false }))).toBe(false);
  });

  it("ignores system messages (boosts, join notices)", () => {
    expect(isCountableMessage(fakeMessage({ system: true }))).toBe(false);
  });

  it("ignores bot and webhook messages", () => {
    expect(isCountableMessage(fakeMessage({ bot: true }))).toBe(false);
    expect(isCountableMessage(fakeMessage({ webhookId: "wh1" }))).toBe(false);
  });
});

describe("resolveCountedChannelId", () => {
  it("uses the channel id for a normal message", () => {
    expect(resolveCountedChannelId(fakeMessage({ channelId: "c1" }))).toBe("c1");
  });

  it("resolves a thread to its parent channel", () => {
    const message = fakeMessage({ channelId: "t9", thread: { parentId: "c1" } });
    expect(resolveCountedChannelId(message)).toBe("c1");
  });

  it("falls back to the thread id when it has no parent", () => {
    const message = fakeMessage({ channelId: "t9", thread: { parentId: null } });
    expect(resolveCountedChannelId(message)).toBe("t9");
  });
});
