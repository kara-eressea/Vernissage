import type { ChatInputCommandInteraction } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import type { BotConfig } from "../../../src/config.js";
import { openDb } from "../../../src/db/index.js";
import {
  listChannelRules,
  setChannelRule,
} from "../../../src/db/repositories/countedChannels.js";
import {
  getGuild,
  getHourlyCap,
  setGuildConfig,
} from "../../../src/db/repositories/guilds.js";
import { handleConfig } from "../../../src/discord/commands/raffle/config.js";
import type { CommandContext } from "../../../src/discord/commands/index.js";

let db: Database;
let ctx: CommandContext;

beforeEach(() => {
  db = openDb(":memory:");
  ctx = {
    db,
    config: {} as BotConfig,
    notifier: {
      resolveAuditChannel: async () => undefined,
      mirrorAudit: async () => undefined,
      postEntryMessage: async () => undefined,
      postAudit: async () => undefined,
      postAnnouncement: async () => undefined,
    },
  };
});

afterEach(() => {
  db.close();
});

/** Count audit rows written so far (no list-all helper exists on the repo). */
function auditRows(): Array<{ event_type: string; actor_id: string | null }> {
  return db.prepare(`SELECT event_type, actor_id FROM audit_log`).all() as Array<{
    event_type: string;
    actor_id: string | null;
  }>;
}

interface FakeOpts {
  guildId?: string | null;
  userId?: string;
  ownerId?: string;
  roleIds?: string[];
  manageGuild?: boolean;
  subcommand: string;
  values?: Record<string, unknown>;
}

/** A fake ChatInputCommandInteraction covering only what the config handlers read. */
function fakeInteraction(opts: FakeOpts): ChatInputCommandInteraction & {
  reply: ReturnType<typeof vi.fn>;
} {
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
    guild: { ownerId: opts.ownerId ?? "owner" },
    member: { roles: { cache: new Map((opts.roleIds ?? []).map((r) => [r, {}])) } },
    memberPermissions: { has: () => opts.manageGuild ?? false },
    options: {
      getSubcommand: () => opts.subcommand,
      getChannel: (name: string, required?: boolean) => get(name, required),
      getRole: (name: string) => get(name),
      getInteger: (name: string) => get(name),
      getString: (name: string, required?: boolean) => get(name, required),
      getBoolean: (name: string) => get(name),
    },
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChatInputCommandInteraction & { reply: ReturnType<typeof vi.fn> };
}

describe("handleConfig — permission gate", () => {
  it("rejects a non-moderator and writes nothing (bootstrap, no mod role set)", async () => {
    const interaction = fakeInteraction({
      subcommand: "set",
      manageGuild: false,
      roleIds: [],
      userId: "u1",
      ownerId: "someone-else",
      values: { "hourly-cap": 20 },
    });

    await handleConfig(interaction, ctx);

    expect(interaction.reply).toHaveBeenCalledOnce();
    expect(getGuild(db, "g1")).toBeUndefined(); // no row created
    expect(auditRows()).toHaveLength(0);
  });

  it("allows a Manage-Server member before any mod role is configured", async () => {
    const interaction = fakeInteraction({
      subcommand: "set",
      manageGuild: true,
      values: { "hourly-cap": 20 },
    });

    await handleConfig(interaction, ctx);

    expect(getHourlyCap(db, "g1")).toBe(20);
  });

  it("allows a member holding the configured mod role", async () => {
    setGuildConfig(db, "g1", { mod_role: "mods" }, "2026-07-01T00:00:00.000Z");
    const interaction = fakeInteraction({
      subcommand: "set",
      manageGuild: false,
      ownerId: "someone-else",
      roleIds: ["x", "mods"],
      values: { "cooldown-days": 3 },
    });

    await handleConfig(interaction, ctx);

    expect(getGuild(db, "g1")?.default_cooldown_days).toBe(3);
  });
});

describe("handleConfig — writes", () => {
  it("set writes the provided field and exactly one audit row", async () => {
    const interaction = fakeInteraction({
      subcommand: "set",
      manageGuild: true,
      userId: "mod-7",
      values: { "hourly-cap": 15 },
    });

    await handleConfig(interaction, ctx);

    expect(getHourlyCap(db, "g1")).toBe(15);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ event_type: "config_set", actor_id: "mod-7" });
  });

  it("sets and clears the announce channel", async () => {
    const setInteraction = fakeInteraction({
      subcommand: "set",
      manageGuild: true,
      values: { "announce-channel": { id: "chan-77" } },
    });
    await handleConfig(setInteraction, ctx);
    expect(getGuild(db, "g1")?.announce_channel).toBe("chan-77");

    const clearInteraction = fakeInteraction({
      subcommand: "set",
      manageGuild: true,
      values: { clear: "announce_channel" },
    });
    await handleConfig(clearInteraction, ctx);
    expect(getGuild(db, "g1")?.announce_channel).toBeNull();
  });

  it("rejects a set with no fields and writes nothing", async () => {
    const interaction = fakeInteraction({
      subcommand: "set",
      manageGuild: true,
      values: {},
    });

    await handleConfig(interaction, ctx);

    expect(interaction.reply).toHaveBeenCalledOnce();
    expect(getGuild(db, "g1")).toBeUndefined();
    expect(auditRows()).toHaveLength(0);
  });

  it("channel with mode clear removes the rule and audits it", async () => {
    setChannelRule(db, "g1", "c1", "include");
    const interaction = fakeInteraction({
      subcommand: "channel",
      manageGuild: true,
      values: { channel: { id: "c1" }, mode: "clear" },
    });

    await handleConfig(interaction, ctx);

    expect(listChannelRules(db, "g1")).toEqual([]);
    expect(auditRows()).toEqual([
      { event_type: "counted_channel_cleared", actor_id: "u1" },
    ]);
  });

  it("channel with mode include stores the rule and audits it", async () => {
    const interaction = fakeInteraction({
      subcommand: "channel",
      manageGuild: true,
      values: { channel: { id: "c9" }, mode: "include" },
    });

    await handleConfig(interaction, ctx);

    expect(listChannelRules(db, "g1")).toEqual([{ channelId: "c9", mode: "include" }]);
    expect(auditRows()).toEqual([{ event_type: "counted_channel_set", actor_id: "u1" }]);
  });
});
