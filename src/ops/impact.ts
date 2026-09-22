/**
 * What restoring an archive would do to the data that is already there.
 *
 * A restore is judged safe or unsafe by the raffle state it overwrites, not by
 * anything inside the archive. The dangerous case is subtle enough to be worth
 * detecting rather than documenting: if the live database has a raffle whose
 * commitment was already published to the audit channel, and the archive
 * predates that commitment, then on restart the bot sees an uncommitted raffle,
 * generates a *new* secret, publishes a second commitment, and draws again from
 * a different seed — so the winners it announces need not match the ones it
 * already announced (see commitOnClose in src/draw/service.ts, which skips only
 * when entrants_hash is already set).
 *
 * That is the one thing a restore can break irreversibly and in public, so it
 * is reported separately from the merely lossy cases.
 */

import type { Database } from "better-sqlite3";

export interface RestoreImpact {
  /**
   * Changes that would rewrite something already announced in Discord. These
   * stop a restore unless the operator explicitly opts in.
   */
  blocking: string[];
  /** Data that would be lost or reverted, but nothing already published. */
  advisory: string[];
}

interface RaffleState {
  raffle_id: number;
  name: string | null;
  status: string | null;
  draw_mode: string | null;
  draw_commitment: string | null;
}

function raffleStates(db: Database): Map<number, RaffleState> {
  const rows = db
    .prepare(`SELECT raffle_id, name, status, draw_mode, draw_commitment FROM raffles`)
    .all() as RaffleState[];
  return new Map(rows.map((r) => [r.raffle_id, r]));
}

function entryCountsByRaffle(db: Database): Map<number, number> {
  const rows = db
    .prepare(`SELECT raffle_id, count(*) AS n FROM entries GROUP BY raffle_id`)
    .all() as { raffle_id: number; n: number }[];
  return new Map(rows.map((r) => [r.raffle_id, r.n]));
}

/**
 * Every win by id and the raffle it belongs to. Keyed on win_id rather than
 * counted per raffle because since v20 an imported win (`/raffle-mod record-win`)
 * has no raffle_id at all, and those gate the win cooldown and the prior-winner
 * bar exactly like a drawn one — losing them silently would quietly re-open
 * eligibility for people who should still be barred.
 */
function winsById(db: Database): Map<number, number | null> {
  const rows = db.prepare(`SELECT win_id, raffle_id FROM wins`).all() as {
    win_id: number;
    raffle_id: number | null;
  }[];
  return new Map(rows.map((r) => [r.win_id, r.raffle_id]));
}

/** Blacklist entries by their natural key, so bans added since are noticed. */
function banKeys(db: Database): Set<string> {
  const rows = db.prepare(`SELECT guild_id, user_id FROM blacklist`).all() as {
    guild_id: string;
    user_id: string;
  }[];
  return new Set(rows.map((r) => `${r.guild_id}:${r.user_id}`));
}

function describe(raffle: RaffleState): string {
  return raffle.name ? `raffle ${raffle.raffle_id} ("${raffle.name}")` : `raffle ${raffle.raffle_id}`;
}

/**
 * Compare the database about to be replaced against the one in the archive.
 * Both connections are read-only; nothing here writes.
 */
export function compareForRestore(live: Database, archived: Database): RestoreImpact {
  const blocking: string[] = [];
  const advisory: string[] = [];

  const liveRaffles = raffleStates(live);
  const archivedRaffles = raffleStates(archived);

  for (const [id, current] of liveRaffles) {
    const inArchive = archivedRaffles.get(id);

    if (current.draw_commitment !== null && inArchive?.draw_commitment !== current.draw_commitment) {
      // The commitment is public. Restoring a database that does not carry this
      // exact one means the bot will commit and draw the raffle again.
      blocking.push(
        `${describe(current)} has a published draw commitment that this backup does not carry` +
          `${inArchive === undefined ? " (the raffle does not exist in the backup at all)" : ""}. ` +
          `Restoring would make the bot commit and draw it a second time, with a new secret and ` +
          `possibly different winners than the ones already announced.`,
      );
      continue;
    }

    if (inArchive === undefined) {
      advisory.push(`${describe(current)} was created after this backup and is not in it.`);
    } else if (current.status !== inArchive.status) {
      advisory.push(
        `${describe(current)} is "${current.status}" now but "${inArchive.status}" in the backup; ` +
          whatHappensNext(inArchive),
      );
    }
  }

  compareEntries(live, archived, liveRaffles, advisory);
  compareWins(live, archived, liveRaffles, advisory);

  const bansNow = banKeys(live);
  const bansThen = banKeys(archived);
  const lostBans = [...bansNow].filter((key) => !bansThen.has(key)).length;
  if (lostBans > 0) {
    advisory.push(
      `${lostBans} blacklist entr${lostBans === 1 ? "y" : "ies"} added since this backup ` +
        `${lostBans === 1 ? "is" : "are"} not in it.`,
    );
  }

  return { blocking, advisory };
}

/**
 * What the bot does with a raffle restored in the archive's status. The
 * scheduler only drives `scheduled` and `open` raffles, but a `closed` one is
 * picked up separately by the startup reconcile — which auto-draws it or leaves
 * it for a moderator, depending on its draw mode.
 */
function whatHappensNext(restored: RaffleState): string {
  if (restored.status !== "closed") {
    return `the scheduler would move it forward again on startup.`;
  }
  if (restored.draw_mode === "manual") {
    return `it would stay closed on startup until a moderator runs \`/raffle-mod draw\`.`;
  }
  return (
    `the startup reconcile would draw it again from the same committed secret, ` +
    `so the same winners come out.`
  );
}

function compareEntries(
  live: Database,
  archived: Database,
  liveRaffles: Map<number, RaffleState>,
  advisory: string[],
): void {
  const now = entryCountsByRaffle(live);
  const then = entryCountsByRaffle(archived);

  for (const [id, current] of now) {
    const before = then.get(id) ?? 0;
    if (current > before) {
      advisory.push(`${current - before} of the ${current} entries on ${named(liveRaffles, id)} are not in the backup.`);
    }
  }
}

function compareWins(
  live: Database,
  archived: Database,
  liveRaffles: Map<number, RaffleState>,
  advisory: string[],
): void {
  const now = winsById(live);
  const then = winsById(archived);

  const lostByRaffle = new Map<number, number>();
  let lostImported = 0;

  for (const [winId, raffleId] of now) {
    if (then.has(winId)) {
      continue;
    }
    if (raffleId === null) {
      lostImported += 1;
    } else {
      lostByRaffle.set(raffleId, (lostByRaffle.get(raffleId) ?? 0) + 1);
    }
  }

  for (const [raffleId, count] of lostByRaffle) {
    advisory.push(`${count} recorded win${count === 1 ? "" : "s"} on ${named(liveRaffles, raffleId)} ${count === 1 ? "is" : "are"} not in the backup.`);
  }

  if (lostImported > 0) {
    advisory.push(
      `${lostImported} manually recorded win${lostImported === 1 ? "" : "s"} ` +
        `(\`/raffle-mod record-win\`) ${lostImported === 1 ? "is" : "are"} not in the backup; ` +
        `${lostImported === 1 ? "it gates" : "they gate"} win cooldowns and the prior-winner bar.`,
    );
  }
}

function named(raffles: Map<number, RaffleState>, id: number): string {
  const raffle = raffles.get(id);
  return raffle ? describe(raffle) : `raffle ${id}`;
}
