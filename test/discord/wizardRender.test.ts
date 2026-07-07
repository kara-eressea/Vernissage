import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import { createDraft, getRaffle } from "../../src/db/repositories/raffles.js";
import {
  basicsModal,
  drawModal,
  eligibilityModal,
  renderStep,
  restrictionsScreen,
  scheduleModal,
} from "../../src/discord/wizard/render.js";
import type { WizardStep } from "../../src/db/repositories/wizardState.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

/**
 * Discord rejects text-input labels over 45 characters, and the builders throw
 * at construction time — which surfaced to users as "Something went wrong"
 * whenever the eligibility modal rendered (issue #4). Build every wizard modal
 * and check each label against the limit.
 */
describe("wizard modals", () => {
  it("keeps every text-input label within Discord's 45-character limit", () => {
    const id = createDraft(db, "g1", "mod1", "2026-07-01T00:00:00.000Z");
    const raffle = getRaffle(db, id)!;

    for (const build of [basicsModal, scheduleModal, eligibilityModal, drawModal]) {
      const modal = build(raffle).toJSON() as unknown as {
        components: Array<{ components?: Array<{ label?: string }> }>;
      };
      for (const row of modal.components) {
        for (const component of row.components ?? []) {
          const label = component.label;
          if (label !== undefined) {
            expect(label.length, `label "${label}" in ${build.name}`).toBeLessThanOrEqual(45);
          }
        }
      }
    }
  });
});

/**
 * Discord shows a pre-selected select menu's option label instead of the
 * menu's placeholder, so every string-select option must name the setting it
 * belongs to (e.g. "Activity window: …") to stay readable. The builders also
 * throw at construction on over-limit labels/descriptions, so simply rendering
 * every step guards the 100-character caps.
 */
describe("wizard step messages", () => {
  it("renders every step, with each select option label naming its setting", () => {
    const id = createDraft(db, "g1", "mod1", "2026-07-01T00:00:00.000Z");
    const raffle = getRaffle(db, id)!;

    const steps: WizardStep[] = ["basics", "schedule", "eligibility", "draw", "summary"];
    const messages = [
      ...steps.map((step) => renderStep(step, raffle, [])),
      restrictionsScreen(raffle),
    ];

    for (const message of messages) {
      for (const row of message.components) {
        for (const component of row.components) {
          const options = (component as { options?: Array<{ label: string }> }).options;
          for (const option of options ?? []) {
            expect(option.label, `option "${option.label}"`).toMatch(/^[A-Z][^:]+: /);
          }
        }
      }
    }
  });
});
