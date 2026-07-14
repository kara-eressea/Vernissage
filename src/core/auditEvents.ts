/**
 * The shared vocabulary of audit event types.
 *
 * Every state change writes an `audit_log` row (see CLAUDE.md), and the audit
 * channel mirrors those rows. Emitters and the formatter must agree on the exact
 * `event_type` strings, so they live here in one place. The `raffle_opened` /
 * `raffle_closed` values match the strings the scheduler already writes in
 * src/scheduler/transitions.ts. See design.md "Auditability".
 */

export const AUDIT_EVENTS = {
  raffleCreated: "raffle_created",
  raffleEdited: "raffle_edited",
  raffleScheduled: "raffle_scheduled",
  raffleOpened: "raffle_opened",
  raffleClosed: "raffle_closed",
  raffleDrawn: "raffle_drawn",
  raffleCancelled: "raffle_cancelled",
  entryAccepted: "entry_accepted",
  entryRemoved: "entry_removed",
  entryWithdrawn: "entry_withdrawn",
  blacklistAdded: "blacklist_added",
  blacklistRemoved: "blacklist_removed",
  drawCommitted: "draw_committed",
  drawResult: "draw_result",
  drawReroll: "draw_reroll",
  winClaimed: "win_claimed",
  configSet: "config_set",
  countedChannelSet: "counted_channel_set",
  countedChannelCleared: "counted_channel_cleared",
  eligibilityReset: "eligibility_reset",
  // A raffle composed in the dashboard's Raffle Designer was staged as an inert
  // pending spec (design.md "Raffle Designer handoff"). Not mirrored to the audit
  // channel — it becomes real, with its own raffle_created/scheduled rows, only
  // when a moderator redeems it with /raffle from-design.
  pendingRaffleStaged: "pending_raffle_staged",
} as const;

/** Every known audit event type string. */
export type AuditEventType = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];
