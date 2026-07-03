/**
 * Pure Discord markup helpers (no discord.js import).
 *
 * These build the small bits of Discord-flavored markup the formatters emit —
 * mentions and the like — as plain strings, so message wording stays in pure,
 * unit-testable core code. Timestamp markup lives in time.ts (it is time math).
 */

/** A user mention: `<@id>` renders as a clickable @name in Discord. */
export function userMention(id: string): string {
  return `<@${id}>`;
}

/** A channel mention: `<#id>` renders as a clickable #channel in Discord. */
export function channelMention(id: string): string {
  return `<#${id}>`;
}
