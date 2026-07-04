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
 * Used to advance between picks when selecting multiple winners (and to skip an
 * already-chosen or excluded index). A reroll does not use a fresh seed — it
 * re-runs `selectWinners` from the same base seed with the disqualified ids
 * excluded — so this is only the intra-selection iterator.
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
 *
 * `excludedIds` are disqualified entrants that can never be selected — the
 * reroll mechanism (design.md "/raffle reroll"). Rerolling re-runs the *same*
 * selection from the *same* base seed with the disqualified ids excluded, so a
 * reroll is fully recomputable from public data (base seed + entrant list +
 * disqualified list) with no per-win seed to persist. Excluded ids are skipped
 * exactly as already-chosen indices are, preserving the order of the survivors.
 */
export function selectWinners(
  entrants: string[],
  seed: string,
  winnerCount: number,
  excludedIds?: ReadonlySet<string>,
): string[] {
  const n = entrants.length;
  if (n === 0 || winnerCount <= 0) {
    return [];
  }
  const excluded = excludedIds ?? new Set<string>();
  const eligibleCount = entrants.reduce((c, id) => (excluded.has(id) ? c : c + 1), 0);
  const target = Math.min(winnerCount, eligibleCount);
  if (target === 0) {
    return [];
  }
  const chosen = new Set<number>();
  const winners: string[] = [];
  let current = seed;

  while (winners.length < target) {
    const index = seedIndex(current, n);
    const id = entrants[index]!;
    if (!chosen.has(index) && !excluded.has(id)) {
      chosen.add(index);
      winners.push(id);
    }
    current = nextSeed(current);
  }

  return winners;
}
