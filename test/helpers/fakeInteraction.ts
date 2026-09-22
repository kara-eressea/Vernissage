import type { AutocompleteInteraction, ChatInputCommandInteraction } from "discord.js";
import { vi } from "vitest";

/** What a fake slash-command interaction needs to stand in for the real thing. */
export interface FakeChatInputOpts {
  subcommand?: string;
  /** Option name -> value; every getX reads from here (undefined -> null, or throws if required). */
  values?: Record<string, unknown>;
  /** null models a DM (no guild); undefined defaults to "g1". */
  guildId?: string | null;
  userId?: string;
  ownerId?: string;
  roleIds?: string[];
  manageGuild?: boolean;
  /** The bot's own guild member (guild.members.me); undefined models it unresolved. */
  botMember?: unknown;
}

/** A fake ChatInputCommandInteraction with spyable reply/showModal and all option getters. */
export type FakeChatInput = ChatInputCommandInteraction & {
  reply: ReturnType<typeof vi.fn>;
  showModal: ReturnType<typeof vi.fn>;
};

/**
 * Build a fake slash-command interaction covering the fields the command
 * handlers and the moderator gate read: guild/user identity, the member's roles
 * and Manage-Server permission, and every option getter (all backed by
 * `opts.values`). Per-command tests wrap this with their own defaults.
 */
export function fakeChatInput(opts: FakeChatInputOpts = {}): FakeChatInput {
  const values = opts.values ?? {};
  const get = (name: string, required?: boolean): unknown => {
    const v = values[name];
    if (v === undefined) {
      if (required) throw new Error(`missing required option ${name}`);
      return null;
    }
    return v;
  };
  return {
    guildId: opts.guildId === undefined ? "g1" : opts.guildId,
    user: { id: opts.userId ?? "u1" },
    guild: { ownerId: opts.ownerId ?? "owner", members: { me: opts.botMember ?? null } },
    member: { roles: { cache: new Map((opts.roleIds ?? []).map((r) => [r, {}])) } },
    memberPermissions: { has: () => opts.manageGuild ?? false },
    isChatInputCommand: () => true,
    isModalSubmit: () => false,
    options: {
      getSubcommand: () => opts.subcommand,
      getInteger: (name: string, required?: boolean) => get(name, required),
      getString: (name: string, required?: boolean) => get(name, required),
      getUser: (name: string, required?: boolean) => get(name, required),
      getChannel: (name: string, required?: boolean) => get(name, required),
      getRole: (name: string, required?: boolean) => get(name, required),
      getBoolean: (name: string, required?: boolean) => get(name, required),
    },
    reply: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
  } as unknown as FakeChatInput;
}

/** What a fake autocomplete interaction needs to stand in for the real thing. */
export interface FakeAutocompleteOpts {
  commandName?: string;
  subcommand?: string | null;
  /** The option being typed in, and what has been typed so far. */
  focused?: { name: string; value: string };
  guildId?: string | null;
  userId?: string;
  ownerId?: string;
  roleIds?: string[];
  manageGuild?: boolean;
}

/** A fake AutocompleteInteraction with a spyable `respond`. */
export type FakeAutocomplete = AutocompleteInteraction & { respond: ReturnType<typeof vi.fn> };

/**
 * Build a fake autocomplete interaction covering what the picker reads: which
 * command and subcommand is being typed, which option has focus and its current
 * text, and the caller's moderator standing (the moderator surface withholds
 * suggestions from members).
 */
export function fakeAutocomplete(opts: FakeAutocompleteOpts = {}): FakeAutocomplete {
  const focused = opts.focused ?? { name: "raffle", value: "" };
  return {
    commandName: opts.commandName ?? "raffle",
    guildId: opts.guildId === undefined ? "g1" : opts.guildId,
    user: { id: opts.userId ?? "u1" },
    guild: { ownerId: opts.ownerId ?? "owner" },
    member: { roles: { cache: new Map((opts.roleIds ?? []).map((r) => [r, {}])) } },
    memberPermissions: { has: () => opts.manageGuild ?? false },
    options: {
      getFocused: () => focused,
      getSubcommand: () => (opts.subcommand === undefined ? "enter" : opts.subcommand),
    },
    respond: vi.fn().mockResolvedValue(undefined),
  } as unknown as FakeAutocomplete;
}
