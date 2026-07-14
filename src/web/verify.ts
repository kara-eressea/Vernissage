/**
 * Draw-verification view model.
 *
 * Recomputes a finished raffle's provably-fair draw from the public data the bot
 * stored (docs/dashboard.md "A draw-verification page"): the frozen committed
 * entrant list, its SHA-256 hash, the revealed secret and its commitment, the
 * derived seed, and the winners. Every value is re-derived here with the *same*
 * pure core the draw itself used (`hashEntrants`, `commitSecret`, `deriveSeed`,
 * `selectWinners`), so the page can never drift from the real scheme — the same
 * "reuse the core" rule the simulator follows. The check is presented step by
 * step and the page re-runs it in the browser too, so a "verified" badge needs
 * no trust in the operator.
 *
 * Fidelity notes. Like the simulator, the web process has no gateway or token,
 * so members are shown by id, not handle. The scheme is richer than a single
 * "seed mod N" pick: winners are reconstructed over the *committed* list (active
 * entrants plus the ids the draw failsafe removed, `draw_disqualified`), with the
 * failsafe-removed and any rerolled winners excluded — exactly the reconstruction
 * `rerollWinner`/`reannounceDraw` use — so multi-winner, failsafe, and rerolled
 * draws all verify against the standing winners.
 */

import { commitSecret } from "../core/commitReveal.js";
import { deriveSeed, hashEntrants, selectWinners } from "../core/draw.js";
import type { Database } from "../db/index.js";
import { getAuditForRaffle } from "../db/repositories/audit.js";
import { listEntrants } from "../db/repositories/entries.js";
import { getMemberNames } from "../db/repositories/members.js";
import {
  disqualifiedEntrants,
  getGuildRaffle,
  listByStatus,
  type RaffleRow,
} from "../db/repositories/raffles.js";
import { activeWinnerIds, listWinsForRaffle } from "../db/repositories/wins.js";

/** The event_type written when a raffle is drawn (mirrors AUDIT_EVENTS). */
const RAFFLE_DRAWN = "raffle_drawn";

/** The statuses whose draw is finished and therefore verifiable. */
const VERIFIABLE_STATUSES = ["drawn", "completed"] as const;

/** Whether a raffle's draw is finished (its secret is public). */
function isDrawn(status: string): boolean {
  return (VERIFIABLE_STATUSES as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------------
// View-model shapes
// ---------------------------------------------------------------------------

/** One line of the proof. `check` steps pass or fail; others are derivations. */
export type StepStatus = "ok" | "fail" | "blocked";

export interface VerifyStep {
  n: number;
  title: string;
  desc: string;
  status: StepStatus;
  /** The hex value this step produces (hash, secret, seed), when it has one. */
  value?: string;
}

/** The commitment comparison rendered in step 3. */
export interface CommitmentCheck {
  /** SHA-256(secret), recomputed here. */
  selfValue: string;
  /** The commitment the bot published before the draw. */
  publishedValue: string;
  match: boolean;
}

/** One entrant row in the full committed list. */
export interface EntrantRow {
  index: number;
  userId: string;
  /** Cached display name, or null when the bot hasn't seen this member. */
  name: string | null;
  isWinner: boolean;
  /** Removed by the draw failsafe (left the guild or blacklisted at draw). */
  isExcluded: boolean;
}

/** A standing winner and where it sits in the committed list. */
export interface WinnerRow {
  userId: string;
  /** Cached display name, or null when the bot hasn't seen this member. */
  name: string | null;
  index: number;
}

/** Everything the verification page renders for one drawn raffle. */
export interface VerificationView {
  state: "verified" | "failed";
  raffleId: number;
  raffleName: string;
  isTest: boolean;
  drawnDate: string | null;
  entrantCount: number;
  winnerCount: number;
  winners: WinnerRow[];
  /** Ids the draw failsafe removed, then excluded (usually empty). */
  excluded: string[];
  entrants: EntrantRow[];
  steps: VerifyStep[];
  commitment: CommitmentCheck;
  /** The exact preimage the seed is SHA-256 of, so recomputation is unambiguous. */
  seedPreimage: string;
  entrantsHash: string;
  secret: string;
  seed: string;
  /** The public inputs the in-browser check recomputes from. */
  recompute: RecomputeInput;
}

/** The minimal public data the browser needs to recompute the draw itself. */
export interface RecomputeInput {
  ids: string[];
  secret: string;
  commitment: string;
  hash: string;
  seed: string;
  winnerCount: number;
  excluded: string[];
  winners: string[];
}

/** Why a raffle can't be verified, for the friendly "not yet" states. */
export type VerifyUnavailable =
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_drawn"; raffleId: number; raffleName: string; status: string }
  | { ok: false; reason: "missing_data"; raffleId: number; raffleName: string };

export type VerificationResult = ({ ok: true } & VerificationView) | VerifyUnavailable;

/** A drawn raffle as the verifier index lists it. */
export interface VerifiableRaffleCard {
  id: number;
  name: string;
  isTest: boolean;
  status: string;
  drawnDate: string | null;
  entrantCount: number;
  winnerCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A display name for a raffle, falling back to its id. */
function raffleName(raffle: RaffleRow): string {
  return raffle.name ?? `Raffle #${raffle.raffle_id}`;
}

/**
 * The frozen committed entrant list the published hash covers: the still-active
 * entrants plus the ids the draw failsafe removed, sorted. This is the exact
 * list `commitOnClose` hashed and every reroll re-selects over.
 */
function committedEntrants(db: Database, raffle: RaffleRow): string[] {
  return [...listEntrants(db, raffle.raffle_id), ...disqualifiedEntrants(raffle)].sort();
}

/** When the raffle was drawn, from the `raffle_drawn` audit row (or null). */
function drawnAt(db: Database, raffleId: number): string | null {
  const row = getAuditForRaffle(db, raffleId).find((r) => r.event_type === RAFFLE_DRAWN);
  return row?.created_at ?? null;
}

/** Ordered equality of two id lists. */
function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

// ---------------------------------------------------------------------------
// The verification
// ---------------------------------------------------------------------------

/**
 * Recompute and verify a raffle's draw. Returns a full `VerificationView` for a
 * finished raffle, or an `unavailable` result for one that isn't drawn yet or is
 * missing its commit-reveal data (never thrown — the page renders a gentle note).
 * Scoped to `guildId`, so a mod can only verify their own server's raffles.
 */
export function buildVerification(
  db: Database,
  guildId: string,
  raffleId: number,
): VerificationResult {
  const raffle = getGuildRaffle(db, guildId, raffleId);
  if (!raffle) {
    return { ok: false, reason: "not_found" };
  }
  if (!isDrawn(raffle.status)) {
    return {
      ok: false,
      reason: "not_drawn",
      raffleId,
      raffleName: raffleName(raffle),
      status: raffle.status,
    };
  }
  if (raffle.entrants_hash === null || raffle.draw_secret === null || raffle.draw_commitment === null) {
    // A drawn raffle is always committed; guard rather than render partial proof.
    return { ok: false, reason: "missing_data", raffleId, raffleName: raffleName(raffle) };
  }

  const publishedHash = raffle.entrants_hash;
  const secret = raffle.draw_secret;
  const publishedCommitment = raffle.draw_commitment;

  const committed = committedEntrants(db, raffle);
  const disqualified = disqualifiedEntrants(raffle);

  // Step 1 — recompute the entrant-list hash over the committed list.
  const computedHash = hashEntrants(committed);
  const hashOk = computedHash === publishedHash;

  // Step 3 — the commitment check: SHA-256(secret) must equal the published one.
  const computedCommitment = commitSecret(secret);
  const commitOk = computedCommitment === publishedCommitment;

  // Step 4 — derive the seed from the published hash and the revealed secret.
  // The preimage is stated exactly (colon-joined) so a verifier can reproduce it.
  const seedPreimage = `${publishedHash}:${secret}`;
  const seed = deriveSeed(publishedHash, secret);

  // Step 5 — reselect the winners over the committed list, excluding the ids the
  // failsafe removed and any later-rerolled winners; this must reproduce the
  // standing (non-rerolled) winners in order.
  const allWins = listWinsForRaffle(db, raffleId);
  const rerolledIds = allWins.filter((w) => w.rerolled === 1).map((w) => w.user_id);
  const excludedSet = new Set<string>([...disqualified, ...rerolledIds]);
  const standingWinners = activeWinnerIds(db, raffleId);
  const computedWinners = selectWinners(committed, seed, raffle.winner_count, excludedSet);
  const winnersOk = sameOrder(computedWinners, standingWinners);

  const verified = hashOk && commitOk && winnersOk;

  const indexOf = new Map(committed.map((id, i) => [id, i]));
  const winnerSet = new Set(standingWinners);
  const excludedForDisplay = new Set(disqualified);
  const names = getMemberNames(db, guildId, [...committed, ...standingWinners]);
  const nameOf = (id: string): string | null => names.get(id)?.displayName ?? null;

  const winners: WinnerRow[] = standingWinners.map((id) => ({
    userId: id,
    name: nameOf(id),
    index: indexOf.get(id) ?? -1,
  }));

  const entrants: EntrantRow[] = committed.map((id, index) => ({
    index,
    userId: id,
    name: nameOf(id),
    isWinner: winnerSet.has(id),
    isExcluded: excludedForDisplay.has(id),
  }));

  const steps: VerifyStep[] = [
    {
      n: 1,
      title: "Entrant-list hash",
      desc: `SHA-256 of the ${committed.length} frozen, sorted entrant ids`,
      status: hashOk ? "ok" : "fail",
      value: publishedHash,
    },
    {
      n: 2,
      title: "Revealed secret",
      desc: "Published by the bot after entries closed — nobody could know it in advance",
      status: "ok",
      value: secret,
    },
    {
      n: 3,
      title: "Commitment check",
      desc: "SHA-256(secret) must equal the commitment published before the draw",
      status: commitOk ? "ok" : "fail",
    },
    {
      n: 4,
      title: "Draw seed",
      desc: "SHA-256( entrant-hash + \":\" + secret )",
      status: commitOk ? "ok" : "blocked",
      value: seed,
    },
    {
      n: 5,
      title: raffle.winner_count > 1 ? "Winner selection" : "Winner index",
      desc: "The seed, reduced to a position in the entrant list",
      status: winnersOk ? (commitOk ? "ok" : "blocked") : commitOk ? "fail" : "blocked",
    },
  ];

  return {
    ok: true,
    state: verified ? "verified" : "failed",
    raffleId,
    raffleName: raffleName(raffle),
    isTest: raffle.is_test === 1,
    drawnDate: drawnAt(db, raffleId),
    entrantCount: committed.length,
    winnerCount: raffle.winner_count,
    winners,
    excluded: disqualified,
    entrants,
    steps,
    commitment: {
      selfValue: computedCommitment,
      publishedValue: publishedCommitment,
      match: commitOk,
    },
    seedPreimage,
    entrantsHash: publishedHash,
    secret,
    seed,
    recompute: {
      ids: committed,
      secret,
      commitment: publishedCommitment,
      hash: publishedHash,
      seed,
      winnerCount: raffle.winner_count,
      excluded: [...excludedSet],
      winners: standingWinners,
    },
  };
}

/**
 * The drawn/completed raffles a moderator can verify in a guild, newest first.
 * A DB-only listing (no draw recompute), so the index stays cheap even with many
 * finished raffles.
 */
export function listVerifiableRaffles(db: Database, guildId: string): VerifiableRaffleCard[] {
  const rows = listByStatus(db, guildId, [...VERIFIABLE_STATUSES]);
  return rows
    .map((r) => ({
      id: r.raffle_id,
      name: raffleName(r),
      isTest: r.is_test === 1,
      status: r.status,
      drawnDate: drawnAt(db, r.raffle_id),
      entrantCount: committedEntrants(db, r).length,
      winnerCount: activeWinnerIds(db, r.raffle_id).length,
    }))
    .sort((a, b) => b.id - a.id);
}
