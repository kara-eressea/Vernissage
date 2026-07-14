/**
 * Eligibility-simulator view model.
 *
 * Turns a `SimulationResult` (computed by the shared core in
 * `eligibility/service.ts`) into everything the simulator page renders: the
 * slider state, the message-count histogram with the threshold drawn on it, the
 * member table with a plain-language reason per row, a distribution caption, and
 * the ready-to-paste `/raffle config set` command (docs/dashboard.md "The
 * centrepiece: an eligibility simulator"). Pure presentation over data the core
 * already produced — it evaluates no eligibility itself, so the page can never
 * drift from the real gate.
 */

import type {
  SimulatedMember,
  SimulationResult,
  SimulationSettings,
} from "../eligibility/service.js";

/** Which members the table shows. */
export type SimFilter = "all" | "eligible" | "blocked";

/** How many member rows to render before summarising the rest. */
const MAX_ROWS = 60;

/** One tunable dial: its range, the settings key it reads, and how to label it. */
interface SliderDef {
  key: keyof SimulationSettings;
  /** The `/raffle config set` option name this maps to. */
  param: string;
  label: string;
  /** Short design-doc symbol (X/Y/K), or "" when it has none. */
  symbol: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  hint: string;
}

/**
 * The five dials the activity-centric snapshot can evaluate. The param names are
 * the real `/raffle config set` option names, so the generated command pastes
 * back verbatim (design.md: build commands from the real options, not a copy).
 */
export const SLIDER_DEFS: readonly SliderDef[] = [
  { key: "reqMessages", param: "req-messages", label: "Messages required", symbol: "X", unit: "msgs", min: 0, max: 50, step: 1, hint: "the bar" },
  { key: "reqDays", param: "req-days", label: "Activity window", symbol: "Y", unit: "days", min: 1, max: 30, step: 1, hint: "look-back" },
  { key: "reqActiveDays", param: "req-active-days", label: "Distinct active days", symbol: "K", unit: "days", min: 0, max: 14, step: 1, hint: "spread" },
  { key: "minAccountAgeDays", param: "min-account-age-days", label: "Min account age", symbol: "", unit: "days", min: 0, max: 180, step: 5, hint: "anti-alt" },
  { key: "cooldownDays", param: "cooldown-days", label: "Win cooldown", symbol: "", unit: "days", min: 0, max: 180, step: 5, hint: "fairness" },
];

/** Settings fields whose "no requirement" value is 0 rather than null, for the UI. */
function settingValue(settings: SimulationSettings, key: keyof SimulationSettings): number {
  return settings[key] ?? 0;
}

/** Clamp an integer to a slider's range, snapping out-of-range to the nearest end. */
function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * Overlay query-param overrides onto the guild's base settings, clamped to each
 * dial's range. A missing or unparseable param keeps the base value, so a
 * partial or hand-edited query never throws or escapes the slider bounds.
 */
export function resolveSimSettings(
  base: SimulationSettings,
  params: URLSearchParams,
): SimulationSettings {
  const out: SimulationSettings = { ...base };
  for (const def of SLIDER_DEFS) {
    const raw = params.get(def.param);
    if (raw === null || raw.trim() === "") continue;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) continue;
    (out[def.key] as number) = clampInt(parsed, def.min, def.max);
  }
  return out;
}

/** The `/raffle config set` command that saves the dialled-in bar as the default. */
export function buildConfigCommand(settings: SimulationSettings): string {
  return [
    "/raffle config set",
    `req-messages:${settings.reqMessages}`,
    `req-days:${settings.reqDays}`,
    `req-active-days:${settings.reqActiveDays}`,
    `min-account-age-days:${settings.minAccountAgeDays ?? 0}`,
    `cooldown-days:${settings.cooldownDays ?? 0}`,
  ].join(" ");
}

// ---------------------------------------------------------------------------
// View-model shapes
// ---------------------------------------------------------------------------

export interface SliderView {
  key: string;
  param: string;
  label: string;
  symbol: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  /** Fill percentage of the track, e.g. "40%". */
  pct: string;
  minLabel: string;
  maxLabel: string;
  hint: string;
}

export interface HistogramBin {
  /** Members in this bin. */
  count: number;
  /** Bar height as a percentage of the tallest bin, e.g. "72%". */
  heightPct: string;
  /** Whether the whole bin clears the message bar (accent) or falls below it (grey). */
  clears: boolean;
}

export interface HistogramView {
  bins: HistogramBin[];
  axisMax: number;
  /** Left offset of the threshold line, e.g. "20%". */
  thresholdPct: string;
  yTicks: number[];
  xTicks: number[];
}

export interface CaptionView {
  text: string;
  tone: "raise" | "lower" | "neutral";
}

export interface SimMemberRow {
  userId: string;
  messages: number;
  activeDays: number;
  eligible: boolean;
  statusLabel: string;
  /** Plain-language explanation, or "—" when eligible. */
  reason: string;
  /** Stable avatar colour derived from the id. */
  avatarColor: string;
}

export interface SimFilterTab {
  filter: SimFilter;
  label: string;
  active: boolean;
}

export interface SimulatorView {
  settings: SimulationSettings;
  sliders: SliderView[];
  eligible: number;
  considered: number;
  pctClear: number;
  /** Whether any candidate had counted activity in the window. */
  hasCandidates: boolean;
  histogram: HistogramView;
  caption: CaptionView;
  filter: SimFilter;
  filterTabs: SimFilterTab[];
  rows: SimMemberRow[];
  /** e.g. "showing 60 of 213" or "42 members". */
  shownLabel: string;
  command: string;
}

const MEMBER_COLORS = ["#3fb6a8", "#7c86f2", "#d4a24c", "#e5687a", "#46b877", "#9b6ff0", "#54a6d4", "#d47a4c"];

/** A stable avatar colour for a member id (the web process has no usernames). */
function memberColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return MEMBER_COLORS[h % MEMBER_COLORS.length]!;
}

/** Plain-language reason for the first gate a member fails. */
function describeReason(m: SimulatedMember, settings: SimulationSettings): string {
  switch (m.reason) {
    case null:
      return "—";
    case "insufficient_activity":
      // The message floor is checked before the distinct-day floor, so a member
      // below the message count fails on messages; otherwise on the day spread.
      if (m.messages < settings.reqMessages) {
        return `Needs ${settings.reqMessages} msgs · has ${m.messages}`;
      }
      return `Only ${m.activeDays} active day${m.activeDays === 1 ? "" : "s"} · needs ${settings.reqActiveDays}`;
    case "account_too_new":
      return m.accountAgeDays === null
        ? "Account too new"
        : `Account too new · ${m.accountAgeDays}d old`;
    case "in_cooldown":
      return "In win cooldown";
    case "blacklisted":
      return "Blacklisted";
    default:
      // The snapshot can't produce the per-raffle reasons, but stay total.
      return "Not eligible";
  }
}

/** Build the message-count histogram with the threshold line placed on it. */
function buildHistogram(members: SimulatedMember[], reqMessages: number): HistogramView {
  const binCount = 12;
  const maxMsg = members.reduce((m, r) => Math.max(m, r.messages), 0);
  // Give the threshold and the tallest member some room; keep a sane floor.
  const rough = Math.max(reqMessages + 1, maxMsg, 12);
  const binSize = Math.max(1, Math.ceil(rough / binCount));
  const axisMax = binSize * binCount;

  const counts = new Array<number>(binCount).fill(0);
  for (const m of members) {
    const idx = Math.min(binCount - 1, Math.floor(m.messages / binSize));
    counts[idx]! += 1;
  }
  const tallest = Math.max(1, ...counts);
  const bins: HistogramBin[] = counts.map((count, i) => ({
    count,
    heightPct: `${Math.round((count / tallest) * 100)}%`,
    // A bin clears the bar when its whole range sits at or above X.
    clears: i * binSize >= reqMessages,
  }));

  const thresholdPct = `${Math.min(100, Math.max(0, (reqMessages / axisMax) * 100)).toFixed(1)}%`;
  const yTicks = [tallest, Math.round(tallest * 0.66), Math.round(tallest * 0.33), 0];
  const xTicks = [0, 1, 2, 3, 4, 5, 6].map((f) => Math.round((axisMax / 6) * f));
  return { bins, axisMax, thresholdPct, yTicks, xTicks };
}

/** A caption pointing at the nearest move that changes the pool, honestly hedged. */
function buildCaption(members: SimulatedMember[], settings: SimulationSettings): CaptionView {
  const X = settings.reqMessages;
  const STEP = 5;
  // Currently-eligible members a +5 raise would drop (their message count < X+5).
  const cutByRaising = members.filter((m) => m.eligible && m.messages < X + STEP).length;
  if (cutByRaising > 0) {
    return {
      tone: "raise",
      text: `Raise X to ${X + STEP} and you'd cut ${cutByRaising} member${cutByRaising === 1 ? "" : "s"} from the pool.`,
    };
  }
  // Members blocked specifically on the message floor within a -5 reach.
  const nearMiss = members.filter(
    (m) =>
      m.reason === "insufficient_activity" &&
      m.messages < X &&
      m.messages >= X - STEP,
  ).length;
  if (X > 0 && nearMiss > 0) {
    return {
      tone: "lower",
      text: `Lower X to ${Math.max(0, X - STEP)} and up to ${nearMiss} more member${nearMiss === 1 ? "" : "s"} could clear the message bar.`,
    };
  }
  return {
    tone: "neutral",
    text: "The message bar isn't the binding constraint here — nudging X barely moves the pool.",
  };
}

/** Order members for the table: blocked first (the tuning target), then busiest. */
function sortMembers(members: SimulatedMember[]): SimulatedMember[] {
  return members.slice().sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? 1 : -1;
    if (a.messages !== b.messages) return b.messages - a.messages;
    return a.userId.localeCompare(b.userId);
  });
}

/** Assemble the full simulator view model from a computed result. */
export function buildSimulatorView(
  result: SimulationResult,
  filter: SimFilter,
): SimulatorView {
  const { settings, considered, eligible, members } = result;

  const sliders: SliderView[] = SLIDER_DEFS.map((def) => {
    const value = settingValue(settings, def.key);
    const pct = def.max > def.min ? ((value - def.min) / (def.max - def.min)) * 100 : 0;
    return {
      key: String(def.key),
      param: def.param,
      label: def.label,
      symbol: def.symbol,
      unit: def.unit,
      min: def.min,
      max: def.max,
      step: def.step,
      value,
      pct: `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`,
      minLabel: String(def.min),
      maxLabel: String(def.max),
      hint: def.hint,
    };
  });

  const filtered = members.filter((m) =>
    filter === "eligible" ? m.eligible : filter === "blocked" ? !m.eligible : true,
  );
  const sorted = sortMembers(filtered);
  const rows: SimMemberRow[] = sorted.slice(0, MAX_ROWS).map((m) => ({
    userId: m.userId,
    messages: m.messages,
    activeDays: m.activeDays,
    eligible: m.eligible,
    statusLabel: m.eligible ? "Eligible" : "Not eligible",
    reason: describeReason(m, settings),
    avatarColor: memberColor(m.userId),
  }));

  const total = sorted.length;
  const shownLabel =
    total > MAX_ROWS
      ? `showing ${MAX_ROWS} of ${total}`
      : `${total} member${total === 1 ? "" : "s"}`;

  const blocked = considered - eligible;
  const filterTabs: SimFilterTab[] = [
    { filter: "all", label: `All ${considered}`, active: filter === "all" },
    { filter: "eligible", label: `Eligible ${eligible}`, active: filter === "eligible" },
    { filter: "blocked", label: `Blocked ${blocked}`, active: filter === "blocked" },
  ];

  return {
    settings,
    sliders,
    eligible,
    considered,
    pctClear: considered > 0 ? Math.round((eligible / considered) * 100) : 0,
    hasCandidates: considered > 0,
    histogram: buildHistogram(members, settings.reqMessages),
    caption: buildCaption(members, settings),
    filter,
    filterTabs,
    rows,
    shownLabel,
    command: buildConfigCommand(settings),
  };
}
