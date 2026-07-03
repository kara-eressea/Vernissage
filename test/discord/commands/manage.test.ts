import type { ChatInputCommandInteraction } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import type { BotConfig } from "../../../src/config.js";
import { openDb } from "../../../src/db/index.js";
import {
  createDraft,
  getRaffle,
  setStatus,
} from "../../../src/db/repositories/raffles.js";
import { getWizardState } from "../../../src/db/repositories/wizardState.js";
import { handleCancel, handleCreate, handleEdit } from "../../../src/discord/commands/raffle/manage.js";
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

function auditRows(): Array<{ event_type: string; payload: string | null }> {
  return db.prepare(`SELECT event_type, payload FROM audit_log`).all() as Array<{
    event_type: string;
    payload: string | null;
  }>;
}

interface FakeOpts {
  manageGuild?: boolean;
  subcommand: string;
  values?: Record<string, unknown>;
}

function fakeInteraction(opts: FakeOpts): ChatInputCommandInteraction & {
  reply: ReturnType<typeof vi.fn>;
  showModal: ReturnType<typeof vi.fn>;
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
    guildId: "g1",
    user: { id: "mod1" },
    guild: { ownerId: "owner" },
    member: { roles: { cache: new Map() } },
    memberPermissions: { has: () => opts.manageGuild ?? true },
    isChatInputCommand: () => true,
    isModalSubmit: () => false,
    options: {
      getSubcommand: () => opts.subcommand,
      getInteger: (name: string, required?: boolean) => get(name, required),
      getString: (name: string, required?: boolean) => get(name, required),
    },
    reply: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChatInputCommandInteraction & {
    reply: ReturnType<typeof vi.fn>;
    showModal: ReturnType<typeof vi.fn>;
  };
}

describe("handleCreate", () => {
  it("creates a draft, audits it, seeds the wizard, and opens step 1", async () => {
    const interaction = fakeInteraction({ subcommand: "create" });
    await handleCreate(interaction, ctx);

    const drafts = db.prepare(`SELECT * FROM raffles WHERE status = 'draft'`).all();
    expect(drafts).toHaveLength(1);
    const id = (drafts[0] as { raffle_id: number }).raffle_id;
    expect(getWizardState(db, id)?.step).toBe("basics");
    expect(auditRows().map((r) => r.event_type)).toContain("raffle_created");
    expect(interaction.reply).toHaveBeenCalled();
  });

  it("applies name/prize prefill when provided", async () => {
    const interaction = fakeInteraction({
      subcommand: "create",
      values: { name: "Prefilled", prize: "A hat" },
    });
    await handleCreate(interaction, ctx);
    const draft = db.prepare(`SELECT * FROM raffles WHERE status='draft'`).get() as {
      name: string;
      prize: string;
    };
    expect(draft.name).toBe("Prefilled");
    expect(draft.prize).toBe("A hat");
  });

  it("rejects a non-moderator without creating anything", async () => {
    const interaction = fakeInteraction({ subcommand: "create", manageGuild: false });
    await handleCreate(interaction, ctx);
    expect(db.prepare(`SELECT count(*) c FROM raffles`).get()).toEqual({ c: 0 });
  });
});

describe("handleCancel", () => {
  it("cancels a pre-drawn raffle and records the reason", async () => {
    const id = createDraft(db, "g1", "mod1", "2026-07-01T00:00:00.000Z");
    setStatus(db, id, "open");
    const interaction = fakeInteraction({
      subcommand: "cancel",
      values: { raffle: id, reason: "sponsor pulled out" },
    });

    await handleCancel(interaction, ctx);

    expect(getRaffle(db, id)?.status).toBe("cancelled");
    const cancelRow = auditRows().find((r) => r.event_type === "raffle_cancelled");
    expect(cancelRow).toBeDefined();
    expect(JSON.parse(cancelRow!.payload!)).toEqual({ reason: "sponsor pulled out" });
  });

  it("refuses to cancel a drawn raffle", async () => {
    const id = createDraft(db, "g1", "mod1", "2026-07-01T00:00:00.000Z");
    setStatus(db, id, "drawn");
    const interaction = fakeInteraction({
      subcommand: "cancel",
      values: { raffle: id, reason: "too late" },
    });

    await handleCancel(interaction, ctx);

    expect(getRaffle(db, id)?.status).toBe("drawn"); // unchanged
    expect(auditRows()).toHaveLength(0);
  });

  it("rejects an id from another guild", async () => {
    const id = createDraft(db, "g2", "mod1", "2026-07-01T00:00:00.000Z");
    const interaction = fakeInteraction({
      subcommand: "cancel",
      values: { raffle: id, reason: "x" },
    });
    await handleCancel(interaction, ctx);
    expect(getRaffle(db, id)?.status).toBe("draft");
  });
});

describe("handleEdit", () => {
  it("reopens the wizard for a draft raffle", async () => {
    const id = createDraft(db, "g1", "mod1", "2026-07-01T00:00:00.000Z");
    const interaction = fakeInteraction({ subcommand: "edit", values: { raffle: id } });
    await handleEdit(interaction, ctx);
    expect(interaction.reply).toHaveBeenCalled();
    expect(interaction.showModal).not.toHaveBeenCalled();
  });

  it("shows the end-extension modal for an open raffle", async () => {
    const id = createDraft(db, "g1", "mod1", "2026-07-01T00:00:00.000Z");
    setStatus(db, id, "open");
    const interaction = fakeInteraction({ subcommand: "edit", values: { raffle: id } });
    await handleEdit(interaction, ctx);
    expect(interaction.showModal).toHaveBeenCalled();
  });

  it("refuses to edit a drawn raffle", async () => {
    const id = createDraft(db, "g1", "mod1", "2026-07-01T00:00:00.000Z");
    setStatus(db, id, "drawn");
    const interaction = fakeInteraction({ subcommand: "edit", values: { raffle: id } });
    await handleEdit(interaction, ctx);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringMatching(/no longer be edited/i) }),
    );
    expect(interaction.showModal).not.toHaveBeenCalled();
  });
});
