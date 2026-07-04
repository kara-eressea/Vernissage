/**
 * Draw orchestration (non-pure: DB + announcer, no discord.js).
 *
 * Connects the pure draw primitives (src/core/draw.ts, commitReveal.ts) and the
 * repositories to the raffle lifecycle, implementing the v1 commit-reveal
 * provably-fair scheme (design.md "Provably fair draw"):
 *
 *  - commitOnClose: freeze the entrant list, publish its hash and a SHA-256
 *    commitment of a bot-generated secret. Idempotent.
 *  - executeDraw: reveal the secret, derive the seed, select winners, record
 *    wins, and publish full verification data. Handles the zero-entrant case.
 *  - rerollWinner: disqualify a winner and re-select from the same base seed
 *    with the disqualified set excluded (reproducible from public data).
 *
 * All DB writes for one step run in a single transaction; Discord posting via
 * the announcer happens after the transaction commits. The randomness source is
 * kept behind the injectable secret generator and `deriveSeed`, so drand can
 * replace the revealed secret later without touching this module.
 */

import { randomBytes } from "node:crypto";
import type { Database } from "better-sqlite3";
import { resolveAnnounceChannelId } from "../core/announceFormat.js";
import { AUDIT_EVENTS } from "../core/auditEvents.js";
import { formatAuditLine } from "../core/auditFormat.js";
import { claimDeadline, claimWindowEnabled } from "../core/claim.js";
import { commitSecret } from "../core/commitReveal.js";
import { deriveSeed, hashEntrants, selectWinners } from "../core/draw.js";
import {
  formatCommitmentPost,
  formatResultPost,
  formatRerollPost,
  formatWinnerAnnouncement,
} from "../core/drawFormat.js";
import type { DrawMode } from "../core/types.js";
import { writeAudit } from "../db/repositories/audit.js";
import { isBlacklisted } from "../db/repositories/blacklist.js";
import { listEntrants, removeEntry } from "../db/repositories/entries.js";
import { getGuild } from "../db/repositories/guilds.js";
import {
  disqualifiedEntrants,
  getRaffle,
  listByStatusAllGuilds,
  setDrawCommitment,
  setDrawDisqualified,
  setEntrantsHash,
  setStatus,
  type RaffleRow,
} from "../db/repositories/raffles.js";
import {
  activeWinnerIds,
  addWin,
  claimWin,
  getActiveWinForUser,
  getWin,
  listExpiredUnclaimedWins,
  listWinsForRaffle,
  markRerolled,
} from "../db/repositories/wins.js";

/** The subset of the notifier the draw service posts through. */
export interface DrawAnnouncer {
  postAudit(guildId: string, content: string): Promise<void>;
  postAnnouncement(channelId: string, content: string): Promise<string | undefined>;
}

/** Produces a fresh draw secret. Injectable so tests are deterministic. */
export type SecretGenerator = () => string;

/** A winner disqualified by the draw failsafe and why. */
type Disqualification = { id: string; reason: "left_guild" | "blacklisted" };

/** The outcome of the pulled-winner failsafe: the final winners and who was removed. */
interface ResolvedWinners {
  winners: string[];
  removals: Disqualification[];
  excluded: Set<string>;
}

/**
 * Select winners over the frozen entrant list, applying the pulled-winner
 * failsafe: any winner who has left the guild or been blacklisted is excluded
 * and the selection re-runs from the same base seed with them removed
 * (verifiable exactly like a reroll — indices stay seed mod entrant_count over
 * the committed list). Only the pulled winners are checked, so this is cheap
 * regardless of entrant count. Bounded: `excluded` grows each pass, so it
 * terminates when every winner is valid or the eligible pool is exhausted.
 */
async function resolveValidWinners(
  db: Database,
  raffle: RaffleRow,
  entrants: string[],
  seed: string,
  now: string,
  resolveMembers?: PresenceResolver,
): Promise<ResolvedWinners> {
  const excluded = new Set<string>();
  const removals: Disqualification[] = [];
  let winners =
    entrants.length === 0 ? [] : selectWinners(entrants, seed, raffle.winner_count, excluded);
  while (winners.length > 0) {
    const present = resolveMembers ? await resolveMembers(raffle.guild_id, winners) : null;
    const invalid: Disqualification[] = [];
    for (const w of winners) {
      if (present && !present.has(w)) {
        invalid.push({ id: w, reason: "left_guild" });
      } else if (isBlacklisted(db, raffle.guild_id, w, now)) {
        invalid.push({ id: w, reason: "blacklisted" });
      }
    }
    if (invalid.length === 0) {
      break;
    }
    for (const bad of invalid) {
      excluded.add(bad.id);
      removals.push(bad);
    }
    winners = selectWinners(entrants, seed, raffle.winner_count, excluded);
  }
  return { winners, removals, excluded };
}

/**
 * Resolves which of `candidateIds` are still present in the guild. Returns the
 * present set, or null when membership can't be reliably determined (in which
 * case no one is treated as departed). Injected so the service stays free of
 * discord.js; the Discord layer supplies a REST-backed implementation.
 */
export type PresenceResolver = (
  guildId: string,
  candidateIds: string[],
) => Promise<ReadonlySet<string> | null>;

/** Default secret: 32 random bytes as hex. Non-deterministic (hence not in core). */
export const generateSecret: SecretGenerator = () => randomBytes(32).toString("hex");

export type DrawOutcome =
  | { ok: true; winners: string[] }
  | { ok: false; reason: "not_found" | "not_closed" | "already_drawn" };

export type RerollOutcome =
  | { ok: true; disqualified: string; replacement: string | null }
  | { ok: false; reason: "not_found" | "not_drawn" | "invalid_win" };

export type ClaimOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: "not_found" | "not_drawn" | "not_winner" | "no_claim_required" | "already_claimed";
    };

/** Resolve the channel a raffle announces in, or null if none is configured. */
function announceChannelFor(db: Database, raffle: RaffleRow): string | null {
  const guild = getGuild(db, raffle.guild_id);
  return resolveAnnounceChannelId(raffle.channel_id, guild?.announce_channel ?? null);
}

/**
 * The claim deadline a winner drawn at `now` gets, or null when the raffle sets
 * no claim window. All winners drawn in one step share the same deadline; a
 * rerolled replacement gets a fresh one from its own draw moment.
 */
function winnerDeadline(raffle: RaffleRow, now: string): string | null {
  return claimWindowEnabled(raffle.claim_window_hours)
    ? claimDeadline(now, raffle.claim_window_hours)
    : null;
}

/**
 * Freeze entries and publish the commitment for a closed raffle. Idempotent: if
 * the entrant hash is already set (committed earlier, or on a re-run), it does
 * nothing. Only operates on `closed` raffles.
 */
export async function commitOnClose(
  db: Database,
  announcer: DrawAnnouncer,
  raffleId: number,
  now: string,
  generate: SecretGenerator = generateSecret,
): Promise<void> {
  const existing = getRaffle(db, raffleId);
  if (!existing || existing.status !== "closed" || existing.entrants_hash !== null) {
    return;
  }

  const entrants = listEntrants(db, raffleId);
  const entrantsHash = hashEntrants(entrants);
  const secret = generate();
  const commitment = commitSecret(secret);

  // Re-check inside the transaction so two concurrent close/reconcile paths
  // can't both commit (which would overwrite the secret and double-publish).
  // Transactions are synchronous and serialize, so only the first one commits.
  let committed = false;
  db.transaction(() => {
    const fresh = getRaffle(db, raffleId);
    if (!fresh || fresh.status !== "closed" || fresh.entrants_hash !== null) {
      return;
    }
    setEntrantsHash(db, raffleId, entrantsHash);
    setDrawCommitment(db, raffleId, commitment, secret);
    writeAudit(db, {
      guildId: existing.guild_id,
      raffleId,
      eventType: AUDIT_EVENTS.drawCommitted,
      actorId: "system",
      payload: { entrantsHash, commitment },
      createdAt: now,
    });
    committed = true;
  })();
  if (!committed) {
    return;
  }

  await announcer.postAudit(
    existing.guild_id,
    formatCommitmentPost({
      raffleId,
      raffleName: existing.name,
      entrantIds: entrants,
      entrantsHash,
      commitment,
      now,
    }),
  );
}

/**
 * Execute the draw for a closed raffle: ensure it is committed, reveal the
 * secret, select winners, record wins, mark it drawn, and publish verification
 * data plus a public winner announcement. The zero-entrant case is drawn with
 * no winner (design.md edge case). Safe to call on an already-drawn raffle (it
 * reports `already_drawn`).
 */
export async function executeDraw(
  db: Database,
  announcer: DrawAnnouncer,
  raffleId: number,
  now: string,
  generate: SecretGenerator = generateSecret,
  resolveMembers?: PresenceResolver,
): Promise<DrawOutcome> {
  const pre = getRaffle(db, raffleId);
  if (!pre) {
    return { ok: false, reason: "not_found" };
  }
  if (pre.status === "drawn" || pre.status === "completed") {
    return { ok: false, reason: "already_drawn" };
  }
  if (pre.status !== "closed") {
    return { ok: false, reason: "not_closed" };
  }

  // Ensure the commitment exists (idempotent). For the normal flow this already
  // ran at close; for a manual draw on an uncommitted raffle it commits now.
  await commitOnClose(db, announcer, raffleId, now, generate);

  const raffle = getRaffle(db, raffleId);
  if (
    !raffle ||
    raffle.entrants_hash === null ||
    raffle.draw_secret === null ||
    raffle.draw_commitment === null
  ) {
    // Unreachable after a successful commit, but fail safe rather than throw.
    return { ok: false, reason: "not_closed" };
  }
  const entrantsHash = raffle.entrants_hash;
  const secret = raffle.draw_secret;
  const commitment = raffle.draw_commitment;

  // The frozen entrant list is the one the published hash was computed over.
  // Entries are not mutated between here and the transaction, and after the
  // draw the only removals are the failsafe ones recorded in draw_disqualified,
  // so this same committed list is reconstructable at reroll time.
  const entrants = listEntrants(db, raffleId);
  const seed = deriveSeed(entrantsHash, secret);
  const { winners, removals, excluded } = await resolveValidWinners(
    db,
    raffle,
    entrants,
    seed,
    now,
    resolveMembers,
  );

  // Re-check status inside the transaction so a concurrent close/reconcile path
  // cannot draw the same raffle twice (which would duplicate the wins rows).
  // Only the first transaction to flip closed->drawn writes; the other aborts.
  let drew = false;
  db.transaction(() => {
    const fresh = getRaffle(db, raffleId);
    if (!fresh || fresh.status !== "closed") {
      return;
    }
    for (const bad of removals) {
      removeEntry(db, raffleId, bad.id, now, bad.reason);
      writeAudit(db, {
        guildId: raffle.guild_id,
        raffleId,
        eventType: AUDIT_EVENTS.entryRemoved,
        actorId: "system",
        payload: { userId: bad.id },
        createdAt: now,
      });
    }
    // Freeze the disqualified set so a later reroll reconstructs the committed
    // entrant list (active entries + these) and excludes them, keeping every
    // reroll reproducible over the same list the published hash covers.
    if (removals.length > 0) {
      setDrawDisqualified(db, raffleId, removals.map((r) => r.id));
    }
    const deadline = winnerDeadline(raffle, now);
    for (const winner of winners) {
      addWin(db, raffleId, winner, now, deadline);
    }
    setStatus(db, raffleId, "drawn");
    writeAudit(db, {
      guildId: raffle.guild_id,
      raffleId,
      eventType: AUDIT_EVENTS.raffleDrawn,
      actorId: "system",
      // Distinguish a genuinely empty raffle from one whose every eligible
      // winner was disqualified by the failsafe (entrants existed, none valid).
      payload: winners.length === 0
        ? {
            winners,
            reason: entrants.length === 0 ? "no_entrants" : "no_eligible_winners",
            excluded: [...excluded],
          }
        : { winners, seed, secret, entrantsHash, commitment, excluded: [...excluded] },
      createdAt: now,
    });
    drew = true;
  })();
  if (!drew) {
    return { ok: false, reason: "already_drawn" };
  }

  for (const bad of removals) {
    await announcer.postAudit(
      raffle.guild_id,
      formatAuditLine({
        eventType: AUDIT_EVENTS.entryRemoved,
        raffleId,
        actorId: "system",
        payload: { userId: bad.id },
        createdAt: now,
      }),
    );
  }

  await announcer.postAudit(
    raffle.guild_id,
    formatResultPost({
      raffleId,
      raffleName: raffle.name,
      winners,
      entrantsHash,
      commitment,
      secret,
      seed,
      excluded: [...excluded],
      now,
    }),
  );
  const channelId = announceChannelFor(db, raffle);
  if (channelId) {
    await announcer.postAnnouncement(
      channelId,
      formatWinnerAnnouncement({
        raffleName: raffle.name,
        prize: raffle.prize,
        winners,
        claimDeadline: winnerDeadline(raffle, now),
      }),
    );
  }

  return { ok: true, winners };
}

/**
 * Disqualify a winner and draw a replacement. Marks the win rerolled, then
 * re-selects `winner_count` winners from the same base seed with every
 * disqualified id excluded; the newly-selected id(s) not already active are the
 * replacement(s). The mod-entered reason is stored in the audit row (mod-only),
 * not published. Only valid on a `drawn` raffle for a live (non-rerolled) win.
 */
export async function rerollWinner(
  db: Database,
  announcer: DrawAnnouncer,
  raffleId: number,
  winId: number,
  reason: string,
  now: string,
): Promise<RerollOutcome> {
  const raffle = getRaffle(db, raffleId);
  if (!raffle) {
    return { ok: false, reason: "not_found" };
  }
  if (raffle.status !== "drawn") {
    return { ok: false, reason: "not_drawn" };
  }
  const win = getWin(db, winId);
  if (!win || win.raffle_id !== raffleId || win.rerolled === 1) {
    return { ok: false, reason: "invalid_win" };
  }
  if (raffle.entrants_hash === null || raffle.draw_secret === null) {
    // A drawn raffle is always committed; fail safe rather than throw.
    return { ok: false, reason: "invalid_win" };
  }
  const entrantsHash = raffle.entrants_hash;
  const secret = raffle.draw_secret;

  // Reconstruct the frozen entrant list the commitment covers: the still-active
  // entries plus the ids the draw failsafe removed (draw_disqualified). Sorting
  // matches the order commit froze, so `selectWinners` reproduces the same
  // indices — selecting over the current (shrunk) list instead would change the
  // entrant count and break verifiability.
  const disqualified = disqualifiedEntrants(raffle);
  const committedEntrants = [...listEntrants(db, raffleId), ...disqualified].sort();
  const seed = deriveSeed(entrantsHash, secret);
  let replacement: string | null = null;

  // Re-check status and the win's rerolled flag inside the transaction so a
  // double-clicked reroll can't fire twice: the second call would otherwise
  // pass the pre-transaction guards, re-mark the same win, and emit a spurious
  // draw_reroll. Transactions serialize, so only the first flips rerolled.
  let rerolled = false;
  db.transaction(() => {
    const freshRaffle = getRaffle(db, raffleId);
    const freshWin = getWin(db, winId);
    if (
      !freshRaffle ||
      freshRaffle.status !== "drawn" ||
      !freshWin ||
      freshWin.rerolled === 1
    ) {
      return;
    }
    markRerolled(db, winId);
    // Exclude every rerolled winner and every id the draw failsafe disqualified,
    // so the reroll never reselects a removed winner and stays a faithful
    // continuation of the committed draw.
    const excluded = new Set<string>([
      ...disqualified,
      ...listWinsForRaffle(db, raffleId)
        .filter((w) => w.rerolled === 1)
        .map((w) => w.user_id),
    ]);
    const selection = selectWinners(committedEntrants, seed, raffle.winner_count, excluded);
    const active = new Set(activeWinnerIds(db, raffleId));
    const replacements = selection.filter((id) => !active.has(id));
    // A replacement drawn now starts its own claim window from this moment.
    const deadline = winnerDeadline(raffle, now);
    for (const id of replacements) {
      addWin(db, raffleId, id, now, deadline);
    }
    replacement = replacements[0] ?? null;
    writeAudit(db, {
      guildId: raffle.guild_id,
      raffleId,
      eventType: AUDIT_EVENTS.drawReroll,
      actorId: "system",
      payload: { disqualified: win.user_id, replacement, reason, seed },
      createdAt: now,
    });
    rerolled = true;
  })();
  if (!rerolled) {
    return { ok: false, reason: "invalid_win" };
  }

  await announcer.postAudit(
    raffle.guild_id,
    formatRerollPost({
      raffleId,
      raffleName: raffle.name,
      disqualified: win.user_id,
      replacement,
      now,
    }),
  );
  const channelId = announceChannelFor(db, raffle);
  if (channelId && replacement) {
    await announcer.postAnnouncement(
      channelId,
      formatWinnerAnnouncement({
        raffleName: raffle.name,
        prize: raffle.prize,
        winners: [replacement],
        claimDeadline: winnerDeadline(raffle, now),
      }),
    );
  }

  return { ok: true, disqualified: win.user_id, replacement };
}

/**
 * Record a winner's claim. Valid only while the raffle is `drawn` and the caller
 * holds a live (non-rerolled) win with a claim deadline. The `claimWin` update is
 * conditional, so a double-click or a race with the expiry sweep can't
 * double-claim. On success writes and mirrors a `win_claimed` audit row.
 */
export async function recordClaim(
  db: Database,
  announcer: DrawAnnouncer,
  raffleId: number,
  userId: string,
  now: string,
): Promise<ClaimOutcome> {
  const raffle = getRaffle(db, raffleId);
  if (!raffle) {
    return { ok: false, reason: "not_found" };
  }
  if (raffle.status !== "drawn") {
    return { ok: false, reason: "not_drawn" };
  }
  const win = getActiveWinForUser(db, raffleId, userId);
  if (!win) {
    return { ok: false, reason: "not_winner" };
  }
  if (win.claim_deadline === null) {
    // The raffle set no claim window, so there is nothing to claim.
    return { ok: false, reason: "no_claim_required" };
  }
  if (win.claimed_at !== null) {
    return { ok: false, reason: "already_claimed" };
  }

  let claimed = false;
  db.transaction(() => {
    if (!claimWin(db, win.win_id, now)) {
      return; // Lost the race to another claim or the expiry sweep.
    }
    writeAudit(db, {
      guildId: raffle.guild_id,
      raffleId,
      eventType: AUDIT_EVENTS.winClaimed,
      actorId: userId,
      payload: { userId },
      createdAt: now,
    });
    claimed = true;
  })();
  if (!claimed) {
    return { ok: false, reason: "already_claimed" };
  }

  void announcer.postAudit(
    raffle.guild_id,
    formatAuditLine({
      eventType: AUDIT_EVENTS.winClaimed,
      raffleId,
      actorId: userId,
      payload: { userId },
      createdAt: now,
    }),
  );
  return { ok: true };
}

/**
 * Reroll every winner whose claim window has lapsed unclaimed. Each expired slot
 * is rerolled to the next eligible entrant over the frozen committed list (via
 * `rerollWinner`, so it stays provably fair), and the replacement starts its own
 * claim window. Replacements that also go unclaimed are caught on a later sweep;
 * when the pool is exhausted `rerollWinner` fills no slot and logs it. Returns
 * how many slots were rerolled. The scheduler calls this on an interval.
 */
export async function expireUnclaimedWins(
  db: Database,
  announcer: DrawAnnouncer,
  now: string,
): Promise<number> {
  const expired = listExpiredUnclaimedWins(db, now);
  let rerolled = 0;
  for (const win of expired) {
    try {
      const outcome = await rerollWinner(db, announcer, win.raffle_id, win.win_id, "unclaimed", now);
      if (outcome.ok) {
        rerolled += 1;
      }
    } catch (err) {
      console.error(`Failed to expire unclaimed win ${win.win_id}:`, err);
    }
  }
  return rerolled;
}

/**
 * React to a raffle closing: commit, then auto-draw if the raffle draws
 * automatically. Manual raffles stop after the commit and wait for `/raffle
 * draw`. This is the seam the scheduler's onTransition close calls.
 */
export async function onRaffleClosed(
  db: Database,
  announcer: DrawAnnouncer,
  raffleId: number,
  drawMode: DrawMode | null,
  now: string,
  generate: SecretGenerator = generateSecret,
  resolveMembers?: PresenceResolver,
): Promise<void> {
  await commitOnClose(db, announcer, raffleId, now, generate);
  if (drawMode === "auto") {
    await executeDraw(db, announcer, raffleId, now, generate, resolveMembers);
  }
}

/**
 * Startup reconcile for draws missed while the bot was down. A raffle already
 * `closed` in the DB emits no new transition, so nothing would otherwise commit
 * or draw it. For every closed raffle: commit if uncommitted, and auto-draw if
 * its draw mode is auto. Manual raffles are left committed and awaiting a mod.
 */
export async function reconcilePendingDraws(
  db: Database,
  announcer: DrawAnnouncer,
  now: string,
  generate: SecretGenerator = generateSecret,
  resolveMembers?: PresenceResolver,
): Promise<void> {
  const closed = listByStatusAllGuilds(db, ["closed"]);
  for (const raffle of closed) {
    try {
      await onRaffleClosed(
        db,
        announcer,
        raffle.raffle_id,
        raffle.draw_mode as DrawMode | null,
        now,
        generate,
        resolveMembers,
      );
    } catch (err) {
      console.error(`Failed to reconcile draw for raffle ${raffle.raffle_id}:`, err);
    }
  }
}
