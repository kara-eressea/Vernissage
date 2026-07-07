import { describe, expect, it } from "vitest";
import { formatWallClockInZone, parseFriendlyTime, parseFriendlyTimeInZone } from "../../src/core/timeParse.js";

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

describe("parseFriendlyTimeInZone", () => {
  function isoInZone(input: string, now: string, tz: string | null): string {
    const r = parseFriendlyTimeInZone(input, now, tz);
    if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
    return r.utcIso;
  }

  it("treats a null zone as UTC", () => {
    expect(isoInZone("tomorrow 20:00", NOW, null)).toBe("2026-07-04T20:00:00.000Z");
  });

  it("interprets wall-clock input in the guild zone (summer CEST = +120)", () => {
    // 20:00 in Copenhagen on a summer day is 18:00 UTC.
    const now = "2026-07-14T09:00:00.000Z";
    expect(isoInZone("tomorrow 20:00", now, "Europe/Copenhagen")).toBe(
      "2026-07-15T18:00:00.000Z",
    );
  });

  it("resolves the offset for the target instant across a DST boundary", () => {
    // `now` is 2026-03-28 (still CET, +60); the target 2026-03-29 20:00 is after
    // the spring-forward, so CEST (+120) applies. The two-pass resolution must
    // use the target-side offset: 20:00 CEST = 18:00 UTC, not 19:00 UTC.
    const now = "2026-03-28T10:00:00.000Z";
    expect(isoInZone("tomorrow 20:00", now, "Europe/Copenhagen")).toBe(
      "2026-03-29T18:00:00.000Z",
    );
  });

  it("resolves the offset across the autumn fall-back (offset decreases)", () => {
    // The reverse: `now` is 2026-10-24 (still CEST, +120); the target 2026-10-25
    // 20:00 is after the fall-back, so CET (+60) applies. The target-side offset
    // gives 20:00 CET = 19:00 UTC, not the 18:00 the now-side offset would.
    const now = "2026-10-24T10:00:00.000Z";
    expect(isoInZone("tomorrow 20:00", now, "Europe/Copenhagen")).toBe(
      "2026-10-25T19:00:00.000Z",
    );
  });
});

describe("formatWallClockInZone", () => {
  it("renders a stored UTC instant as guild-local wall clock that round-trips", () => {
    // 19:00 UTC is 20:00 in Copenhagen (CET, winter).
    const stored = "2026-12-01T19:00:00.000Z";
    const text = formatWallClockInZone(stored, "Europe/Copenhagen");
    expect(text).toBe("2026-12-01 20:00");
    const parsed = parseFriendlyTimeInZone(text, "2026-11-01T00:00:00.000Z", "Europe/Copenhagen");
    expect(parsed).toEqual({ ok: true, utcIso: stored });
  });

  it("uses UTC when no zone is configured", () => {
    expect(formatWallClockInZone("2026-12-01T19:30:00.000Z", null)).toBe("2026-12-01 19:30");
  });
});
