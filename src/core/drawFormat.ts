/**
 * Draw-related message formatting (pure).
 *
 * The audit channel receives the provably-fair verification data (design.md
 * "Auditability"): the frozen entrant list + hash + commitment at close, and
 * the revealed secret + seed + winners at draw. These crypto values are public
 * by design — the point is that a third party can recompute the draw — so,
 * unlike auditFormat's deliberately-narrow ledger lines, these posts print the
 * hash, seed, and secret. The public winner announcement is separate and
 * celebratory. No discord.js or database import.
 */

import { userMention } from "./format.js";
import { discordTimestamp } from "./time.js";

/** Inputs for the commitment post published to the audit channel at close. */
export interface CommitmentPost {
  raffleId: number;
  raffleName: string | null;
  entrantIds: string[];
  entrantsHash: string;
  commitment: string;
  now: string;
}

/**
 * The commitment post: the frozen entrant list, its hash, and the SHA-256
 * commitment of the secret that will be revealed at draw. Everything a verifier
 * needs to later confirm nothing was rerolled after entries were seen.
 */
export function formatCommitmentPost(input: CommitmentPost): string {
  const name = input.raffleName ?? `Raffle #${input.raffleId}`;
  const lines = [
    `🎲 **Draw commitment — ${name}** (#${input.raffleId})`,
    `Entries are frozen (${input.entrantIds.length}). At draw time the secret is`,
    `revealed and anyone can recompute the winner. — ${discordTimestamp(input.now, "f")}`,
    ``,
    `**Entrant list hash (SHA-256):** \`${input.entrantsHash}\``,
    `**Secret commitment (SHA-256):** \`${input.commitment}\``,
  ];
  if (input.entrantIds.length > 0) {
    lines.push(`**Entrants:** ${input.entrantIds.map(userMention).join(", ")}`);
  }
  return lines.join("\n");
}

/** Inputs for the result post published to the audit channel at draw. */
export interface ResultPost {
  raffleId: number;
  raffleName: string | null;
  winners: string[];
  entrantsHash: string;
  commitment: string;
  /** The revealed secret. */
  secret: string;
  /** The derived draw seed (SHA-256 of hash + secret). */
  seed: string;
  /** Ids excluded from selection (left the guild or blacklisted at draw). */
  excluded?: string[];
  now: string;
}

/**
 * The result post: reveals the secret and the derived seed alongside the
 * winners, so a verifier can confirm SHA-256(secret) == commitment and then
 * recompute the selection. Handles the zero-winner case explicitly.
 */
export function formatResultPost(input: ResultPost): string {
  const name = input.raffleName ?? `Raffle #${input.raffleId}`;
  const who =
    input.winners.length > 0
      ? input.winners.map(userMention).join(", ")
      : "no eligible entrants";
  const lines = [
    `🏆 **Draw result — ${name}** (#${input.raffleId})`,
    `**Winner(s):** ${who} — ${discordTimestamp(input.now, "f")}`,
    ``,
    `**Entrant list hash:** \`${input.entrantsHash}\``,
    `**Revealed secret:** \`${input.secret}\``,
    `**Commitment check:** SHA-256(secret) must equal \`${input.commitment}\``,
    `**Draw seed:** \`${input.seed}\` = SHA-256(hash + secret)`,
  ];
  if (input.excluded && input.excluded.length > 0) {
    // Publishing the excluded ids keeps the draw verifiable: a checker must skip
    // these (left the guild or blacklisted at draw) to reproduce the winners.
    lines.push(`**Excluded (left or blacklisted):** ${input.excluded.map(userMention).join(", ")}`);
  }
  return lines.join("\n");
}

/** Inputs for a reroll post published to the audit channel. */
export interface RerollPost {
  raffleId: number;
  raffleName: string | null;
  disqualified: string;
  /** The replacement winner id, or null if none could be drawn. */
  replacement: string | null;
  now: string;
}

/**
 * The reroll post. Shows that a winner was disqualified and who replaced them,
 * with the seed unchanged — the replacement is reproducible from the same base
 * seed with the disqualified set excluded. The mod-entered reason is kept in the
 * audit_log row (mod-visible), not published, mirroring the blacklist rule.
 */
export function formatRerollPost(input: RerollPost): string {
  const name = input.raffleName ?? `Raffle #${input.raffleId}`;
  const replacement = input.replacement
    ? userMention(input.replacement)
    : "no replacement available";
  return [
    `♻️ **Reroll — ${name}** (#${input.raffleId})`,
    `${userMention(input.disqualified)} was disqualified; replaced by ${replacement}`,
    `— ${discordTimestamp(input.now, "f")}. Same seed, disqualified entrant excluded.`,
  ].join("\n");
}

/** Inputs for the public, celebratory winner announcement. */
export interface WinnerAnnouncement {
  raffleName: string | null;
  prize: string | null;
  winners: string[];
  /**
   * When the raffle has a claim window, the winners' claim deadline (UTC ISO).
   * A note is appended telling winners to claim before it or forfeit the slot.
   */
  claimDeadline?: string | null;
}

/**
 * The public winner announcement for the raffle's announce channel. Winners are
 * mentioned (and pinged, unlike the quiet audit posts). Zero winners yields a
 * "no eligible entrants" note (design.md zero-entrant edge case). When a claim
 * deadline is given, a line instructs winners to run `/raffle claim` before it.
 */
export function formatWinnerAnnouncement(input: WinnerAnnouncement): string {
  const name = input.raffleName ?? "the raffle";
  if (input.winners.length === 0) {
    return `🎗️ **${name}** has been drawn, but there were no eligible entrants.`;
  }
  const winners = input.winners.map(userMention).join(", ");
  const prize = input.prize ? ` — ${input.prize}` : "";
  const label = input.winners.length === 1 ? "Winner" : "Winners";
  const line = `🎉 **${name}** — congratulations to the ${label}: ${winners}${prize}!`;
  if (input.claimDeadline) {
    return (
      `${line}\n⏳ Claim with \`/raffle claim\` by ${discordTimestamp(input.claimDeadline, "R")} ` +
      `or the prize is rerolled to someone else.`
    );
  }
  return line;
}
