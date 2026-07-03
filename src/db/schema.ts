/**
 * SQLite schema for Vernissage.
 *
 * Transcribed from design.md "Data model". Kept portable (no SQLite-only column
 * types) so a later move to Postgres is straightforward. All timestamps are UTC
 * ISO strings; message content is never stored, only counts.
 *
 * This is a single flattened baseline. The schema evolved through incremental
 * migrations up to version 7; since no database exists below that version, the
 * incremental steps were collapsed into this one CREATE-everything baseline. The
 * version marker stays at 7 so any already-migrated database is left untouched
 * and any future change adds a `current < 8` step (see migrate.ts).
 */

/** Current schema version, tracked via SQLite's `user_version` pragma. */
export const SCHEMA_VERSION = 7;

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
  cooldown_days   INTEGER,
  cooldown_count  INTEGER,
  draw_mode       TEXT,
  channel_id      TEXT,
  message_id      TEXT,
  entrants_hash   TEXT,
  draw_commitment TEXT,
  draw_secret     TEXT,
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
  PRIMARY KEY (raffle_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_entries_raffle
  ON entries (raffle_id);

CREATE TABLE IF NOT EXISTS wins (
  win_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  raffle_id  INTEGER NOT NULL,
  user_id    TEXT NOT NULL,
  won_at     TEXT,
  rerolled   INTEGER NOT NULL DEFAULT 0
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
