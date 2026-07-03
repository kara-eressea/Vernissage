/**
 * Wizard-state repository.
 *
 * Tracks which step of the creation wizard a draft raffle is on, keyed by the
 * draft's raffle id. This is only a resumption pointer — the collected field
 * values live in the `raffles` row itself — so a bot restart mid-wizard resumes
 * at the right step with no lost input (design.md "Raffle creation wizard").
 */

import type { Database } from "better-sqlite3";

/** The ordered wizard steps. */
export type WizardStep = "basics" | "schedule" | "eligibility" | "draw" | "summary";

export interface WizardStateRow {
  raffle_id: number;
  step: string;
  updated_at: string | null;
}

/** The current wizard state for a draft raffle, or undefined if none. */
export function getWizardState(db: Database, raffleId: number): WizardStateRow | undefined {
  return db
    .prepare(`SELECT * FROM wizard_state WHERE raffle_id = ?`)
    .get(raffleId) as WizardStateRow | undefined;
}

/** Record (or advance) the wizard step for a draft raffle. */
export function upsertWizardStep(
  db: Database,
  raffleId: number,
  step: WizardStep,
  updatedAt: string,
): void {
  db.prepare(
    `INSERT INTO wizard_state (raffle_id, step, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT (raffle_id) DO UPDATE SET step = excluded.step, updated_at = excluded.updated_at`,
  ).run(raffleId, step, updatedAt);
}

/** Remove a draft's wizard state (on confirm, cancel, or save-as-draft exit). */
export function clearWizardState(db: Database, raffleId: number): void {
  db.prepare(`DELETE FROM wizard_state WHERE raffle_id = ?`).run(raffleId);
}
