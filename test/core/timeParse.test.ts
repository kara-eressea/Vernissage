import { describe, expect, it } from "vitest";
import { parseFriendlyTime } from "../../src/core/timeParse.js";

const NOW = "2026-07-03T12:00:00.000Z";

function iso(input: string, tz = 0): string {
  const r = parseFriendlyTime(input, NOW, tz);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.utcIso;
}

describe("parseFriendlyTime — relative", () => {
  it("parses 'in N days' from now", () => {
    expect(iso("in 3 days")).toBe("2026-07-06T12:00:00.000Z");
  });

  it("parses 'in N hours' and 'in N minutes'", () => {
    expect(iso("in 2 hours")).toBe("2026-07-03T14:00:00.000Z");
    expect(iso("in 90 minutes")).toBe("2026-07-03T13:30:00.000Z");
  });

  it("parses 'in N weeks'", () => {
    expect(iso("in 1 week")).toBe("2026-07-10T12:00:00.000Z");
  });
});

describe("parseFriendlyTime — day-relative", () => {
  it("parses 'today HH:MM' in UTC", () => {
    expect(iso("today 18:30")).toBe("2026-07-03T18:30:00.000Z");
  });

  it("parses 'tomorrow HH:MM' in UTC", () => {
    expect(iso("tomorrow 20:00")).toBe("2026-07-04T20:00:00.000Z");
  });

  it("applies the timezone offset (CEST, +120) to wall-clock time", () => {
    // 20:00 local at +120 is 18:00 UTC.
    expect(iso("tomorrow 20:00", 120)).toBe("2026-07-04T18:00:00.000Z");
  });

  it("rolls the local day over correctly under a positive offset", () => {
    // now is 12:00 UTC = 14:00 local at +120, still the 3rd locally.
    expect(iso("today 23:00", 120)).toBe("2026-07-03T21:00:00.000Z");
  });
});

describe("parseFriendlyTime — absolute", () => {
  it("parses 'YYYY-MM-DD HH:MM' as local wall time", () => {
    expect(iso("2026-08-01 20:00")).toBe("2026-08-01T20:00:00.000Z");
    expect(iso("2026-08-01 20:00", 120)).toBe("2026-08-01T18:00:00.000Z");
  });

  it("parses a bare date as local midnight", () => {
    expect(iso("2026-08-01")).toBe("2026-08-01T00:00:00.000Z");
  });

  it("passes through a full ISO timestamp with a timezone", () => {
    expect(iso("2026-08-01T20:00:00.000Z")).toBe("2026-08-01T20:00:00.000Z");
    expect(iso("2026-08-01T20:00:00+02:00")).toBe("2026-08-01T18:00:00.000Z");
  });

  it("handles a month boundary in relative math", () => {
    expect(parseFriendlyTime("in 30 days", "2026-01-31T00:00:00.000Z")).toEqual({
      ok: true,
      utcIso: "2026-03-02T00:00:00.000Z",
    });
  });
});

describe("parseFriendlyTime — errors", () => {
  it("rejects gibberish", () => {
    expect(parseFriendlyTime("whenever", NOW).ok).toBe(false);
  });

  it("rejects an out-of-range time of day", () => {
    expect(parseFriendlyTime("tomorrow 25:00", NOW).ok).toBe(false);
    expect(parseFriendlyTime("today 12:99", NOW).ok).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(parseFriendlyTime("   ", NOW).ok).toBe(false);
  });
});
