/**
 * Wizard custom-id encoding (pure).
 *
 * Component and modal interactions carry a custom id of the form
 * `wiz:<step>:<action>:<raffleId>`. The draft raffle id is embedded so a handler
 * can reload all state from the database after a restart — nothing is held in
 * memory (design.md "Raffle creation wizard"). No discord.js import.
 */

/** The custom-id namespace the interaction router dispatches on. */
export const WIZARD_PREFIX = "wiz";

export interface WizardCustomId {
  step: string;
  action: string;
  raffleId: number;
}

/** Build a wizard custom id. */
export function buildWizardId(step: string, action: string, raffleId: number): string {
  return `${WIZARD_PREFIX}:${step}:${action}:${raffleId}`;
}

/** Parse a wizard custom id, or null if it is not a well-formed wizard id. */
export function parseWizardId(customId: string): WizardCustomId | null {
  const parts = customId.split(":");
  if (parts.length !== 4 || parts[0] !== WIZARD_PREFIX) {
    return null;
  }
  const raffleId = Number(parts[3]);
  if (!Number.isInteger(raffleId) || raffleId < 0) {
    return null;
  }
  return { step: parts[1]!, action: parts[2]!, raffleId };
}
