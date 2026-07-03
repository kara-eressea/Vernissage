/**
 * Provably-fair draw core (pure, source-agnostic).
 *
 * The randomness source is deliberately not baked in here. A seed is derived
 * from the entrant-list hash plus some public randomness bytes; whether those
 * bytes come from a revealed commit-reveal secret (v1) or a drand round
 * signature (later) is decided by the integration layer. Everything in this
 * module is deterministic and independently verifiable from public data.
 *
 * See design.md "Provably fair draw".
 */

import { createHash } from "node:crypto";

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * SHA-256 of the frozen entrant list. Ids are sorted so the hash is
 * independent of insertion order, then joined with newlines. This is the value
 * published to the audit channel at raffle close.
 */
export function hashEntrants(userIds: string[]): string {
  const sorted = [...userIds].sort();
  return sha256Hex(sorted.join("\n"));
}

/**
 * Derive the draw seed from the entrant-list hash and public randomness.
 *
 * `randomness` is treated as opaque bytes (hex string, base64, a drand
 * signature, ...) and concatenated to the hash before hashing. Returns a hex
 * string usable as the first seed.
 */
export function deriveSeed(entrantsHash: string, randomness: string): string {
  return sha256Hex(`${entrantsHash}:${randomness}`);
}

/**
 * The next seed in the iteration: seed_n = SHA-256(seed_{n-1}).
 *
 * Used both to select multiple winners and to reroll a disqualified winner, so
 * a reroll stays verifiable as "the next value the committed formula produces".
 */
export function nextSeed(seed: string): string {
  return sha256Hex(seed);
}

/** Interpret a hex seed as a non-negative integer index into `count` slots. */
function seedIndex(seed: string, count: number): number {
  return Number(BigInt(`0x${seed}`) % BigInt(count));
}

/**
 * Select `winnerCount` distinct winners from `entrants` using `seed`.
 *
 * The seed is iterated (nextSeed) for each pick; indices already chosen are
 * skipped by advancing to the next seed. Returns the winning ids in selection
 * order. An empty entrant list yields no winners; requesting more winners than
 * entrants returns everyone (in selection order).
 */
export function selectWinners(
  entrants: string[],
  seed: string,
  winnerCount: number,
): string[] {
  const n = entrants.length;
  if (n === 0 || winnerCount <= 0) {
    return [];
  }
  const target = Math.min(winnerCount, n);
  const chosen = new Set<number>();
  const winners: string[] = [];
  let current = seed;

  while (winners.length < target) {
    const index = seedIndex(current, n);
    if (!chosen.has(index)) {
      chosen.add(index);
      winners.push(entrants[index]!);
    }
    current = nextSeed(current);
  }

  return winners;
}
