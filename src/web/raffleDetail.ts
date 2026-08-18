/**
 * Raffle-detail view model.
 *
 * Everything one raffle knows about itself, in one place (issue #29): the
 * settings it actually applied, who entered — including the withdrawals and
 * removals that were stored but surfaced nowhere — who won and whether they
 * claimed, the audit timeline, and the eligibility picture.
 *
 * Two things it deliberately does not do. It never re-implements a rule: the
 * eligibility half comes from `evaluateRaffleEligibility` and is presented by the
 * same `buildRaffleEligibilityView` the standalone report uses, so the two pages
 * can never disagree (docs/dashboard.md principle 2). And it does not pretend the
 * settings resolve more than they do — the activity bar is read straight off the
 * raffle row with no guild-default fallback, because that is exactly what the
 * entry gate does; only the cooldown falls back, and only that is labelled so.
 *
 * The eligibility section is authoritative for a raffle whose measurement was
 * frozen at open (schema v19) and clearly labelled approximate for one that
 * predates it — the same distinction, and the same wording, as `/app/eligibility`.
 */

import { describeAuditEvent } from "../core/auditFormat.js";
import type { Database } from "../db/index.js";
import { getAuditForRaffle } from "../db/repositories/audit.js";
import { listEntryRows } from "../db/repositories/entries.js";
import { getGuild, type GuildRow } from "../db/repositories/guilds.js";
import { getMemberNames } from "../db/repositories/members.js";
import {
  disqualifiedEntrants,
  getGuildRaffle,
  type RaffleRow,
} from "../db/repositories/raffles.js";
import { listWinsForRaffle } from "../db/repositories/wins.js";
import { evaluateRaffleEligibility } from "../eligibility/service.js";
import { claimStateOf, type ClaimState } from "./history.js";
import {
  blockedReasonBreakdown,
  buildRaffleEligibilityView,
  type RaffleEligibilityView,
  type ReasonCount,
} from "./raffleEligibility.js";

/** How many blocked members the detail page previews before linking onward. */
const BLOCKED_PREVIEW = 8;

/** One row of the "settings this raffle applied" table. */
export interface DetailSetting {
  label: string;
  value: string;
  /** Where the value came from, when that isn't obvious. Null to say nothing. */
  note: string | null;
}

/** An entrant, including one who withdrew or was removed. */
export interface DetailEntrant {
  userId: string;
  name: string | null;
  enteredAt: string | null;
  removedAt: string | null;
  /** "withdrawn", "blacklisted", … as stored; null when still entered. */
  removedReason: string | null;
  isWinner: boolean;
  /** Removed by the draw failsafe rather than by withdrawal or a ban. */
  disqualified: boolean;
}

export interface DetailWinner {
  userId: string;
  name: string | null;
  rerolled: boolean;
  claim: ClaimState;
  claimDeadline: string | null;
  claimedAt: string | null;
}

/** One audit event, rendered for the web rather than for the audit channel. */
export interface TimelineEntry {
  at: string;
  text: string;
}

/** The eligibility panel: the standalone report's view, plus a reason breakdown. */
export interface DetailEligibility {
  view: RaffleEligibilityView;
  breakdown: ReasonCount[];
  /** The first few blocked members; the full table lives on /app/eligibility. */
  preview: RaffleEligibilityView["rows"];
  blocked: number;
}

export interface RaffleDetailView {
  raffleId: number;
  raffleName: string;
  status: string;
  isTest: boolean;
  prize: string | null;
  description: string | null;
  createdAt: string | null;
  createdBy: string | null;
  createdByName: string | null;
  startsAt: string | null;
  endsAt: string | null;
  drawnAt: string | null;
  drawMode: string;
  winnerCount: number;
  /** Deep link to the announcement post, when both ids are known. */
  announceUrl: string | null;
  settings: DetailSetting[];
  entrants: DetailEntrant[];
  activeEntrants: number;
  removedEntrants: number;
  winners: DetailWinner[];
  timeline: TimelineEntry[];
  /** Whether the draw can be recomputed on /app/verify. */
  verifiable: boolean;
  /** Null for a draft, which has no window to evaluate anything over. */
  eligibility: DetailEligibility | null;
}

export type RaffleDetailResult =
  | ({ ok: true } & RaffleDetailView)
  | { ok: false; reason: "not_found" };

/** The event_type written when a raffle is drawn (mirrors AUDIT_EVENTS). */
const RAFFLE_DRAWN = "raffle_drawn";

/** A display name for a raffle, falling back to its id. */
function raffleName(raffle: RaffleRow): string {
  return raffle.name ?? `Raffle #${raffle.raffle_id}`;
}

/** "10" / "not set" — a nullable number as the settings table shows it. */
function num(value: number | null, unset = "not set"): string {
  return value === null ? unset : String(value);
}

/**
 * The settings the raffle actually applied.
 *
 * Which values fall back to a guild default is a per-field fact, not a blanket
 * rule, and the notes say so: the **activity** bar is whatever the row stores
 * (a null means no floor at all, *not* the server default — `gatherEligibilityInput`
 * reads `req_messages ?? 0`), the **cooldown** genuinely falls back, and account
 * age and tenure are server-wide policy with no per-raffle override at all
 * (schema v15).
 */
function buildSettings(raffle: RaffleRow, guild: GuildRow | undefined): DetailSetting[] {
  const rows: DetailSetting[] = [];
  const serverNote = (value: number | null): string | null =>
    value === null ? null : `server default ${value}`;

  if (raffle.open_to_all === 1) {
    rows.push({
      label: "Open to everyone",
      value: "Yes",
      note: "Every gate below is waived except the blacklist and the creator bar",
    });
  }
  rows.push({
    label: "Messages required",
    value: raffle.req_messages === null ? "none" : String(raffle.req_messages),
    note:
      raffle.req_messages === null
        ? "No message floor — a null here is no bar, not the server default"
        : serverNote(guild?.default_req_messages ?? null),
  });
  rows.push({
    label: "Activity window",
    value: raffle.req_days === null ? "1 day" : `${raffle.req_days} days`,
    note: serverNote(guild?.default_req_days ?? null),
  });
  rows.push({
    label: "Active days required",
    value: raffle.req_active_days === null ? "none" : String(raffle.req_active_days),
    note:
      raffle.req_active_days === null
        ? "No spread floor"
        : serverNote(guild?.default_req_active_days ?? null),
  });
  rows.push({
    label: "Win cooldown",
    value:
      raffle.cooldown_days === null
        ? num(guild?.default_cooldown_days ?? null, "none")
        : String(raffle.cooldown_days),
    note: raffle.cooldown_days === null ? "from the server default" : "set on this raffle",
  });
  if (raffle.cooldown_count !== null || guild?.default_cooldown_count) {
    rows.push({
      label: "Cooldown (raffles)",
      value:
        raffle.cooldown_count === null
          ? num(guild?.default_cooldown_count ?? null, "none")
          : String(raffle.cooldown_count),
      note: raffle.cooldown_count === null ? "from the server default" : "set on this raffle",
    });
  }
  rows.push({
    label: "Minimum account age",
    value: num(guild?.default_min_account_age_days ?? null, "none"),
    note: "server-wide policy — no per-raffle override",
  });
  rows.push({
    label: "Minimum server tenure",
    value: num(guild?.default_min_server_age_days ?? null, "none"),
    note: "server-wide policy — no per-raffle override",
  });
  if (raffle.required_role_id) {
    rows.push({ label: "Required role", value: raffle.required_role_id, note: null });
  }
  if (raffle.excluded_role_id) {
    rows.push({ label: "Excluded role", value: raffle.excluded_role_id, note: null });
  }
  rows.push({
    label: "Past winners",
    value: raffle.exclude_prior_winners === 1 ? "barred" : "may enter",
    note: null,
  });
  rows.push({
    label: "Claim window",
    value: raffle.claim_window_hours ? `${raffle.claim_window_hours}h` : "none",
    note: raffle.claim_window_hours ? "unclaimed prizes are rerolled" : null,
  });
  return rows;
}

/** Build the detail view for one raffle, scoped to the moderator's guild. */
export function buildRaffleDetail(
  db: Database,
  guildId: string,
  raffleId: number,
  now: string,
): RaffleDetailResult {
  const raffle = getGuildRaffle(db, guildId, raffleId);
  if (!raffle) {
    return { ok: false, reason: "not_found" };
  }

  const guild = getGuild(db, guildId);
  const audit = getAuditForRaffle(db, raffleId);
  const wins = listWinsForRaffle(db, raffleId);
  const entryRows = listEntryRows(db, raffleId);
  const disqualified = new Set(disqualifiedEntrants(raffle));

  // One name lookup for everyone the page can mention: entrants, winners, the
  // creator, and every audit actor.
  const names = getMemberNames(db, guildId, [
    ...entryRows.map((e) => e.user_id),
    ...wins.map((w) => w.user_id),
    ...audit.map((a) => a.actor_id).filter((id): id is string => id !== null),
    ...(raffle.created_by ? [raffle.created_by] : []),
  ]);
  const nameOf = (id: string): string | null => names.get(id)?.displayName ?? null;

  const winnerIds = new Set(wins.filter((w) => w.rerolled === 0).map((w) => w.user_id));

  const entrants: DetailEntrant[] = entryRows.map((e) => ({
    userId: e.user_id,
    name: nameOf(e.user_id),
    enteredAt: e.entered_at,
    removedAt: e.removed_at,
    removedReason: e.removed_reason,
    isWinner: winnerIds.has(e.user_id),
    disqualified: disqualified.has(e.user_id),
  }));

  // The audit timeline reuses the audit channel's sentences through the shared
  // renderer seam, so a new event type is described identically on both surfaces
  // — only mentions differ, resolving to cached names here rather than markup.
  // Audit payloads are written as JSON, but a hand-edited or older row must not
  // take the whole page down; an unreadable payload just describes less.
  const payloadOf = (raw: string | null): unknown => {
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  };

  const timeline: TimelineEntry[] = audit.map((row) => ({
    at: row.created_at ?? "",
    text: describeAuditEvent(
      {
        eventType: row.event_type,
        raffleId: row.raffle_id,
        actorId: row.actor_id,
        payload: payloadOf(row.payload),
        createdAt: row.created_at ?? now,
      },
      { mention: (id) => nameOf(id) ?? id },
    ),
  }));

  // A draft has no start, so there is no window to judge anyone over.
  const report =
    raffle.status === "draft" ? null : evaluateRaffleEligibility(db, guildId, raffleId, now);
  let eligibility: DetailEligibility | null = null;
  if (report) {
    const memberNames = getMemberNames(db, guildId, report.members.map((m) => m.userId));
    const labelled = new Map<string, string>();
    for (const [id, n] of memberNames) {
      const label = n.displayName ?? n.username;
      if (label) {
        labelled.set(id, label);
      }
    }
    // Built with the "blocked" filter so the preview rows are the ones this page
    // is asked about; the header counts come from the report and are unfiltered.
    const view = buildRaffleEligibilityView(report, "blocked", labelled);
    eligibility = {
      view,
      breakdown: blockedReasonBreakdown(report),
      preview: view.rows.slice(0, BLOCKED_PREVIEW),
      blocked: report.considered - report.eligible,
    };
  }

  return {
    ok: true,
    raffleId,
    raffleName: raffleName(raffle),
    status: raffle.status,
    isTest: raffle.is_test === 1,
    prize: raffle.prize,
    description: raffle.description,
    createdAt: raffle.created_at,
    createdBy: raffle.created_by,
    createdByName: raffle.created_by ? nameOf(raffle.created_by) : null,
    startsAt: raffle.starts_at,
    endsAt: raffle.ends_at,
    drawnAt: audit.find((a) => a.event_type === RAFFLE_DRAWN)?.created_at ?? null,
    drawMode: raffle.draw_mode ?? "auto",
    winnerCount: raffle.winner_count,
    announceUrl:
      raffle.channel_id && raffle.message_id
        ? `https://discord.com/channels/${guildId}/${raffle.channel_id}/${raffle.message_id}`
        : null,
    settings: buildSettings(raffle, guild),
    entrants,
    activeEntrants: entrants.filter((e) => e.removedAt === null).length,
    removedEntrants: entrants.filter((e) => e.removedAt !== null).length,
    winners: wins
      .slice()
      .sort((a, b) => a.rerolled - b.rerolled || a.win_id - b.win_id)
      .map((w) => ({
        userId: w.user_id,
        name: nameOf(w.user_id),
        rerolled: w.rerolled === 1,
        claim: claimStateOf(w, now),
        claimDeadline: w.claim_deadline,
        claimedAt: w.claimed_at,
      })),
    timeline,
    verifiable:
      (raffle.status === "drawn" || raffle.status === "completed") &&
      raffle.entrants_hash !== null &&
      raffle.draw_secret !== null,
    eligibility,
  };
}
