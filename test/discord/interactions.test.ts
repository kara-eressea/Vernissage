import { MessageFlags } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInteractionRouter,
  customIdNamespace,
  type CustomIdInteraction,
} from "../../src/discord/interactions.js";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeInteraction(
  customId: string,
  state: { replied?: boolean; deferred?: boolean } = {},
): CustomIdInteraction & { reply: ReturnType<typeof vi.fn>; followUp: ReturnType<typeof vi.fn> } {
  return {
    customId,
    replied: state.replied ?? false,
    deferred: state.deferred ?? false,
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
  };
}

describe("customIdNamespace", () => {
  it("takes the segment before the first colon", () => {
    expect(customIdNamespace("wiz:schedule:submit:42")).toBe("wiz");
    expect(customIdNamespace("enter")).toBe("enter");
  });
});

describe("interaction router", () => {
  it("dispatches to the handler registered for the namespace", async () => {
    const router = createInteractionRouter();
    const handler = vi.fn().mockResolvedValue(undefined);
    router.register("wiz", handler);

    const interaction = fakeInteraction("wiz:basics:submit:1");
    const handled = await router.route(interaction);

    expect(handled).toBe(true);
    expect(handler).toHaveBeenCalledWith(interaction);
  });

  it("returns false for an unregistered namespace", async () => {
    const router = createInteractionRouter();
    expect(await router.route(fakeInteraction("mystery:thing"))).toBe(false);
  });

  it("replies ephemerally when a handler throws", async () => {
    const router = createInteractionRouter();
    router.register("wiz", vi.fn().mockRejectedValue(new Error("boom")));

    const interaction = fakeInteraction("wiz:basics:submit:1");
    await router.route(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
  });

  it("follows up when the handler already replied before throwing", async () => {
    const router = createInteractionRouter();
    router.register("wiz", vi.fn().mockRejectedValue(new Error("boom")));

    const interaction = fakeInteraction("wiz:basics:submit:1", { replied: true });
    await router.route(interaction);

    expect(interaction.followUp).toHaveBeenCalled();
  });
});
