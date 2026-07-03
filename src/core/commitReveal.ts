/**
 * Commit-reveal primitives (pure, deterministic).
 *
 * The v1 provably-fair fallback (design.md "Provably fair draw"): before a
 * raffle closes the bot publishes `SHA-256(secret)` as a commitment; after the
 * draw it reveals the secret, and anyone can confirm the commitment and then
 * recompute the seed. Secret *generation* is non-deterministic and lives in the
 * service layer (node:crypto); only the commit and verify steps are here, so
 * this module stays pure and unit-testable. No discord.js or database import.
 */

import { createHash } from "node:crypto";

/** SHA-256(secret) as hex — the commitment published before close. */
export function commitSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Whether a revealed secret matches a previously published commitment. */
export function verifyCommitment(secret: string, commitment: string): boolean {
  return commitSecret(secret) === commitment;
}
