import { describe, expect, it } from "vitest";
import {
  buildPendingSpec,
  type DesignerGuildContext,
  type DesignerSubmission,
} from "../../src/core/designerSpec.js";

const NOW = "2026-07-14T12:00:00.000Z";

function guild(over: Partial<DesignerGuildContext> = {}): DesignerGuildContext {
  return {
    timezone: "Europe/Copenhagen", // CEST (UTC+2) in July
    defaultReqMessages: 10,
    defaultReqDays: 14,
    defaultReqActiveDays: 3,
    defaultCooldownDays: 60,
    defaultCooldownCount: 2,
    ...over,
  };
}

function submission(over: Partial<DesignerSubmission> = {}): DesignerSubmission {
  return {
    name: "Summer Vinyl Giveaway",
    prize: "A record",
    description: "Two days only.",
    start: "2026-07-17T18:00",
    end: "2026-07-19T18:00",
    winnerCount: 1,
    drawMode: "auto",
    isTest: false,
    claimWindowHours: 24,
    openToAll: false,
    barPastWinners: true,
    reqMode: "defaults",
    reqMessages: 20,
    reqDays: 7,
    reqActiveDays: 2,
    cooldownDays: 30,
    ...over,
  };
}

describe("buildPendingSpec", () => {
  it("converts the wall-clock schedule to UTC using the guild timezone", () => {
    const result = buildPendingSpec(submission(), guild(), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 18:00 CEST (UTC+2) → 16:00 UTC.
    expect(result.spec.starts_at).toBe("2026-07-17T16:00:00.000Z");
    expect(result.spec.ends_at).toBe("2026-07-19T16:00:00.000Z");
  });

  it("applies the guild's saved eligibility in defaults mode", () => {
    const result = buildPendingSpec(submission({ reqMode: "defaults" }), guild(), NOW);
    if (!result.ok) throw new Error(result.error);
    expect(result.spec.req_messages).toBe(10);
    expect(result.spec.req_days).toBe(14);
    expect(result.spec.req_active_days).toBe(3);
    expect(result.spec.cooldown_days).toBe(60);
    expect(result.spec.cooldown_count).toBe(2);
  });

  it("uses the submitted dials in custom mode", () => {
    const result = buildPendingSpec(submission({ reqMode: "custom" }), guild(), NOW);
    if (!result.ok) throw new Error(result.error);
    expect(result.spec.req_messages).toBe(20);
    expect(result.spec.req_days).toBe(7);
    expect(result.spec.req_active_days).toBe(2);
    expect(result.spec.cooldown_days).toBe(30);
    expect(result.spec.cooldown_count).toBeNull();
  });

  it("nulls the activity dials when open to everyone", () => {
    const result = buildPendingSpec(submission({ openToAll: true }), guild(), NOW);
    if (!result.ok) throw new Error(result.error);
    expect(result.spec.open_to_all).toBe(true);
    expect(result.spec.req_messages).toBeNull();
    expect(result.spec.req_days).toBeNull();
    expect(result.spec.cooldown_days).toBeNull();
    // The bar-past-winners flag is still carried (inert under open-to-all).
    expect(result.spec.exclude_prior_winners).toBe(true);
  });

  it("carries the description, draw, and claim settings", () => {
    const result = buildPendingSpec(
      submission({ winnerCount: 3, drawMode: "manual", isTest: true, claimWindowHours: null }),
      guild(),
      NOW,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.spec.winner_count).toBe(3);
    expect(result.spec.draw_mode).toBe("manual");
    expect(result.spec.is_test).toBe(true);
    expect(result.spec.claim_window_hours).toBeNull();
    expect(result.spec.description).toBe("Two days only.");
  });

  it("rejects an end before the start", () => {
    const result = buildPendingSpec(
      submission({ start: "2026-07-19T18:00", end: "2026-07-17T18:00" }),
      guild(),
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/after the start/i);
  });

  it("rejects a missing name", () => {
    const result = buildPendingSpec(submission({ name: "   " }), guild(), NOW);
    expect(result.ok).toBe(false);
  });

  it("rejects an unparseable schedule", () => {
    const result = buildPendingSpec(submission({ start: "" }), guild(), NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/opening time/i);
  });

  it("rejects defaults mode when the guild has no activity bar configured", () => {
    const result = buildPendingSpec(
      submission({ reqMode: "defaults" }),
      guild({ defaultReqMessages: null, defaultReqDays: null }),
      NOW,
    );
    expect(result.ok).toBe(false);
  });

  it("treats a UTC-less guild as UTC wall-clock", () => {
    const result = buildPendingSpec(submission(), guild({ timezone: null }), NOW);
    if (!result.ok) throw new Error(result.error);
    // No timezone → the wall-clock is read as UTC directly.
    expect(result.spec.starts_at).toBe("2026-07-17T18:00:00.000Z");
  });
});
