/**
 * Per-raffle eligibility view model.
 *
 * "Who could enter this raffle, and for everyone who couldn't, why not?" — the
 * table a moderator wants in front of them when a member asks why they were
 * turned away. It turns a `RaffleEligibilityReport` (computed by the shared core
 * in `eligibility/service.ts`) into rows, plain-language reasons, filter tabs,
 * and the honest fidelity notes the page prints alongside them.
 *
 * Pure presentation: it evaluates no eligibility itself, so the page can never
 * drift from the real gate (docs/dashboard.md principle 2).
 */

import type {
  RaffleEligibilityMember,
  RaffleEligibilityReport,
  RaffleEligibilitySettings,
} from "../eligibility/service.js";

/** Which members the table shows. */
export type EligibilityFilter = "all" | "eligible" | "blocked" | "entered";

/** How many rows to render before summarising the rest. */
const MAX_ROWS = 100;

const MEMBER_COLORS = [
  "#3fb6a8", "#7c86f2", "#d4a24c", "#e5687a", "#46b877", "#9b6ff0", "#54a6d4", "#d47a4c",
];

/** A stable avatar colour for a member id, matching the simulator's palette. */
function memberColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return MEMBER_COLORS[h % MEMBER_COLORS.length]!;
}

export interface EligibilityRow {
  userId: string;
  name: string | null;
  messages: number;
  activeDays: number;
  eligible: boolean;
  entered: boolean;
  statusLabel: string;
  /** Every failing gate in plain language; empty when eligible. */
  reasons: string[];
  avatarColor: string;
}

export interface EligibilityFilterTab {
  filter: EligibilityFilter;
  label: string;
  active: boolean;
}

export interface RaffleEligibilityView {
  raffleId: number;
  raffleName: string;
  status: string;
  isTest: boolean;
  /** e.g. "1 Jul – 14 Jul 2026 (14 days, ending when the raffle opened)". */
  windowLabel: string;
  /**
   * How the activity was measured: frozen when the raffle opened, or computed
   * live. The gate reads the same thing, so this tells a moderator whether the
   * numbers below are the exact ones the raffle judged.
   */
  measurement: { frozen: boolean; label: string };
  /** One-line recap of the bar this raffle applied. */
  barLabel: string;
  considered: number;
  eligible: number;
  entered: number;
  /** Eligible members who did not enter — the "reachable but didn't" number. */
  missed: number;
  filter: EligibilityFilter;
  filterTabs: EligibilityFilterTab[];
  rows: EligibilityRow[];
  shownLabel: string;
  /** What this report cannot see, stated rather than hidden. */
  caveats: string[];
}

/** Plain-language text for one failing gate. */
function describeReason(
  reason: string,
  member: RaffleEligibilityMember,
  settings: RaffleEligibilitySettings,
): string {
  switch (reason) {
    case "insufficient_activity":
      // Both floors are reported, because a member can miss either or both and
      // "not active enough" alone does not tell a moderator which to explain.
      if (member.missesVolume && member.missesSpread) {
        return `Needs ${settings.reqMessages} msgs on ${settings.reqActiveDays} days · has ${member.messages} on ${member.activeDays}`;
      }
      if (member.missesVolume) {
        return `Needs ${settings.reqMessages} msgs · has ${member.messages}`;
      }
      return `Needs ${settings.reqActiveDays} active days · has ${member.activeDays}`;
    case "account_too_new":
      return member.accountAgeDays === null
        ? "Account too new"
        : `Account too new · ${member.accountAgeDays}d old`;
    case "in_cooldown":
      return "In win cooldown";
    case "prior_winner":
      return "Has won here before";
    case "blacklisted":
      return "Blacklisted";
    case "is_creator":
      return "Created this raffle";
    case "not_open":
      return "Raffle not open";
    default:
      return "Not eligible";
  }
}

/** One bucket of the blocked-by-reason breakdown. */
export interface ReasonCount {
  label: string;
  count: number;
}

/**
 * How many blocked members each gate accounts for.
 *
 * A member failing two gates is counted under both — the question this answers
 * is "how much of the blocking does each rule do?", not "how do the blocked
 * partition?". The activity gate is split into its two floors, because "not
 * active enough" hides the distinction that actually explains most complaints:
 * plenty of messages, too few separate days (issue #34).
 */
export function blockedReasonBreakdown(report: RaffleEligibilityReport): ReasonCount[] {
  const counts = new Map<string, number>();
  const bump = (label: string): void => {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  };

  for (const m of report.members) {
    if (m.eligible) continue;
    for (const reason of m.reasons) {
      if (reason === "insufficient_activity") {
        bump(
          m.missesVolume && m.missesSpread
            ? "Too few messages, on too few days"
            : m.missesVolume
              ? "Too few messages"
              : "Too few active days",
        );
        continue;
      }
      bump(describeReason(reason, m, report.settings));
    }
  }
  return [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

/** "1 Jul" / "14 Jul 2026" for the window caption. */
function dayLabel(day: string, withYear = false): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
}

/** One-line recap of the bar the raffle applied. */
function describeBar(settings: RaffleEligibilitySettings): string {
  if (settings.openToAll) {
    return "Open to everyone — no activity requirement";
  }
  const parts = [`${settings.reqMessages} msgs / ${settings.reqDays} days`];
  if (settings.reqActiveDays > 0) parts.push(`${settings.reqActiveDays} active days`);
  if (settings.minAccountAgeDays && settings.minAccountAgeDays > 0) {
    parts.push(`${settings.minAccountAgeDays}d+ account`);
  }
  if (settings.cooldownDays && settings.cooldownDays > 0) {
    parts.push(`${settings.cooldownDays}d cooldown`);
  }
  if (settings.excludePriorWinners) parts.push("no past winners");
  return parts.join(" · ");
}

/**
 * What the report cannot see. These follow from the web process having no
 * gateway (no roles, no join dates) and from only present state being stored for
 * the blacklist — the same honesty the simulator page carries.
 */
function buildCaveats(report: RaffleEligibilityReport): string[] {
  const caveats = [
    "Only members with counted activity in the window (plus anyone who entered) appear — someone who has never posted is invisible here.",
    "The blacklist is read as it stands now, not as it stood when the raffle ran.",
  ];
  if (report.settings.requiredRoleId || report.settings.excludedRoleId) {
    caveats.push(
      "This raffle has a role gate, which can't be checked without a member fetch — some members shown as eligible may have been blocked by it.",
    );
  }
  if (report.frozenAt === null) {
    // A frozen snapshot survives pruning; a recomputed one reads the activity
    // table as it stands today, which keeps only the last 180 days.
    caveats.push(
      "Nothing was frozen for this raffle, so its activity is recomputed from the counted-message table — which keeps only the last 180 days. If this raffle's window has since aged out, the figures here under-report it.",
    );
  }
  return caveats;
}

/** Sort eligible-but-didn't-enter first, then blocked, then entered; by volume. */
function sortMembers(members: RaffleEligibilityMember[]): RaffleEligibilityMember[] {
  const rank = (m: RaffleEligibilityMember): number => {
    if (m.entered) return 2;
    return m.eligible ? 0 : 1;
  };
  return [...members].sort((a, b) => rank(a) - rank(b) || b.messages - a.messages);
}

/** Build everything the per-raffle eligibility page renders. */
export function buildRaffleEligibilityView(
  report: RaffleEligibilityReport,
  filter: EligibilityFilter,
  names?: ReadonlyMap<string, string>,
): RaffleEligibilityView {
  const matches = (m: RaffleEligibilityMember): boolean => {
    if (filter === "eligible") return m.eligible;
    if (filter === "blocked") return !m.eligible;
    if (filter === "entered") return m.entered;
    return true;
  };

  const filtered = sortMembers(report.members).filter(matches);
  const rows: EligibilityRow[] = filtered.slice(0, MAX_ROWS).map((m) => ({
    userId: m.userId,
    name: names?.get(m.userId) ?? null,
    messages: m.messages,
    activeDays: m.activeDays,
    eligible: m.eligible,
    entered: m.entered,
    statusLabel: m.entered ? "Entered" : m.eligible ? "Eligible" : "Blocked",
    reasons: m.reasons.map((r) => describeReason(r, m, report.settings)),
    avatarColor: memberColor(m.userId),
  }));

  const total = filtered.length;
  const blocked = report.considered - report.eligible;
  const missed = report.members.filter((m) => m.eligible && !m.entered).length;

  return {
    raffleId: report.raffleId,
    raffleName: report.raffleName,
    status: report.status,
    isTest: report.isTest,
    windowLabel: `${dayLabel(report.window.startDay)} – ${dayLabel(report.window.endDay, true)} · ${report.settings.reqDays} days, ending when the raffle opened`,
    measurement: report.frozenAt
      ? {
          frozen: true,
          label:
            "Locked when the raffle opened — these are the exact figures the gate judged. Messages sent after it opened do not count.",
        }
      : {
          frozen: false,
          label:
            "Measured now, not locked — this raffle opened before eligibility was frozen at open, so same-day activity after it opened can be included here.",
        },
    barLabel: describeBar(report.settings),
    considered: report.considered,
    eligible: report.eligible,
    entered: report.entered,
    missed,
    filter,
    filterTabs: [
      { filter: "all", label: `All ${report.considered}`, active: filter === "all" },
      { filter: "eligible", label: `Eligible ${report.eligible}`, active: filter === "eligible" },
      { filter: "blocked", label: `Blocked ${blocked}`, active: filter === "blocked" },
      { filter: "entered", label: `Entered ${report.entered}`, active: filter === "entered" },
    ],
    rows,
    shownLabel:
      total > MAX_ROWS
        ? `showing ${MAX_ROWS} of ${total}`
        : `${total} member${total === 1 ? "" : "s"}`,
    caveats: buildCaveats(report),
  };
}
