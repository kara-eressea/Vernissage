import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { makeFakeNotifier } from "../../helpers/fakeNotifier.js";
import { fakeChatInput, type FakeChatInputOpts } from "../../helpers/fakeInteraction.js";

let db: Database;
let ctx: CommandContext;

beforeEach(() => {
  db = openDb(":memory:");
  ctx = { db, config: {} as BotConfig, notifier: makeFakeNotifier() };
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

/** A non-privileged member by default (config's permission tests set the gate explicitly). */
function fakeInteraction(opts: FakeChatInputOpts & { subcommand: string }) {
  return fakeChatInput(opts);
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

  it("rejects an audit channel the bot cannot post in and writes nothing", async () => {
    const interaction = fakeInteraction({
      subcommand: "set",
      manageGuild: true,
      botMember: { id: "bot" },
      values: {
        "audit-channel": { id: "private-1", permissionsFor: () => ({ has: () => false }) },
      },
    });

    await handleConfig(interaction, ctx);

    expect(interaction.reply).toHaveBeenCalledOnce();
    const { content } = interaction.reply.mock.calls[0]![0] as { content: string };
    expect(content).toMatch(/can't post in <#private-1>/);
    expect(getGuild(db, "g1")?.audit_channel ?? null).toBeNull();
    expect(auditRows()).toHaveLength(0);
  });

  it("accepts an announce channel the bot can post in", async () => {
    const interaction = fakeInteraction({
      subcommand: "set",
      manageGuild: true,
      botMember: { id: "bot" },
      values: {
        "announce-channel": { id: "open-1", permissionsFor: () => ({ has: () => true }) },
      },
    });

    await handleConfig(interaction, ctx);

    expect(getGuild(db, "g1")?.announce_channel).toBe("open-1");
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

  it("channels clear removes the rule and audits it", async () => {
    setChannelRule(db, "g1", "c1", "include");
    const interaction = fakeInteraction({
      subcommand: "channels",
      manageGuild: true,
      values: { action: "clear", channel: { id: "c1" } },
    });

    await handleConfig(interaction, ctx);

    expect(listChannelRules(db, "g1")).toEqual([]);
    expect(auditRows()).toEqual([
      { event_type: "counted_channel_cleared", actor_id: "u1" },
    ]);
  });

  it("channels include stores the rule and audits it", async () => {
    const interaction = fakeInteraction({
      subcommand: "channels",
      manageGuild: true,
      values: { action: "include", channel: { id: "c9" } },
    });

    await handleConfig(interaction, ctx);

    expect(listChannelRules(db, "g1")).toEqual([{ channelId: "c9", mode: "include" }]);
    expect(auditRows()).toEqual([{ event_type: "counted_channel_set", actor_id: "u1" }]);
  });

  it("channels include builds up a multi-channel allowlist across calls", async () => {
    for (const id of ["c1", "c2", "c3"]) {
      await handleConfig(
        fakeInteraction({
          subcommand: "channels",
          manageGuild: true,
          values: { action: "include", channel: { id } },
        }),
        ctx,
      );
    }

    expect(listChannelRules(db, "g1")).toEqual([
      { channelId: "c1", mode: "include" },
      { channelId: "c2", mode: "include" },
      { channelId: "c3", mode: "include" },
    ]);
  });

  it("channels list is read-only: no channel needed, nothing written", async () => {
    setChannelRule(db, "g1", "c1", "include");
    setChannelRule(db, "g1", "c2", "exclude");
    const interaction = fakeInteraction({
      subcommand: "channels",
      manageGuild: true,
      values: { action: "list" },
    });

    await handleConfig(interaction, ctx);

    const reply = (interaction.reply.mock.calls[0]![0] as { content: string }).content;
    expect(reply).toContain("<#c1>");
    expect(reply).toContain("<#c2>");
    expect(reply).toContain("Only included channels count");
    // A read-only view writes no rules and no audit rows.
    expect(auditRows()).toHaveLength(0);
  });

  it("channels include/exclude/clear require a channel", async () => {
    const interaction = fakeInteraction({
      subcommand: "channels",
      manageGuild: true,
      values: { action: "include" },
    });

    await handleConfig(interaction, ctx);

    expect(interaction.reply).toHaveBeenCalledOnce();
    expect(listChannelRules(db, "g1")).toEqual([]);
    expect(auditRows()).toHaveLength(0);
  });
});
