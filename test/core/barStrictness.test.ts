import { describe, expect, it } from "vitest";
import {
  excludedBy,
  plainEmphasis,
  stricterThanDefaults,
  strictnessWarning,
  type BarValues,
} from "../../src/core/barStrictness.js";

/** The server's normal bar in these tests: 10 messages / 14 days / 3 active days. */
const DEFAULTS: BarValues = { reqMessages: 10, reqDays: 14, reqActiveDays: 3 };

function bar(overrides: Partial<BarValues> = {}): BarValues {
  return { ...DEFAULTS, ...overrides };
}

describe("stricterThanDefaults", () => {
  it("reports nothing when the raffle matches the defaults", () => {
    expect(stricterThanDefaults(bar(), DEFAULTS)).toEqual([]);
  });

  it("reports nothing when the raffle is looser", () => {
    // Opening a raffle up is a deliberate choice and needs no warning.
    expect(stricterThanDefaults(bar({ reqMessages: 5, reqActiveDays: 0 }), DEFAULTS)).toEqual([]);
  });

  it("catches the active-days floor that caused the reports", () => {
    // The live raffle raised K from 3 to 5 and nothing said so.
    expect(stricterThanDefaults(bar({ reqActiveDays: 5 }), DEFAULTS)).toEqual([
      { dial: "activeDays", label: "active days", raffle: 5, fallback: 3 },
    ]);
  });

  it("catches a raised message floor", () => {
    expect(stricterThanDefaults(bar({ reqMessages: 25 }), DEFAULTS)).toEqual([
      { dial: "messages", label: "messages", raffle: 25, fallback: 10 },
    ]);
  });

  it("treats a shorter window as stricter, and a longer one as looser", () => {
    // Less time to accumulate the same messages is a higher bar, so the
    // comparison runs the opposite way from the other two dials.
    expect(stricterThanDefaults(bar({ reqDays: 7 }), DEFAULTS)).toEqual([
      { dial: "window", label: "day window", raffle: 7, fallback: 14 },
    ]);
    expect(stricterThanDefaults(bar({ reqDays: 30 }), DEFAULTS)).toEqual([]);
  });

  it("ignores a shorter window when no activity floor applies to it", () => {
    // No messages and no active days required: the window gates nothing, so
    // calling it "stricter" would be a warning about a bar that does not exist.
    const open = { reqMessages: 0, reqDays: 1, reqActiveDays: 0 };
    expect(stricterThanDefaults(open, DEFAULTS)).toEqual([]);
  });

  it("reads a null floor as no floor, not as the server default", () => {
    // The gate reads `req_messages ?? 0`, so nulls are wide open — comparing raw
    // columns would have reported this raffle as stricter on the window alone.
    const unset: BarValues = { reqMessages: null, reqDays: null, reqActiveDays: null };
    expect(stricterThanDefaults(unset, DEFAULTS)).toEqual([]);
  });

  it("reports every stricter dial at once", () => {
    const dials = stricterThanDefaults(
      bar({ reqMessages: 20, reqDays: 7, reqActiveDays: 5 }),
      DEFAULTS,
    );
    expect(dials.map((d) => d.dial)).toEqual(["messages", "activeDays", "window"]);
  });

  it("compares against a server with no bar of its own", () => {
    const none: BarValues = { reqMessages: null, reqDays: null, reqActiveDays: null };
    expect(stricterThanDefaults(bar(), none).map((d) => d.dial)).toEqual([
      "messages",
      "activeDays",
    ]);
  });
});

describe("strictnessWarning", () => {
  const stricter = stricterThanDefaults(bar({ reqActiveDays: 5 }), DEFAULTS);

  it("says nothing at all when the raffle is not stricter", () => {
    expect(strictnessWarning([], { underDefaults: 48, underRaffle: 48 })).toBeNull();
  });

  it("names the dial, both values, and the pool cost", () => {
    const msg = strictnessWarning(stricter, { underDefaults: 48, underRaffle: 43 })!;
    expect(msg).toContain("5 active days");
    expect(msg).toContain("server default: 3");
    expect(msg).toContain("5 fewer members");
    expect(msg).toContain("48 → 43");
  });

  it("says so plainly when the stricter bar costs nobody", () => {
    // Silence here would read as a bug; "stricter, but free" is the useful answer.
    const msg = strictnessWarning(stricter, { underDefaults: 48, underRaffle: 48 })!;
    expect(msg.toLowerCase()).toContain("no one currently active");
  });

  it("still warns when the pool could not be measured", () => {
    const msg = strictnessWarning(stricter, null)!;
    expect(msg).toContain("5 active days");
    expect(msg).not.toContain("fewer");
  });

  it("uses singular wording for a single excluded member", () => {
    const msg = strictnessWarning(stricter, { underDefaults: 44, underRaffle: 43 })!;
    expect(msg).toContain("1 fewer member");
    expect(msg).not.toContain("1 fewer members");
  });

  it("never tells the moderator what to do", () => {
    // Advisory by design: it reports the cost and gets out of the way.
    const msg = strictnessWarning(stricter, { underDefaults: 48, underRaffle: 20 })!.toLowerCase();
    for (const nag of ["should", "consider", "recommend", "instead", "too strict"]) {
      expect(msg).not.toContain(nag);
    }
  });

  it("renders the same sentence without markup for the dashboard", () => {
    const impact = { underDefaults: 48, underRaffle: 43 };
    const discord = strictnessWarning(stricter, impact)!;
    const web = strictnessWarning(stricter, impact, plainEmphasis)!;

    // The dashboard banner sets textContent, so markdown would show literally.
    expect(discord).toContain("**5 active days**");
    expect(web).not.toContain("**");
    expect(web).toContain("5 active days");
    // Same facts either way.
    expect(web).toContain("48 → 43");
    expect(discord.replace(/\*\*/g, "")).toBe(web);
  });
});

describe("excludedBy", () => {
  it("is null when the pool was never measured", () => {
    expect(excludedBy(null)).toBeNull();
  });

  it("never goes negative", () => {
    // A stricter bar cannot widen the pool; "-1 fewer members" would be nonsense.
    expect(excludedBy({ underDefaults: 40, underRaffle: 43 })).toBe(0);
  });

  it("counts the members between the two bars", () => {
    expect(excludedBy({ underDefaults: 48, underRaffle: 43 })).toBe(5);
  });
});
