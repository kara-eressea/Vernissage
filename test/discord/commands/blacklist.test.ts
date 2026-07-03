import type { ChatInputCommandInteraction } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import type { BotConfig } from "../../../src/config.js";
import { openDb } from "../../../src/db/index.js";
import { isBlacklisted, listBans } from "../../../src/db/repositories/blacklist.js";
import { addEntry, hasEntry } from "../../../src/db/repositories/entries.js";
import { createDraft, setStatus } from "../../../src/db/repositories/raffles.js";
import { setGuildConfig } from "../../../src/db/repositories/guilds.js";
import {
  handleBan,
  handleBanlist,
  handleUnban,
} from "../../../src/discord/commands/raffle/blacklist.js";
import type { CommandContext } from "../../../src/discord/commands/index.js";

let db: Database;
let ctx: CommandContext;
let mirrored: Array<{ eventType: string; raffleId: number | null }>;

beforeEach(() => {
  db = openDb(":memory:");
  mirrored = [];
  ctx = {
    db,
    config: {} as BotConfig,
    notifier: {
      resolveAuditChannel: async () => undefined,
      mirrorAudit: async (e) => {
        mirrored.push({ eventType: e.eventType, raffleId: e.raffleId });
      },
      postEntryMessage: async () => undefined,
      postAudit: async () => undefined,
      postAnnouncement: async () => undefined,
    },
  };
});

afterEach(() => {
  db.close();
});

interface FakeOpts {
  isMod?: boolean;
  values?: Record<string, unknown>;
}

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
  const isMod = opts.isMod ?? true;
  return {
    guildId: "g1",
    user: { id: "mod1" },
    guild: { ownerId: isMod ? "mod1" : "someone-else" },
    member: { roles: { cache: new Map() } },
    memberPermissions: { has: () => isMod },
    options: {
      getUser: (name: string, required?: boolean) => get(name, required),
      getString: (name: string, required?: boolean) => get(name, required),
    },
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChatInputCommandInteraction & { reply: ReturnType<typeof vi.fn> };
}

function replyText(interaction: { reply: ReturnType<typeof vi.fn> }): string {
  return (interaction.reply.mock.calls[0]![0] as { content: string }).content;
}

describe("handleBan", () => {
  it("rejects a non-moderator without banning", async () => {
    const interaction = fakeInteraction({ isMod: false, values: { user: { id: "u1" } } });
    await handleBan(interaction, ctx);
    expect(isBlacklisted(db, "g1", "u1", new Date().toISOString())).toBe(false);
    expect(replyText(interaction).toLowerCase()).toContain("permission");
  });

  it("bans a user, removes their open-raffle entry, and mirrors reason-free audits", async () => {
    const raffleId = createDraft(db, "g1", "mod1", "2026-07-01T00:00:00.000Z");
    setStatus(db, raffleId, "open");
    addEntry(db, raffleId, "u1", "2026-07-01T00:00:00.000Z");

    const interaction = fakeInteraction({
      values: { user: { id: "u1" }, reason: "spamming" },
    });
    await handleBan(interaction, ctx);

    expect(isBlacklisted(db, "g1", "u1", new Date().toISOString())).toBe(true);
    expect(hasEntry(db, raffleId, "u1")).toBe(false);
    // Both a ban and the entry removal were mirrored to the audit channel.
    expect(mirrored.map((m) => m.eventType)).toEqual(["blacklist_added", "entry_removed"]);
    // The mod sees the reason in their ephemeral reply...
    expect(replyText(interaction)).toContain("spamming");
    // ...but it never enters the DB audit payload.
    const payloads = (
      db.prepare(`SELECT payload FROM audit_log`).all() as Array<{ payload: string | null }>
    ).map((r) => r.payload ?? "");
    expect(payloads.every((p) => !p.includes("spamming"))).toBe(true);
  });

  it("rejects a malformed duration with a friendly message", async () => {
    const interaction = fakeInteraction({
      values: { user: { id: "u1" }, duration: "banana" },
    });
    await handleBan(interaction, ctx);
    expect(isBlacklisted(db, "g1", "u1", new Date().toISOString())).toBe(false);
    expect(replyText(interaction)).toContain("Invalid duration");
  });
});

describe("handleUnban / handleBanlist", () => {
  it("unban lifts the ban and notes that entries are not restored", async () => {
    setGuildConfig(db, "g1", {}, "2026-07-01T00:00:00.000Z");
    const banInteraction = fakeInteraction({ values: { user: { id: "u1" } } });
    await handleBan(banInteraction, ctx);

    const unbanInteraction = fakeInteraction({ values: { user: { id: "u1" } } });
    await handleUnban(unbanInteraction, ctx);
    expect(isBlacklisted(db, "g1", "u1", new Date().toISOString())).toBe(false);
    expect(replyText(unbanInteraction).toLowerCase()).toContain("not restored");
  });

  it("banlist reports the current bans, including reasons", async () => {
    await handleBan(fakeInteraction({ values: { user: { id: "u1" }, reason: "botting" } }), ctx);
    const list = fakeInteraction({});
    await handleBanlist(list, ctx);
    expect(listBans(db, "g1")).toHaveLength(1);
    expect(replyText(list)).toContain("botting");
  });
});
