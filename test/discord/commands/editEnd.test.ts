import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import type { ModalSubmitInteraction } from "discord.js";
import { openDb } from "../../../src/db/index.js";
import { setGuildConfig } from "../../../src/db/repositories/guilds.js";
import {
  createDraft,
  getRaffle,
  setStatus,
  updateRaffleFields,
} from "../../../src/db/repositories/raffles.js";
import { handleEditEnd, EDIT_END_PREFIX } from "../../../src/discord/commands/raffle/editEnd.js";
import { makeFakeNotifier } from "../../helpers/fakeNotifier.js";

/**
 * The end-correction modal.
 *
 * It moves a live raffle's end time, so the standing that matters is the one the
 * submitter holds *now* — not the one they held when `/raffle-mod edit` showed
 * them the modal, which a modal left open can easily outlive (issue #53).
 */

let db: Database;
let notifier: ReturnType<typeof makeFakeNotifier>;
let deps: { db: Database; notifier: ReturnType<typeof makeFakeNotifier> };

const NOW = "2026-07-15T12:00:00.000Z";

beforeEach(() => {
  db = openDb(":memory:");
  notifier = makeFakeNotifier();
  deps = { db, notifier };
});

afterEach(() => {
  db.close();
});

/** An open raffle running until well after `NOW`. */
function seedOpenRaffle(): number {
  const id = createDraft(db, "g1", "mod1", NOW);
  updateRaffleFields(db, id, {
    name: "R",
    prize: "P",
    starts_at: "2026-07-14T12:00:00.000Z",
    ends_at: "2026-07-20T12:00:00.000Z",
  });
  setStatus(db, id, "open");
  return id;
}

type FakeModal = ModalSubmitInteraction & { reply: ReturnType<typeof vi.fn> };

function fakeModal(
  raffleId: number,
  end: string,
  opts: { isMod?: boolean; roleIds?: string[] } = {},
): FakeModal {
  return {
    customId: `${EDIT_END_PREFIX}:${raffleId}`,
    user: { id: "mod1" },
    guildId: "g1",
    guild: { ownerId: "owner" },
    member: { roles: { cache: new Map((opts.roleIds ?? []).map((r) => [r, {}])) } },
    memberPermissions: { has: () => opts.isMod ?? true },
    fields: { getTextInputValue: () => end },
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as FakeModal;
}

function auditCount(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get() as { n: number }).n;
}

describe("handleEditEnd", () => {
  it("moves the end time, audits it, and mirrors the change", async () => {
    const id = seedOpenRaffle();

    const interaction = fakeModal(id, "2026-07-25 20:00");
    await handleEditEnd(interaction, deps);

    // No guild timezone configured here, so the input is read as UTC.
    expect(getRaffle(db, id)?.ends_at).toBe("2026-07-25T20:00:00.000Z");
    expect(auditCount()).toBe(1);
    expect(notifier.mirrorAudit).toHaveBeenCalledOnce();
    const { content } = interaction.reply.mock.calls[0]![0] as { content: string };
    expect(content).toContain("End time updated");
  });

  it("refuses a submitter who is no longer a moderator, writing nothing", async () => {
    // The whole point of #53: being shown the modal is not permission to submit
    // it. Nothing is written and no audit row appears.
    const id = seedOpenRaffle();

    const interaction = fakeModal(id, "2026-07-25 20:00", { isMod: false });
    await handleEditEnd(interaction, deps);

    expect(getRaffle(db, id)?.ends_at).toBe("2026-07-20T12:00:00.000Z"); // untouched
    expect(auditCount()).toBe(0);
    expect(notifier.mirrorAudit).not.toHaveBeenCalled();
    const { content } = interaction.reply.mock.calls[0]![0] as { content: string };
    expect(content).toContain("do not have permission");
  });

  it("accepts a moderator holding only the configured mod role", async () => {
    const id = seedOpenRaffle();
    setGuildConfig(db, "g1", { mod_role: "role-mod" }, NOW);

    await handleEditEnd(fakeModal(id, "2026-07-25 20:00", { isMod: false, roleIds: ["role-mod"] }), deps);

    expect(getRaffle(db, id)?.ends_at).toBe("2026-07-25T20:00:00.000Z");
    expect(auditCount()).toBe(1);
  });

  it("still reads the guild timezone for parsing after the gate", async () => {
    // The gate folded the two guild lookups into one; the timezone must survive.
    const id = seedOpenRaffle();
    setGuildConfig(db, "g1", { timezone: "Europe/Copenhagen" }, NOW);

    await handleEditEnd(fakeModal(id, "2026-07-25 20:00"), deps);

    // 20:00 in Copenhagen (UTC+2 in July) is 18:00 UTC — not 20:00 UTC.
    expect(getRaffle(db, id)?.ends_at).toBe("2026-07-25T18:00:00.000Z");
  });

  it("rejects an unparseable time without writing", async () => {
    const id = seedOpenRaffle();

    const interaction = fakeModal(id, "whenever really");
    await handleEditEnd(interaction, deps);

    expect(getRaffle(db, id)?.ends_at).toBe("2026-07-20T12:00:00.000Z");
    expect(auditCount()).toBe(0);
  });

  it("rejects an end time before the raffle started", async () => {
    const id = seedOpenRaffle();

    const interaction = fakeModal(id, "2026-07-10 20:00");
    await handleEditEnd(interaction, deps);

    expect(getRaffle(db, id)?.ends_at).toBe("2026-07-20T12:00:00.000Z");
    expect(auditCount()).toBe(0);
  });

  it("refuses a submit that lands after the raffle stopped being open", async () => {
    // A modal outlives the state that opened it just as it outlives standing:
    // rewriting a settled raffle's end time would also audit it as an edit.
    const id = seedOpenRaffle();
    setStatus(db, id, "closed");

    const interaction = fakeModal(id, "2026-07-25 20:00");
    await handleEditEnd(interaction, deps);

    expect(getRaffle(db, id)?.ends_at).toBe("2026-07-20T12:00:00.000Z");
    expect(auditCount()).toBe(0);
    const { content } = interaction.reply.mock.calls[0]![0] as { content: string };
    expect(content).toContain("no longer open");
  });

  it("refuses a raffle belonging to another guild", async () => {
    const id = createDraft(db, "other-guild", "mod1", NOW);
    updateRaffleFields(db, id, {
      name: "Theirs",
      starts_at: "2026-07-14T12:00:00.000Z",
      ends_at: "2026-07-20T12:00:00.000Z",
    });
    setStatus(db, id, "open");

    const interaction = fakeModal(id, "2026-07-25 20:00");
    await handleEditEnd(interaction, deps);

    expect(getRaffle(db, id)?.ends_at).toBe("2026-07-20T12:00:00.000Z");
    expect(auditCount()).toBe(0);
    const { content } = interaction.reply.mock.calls[0]![0] as { content: string };
    expect(content).toContain("no longer exists");
  });

  it("reports a raffle that no longer exists", async () => {
    const interaction = fakeModal(999, "2026-07-25 20:00");
    await handleEditEnd(interaction, deps);

    const { content } = interaction.reply.mock.calls[0]![0] as { content: string };
    expect(content).toContain("no longer exists");
  });
});
