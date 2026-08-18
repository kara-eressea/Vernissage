import { describe, expect, it } from "vitest";
import {
  activeDaysInWindow,
  cappedIncrement,
  messagesInWindow,
  pruneCutoffDay,
} from "../../src/core/activity.js";
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

describe("activeDaysInWindow", () => {
  const counts: DailyCount[] = [
    { day: "2026-06-30", count: 5 },
    { day: "2026-07-01", count: 3 },
    { day: "2026-07-02", count: 10 },
    { day: "2026-07-03", count: 1 },
  ];

  it("counts distinct days with any activity in the inclusive window", () => {
    expect(
      activeDaysInWindow(counts, { startDay: "2026-07-01", endDay: "2026-07-03" }),
    ).toBe(3);
  });

  it("counts a huge single-day burst as one active day", () => {
    const burst: DailyCount[] = [{ day: "2026-07-02", count: 500 }];
    expect(
      activeDaysInWindow(burst, { startDay: "2026-07-01", endDay: "2026-07-14" }),
    ).toBe(1);
  });

  it("ignores zero-count rows and days outside the window", () => {
    const withZero: DailyCount[] = [
      { day: "2026-07-01", count: 0 },
      { day: "2026-07-02", count: 4 },
      { day: "2026-08-01", count: 9 },
    ];
    expect(
      activeDaysInWindow(withZero, { startDay: "2026-07-01", endDay: "2026-07-31" }),
    ).toBe(1);
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

  it("keeps the retention horizon plus a safety margin", () => {
    // 30 days of retention + 1 safety day: rows before 2026-06-14 may go.
    expect(pruneCutoffDay(NOW, null, 30, 1)).toBe("2026-06-14");
    expect(pruneCutoffDay(NOW, null, 1, 1)).toBe("2026-07-13");
  });

  it("respects a zero safety margin", () => {
    expect(pruneCutoffDay(NOW, null, 14, 0)).toBe("2026-07-01");
  });

  it("reaches further back when an open raffle still needs older days", () => {
    // A raffle judging a window that starts before the retention horizon keeps
    // its own days alive (less the safety margin), whatever the horizon says.
    expect(pruneCutoffDay(NOW, "2026-05-01", 30, 1)).toBe("2026-04-30");
  });

  it("does not shorten retention for a raffle whose window is recent", () => {
    // The raffle needs only 2026-07-10 onward, but retention still governs.
    expect(pruneCutoffDay(NOW, "2026-07-10", 30, 1)).toBe("2026-06-14");
  });

  it("regression: an open raffle's window survives as the raffle runs", () => {
    // Issue: retention was measured from now while a raffle's window is frozen
    // at its start, so a raffle open longer than its own window had the earliest
    // days it was judging entrants on deleted underneath it.
    const openedLongAgo = "2026-06-01"; // window start of a still-open raffle
    expect(pruneCutoffDay(NOW, openedLongAgo, 14, 1)).toBe("2026-05-31");
    expect(pruneCutoffDay(NOW, openedLongAgo, 14, 1) < openedLongAgo).toBe(true);
  });
});
