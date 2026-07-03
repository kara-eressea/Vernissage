import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "../../src/discord/commands/index.js";
import { routeInteraction, selectCommand } from "../../src/discord/router.js";

// The router logs handler errors via console.error; keep that out of test output.
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A minimal fake command with a spyable execute. */
function fakeCommand(name: string, execute = vi.fn().mockResolvedValue(undefined)): Command {
  return {
    data: { name, toJSON: () => ({ name }) as never },
    execute,
  };
}

/** A minimal fake interaction covering only what the router touches. */
function fakeInteraction(
  commandName: string,
  state: { replied?: boolean; deferred?: boolean } = {},
): ChatInputCommandInteraction & {
  reply: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
} {
  return {
    commandName,
    replied: state.replied ?? false,
    deferred: state.deferred ?? false,
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChatInputCommandInteraction & {
    reply: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
  };
}

describe("selectCommand", () => {
  const commands = [fakeCommand("enter"), fakeCommand("status")];

  it("finds a registered command by name", () => {
    expect(selectCommand("status", commands)?.data.name).toBe("status");
  });

  it("returns undefined for an unknown command", () => {
    expect(selectCommand("nope", commands)).toBeUndefined();
  });
});

describe("routeInteraction", () => {
  it("dispatches to the matching command", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const commands = [fakeCommand("enter", execute)];
    const interaction = fakeInteraction("enter");

    await routeInteraction(interaction, commands);

    expect(execute).toHaveBeenCalledOnce();
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("replies ephemerally for an unknown command", async () => {
    const interaction = fakeInteraction("ghost");
    await routeInteraction(interaction, []);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
  });

  it("replies with an error when the handler throws before replying", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("boom"));
    const commands = [fakeCommand("enter", execute)];
    const interaction = fakeInteraction("enter");

    await routeInteraction(interaction, commands);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it("follows up with an error when the handler already replied", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("boom"));
    const commands = [fakeCommand("enter", execute)];
    const interaction = fakeInteraction("enter", { replied: true });

    await routeInteraction(interaction, commands);

    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
  });
});
