import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/db/index.js";
import { addEntry } from "../../src/db/repositories/entries.js";
import {
  createDraft,
  setDrawCommitment,
  setEntrantsHash,
  setStatus,
  updateRaffleFields,
} from "../../src/db/repositories/raffles.js";
import { addBan } from "../../src/db/repositories/blacklist.js";
import { addWin } from "../../src/db/repositories/wins.js";
import { runBackup } from "../../src/ops/backup.js";
import { runRestore } from "../../src/ops/restore.js";

const GUILD = "111111111111111111";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "vernissage-impact-test-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** An open raffle with two entrants, as it stands before the doors close. */
function openRaffle(path: string): number {
  const db = openDb(path);
  try {
    const id = createDraft(db, GUILD, "mod-1", "2026-01-01T10:00:00.000Z");
    updateRaffleFields(db, id, { name: "Winter draw", prize: "A record", winner_count: 1 });
    setStatus(db, id, "open");
    addEntry(db, id, "user-a", "2026-01-02T10:00:00.000Z");
    addEntry(db, id, "user-b", "2026-01-02T11:00:00.000Z");
    return id;
  } finally {
    db.close();
  }
}

/** Close, commit and draw it, as the bot would. */
function closeAndDraw(path: string, raffleId: number): void {
  const db = openDb(path);
  try {
    setStatus(db, raffleId, "closed");
    setEntrantsHash(db, raffleId, "c".repeat(64));
    setDrawCommitment(db, raffleId, "b".repeat(64), "a".repeat(64));
    setStatus(db, raffleId, "drawn");
    addWin(db, raffleId, "user-a", "2026-01-03T10:00:00.000Z");
  } finally {
    db.close();
  }
}

describe("restore impact", () => {
  it("refuses a backup that predates a draw the bot already announced", async () => {
    const live = join(work, "vernissage.db");
    const raffleId = openRaffle(live);

    // Backup taken while the raffle was still open...
    const { archivePath } = await runBackup({
      databasePath: live,
      outDir: join(work, "archives"),
      env: {},
    });

    // ...and the raffle has since closed, committed and drawn.
    closeAndDraw(live, raffleId);

    await expect(
      runRestore({ archivePath, databasePath: live, force: true }),
    ).rejects.toThrow(/already been announced/i);

    // Refusing must leave the live database exactly as it was.
    const db = openDb(live);
    const raffle = db.prepare(`SELECT status, draw_commitment FROM raffles`).get() as {
      status: string;
      draw_commitment: string;
    };
    db.close();
    expect(raffle.status).toBe("drawn");
    expect(raffle.draw_commitment).toBe("b".repeat(64));
    expect(existsSync(`${live}.pre-restore-20260101T000000Z`)).toBe(false);
  });

  it("names the raffle and the reason, so the refusal explains itself", async () => {
    const live = join(work, "vernissage.db");
    const raffleId = openRaffle(live);
    const { archivePath } = await runBackup({
      databasePath: live,
      outDir: join(work, "archives"),
      env: {},
    });
    closeAndDraw(live, raffleId);

    const error = await runRestore({ archivePath, databasePath: live, force: true }).catch(
      (e: Error) => e,
    );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("Winter draw");
    expect(message).toContain("--rewrite-published-draws");
  });

  it("goes ahead when the operator opts in explicitly", async () => {
    const live = join(work, "vernissage.db");
    const raffleId = openRaffle(live);
    const { archivePath } = await runBackup({
      databasePath: live,
      outDir: join(work, "archives"),
      env: {},
    });
    closeAndDraw(live, raffleId);

    const result = await runRestore({
      archivePath,
      databasePath: live,
      force: true,
      rewritePublishedDraws: true,
    });

    expect(result.stats.rowCounts.raffles).toBe(1);
    const db = openDb(live);
    const status = (db.prepare(`SELECT status FROM raffles`).get() as { status: string }).status;
    db.close();
    expect(status).toBe("open");
  });

  it("allows a backup taken after the draw, and reports what reverts", async () => {
    const live = join(work, "vernissage.db");
    const raffleId = openRaffle(live);
    closeAndDraw(live, raffleId);

    // Backup taken after the draw: it carries the same commitment, so the bot
    // would reuse the same secret and reach the same winners.
    const { archivePath } = await runBackup({
      databasePath: live,
      outDir: join(work, "archives"),
      env: {},
    });

    // A later entry on a second raffle that the backup does not know about.
    const db = openDb(live);
    const later = createDraft(db, GUILD, "mod-1", "2026-02-01T10:00:00.000Z");
    updateRaffleFields(db, later, { name: "Spring draw" });
    setStatus(db, later, "open");
    addEntry(db, later, "user-c", "2026-02-02T10:00:00.000Z");
    db.close();

    const result = await runRestore({ archivePath, databasePath: live, force: true });

    expect(result.warnings.join("\n")).toContain("Spring draw");
    expect(result.warnings.join("\n")).toMatch(/is not in it/);
  });

  it("reports imported wins, which have no raffle to be counted against", async () => {
    const live = join(work, "vernissage.db");
    openRaffle(live);
    const { archivePath } = await runBackup({
      databasePath: live,
      outDir: join(work, "archives"),
      env: {},
    });

    // A win recorded by a moderator for a prize won outside the bot. It has no
    // raffle_id, but it gates the win cooldown just like a drawn win.
    const db = openDb(live);
    db.prepare(
      `INSERT INTO wins (raffle_id, guild_id, source, note, user_id, won_at)
       VALUES (NULL, ?, 'external', ?, ?, ?)`,
    ).run(GUILD, "won at the launch party", "user-d", "2026-02-01T10:00:00.000Z");
    addBan(db, {
      guildId: GUILD,
      userId: "user-e",
      bannedBy: "mod-1",
      reason: "spam",
      bannedAt: "2026-02-02T10:00:00.000Z",
      expiresAt: null,
    });
    db.close();

    const result = await runRestore({ archivePath, databasePath: live, force: true });

    const warnings = result.warnings.join("\n");
    expect(warnings).toMatch(/1 manually recorded win/);
    expect(warnings).toMatch(/win cooldowns/);
    expect(warnings).toMatch(/1 blacklist entry/);
  });

  it("says a manual raffle waits for a moderator rather than drawing itself", async () => {
    const live = join(work, "vernissage.db");
    const raffleId = openRaffle(live);

    // Committed at close but drawn manually, so the backup carries the same
    // commitment and the blocking check passes.
    let db = openDb(live);
    updateRaffleFields(db, raffleId, { draw_mode: "manual" });
    setStatus(db, raffleId, "closed");
    setEntrantsHash(db, raffleId, "c".repeat(64));
    setDrawCommitment(db, raffleId, "b".repeat(64), "a".repeat(64));
    db.close();

    const { archivePath } = await runBackup({
      databasePath: live,
      outDir: join(work, "archives"),
      env: {},
    });

    db = openDb(live);
    setStatus(db, raffleId, "drawn");
    db.close();

    const result = await runRestore({ archivePath, databasePath: live, force: true });

    const warnings = result.warnings.join("\n");
    expect(warnings).toContain("/raffle-mod draw");
    expect(warnings).not.toMatch(/startup reconcile would draw/);
  });

  it("has nothing to compare when restoring onto a fresh host", async () => {
    const source = join(work, "source.db");
    openRaffle(source);
    const { archivePath } = await runBackup({
      databasePath: source,
      outDir: join(work, "archives"),
      env: {},
    });

    const fresh = join(work, "fresh", "vernissage.db");
    const result = await runRestore({ archivePath, databasePath: fresh, force: false });
    expect(result.warnings).toEqual([]);
  });
});
