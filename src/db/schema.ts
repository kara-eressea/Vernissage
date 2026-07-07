/**
 * SQLite schema for Vernissage.
 *
 * Transcribed from design.md "Data model". Kept portable (no SQLite-only column
 * types) so a later move to Postgres is straightforward. All timestamps are UTC
 * ISO strings; message content is never stored, only counts.
 *
 * This started as a single flattened baseline. The schema evolved through
 * incremental migrations up to version 7; those were collapsed into this
 * CREATE-everything baseline. Later changes add an incremental step in migrate.ts
 * (v8 added raffles.draw_disqualified; v9 dropped the redundant
 * idx_entries_raffle; v10 added the prior-winner and role entry gates; v11 added
 * the winner claim window; v12 added raffles.is_test; v13 added
 * wins.cooldown_waived; v14 backfilled null raffles.draw_mode to 'auto') and are
 * also reflected here so a fresh database is created at the current version
 * directly.
 */

/** Current schema version, tracked via SQLite's `user_version` pragma. */
export const SCHEMA_VERSION = 14;

/**
 * The full current schema. Every statement is idempotent (IF NOT EXISTS), so
 * applying it to an already-created database is a no-op.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS guilds (
  guild_id        TEXT PRIMARY KEY,
  audit_channel   TEXT,
  announce_channel TEXT,
  mod_role        TEXT,
  hourly_cap      INTEGER,
  default_cooldown_days        INTEGER,
  default_cooldown_count       INTEGER,
  default_min_account_age_days INTEGER,
  default_req_messages         INTEGER,
  default_req_days             INTEGER,
  timezone        TEXT,
  blacklist_generic_message INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT
);

CREATE TABLE IF NOT EXISTS counted_channels (
  guild_id   TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  mode       TEXT NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE IF NOT EXISTS activity (
  guild_id  TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  day       TEXT NOT NULL,
  count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id, day)
);

-- No separate index on (guild_id, user_id, day): the activity PRIMARY KEY
-- already covers that lookup. Only the pruning-by-day index is added.
CREATE INDEX IF NOT EXISTS idx_activity_day
  ON activity (day);

CREATE TABLE IF NOT EXISTS raffles (
  raffle_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id        TEXT NOT NULL,
  name            TEXT,
  description     TEXT,
  prize           TEXT,
  status          TEXT NOT NULL,
  starts_at       TEXT,
  ends_at         TEXT,
  winner_count    INTEGER NOT NULL DEFAULT 1,
  req_messages    INTEGER,
  req_days        INTEGER,
  window_anchor   TEXT NOT NULL DEFAULT 'start',
  new_member_exempt INTEGER NOT NULL DEFAULT 0,
  new_member_days INTEGER,
  min_account_age_days INTEGER,
  -- Optional entry gates, all off/unset by default (design.md "Entry flow"):
  -- bar anyone who has ever won here, and require/exclude a single role. The
  -- creator self-exclusion needs no column (it reads created_by at entry time).
  exclude_prior_winners INTEGER NOT NULL DEFAULT 0,
  required_role_id TEXT,
  excluded_role_id TEXT,
  cooldown_days   INTEGER,
  cooldown_count  INTEGER,
  -- Winner claim window in hours; null/0 = off. When set, each winner must claim
  -- before their per-win deadline or the scheduler rerolls the slot (design.md
  -- "Winner claim window").
  claim_window_hours INTEGER,
  -- Test raffle: badges the announcement as prize-free and keeps its result
  -- eligibility-neutral — a test win never gates a member's future entries and a
  -- drawn test raffle never advances a count-based cooldown (design.md "Test
  -- raffles"). Off by default.
  is_test         INTEGER NOT NULL DEFAULT 0,
  -- 'auto' or 'manual'. Set to 'auto' at draft creation (and backfilled by
  -- v14) so the stored value always matches the wizard's pre-selected default.
  draw_mode       TEXT,
  channel_id      TEXT,
  message_id      TEXT,
  entrants_hash   TEXT,
  draw_commitment TEXT,
  draw_secret     TEXT,
  -- JSON array of entrant ids disqualified by the draw failsafe (left the guild
  -- or blacklisted at draw). Frozen at draw so a later reroll excludes them and
  -- reproduces the selection over the same committed entrant list. Null until a
  -- draw disqualifies someone.
  draw_disqualified TEXT,
  drand_round     INTEGER,
  created_by      TEXT,
  created_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_raffles_guild_status
  ON raffles (guild_id, status);

CREATE TABLE IF NOT EXISTS entries (
  raffle_id      INTEGER NOT NULL,
  user_id        TEXT NOT NULL,
  entered_at     TEXT,
  removed_at     TEXT,
  removed_reason TEXT,
  -- No separate index on raffle_id: the (raffle_id, user_id) PRIMARY KEY already
  -- has raffle_id as its leading column, covering hasEntry/listEntrants.
  PRIMARY KEY (raffle_id, user_id)
);

CREATE TABLE IF NOT EXISTS wins (
  win_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  raffle_id  INTEGER NOT NULL,
  user_id    TEXT NOT NULL,
  won_at     TEXT,
  rerolled   INTEGER NOT NULL DEFAULT 0,
  claim_deadline TEXT,               -- claim window: deadline to claim by (null = no claim)
  claimed_at     TEXT,               -- when the winner claimed, null until claimed
  -- Set by /raffle reset to waive this win from gating re-entry: waived wins
  -- drop out of getUserWins, lifting both the win cooldown and the prior-winner
  -- bar for that member. The win record itself (winner, claim) is preserved.
  cooldown_waived INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_wins_user
  ON wins (user_id);

CREATE INDEX IF NOT EXISTS idx_wins_raffle
  ON wins (raffle_id);

CREATE TABLE IF NOT EXISTS blacklist (
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  banned_by  TEXT,
  reason     TEXT,
  banned_at  TEXT,
  expires_at TEXT,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  event_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT,
  raffle_id  INTEGER,
  event_type TEXT NOT NULL,
  actor_id   TEXT,
  payload    TEXT,
  created_at TEXT
);

-- audit_log is only read by raffle id (getAuditForRaffle); a raffle_id index
-- serves that seek. No query filters by guild_id, so no guild-leading index.
CREATE INDEX IF NOT EXISTS idx_audit_raffle
  ON audit_log (raffle_id);

CREATE TABLE IF NOT EXISTS wizard_state (
  raffle_id  INTEGER PRIMARY KEY,
  step       TEXT NOT NULL,
  updated_at TEXT
);
`;
