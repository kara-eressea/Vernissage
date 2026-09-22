/**
 * Raffle-id autocomplete choices (pure).
 *
 * Asking a non-technical member to know a raffle's numeric id is asking the
 * wrong question (issue #48): they know the raffle as "the Vinyl giveaway", not
 * as 42. Every command option that takes an id therefore offers a picker, and
 * this module turns raffle rows into the choices behind it — matching what was
 * typed, ordering them, and labelling them so the right row is recognisable at a
 * glance.
 *
 * Discord's limits shape the output and are enforced here rather than trusted
 * to the caller: at most 25 choices per response, and each label at most 100
 * characters. Both are silent failures at the API boundary — an over-long label
 * rejects the whole response, leaving the member with a picker that just never
 * appears — so the label is truncated and the list is capped before it is sent.
 *
 * No discord.js and no database import: rows in, choices out.
 */

/** The fields a choice is built from — a structural subset of `RaffleRow`. */
export interface ChoosableRaffle {
  raffle_id: number;
  name: string | null;
  status: string;
  is_test?: number;
}

/** One autocomplete choice, in the shape Discord expects for an integer option. */
export interface RaffleChoice {
  name: string;
  value: number;
}

/** Discord's cap on choices in one autocomplete response. */
export const MAX_CHOICES = 25;
/** Discord's cap on the length of a choice label. */
const MAX_LABEL = 100;

/** Shorten to fit Discord's label limit, marking the cut with an ellipsis. */
function fit(label: string): string {
  return label.length <= MAX_LABEL ? label : `${label.slice(0, MAX_LABEL - 1).trimEnd()}…`;
}

/**
 * The label for one raffle: `#42 · Vinyl giveaway (open)`.
 *
 * The id leads because it is what the member is choosing — and seeing it next to
 * the name is how they learn the ids exist at all. The status is included
 * because the same picker is used at every stage; "which of these two is the one
 * still open" should not need a second command. Test raffles are marked: mixing
 * a test raffle up with a live one is a mistake worth a word to prevent.
 */
export function raffleLabel(raffle: ChoosableRaffle): string {
  const name = raffle.name?.trim() || "unnamed";
  const test = raffle.is_test === 1 ? ", test" : "";
  return fit(`#${raffle.raffle_id} · ${name} (${raffle.status}${test})`);
}

/**
 * Whether a raffle matches what has been typed so far.
 *
 * Two ways to match, because there are two ways someone arrives here: typing the
 * name of the raffle they mean, or typing the id they already know. Matching the
 * id by *prefix* rather than substring keeps "4" from surfacing #14 and #24
 * above #4. An empty query matches everything — that is the first keystroke,
 * where the whole point is to show what there is.
 */
export function matchesQuery(raffle: ChoosableRaffle, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") {
    return true;
  }
  if (String(raffle.raffle_id).startsWith(q.replace(/^#/, ""))) {
    return true;
  }
  return (raffle.name ?? "").toLowerCase().includes(q);
}

/**
 * Build the choices for a picker: the matching raffles, newest first, capped to
 * Discord's limit.
 *
 * Newest first because recency is the best available proxy for "the one they
 * mean" — the raffle someone is entering, withdrawing from, or drawing is
 * almost always the most recent one in that state.
 */
export function raffleChoices(
  raffles: readonly ChoosableRaffle[],
  query: string,
): RaffleChoice[] {
  return raffles
    .filter((raffle) => matchesQuery(raffle, query))
    .sort((a, b) => b.raffle_id - a.raffle_id)
    .slice(0, MAX_CHOICES)
    .map((raffle) => ({ name: raffleLabel(raffle), value: raffle.raffle_id }));
}
