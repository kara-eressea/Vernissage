import { describe, expect, it } from "vitest";
import { computeTransition } from "../../src/core/transitions.js";

const startsAt = "2026-07-10T12:00:00.000Z";
const endsAt = "2026-07-17T12:00:00.000Z";

describe("computeTransition", () => {
  it("stays scheduled before the start time", () => {
    expect(computeTransition("scheduled", startsAt, endsAt, "2026-07-09T00:00:00.000Z")).toBe(
      "scheduled",
    );
  });

  it("opens at exactly the start time (inclusive)", () => {
    expect(computeTransition("scheduled", startsAt, endsAt, startsAt)).toBe("open");
  });

  it("opens while between start and end", () => {
    expect(computeTransition("scheduled", startsAt, endsAt, "2026-07-14T00:00:00.000Z")).toBe(
      "open",
    );
  });

  it("closes an open raffle at exactly the end time (inclusive)", () => {
    expect(computeTransition("open", startsAt, endsAt, endsAt)).toBe("closed");
  });

  it("closes an open raffle after the end time", () => {
    expect(computeTransition("open", startsAt, endsAt, "2026-07-20T00:00:00.000Z")).toBe(
      "closed",
    );
  });

  it("reconciles a scheduled raffle straight to closed when both times passed during downtime", () => {
    expect(computeTransition("scheduled", startsAt, endsAt, "2026-07-20T00:00:00.000Z")).toBe(
      "closed",
    );
  });

  it("leaves scheduler-terminal statuses unchanged", () => {
    for (const status of ["draft", "closed", "drawn", "completed", "cancelled"] as const) {
      expect(computeTransition(status, startsAt, endsAt, "2026-07-20T00:00:00.000Z")).toBe(
        status,
      );
    }
  });
});
