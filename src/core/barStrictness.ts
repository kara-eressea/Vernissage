/**
 * Bar-strictness comparison (pure).
 *
 * Answers "is this raffle asking for more than the server usually does?" — the
 * question nothing surfaced when a live raffle raised its distinct-active-days
 * floor from the guild default of 3 to 5, quietly blocking members who would
 * have qualified under the normal bar and producing two "why wasn't I eligible?"
 * reports (issue #35).
 *
 * Only **stricter** is reported. A looser raffle is a deliberate "open this one
 * up" and needs no warning.
 *
 * The comparison is against the values the entry gate actually applies, which is
 * not the same as the values stored on the row: the gate reads `req_messages ?? 0`
 * and `req_active_days ?? 0`, so a null is *no floor* rather than the server
 * default (design.md "Entry flow"). Comparing raw columns would report a raffle
 * with nulls as drastically stricter when it is in fact wide open.
 *
 * No discord.js or database import; the pool impact is computed by the caller
 * from the existing simulator and attached separately.
 *
 * The sentence is built once, with a small `emphasis` seam for the two surfaces
 * that show it: the wizard passes Discord bold, the dashboard passes plain text
 * (its banner sets `textContent`, so it never injects markup). One wording, two
 * renderings — the same seam the audit formatter uses.
 */

/** A raffle's or a guild's activity bar, as stored (nulls allowed). */
export interface BarValues {
  reqMessages: number | null;
  reqDays: number | null;
  reqActiveDays: number | null;
}

/** Which dial is stricter, and by how much. */
export type BarDial = "messages" | "window" | "activeDays";

export interface StricterDial {
  dial: BarDial;
  /** Human name of the dial, for the warning copy. */
  label: string;
  /** The value this raffle applies. */
  raffle: number;
  /** The value the server default applies. */
  fallback: number;
}

/**
 * The effective bar the gate applies, mirroring `gatherEligibilityInput`: an
 * unset message or active-day floor is zero (no floor), and an unset window is
 * one day.
 */
function effective(bar: BarValues): { messages: number; days: number; activeDays: number } {
  return {
    messages: bar.reqMessages ?? 0,
    days: bar.reqDays !== null && bar.reqDays >= 1 ? bar.reqDays : 1,
    activeDays: bar.reqActiveDays ?? 0,
  };
}

/**
 * Every dial on which `raffle` is stricter than `defaults`, in the order a
 * moderator reads them. Empty when the raffle is at or below the server's normal
 * bar on every dial.
 *
 * The window is the one dial where *smaller* is stricter — less time to
 * accumulate the same messages — and it is only meaningful when some activity
 * floor applies at all, so a raffle with no floor never reports a "shorter
 * window" that gates nothing.
 */
export function stricterThanDefaults(raffle: BarValues, defaults: BarValues): StricterDial[] {
  const r = effective(raffle);
  const d = effective(defaults);
  const out: StricterDial[] = [];

  if (r.messages > d.messages) {
    out.push({ dial: "messages", label: "messages", raffle: r.messages, fallback: d.messages });
  }
  if (r.activeDays > d.activeDays) {
    out.push({
      dial: "activeDays",
      label: "active days",
      raffle: r.activeDays,
      fallback: d.activeDays,
    });
  }
  // A shorter window only bites when there is something to accumulate within it.
  const gated = r.messages >= 1 || r.activeDays >= 1;
  if (gated && r.days < d.days) {
    out.push({ dial: "window", label: "day window", raffle: r.days, fallback: d.days });
  }
  return out;
}

/** How the pool changes under the stricter bar; null when it could not be measured. */
export interface PoolImpact {
  /** Members eligible under the server defaults. */
  underDefaults: number;
  /** Members eligible under this raffle's bar. */
  underRaffle: number;
}

/**
 * Members the stricter bar excludes, or null when the pool was not measured.
 * Never negative: a stricter bar cannot widen the pool, and a simulator quirk
 * should not produce "-1 fewer members".
 */
export function excludedBy(impact: PoolImpact | null): number | null {
  return impact === null ? null : Math.max(0, impact.underDefaults - impact.underRaffle);
}

/** How a surface emphasises the values inside the sentence. */
export type Emphasis = (text: string) => string;

/** Discord bold, the wizard's rendering. */
export const discordEmphasis: Emphasis = (text) => `**${text}**`;

/** No markup, for a surface that sets text rather than HTML. */
export const plainEmphasis: Emphasis = (text) => text;

/**
 * One line naming each stricter dial with both values, and the pool cost when it
 * is known. Returns null when the raffle is not stricter — the caller shows
 * nothing at all in that case.
 *
 * Deliberately free of any recommendation: this is information at the point of
 * decision, not an objection. A moderator raising the bar on purpose should see
 * the cost and carry on.
 */
export function strictnessWarning(
  stricter: StricterDial[],
  impact: PoolImpact | null,
  emphasis: Emphasis = discordEmphasis,
): string | null {
  if (stricter.length === 0) {
    return null;
  }
  const dials = stricter
    .map((s) => `${emphasis(`${s.raffle} ${s.label}`)} (server default: ${s.fallback})`)
    .join(", ");
  const head = `\u26a0\ufe0f Stricter than your server default — this raffle asks for ${dials}.`;
  const lost = excludedBy(impact);
  if (lost === null) {
    return head;
  }
  if (lost === 0) {
    // Stricter on paper, but nobody currently sits between the two bars. Worth
    // saying — it is the reassuring answer, and silence would look like a bug.
    return `${head} No one currently active would be excluded by the difference.`;
  }
  return (
    `${head} About ${emphasis(`${lost} fewer member${lost === 1 ? "" : "s"}`)} would qualify ` +
    `(${impact!.underDefaults} \u2192 ${impact!.underRaffle}), based on activity right now.`
  );
}
