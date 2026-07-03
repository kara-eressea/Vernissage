import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import {
  createDraft,
  getRaffle,
  updateRaffleFields,
} from "../../src/db/repositories/raffles.js";
import { getWizardState, upsertWizardStep } from "../../src/db/repositories/wizardState.js";
import { createWizard, type WizardInteraction } from "../../src/discord/wizard/index.js";

let db: Database;
const notifier = {
  resolveAuditChannel: async () => undefined,
  mirrorAudit: vi.fn().mockResolvedValue(undefined),
  postEntryMessage: async () => undefined,
};

beforeEach(() => {
  db = openDb(":memory:");
  notifier.mirrorAudit.mockClear();
});

afterEach(() => {
  db.close();
});

function wizard() {
  return createWizard({ db, notifier });
}

function fakeModal(
  customId: string,
  fields: Record<string, string>,
): WizardInteraction & { update: ReturnType<typeof vi.fn>; reply: ReturnType<typeof vi.fn> } {
  return {
    customId,
    user: { id: "mod1" },
    isChatInputCommand: () => false,
    isModalSubmit: () => true,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isFromMessage: () => true,
    fields: { getTextInputValue: (id: string) => fields[id] ?? "" },
    update: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as WizardInteraction & {
    update: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
  };
}

function fakeButton(
  customId: string,
): WizardInteraction & { update: ReturnType<typeof vi.fn>; showModal: ReturnType<typeof vi.fn> } {
  return {
    customId,
    user: { id: "mod1" },
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    update: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
  } as unknown as WizardInteraction & {
    update: ReturnType<typeof vi.fn>;
    showModal: ReturnType<typeof vi.fn>;
  };
}

describe("wizard schedule step", () => {
  it("re-renders with an error and does not advance on an unparseable time", async () => {
    const id = createDraft(db, "g1", "mod1", "2026-07-01T00:00:00.000Z");
    updateRaffleFields(db, id, { name: "X", prize: "Y" });
    upsertWizardStep(db, id, "schedule", "2026-07-01T00:00:00.000Z");

    const interaction = fakeModal(`wiz:schedule:submit:${id}`, {
      start: "whenever",
      end: "in 7 days",
    });
    await wizard().handle(interaction);

    expect(interaction.update).toHaveBeenCalled();
    const payload = interaction.update.mock.calls[0]![0] as { content: string };
    expect(payload.content).toMatch(/⚠️/);
    expect(getRaffle(db, id)?.starts_at).toBeNull(); // not saved
    expect(getWizardState(db, id)?.step).toBe("schedule"); // not advanced
  });
});

describe("wizard basics step", () => {
  it("saves basics and advances to the schedule step", async () => {
    const id = createDraft(db, "g1", "mod1", "2026-07-01T00:00:00.000Z");
    upsertWizardStep(db, id, "basics", "2026-07-01T00:00:00.000Z");

    const interaction = fakeModal(`wiz:basics:submit:${id}`, {
      name: "Great raffle",
      prize: "A prize",
      description: "",
    });
    await wizard().handle(interaction);

    expect(getRaffle(db, id)?.name).toBe("Great raffle");
    expect(getWizardState(db, id)?.step).toBe("schedule");
  });
});

function fakeChannelSelect(
  customId: string,
  values: string[],
): WizardInteraction & { update: ReturnType<typeof vi.fn> } {
  return {
    customId,
    user: { id: "mod1" },
    values,
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isChannelSelectMenu: () => true,
    update: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as WizardInteraction & { update: ReturnType<typeof vi.fn> };
}

describe("wizard announce channel override", () => {
  it("stores the selected channel on the raffle, and clears it on empty", async () => {
    const id = createDraft(db, "g1", "mod1", "2026-07-01T00:00:00.000Z");
    upsertWizardStep(db, id, "summary", "2026-07-01T00:00:00.000Z");

    await wizard().handle(fakeChannelSelect(`wiz:summary:channel:${id}`, ["chan-9"]));
    expect(getRaffle(db, id)?.channel_id).toBe("chan-9");

    await wizard().handle(fakeChannelSelect(`wiz:summary:channel:${id}`, []));
    expect(getRaffle(db, id)?.channel_id).toBeNull();
  });
});

describe("wizard confirm", () => {
  it("schedules a fully valid draft, audits it, and clears wizard state", async () => {
    const id = createDraft(db, "g1", "mod1", "2026-07-01T00:00:00.000Z");
    updateRaffleFields(db, id, {
      name: "Valid",
      prize: "Prize",
      starts_at: "2099-01-01T00:00:00.000Z",
      ends_at: "2099-01-08T00:00:00.000Z",
      req_messages: 20,
      req_days: 14,
      window_anchor: "start",
      winner_count: 1,
      draw_mode: "auto",
    });
    upsertWizardStep(db, id, "summary", "2026-07-01T00:00:00.000Z");

    await wizard().handle(fakeButton(`wiz:summary:confirm:${id}`));

    expect(getRaffle(db, id)?.status).toBe("scheduled");
    expect(getWizardState(db, id)).toBeUndefined(); // cleared
    const events = (
      db.prepare(`SELECT event_type FROM audit_log`).all() as Array<{ event_type: string }>
    ).map((r) => r.event_type);
    expect(events).toContain("raffle_scheduled");
    expect(notifier.mirrorAudit).toHaveBeenCalled();
  });

  it("blocks confirm on an incomplete draft", async () => {
    const id = createDraft(db, "g1", "mod1", "2026-07-01T00:00:00.000Z");
    updateRaffleFields(db, id, { name: "Only a name" });
    upsertWizardStep(db, id, "summary", "2026-07-01T00:00:00.000Z");

    const interaction = fakeButton(`wiz:summary:confirm:${id}`);
    await wizard().handle(interaction);

    expect(getRaffle(db, id)?.status).toBe("draft"); // not scheduled
    expect(interaction.update).toHaveBeenCalled(); // error re-render
  });
});
