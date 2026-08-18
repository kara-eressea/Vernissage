import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DroppedMessageWatch,
  isCountableRawMessage,
} from "../../src/discord/droppedMessages.js";

const ALLOWED = new Set(["g1"]);

/** A raw MESSAGE_CREATE dispatch with the fields the watchdog reads. */
function packet(overrides: Record<string, unknown> = {}): { t: string; d: unknown } {
  return {
    t: "MESSAGE_CREATE",
    d: {
      channel_id: "t9",
      guild_id: "g1",
      type: 0,
      author: { id: "u1" },
      ...overrides,
    },
  };
}

describe("isCountableRawMessage", () => {
  it("accepts a normal guild message in an allowlisted guild", () => {
    expect(isCountableRawMessage(packet().d as never, ALLOWED)).toBe(true);
  });

  it("accepts a reply (a non-system message type)", () => {
    expect(isCountableRawMessage(packet({ type: 19 }).d as never, ALLOWED)).toBe(true);
  });

  it("ignores system messages like joins and boosts", () => {
    expect(isCountableRawMessage(packet({ type: 7 }).d as never, ALLOWED)).toBe(false);
  });

  it("ignores bots and webhooks", () => {
    expect(isCountableRawMessage(packet({ author: { id: "b", bot: true } }).d as never, ALLOWED)).toBe(false);
    expect(isCountableRawMessage(packet({ webhook_id: "w1" }).d as never, ALLOWED)).toBe(false);
  });

  it("ignores guilds off the allowlist and DMs", () => {
    expect(isCountableRawMessage(packet({ guild_id: "other" }).d as never, ALLOWED)).toBe(false);
    expect(isCountableRawMessage(packet({ guild_id: undefined }).d as never, ALLOWED)).toBe(false);
  });
});

describe("DroppedMessageWatch", () => {
  let cached: Set<string>;
  let fetched: string[];
  let fetchChannel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    cached = new Set(["c1"]);
    fetched = [];
    fetchChannel = vi.fn(async (id: string) => {
      fetched.push(id);
      // Fetching a channel caches it, exactly as discord.js does.
      cached.add(id);
      return {};
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  const makeWatch = (): DroppedMessageWatch =>
    new DroppedMessageWatch(ALLOWED, (id) => cached.has(id), fetchChannel);

  it("says nothing about a message in a cached channel", async () => {
    const watch = makeWatch();
    expect(await watch.handle(packet({ channel_id: "c1" }))).toBe(false);
    expect(watch.stats().dropped).toBe(0);
    expect(fetchChannel).not.toHaveBeenCalled();
  });

  it("records a message whose channel discord.js has not cached", async () => {
    const watch = makeWatch();
    expect(await watch.handle(packet({ channel_id: "t9" }))).toBe(true);
    expect(watch.stats()).toEqual({ dropped: 1, channels: 1, unrecovered: 0 });
  });

  it("fetches the uncached channel so later messages there are delivered", async () => {
    const watch = makeWatch();
    await watch.handle(packet({ channel_id: "t9" }));
    expect(fetched).toEqual(["t9"]);
    // The fetch cached it, so the next message is no longer a drop.
    expect(await watch.handle(packet({ channel_id: "t9" }))).toBe(false);
    expect(watch.stats().dropped).toBe(1);
  });

  it("attempts the recovery fetch once per channel, even if it keeps dropping", async () => {
    cached = new Set();
    fetchChannel = vi.fn(async () => ({})); // resolves but caches nothing
    const watch = makeWatch();
    await watch.handle(packet({ channel_id: "t9" }));
    await watch.handle(packet({ channel_id: "t9" }));
    await watch.handle(packet({ channel_id: "t9" }));
    expect(fetchChannel).toHaveBeenCalledTimes(1);
    expect(watch.stats()).toEqual({ dropped: 3, channels: 1, unrecovered: 0 });
  });

  it("records a channel it cannot fetch and does not retry it", async () => {
    fetchChannel = vi.fn(async () => {
      throw new Error("Missing Access");
    });
    const watch = makeWatch();
    await watch.handle(packet({ channel_id: "t9" }));
    await watch.handle(packet({ channel_id: "t9" }));
    expect(fetchChannel).toHaveBeenCalledTimes(1);
    expect(watch.stats().unrecovered).toBe(1);
  });

  it("ignores dispatches that are not message creations", async () => {
    const watch = makeWatch();
    expect(await watch.handle({ t: "TYPING_START", d: { channel_id: "t9" } })).toBe(false);
    expect(await watch.handle({ t: null, d: {} })).toBe(false);
    expect(watch.stats().dropped).toBe(0);
  });

  it("summarises only when something has dropped", async () => {
    const watch = makeWatch();
    expect(watch.summary()).toBeNull();
    await watch.handle(packet({ channel_id: "t9" }));
    await watch.handle(packet({ channel_id: "t8" }));
    expect(watch.summary()).toContain("2 message(s) across 2 channel(s)");
  });
});
