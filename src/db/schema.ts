/**
 * SQLite schema for Vernissage (v1 baseline).
 *
 * Transcribed from design.md "Data model". Kept portable (no SQLite-only column
 * types) so a later move to Postgres is straightforward. All timestamps are UTC
 * ISO strings; message content is never stored, only counts.
 */

/** Current schema version, tracked via SQLite's `user_version` pragma. */
export const SCHEMA_VERSION = 7;

/**
 * v7: guild-level defaults for the activity requirement (so the wizard's "Use
 * defaults" can fill the eligibility step entirely) and a guild timezone (so
 * friendly schedule input is read in the mods' local time). Added the same
 * idempotent way as the v3 columns.
 */
export const V7_COLUMNS: ReadonlyArray<{ table: string; column: string; decl: string }> = [
  { table: "guilds", column: "default_req_messages", decl: "INTEGER" },
  { table: "guilds", column: "default_req_days", decl: "INTEGER" },
  { table: "guilds", column: "timezone", decl: "TEXT" },
];

/**
 * v6: commit-reveal persistence for the provably-fair draw (design.md "Provably
 * fair draw"). `draw_commitment` (SHA-256 of the secret) is published at close;
 * `draw_secret` is revealed at draw. Both live on the raffle row so a restart
 * between close and draw loses nothing. Added the same idempotent way as the v3
 * columns.
 */
export const V6_COLUMNS: ReadonlyArray<{ table: string; column: string; decl: string }> = [
  { table: "raffles", column: "draw_commitment", decl: "TEXT" },
  { table: "raffles", column: "draw_secret", decl: "TEXT" },
];

/**
 * v5: index hygiene. Drop `idx_activity_guild_user_day`, which exactly
 * duplicates the `activity` primary key (guild_id, user_id, day) and only added
 * write cost on the hottest table. Add `idx_audit_raffle` so `getAuditForRaffle`
 * (which filters on raffle_id alone) can seek instead of scanning the
 * ever-growing audit_log; the existing (guild_id, raffle_id) index cannot serve
 * a raffle_id-only predicate. Both statements are idempotent.
 */
export const V5_INDEXES_SQL = `
DROP INDEX IF EXISTS idx_activity_guild_user_day;
CREATE INDEX IF NOT EXISTS idx_audit_raffle ON audit_log (raffle_id);
`;

/**
 * v4: a per-guild toggle for whether blacklist rejections show a generic entry
 * failure instead of naming the blacklist (design.md "Entry flow"). Added the
 * same idempotent way as the v3 columns.
 */
export const V4_COLUMNS: ReadonlyArray<{ table: string; column: string; decl: string }> = [
  { table: "guilds", column: "blacklist_generic_message", decl: "INTEGER NOT NULL DEFAULT 0" },
];

/**
 * v3 columns that store where a raffle announces: a guild-level default channel
 * and a per-raffle override. Declared as (table, column, decl) so the migration
 * can add them idempotently to an existing database (an ALTER, unlike a CREATE
 * IF NOT EXISTS, is not itself idempotent).
 */
export const V3_COLUMNS: ReadonlyArray<{ table: string; column: string; decl: string }> = [
  { table: "guilds", column: "announce_channel", decl: "TEXT" },
  { table: "raffles", column: "channel_id", decl: "TEXT" },
];

/**
 * v2: the wizard resumption pointer. Only the step is tracked here; the raffle's
 * collected values live in the (nullable) `raffles` columns, keyed by the same
 * draft raffle id, so a restart mid-wizard loses nothing. Kept as a separate
 * const so the incremental migration can create it on an existing v1 database.
 */
export const WIZARD_STATE_SQL = `
CREATE TABLE IF NOT EXISTS wizard_state (
  raffle_id  INTEGER PRIMARY KEY,
  step       TEXT NOT NULL,
  updated_at TEXT
);
`;

/**
 * The full v1 schema. Every statement is idempotent (IF NOT EXISTS) so applying
 * it to an already-migrated database is a no-op.
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

-- Note: no separate index on (guild_id, user_id, day) — the activity PRIMARY
-- KEY already covers that lookup. Only the pruning-by-day index is added.
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

CREATE INDEX IF NOT EXISTS idx_audit_guild_raffle
  ON audit_log (guild_id, raffle_id);

CREATE INDEX IF NOT EXISTS idx_audit_raffle
  ON audit_log (raffle_id);
${WIZARD_STATE_SQL}`;
