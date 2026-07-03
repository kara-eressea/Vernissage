import { describe, expect, it } from "vitest";
import { cappedIncrement, messagesInWindow, pruneCutoffDay } from "../../src/core/activity.js";
import type { DailyCount } from "../../src/core/types.js";

describe("messagesInWindow", () => {
  const counts: DailyCount[] = [
    { day: "2026-06-30", count: 5 },
    { day: "2026-07-01", count: 3 },
    { day: "2026-07-02", count: 10 },
    { day: "2026-07-03", count: 1 },
  ];

  it("sums only days within the inclusive window", () => {
    expect(
      messagesInWindow(counts, { startDay: "2026-07-01", endDay: "2026-07-02" }),
    ).toBe(13);
  });

  it("includes both boundary days", () => {
    expect(
      messagesInWindow(counts, { startDay: "2026-06-30", endDay: "2026-07-03" }),
    ).toBe(19);
  });

  it("returns 0 when no days fall in the window", () => {
    expect(
      messagesInWindow(counts, { startDay: "2026-08-01", endDay: "2026-08-31" }),
    ).toBe(0);
  });
});

describe("cappedIncrement", () => {
  it("counts everything when uncapped", () => {
    expect(cappedIncrement(100, 40, null)).toBe(40);
  });

  it("counts up to the remaining headroom under the cap", () => {
    expect(cappedIncrement(8, 5, 10)).toBe(2);
  });

  it("counts nothing once the cap is reached", () => {
    expect(cappedIncrement(10, 5, 10)).toBe(0);
    expect(cappedIncrement(12, 5, 10)).toBe(0);
  });

  it("counts the full amount when well under the cap", () => {
    expect(cappedIncrement(0, 3, 10)).toBe(3);
  });

  it("ignores non-positive new message counts", () => {
    expect(cappedIncrement(0, 0, 10)).toBe(0);
    expect(cappedIncrement(0, -4, null)).toBe(0);
  });
});

describe("pruneCutoffDay", () => {
  const NOW = "2026-07-15T12:00:00.000Z";

  it("keeps the lookback plus a safety margin before the cutoff", () => {
    // 14-day lookback + 1 safety day: rows before 2026-06-30 may be deleted, so
    // the oldest still-needed day (2026-07-01, the start of the 14-day window)
    // is safely retained.
    expect(pruneCutoffDay(NOW, 14, 1)).toBe("2026-06-30");
    expect(pruneCutoffDay(NOW, 1, 1)).toBe("2026-07-13");
  });

  it("respects a zero safety margin", () => {
    expect(pruneCutoffDay(NOW, 14, 0)).toBe("2026-07-01");
  });
});
