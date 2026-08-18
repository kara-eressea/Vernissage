/**
 * Raffle-history view model.
 *
 * "What have we run, and how did it go?" — every finished raffle for a guild,
 * newest first, with its winners, entrant count, claim state, and rerolls, plus
 * the aggregates that only become visible across many raffles (docs/dashboard.md
 * "Raffle history and outcomes"). Pure presentation over data the bot already
 * stores: it evaluates nothing and writes nothing.
 *
 * Two deliberate scope choices, both visible on the page rather than silent:
 *   - **Cancelled raffles are included**, badged and winner-less. "What happened
 *     to that one?" is exactly the question this page exists to answer, and a
 *     cancellation is part of the record.
 *   - **Test raffles are hidden**, because the history is the record of what the
 *     server actually ran for prizes. The page still prints how many were left
 *     out, so the omission is stated rather than implied.
 *
 * The entrant count is the **committed** list (active entrants plus the ids the
 * draw failsafe removed) — the same number the verifier hashes, so a raffle never
 * shows two different entrant counts on two pages.
 */

import type { Database } from "../db/index.js";
import { getAuditForRaffle } from "../db/repositories/audit.js";
import { listEntrants } from "../db/repositories/entries.js";
import { getMemberNames } from "../db/repositories/members.js";
import { disqualifiedEntrants, listByStatus, type RaffleRow } from "../db/repositories/raffles.js";
import { listWinsForRaffle } from "../db/repositories/wins.js";

/** The statuses a raffle can be in once its run is over. */
const ENDED_STATUSES = ["drawn", "completed", "cancelled"] as const;

/** The event_type written when a raffle is drawn (mirrors AUDIT_EVENTS). */
const RAFFLE_DRAWN = "raffle_drawn";

/** Rows per page. Deep history stays reachable, but no page renders forever. */
export const HISTORY_PAGE_SIZE = 25;

/**
 * A winner's standing on the prize. `none` means the raffle had no claim window
 * at all, so there was never anything to claim — distinct from `unclaimed`,
 * which is a deadline still running, and `forfeited`, one that ran out.
 */
export type ClaimState = "none" | "claimed" | "unclaimed" | "forfeited";

export interface HistoryWinner {
  userId: string;
  /** Cached display name, or null when the bot has never seen this member. */
  name: string | null;
  /** Rerolled away: disqualified and replaced, kept for the record. */
  rerolled: boolean;
  claim: ClaimState;
}

export interface HistoryRow {
  id: number;
  name: string;
  status: string;
  cancelled: boolean;
  prize: string | null;
  /** When it was drawn, else when it was scheduled to end, else null. */
  endedAt: string | null;
  /** Whether `endedAt` is the real drawn time or the scheduled end. */
  endedIsDrawn: boolean;
  /** The committed entrant count — the list the draw actually hashed. */
  entrants: number;
  /** Standing winners, then any rerolled-away ones. */
  winners: HistoryWinner[];
  /** Whether the draw can be recomputed on the verifier. */
  verifiable: boolean;
}

/** The aggregates that only show up across a run of raffles. */
export interface HistoryTotals {
  raffles: number;
  drawn: number;
  cancelled: number;
  winners: number;
  rerolls: number;
  /** Wins that had a claim deadline at all — the denominator below. */
  claimRequired: number;
  /** Of those, how many ran out unclaimed. */
  forfeited: number;
  /**
   * Forfeited as a percentage of wins that required a claim, or null when no
   * raffle has used a claim window yet (a rate over nothing means nothing).
   */
  forfeitPct: number | null;
}

export interface HistoryView {
  rows: HistoryRow[];
  totals: HistoryTotals;
  /** Test raffles omitted from the listing, stated rather than hidden. */
  hiddenTests: number;
  page: number;
  pageCount: number;
  /** e.g. "25 of 61 raffles". */
  shownLabel: string;
}

/** A display name for a raffle, falling back to its id. */
function raffleName(raffle: RaffleRow): string {
  return raffle.name ?? `Raffle #${raffle.raffle_id}`;
}

/** When the raffle was drawn, from the `raffle_drawn` audit row (or null). */
function drawnAt(db: Database, raffleId: number): string | null {
  const row = getAuditForRaffle(db, raffleId).find((r) => r.event_type === RAFFLE_DRAWN);
  return row?.created_at ?? null;
}

/** Where a win stands on its claim window, as of `now`. */
export function claimStateOf(
  win: { claim_deadline: string | null; claimed_at: string | null },
  now: string,
): ClaimState {
  if (win.claim_deadline === null) {
    return "none";
  }
  if (win.claimed_at !== null) {
    return "claimed";
  }
  return Date.parse(win.claim_deadline) <= Date.parse(now) ? "forfeited" : "unclaimed";
}

/**
 * Build the history listing for one guild.
 *
 * `page` is zero-based and clamped into range, so a hand-typed `?page=99` lands
 * on the last page rather than an empty one. Totals are computed over the whole
 * (unpaged) history — an unclaimed rate for just the visible page would be a
 * different, less useful number.
 */
export function buildHistoryView(
  db: Database,
  guildId: string,
  now: string,
  page = 0,
): HistoryView {
  const all = listByStatus(db, guildId, [...ENDED_STATUSES]);
  const hiddenTests = all.filter((r) => r.is_test === 1).length;
  const listed = all.filter((r) => r.is_test === 0).sort((a, b) => b.raffle_id - a.raffle_id);

  const totals: HistoryTotals = {
    raffles: listed.length,
    drawn: 0,
    cancelled: 0,
    winners: 0,
    rerolls: 0,
    claimRequired: 0,
    forfeited: 0,
    forfeitPct: null,
  };

  // Aggregate over the whole history first; only the rows are paged.
  for (const raffle of listed) {
    if (raffle.status === "cancelled") {
      totals.cancelled++;
    } else {
      totals.drawn++;
    }
    for (const win of listWinsForRaffle(db, raffle.raffle_id)) {
      if (win.rerolled === 1) {
        totals.rerolls++;
        continue;
      }
      totals.winners++;
      if (win.claim_deadline !== null) {
        totals.claimRequired++;
        if (claimStateOf(win, now) === "forfeited") {
          totals.forfeited++;
        }
      }
    }
  }
  totals.forfeitPct =
    totals.claimRequired === 0
      ? null
      : Math.round((totals.forfeited / totals.claimRequired) * 100);

  const pageCount = Math.max(1, Math.ceil(listed.length / HISTORY_PAGE_SIZE));
  const current = Math.min(Math.max(0, page), pageCount - 1);
  const slice = listed.slice(current * HISTORY_PAGE_SIZE, (current + 1) * HISTORY_PAGE_SIZE);

  // Names are resolved in one pass over the page's winners, not per row.
  const winsByRaffle = new Map(slice.map((r) => [r.raffle_id, listWinsForRaffle(db, r.raffle_id)]));
  const names = getMemberNames(
    db,
    guildId,
    [...winsByRaffle.values()].flat().map((w) => w.user_id),
  );

  const rows: HistoryRow[] = slice.map((raffle) => {
    const wins = winsByRaffle.get(raffle.raffle_id) ?? [];
    const drawn = drawnAt(db, raffle.raffle_id);
    return {
      id: raffle.raffle_id,
      name: raffleName(raffle),
      status: raffle.status,
      cancelled: raffle.status === "cancelled",
      prize: raffle.prize,
      endedAt: drawn ?? raffle.ends_at,
      endedIsDrawn: drawn !== null,
      entrants: listEntrants(db, raffle.raffle_id).length + disqualifiedEntrants(raffle).length,
      winners: wins
        // Standing winners first; the rerolled ones follow as the record of
        // what happened, rather than being dropped.
        .slice()
        .sort((a, b) => a.rerolled - b.rerolled || a.win_id - b.win_id)
        .map((w) => ({
          userId: w.user_id,
          name: names.get(w.user_id)?.displayName ?? null,
          rerolled: w.rerolled === 1,
          claim: claimStateOf(w, now),
        })),
      verifiable:
        raffle.status !== "cancelled" &&
        raffle.entrants_hash !== null &&
        raffle.draw_secret !== null,
    };
  });

  return {
    rows,
    totals,
    hiddenTests,
    page: current,
    pageCount,
    shownLabel:
      listed.length <= HISTORY_PAGE_SIZE
        ? `${listed.length} raffle${listed.length === 1 ? "" : "s"}`
        : `${rows.length} of ${listed.length} raffles`,
  };
}
