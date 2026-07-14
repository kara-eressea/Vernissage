/**
 * Friendly claim-token generator (pure).
 *
 * The Raffle Designer hands a composed raffle back to Discord as a short,
 * single-use claim token the moderator types into `/raffle from-design`
 * (docs/dashboard.md "The handoff problem, and the claim-token solution"). The
 * token is rendered as a readable phrase — `adjective-noun-NNNN`, e.g.
 * `gentle-harbor-4821` — so it can be read aloud and pasted cleanly.
 *
 * Its entropy is only a light backstop, not the security boundary: a token is
 * useless unless you are a moderator of the guild it was staged in (to see it)
 * and the same moderator it was bound to (to redeem it), it is single-use, and it
 * expires. So the wordlists favour clarity over size. They are deliberately
 * neutral (nature and everyday objects) so no two parts can combine into anything
 * unfortunate.
 *
 * `rng` is injectable so tests are deterministic; it defaults to `Math.random`.
 */

/** Calm, unambiguous adjectives. */
const ADJECTIVES = [
  "amber", "azure", "brave", "brisk", "calm", "clever", "cosy", "crisp",
  "dawn", "deft", "eager", "early", "fair", "fleet", "fond", "fresh",
  "gentle", "glad", "golden", "grand", "green", "happy", "hardy", "keen",
  "kind", "lively", "lucid", "mellow", "merry", "mild", "noble", "olive",
  "polar", "prime", "proud", "quiet", "rapid", "ready", "rosy", "royal",
  "sage", "sandy", "sharp", "silver", "sleek", "snug", "solar", "spry",
  "still", "sunny", "swift", "teal", "tidal", "trusty", "vivid", "warm",
  "wise", "witty", "woven", "young", "zesty", "amber", "coral", "frosty",
] as const;

/** Concrete, friendly nouns. */
const NOUNS = [
  "acorn", "anchor", "arbor", "aspen", "badge", "beacon", "birch", "brook",
  "canyon", "cedar", "cinder", "cobble", "cove", "delta", "dune", "ember",
  "fern", "fjord", "garden", "glade", "harbor", "hazel", "heron", "isle",
  "kelp", "lagoon", "lantern", "ledger", "maple", "meadow", "mesa", "moss",
  "orchard", "otter", "pebble", "pier", "pine", "prairie", "quartz", "reef",
  "ridge", "river", "robin", "sable", "spruce", "summit", "thicket", "tide",
  "timber", "vale", "willow", "cove", "harbor", "meadow", "beacon", "lantern",
  "compass", "marble", "cobalt", "cypress", "hollow", "juniper", "lark", "nook",
] as const;

/** The lowest and (exclusive) upper bound of the numeric suffix (1000–9999). */
const NUM_MIN = 1000;
const NUM_SPAN = 9000;

/** Pick one element of a list using the injected rng. */
function pick<T>(list: readonly T[], rng: () => number): T {
  return list[Math.floor(rng() * list.length)]!;
}

/**
 * Generate a friendly claim token, e.g. `gentle-harbor-4821`. Pass a seeded rng
 * for deterministic output in tests; defaults to `Math.random`.
 */
export function generateToken(rng: () => number = Math.random): string {
  const adjective = pick(ADJECTIVES, rng);
  const noun = pick(NOUNS, rng);
  const number = NUM_MIN + Math.floor(rng() * NUM_SPAN);
  return `${adjective}-${noun}-${number}`;
}

/**
 * Canonicalise a user-typed token for lookup: trim, lowercase, and collapse any
 * internal whitespace to single hyphens (so "Gentle Harbor 4821" still matches
 * the stored `gentle-harbor-4821`). Stored tokens are always in canonical form.
 */
export function normalizeToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, "-");
}
