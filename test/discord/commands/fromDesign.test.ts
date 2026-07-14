import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import type { ButtonInteraction } from "discord.js";
import { openDb } from "../../../src/db/index.js";
import { setGuildConfig } from "../../../src/db/repositories/guilds.js";
import { getRaffle } from "../../../src/db/repositories/raffles.js";
import {
  getPendingRaffle,
  stagePendingRaffle,
  type PendingRaffleSpec,
} from "../../../src/db/repositories/pendingRaffles.js";
import {
  buildFromDesignId,
  handleFromDesign,
  handleFromDesignComponent,
} from "../../../src/discord/commands/raffle/fromDesign.js";
import { makeFakeNotifier } from "../../helpers/fakeNotifier.js";
import { fakeChatInput } from "../../helpers/fakeInteraction.js";

const GUILD = "g1";
// Match the fakeChatInput / fakeButton default user so the staging-mod binding
// (only the mod who staged a token may redeem it) is satisfied by default.
const MOD = "u1";
const FUTURE = "2030-01-02T00:00:00.000Z";
const FUTURE_END = "2030-01-03T00:00:00.000Z";
const FAR_EXPIRY = "2030-12-31T00:00:00.000Z";

let db: Database;
const notifier = makeFakeNotifier();

beforeEach(() => {
  db = openDb(":memory:");
  notifier.mirrorAudit.mockClear();
  setGuildConfig(db, GUILD, { announce_channel: "chan", mod_role: null }, "2026-07-01T00:00:00.000Z");
});

afterEach(() => {
  db.close();
});

const ctx = () => ({ db, config: {} as never, notifier });

function spec(over: Partial<PendingRaffleSpec> = {}): PendingRaffleSpec {
  return {
    name: "Summer Vinyl Giveaway",
    prize: "A record",
    description: null,
    starts_at: FUTURE,
    ends_at: FUTURE_END,
    winner_count: 1,
    draw_mode: "auto",
    is_test: false,
    claim_window_hours: null,
    open_to_all: false,
    exclude_prior_winners: true,
    req_messages: 10,
    req_days: 14,
    req_active_days: 0,
    cooldown_days: 0,
    cooldown_count: null,
    ...over,
  };
}

function stage(token: string, over: { userId?: string; expiresAt?: string; spec?: Partial<PendingRaffleSpec> } = {}): void {
  stagePendingRaffle(db, {
    token,
    guildId: GUILD,
    stagedByUserId: over.userId ?? MOD,
    spec: spec(over.spec),
    createdAt: "2026-07-01T00:00:00.000Z",
    expiresAt: over.expiresAt ?? FAR_EXPIRY,
  });
}

/** A fake Confirm/Cancel button interaction with a postable guild + mod standing. */
function fakeButton(
  customId: string,
  opts: { userId?: string; manageGuild?: boolean } = {},
): ButtonInteraction & { update: ReturnType<typeof vi.fn> } {
  const channel = { id: "chan", permissionsFor: () => ({ has: () => true }) };
  return {
    customId,
    guildId: GUILD,
    user: { id: opts.userId ?? MOD },
    guild: {
      ownerId: "owner",
      members: { me: { id: "bot" } },
      channels: { cache: { get: () => channel } },
    },
    member: { roles: { cache: new Map() } },
    memberPermissions: { has: () => opts.manageGuild ?? true },
    isButton: () => true,
    update: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as ButtonInteraction & { update: ReturnType<typeof vi.fn> };
}

describe("handleFromDesign (summary)", () => {
  it("shows a confirm summary with buttons for a valid token", async () => {
    stage("gentle-harbor-4821");
    const interaction = fakeChatInput({
      subcommand: "from-design",
      values: { token: "gentle-harbor-4821" },
      manageGuild: true,
    });
    await handleFromDesign(interaction, ctx());

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const payload = interaction.reply.mock.calls[0]![0] as { content: string; components: unknown[] };
    expect(payload.content).toContain("Summer Vinyl Giveaway");
    expect(payload.components).toHaveLength(1);
  });

  it("normalises a loosely-typed token", async () => {
    stage("amber-cove-1234");
    const interaction = fakeChatInput({
      subcommand: "from-design",
      values: { token: "  Amber Cove 1234 " },
      manageGuild: true,
    });
    await handleFromDesign(interaction, ctx());
    const payload = interaction.reply.mock.calls[0]![0] as { content: string };
    expect(payload.content).toContain("Summer Vinyl Giveaway");
  });

  it("rejects an unknown token", async () => {
    const interaction = fakeChatInput({
      subcommand: "from-design",
      values: { token: "nope-nope-0000" },
      manageGuild: true,
    });
    await handleFromDesign(interaction, ctx());
    const payload = interaction.reply.mock.calls[0]![0] as { content: string };
    expect(payload.content).toMatch(/isn't valid/i);
  });

  it("rejects a token staged by a different moderator", async () => {
    stage("other-mod-5555", { userId: "someone-else" });
    const interaction = fakeChatInput({
      subcommand: "from-design",
      values: { token: "other-mod-5555" },
      manageGuild: true,
      userId: MOD,
    });
    await handleFromDesign(interaction, ctx());
    const payload = interaction.reply.mock.calls[0]![0] as { content: string };
    expect(payload.content).toMatch(/different moderator/i);
  });

  it("blocks a non-moderator", async () => {
    stage("gentle-harbor-4821");
    const interaction = fakeChatInput({
      subcommand: "from-design",
      values: { token: "gentle-harbor-4821" },
      manageGuild: false,
    });
    await handleFromDesign(interaction, ctx());
    const payload = interaction.reply.mock.calls[0]![0] as { content: string };
    expect(payload.content).toMatch(/permission/i);
  });
});

describe("handleFromDesignComponent (confirm)", () => {
  it("creates and schedules the raffle, then consumes the token", async () => {
    stage("gentle-harbor-4821");
    const interaction = fakeButton(buildFromDesignId("confirm", "gentle-harbor-4821"));
    await handleFromDesignComponent(interaction, { db, notifier });

    const payload = interaction.update.mock.calls[0]![0] as { content: string };
    expect(payload.content).toMatch(/scheduled/i);

    // A scheduled raffle now exists with the spec's fields.
    const raffle = db.prepare(`SELECT * FROM raffles ORDER BY raffle_id DESC LIMIT 1`).get() as {
      raffle_id: number;
      status: string;
      name: string;
      exclude_prior_winners: number;
    };
    expect(raffle.status).toBe("scheduled");
    expect(raffle.name).toBe("Summer Vinyl Giveaway");
    expect(raffle.exclude_prior_winners).toBe(1);
    expect(getRaffle(db, raffle.raffle_id)!.starts_at).toBe(FUTURE);

    // The token is consumed and points at the raffle it created.
    const row = getPendingRaffle(db, "gentle-harbor-4821")!;
    expect(row.redeemed_at).not.toBeNull();
    expect(row.redeemed_raffle_id).toBe(raffle.raffle_id);
  });

  it("cancels without creating anything", async () => {
    stage("gentle-harbor-4821");
    const interaction = fakeButton(buildFromDesignId("cancel", "gentle-harbor-4821"));
    await handleFromDesignComponent(interaction, { db, notifier });

    const payload = interaction.update.mock.calls[0]![0] as { content: string };
    expect(payload.content).toMatch(/cancelled/i);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM raffles`).get()).toEqual({ n: 0 });
    expect(getPendingRaffle(db, "gentle-harbor-4821")!.redeemed_at).toBeNull();
  });

  it("refuses to confirm an already-redeemed token", async () => {
    stage("gentle-harbor-4821");
    const first = fakeButton(buildFromDesignId("confirm", "gentle-harbor-4821"));
    await handleFromDesignComponent(first, { db, notifier });
    const second = fakeButton(buildFromDesignId("confirm", "gentle-harbor-4821"));
    await handleFromDesignComponent(second, { db, notifier });

    const payload = second.update.mock.calls[0]![0] as { content: string };
    expect(payload.content).toMatch(/already been used/i);
    // Still exactly one raffle.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM raffles`).get()).toEqual({ n: 1 });
  });

  it("re-authorises the clicker as a moderator", async () => {
    stage("gentle-harbor-4821");
    const interaction = fakeButton(buildFromDesignId("confirm", "gentle-harbor-4821"), {
      manageGuild: false,
    });
    await handleFromDesignComponent(interaction, { db, notifier });
    const payload = interaction.update.mock.calls[0]![0] as { content: string };
    expect(payload.content).toMatch(/permission/i);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM raffles`).get()).toEqual({ n: 0 });
  });
});
