import type { Client } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import { AUDIT_EVENTS } from "../../src/core/auditEvents.js";
import { openDb } from "../../src/db/index.js";
import { upsertGuild } from "../../src/db/repositories/guilds.js";
import { createNotifier } from "../../src/discord/notifier.js";
import { startScheduler } from "../../src/scheduler/runner.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
  // Keep swallowed-error logging out of the test output.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

/** A stub text channel capturing send() calls. */
function stubChannel(send = vi.fn().mockResolvedValue({ id: "msg1" })) {
  return { isTextBased: () => true, send };
}

/** A fake Client whose channels.fetch resolves/reject per the given behavior. */
function fakeClient(fetch: (id: string) => unknown): Client {
  return { channels: { fetch: vi.fn(fetch) } } as unknown as Client;
}

function setAuditChannel(guildId: string, channelId: string): void {
  upsertGuild(db, guildId, { audit_channel: channelId, created_at: "2026-07-01T00:00:00.000Z" });
}

const openEvent = {
  guildId: "g1",
  raffleId: 7,
  eventType: AUDIT_EVENTS.raffleOpened,
  actorId: "scheduler",
  createdAt: "2026-07-03T12:00:00.000Z",
};

describe("resolveAuditChannel", () => {
  it("returns undefined when the guild row is absent", async () => {
    const notifier = createNotifier(fakeClient(() => null), db);
    expect(await notifier.resolveAuditChannel("g1")).toBeUndefined();
  });

  it("returns undefined when audit_channel is null", async () => {
    upsertGuild(db, "g1", { hourly_cap: 5, created_at: "2026-07-01T00:00:00.000Z" });
    const notifier = createNotifier(fakeClient(() => null), db);
    expect(await notifier.resolveAuditChannel("g1")).toBeUndefined();
  });

  it("returns the channel when configured and text-based", async () => {
    setAuditChannel("g1", "c1");
    const channel = stubChannel();
    const notifier = createNotifier(fakeClient(() => channel), db);
    expect(await notifier.resolveAuditChannel("g1")).toBe(channel);
  });
});

describe("mirrorAudit", () => {
  it("sends the formatted line with mentions suppressed", async () => {
    setAuditChannel("g1", "c1");
    const send = vi.fn().mockResolvedValue({ id: "m1" });
    const notifier = createNotifier(fakeClient(() => stubChannel(send)), db);

    await notifier.mirrorAudit(openEvent);

    expect(send).toHaveBeenCalledOnce();
    const arg = send.mock.calls[0]![0];
    expect(arg.content).toContain("raffle #7");
    expect(arg.allowedMentions).toEqual({ parse: [] });
  });

  it("does nothing when the event has no guild", async () => {
    const fetch = vi.fn();
    const notifier = createNotifier(fakeClient(fetch), db);
    await notifier.mirrorAudit({ ...openEvent, guildId: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("no-ops quietly when the audit channel is unset", async () => {
    const notifier = createNotifier(fakeClient(() => null), db);
    await expect(notifier.mirrorAudit(openEvent)).resolves.toBeUndefined();
  });

  it("swallows a channels.fetch rejection", async () => {
    setAuditChannel("g1", "c1");
    const notifier = createNotifier(
      fakeClient(() => Promise.reject(new Error("network"))),
      db,
    );
    await expect(notifier.mirrorAudit(openEvent)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it("ignores a non-text channel without sending", async () => {
    setAuditChannel("g1", "c1");
    const notifier = createNotifier(
      fakeClient(() => ({ isTextBased: () => false })),
      db,
    );
    await expect(notifier.mirrorAudit(openEvent)).resolves.toBeUndefined();
  });

  it("swallows a send rejection and logs it", async () => {
    setAuditChannel("g1", "c1");
    const send = vi.fn().mockRejectedValue(new Error("forbidden"));
    const notifier = createNotifier(fakeClient(() => stubChannel(send)), db);
    await expect(notifier.mirrorAudit(openEvent)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});

describe("scheduler integration", () => {
  it("mirrors an opened transition to the audit channel end-to-end", async () => {
    setAuditChannel("g1", "c1");
    const send = vi.fn().mockResolvedValue({ id: "m" });
    const notifier = createNotifier(fakeClient(() => stubChannel(send)), db);

    // A scheduled raffle whose start time has already passed.
    db.prepare(
      `INSERT INTO raffles (guild_id, status, starts_at, ends_at, draw_mode, created_at)
       VALUES ('g1', 'scheduled', '2026-07-01T00:00:00.000Z', '2026-07-20T00:00:00.000Z', 'auto', '2026-06-30T00:00:00.000Z')`,
    ).run();

    // The scheduler fires onTransition synchronously during the startup sweep;
    // mirrorAudit is async, so collect its promise and await it.
    const pending: Array<Promise<void>> = [];
    const scheduler = startScheduler(db, {
      now: () => "2026-07-03T12:00:00.000Z",
      onTransition: (t) => {
        pending.push(
          notifier.mirrorAudit({
            guildId: t.guildId,
            raffleId: t.raffleId,
            eventType:
              t.to === "open" ? AUDIT_EVENTS.raffleOpened : AUDIT_EVENTS.raffleClosed,
            actorId: "scheduler",
            createdAt: "2026-07-03T12:00:00.000Z",
          }),
        );
      },
    });
    scheduler.stop();
    await Promise.all(pending);

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0].content).toMatch(/open for entries/i);
  });
});

describe("postEntryMessage", () => {
  it("sends the content and returns the new message id", async () => {
    const send = vi.fn().mockResolvedValue({ id: "msg-42" });
    const notifier = createNotifier(fakeClient(() => stubChannel(send)), db);

    const id = await notifier.postEntryMessage("c9", { title: "T", body: "B" });

    expect(id).toBe("msg-42");
    expect(send.mock.calls[0]![0].content).toContain("T");
    expect(send.mock.calls[0]![0].content).toContain("B");
  });

  it("passes through components for the Enter button", async () => {
    const send = vi.fn().mockResolvedValue({ id: "m" });
    const notifier = createNotifier(fakeClient(() => stubChannel(send)), db);
    const components = [{ type: 1 }];

    await notifier.postEntryMessage("c9", { title: "T", body: "B" }, components);

    expect(send.mock.calls[0]![0].components).toBe(components);
  });

  it("returns undefined when the channel cannot be sent to", async () => {
    const notifier = createNotifier(
      fakeClient(() => Promise.reject(new Error("gone"))),
      db,
    );
    expect(await notifier.postEntryMessage("c9", { title: "T", body: "B" })).toBeUndefined();
  });
});
