# Vernissage - Design Document

## Overview
Vernissage is a Discord bot that runs free raffles within a single server
(the Musicorum). Entry is gated by an
activity requirement (minimum messages over a recent period). Winners may be
subject to a cooldown before entering again. All raffle operations are
auditable to allay concerns about rigging.

Activity affects eligibility only. Every eligible entrant gets exactly one
entry with equal odds.

## Goals
- Run scheduled raffles with defined start and end times.
- Gate entry on recent server activity (at least X messages in last Y days).
- Enforce a per-user cooldown after winning (cannot enter for Z days, or the
  next N raffles, configurable).
- Allow moderators to blacklist users from raffles (temporary or permanent).
- Make draws verifiable by third parties (provably fair).
- Log all significant actions to an audit channel.

## Non-goals
- Paid entries or prize fulfilment (handled by humans).
- Weighted entries or bonus tickets.
- Cross-server raffles (single guild per raffle; multi-guild support can be
  considered later).

## Key constraint: message counting
Discord's API provides no per-user message statistics. The bot must count
messages itself via the gateway, starting from the moment it is installed.

- Subscribe to Guild Messages events. Message content is not needed for
  counting, so the privileged Message Content intent can be avoided.
- Store daily per-user counts (see schema). Raw message content is never
  stored.
- History backfill is unreliable (rate limits, deleted messages) and is out of
  scope. Communicate clearly that activity tracking begins at bot install.
- Configurable counting rules per guild:
  - Channels to include or exclude (e.g. exclude bot-command channels).
  - Optional cap on counted messages per user per hour, to blunt spam.
  - Ignore messages from bots and webhooks.
- Anti-spam judgment calls beyond this are left to moderators, who can
  blacklist offenders.
- Window anchor modes (per raffle): "anchored" evaluates the Y days ending
  at raffle start, so post-announcement activity cannot create eligibility;
  this is the default and the main anti-spam measure. "rolling" evaluates
  the Y days ending at the entry attempt. Both are evaluated at entry time;
  only the window endpoint differs.
- With daily buckets the resolution is one UTC calendar day. If hour
  precision is ever needed, switch the activity table to hourly buckets;
  the check logic is unchanged.

## Core concepts

### Raffle lifecycle
```
draft -> scheduled -> open -> closed -> drawn -> completed
                        \-> cancelled (from any pre-drawn state)
```
- **draft**: created by a mod, editable, not visible to users.
- **scheduled**: has start/end times, announced or silent until start.
- **open**: entries accepted between start and end time.
- **closed**: end time reached, entries frozen, awaiting draw.
- **drawn**: winner(s) selected and announced.
- **completed**: prize handled, raffle archived.
- **cancelled**: aborted by a mod; logged with reason.

The scheduler (a periodic task, e.g. every 30 seconds) transitions raffles
between scheduled/open/closed based on stored UTC timestamps. The draw can be
automatic at close or manually triggered by a mod (configurable per raffle).

### Entry flow
1. User clicks the Enter button on the raffle message (or uses /raffle enter).
2. Bot checks, in order:
   - Raffle is open.
   - User is not blacklisted.
   - User's Discord account meets the minimum account age, if set (derived
     from the user id snowflake, no extra storage needed).
   - User is not within a win cooldown.
   - User meets the activity requirement: X messages within the Y-day
     window. The window anchor is set per raffle: "anchored" measures the Y
     days before raffle start (default, prevents qualifying by spamming
     after the announcement), "rolling" measures the Y days before the entry
     attempt. Exemption below applies in either mode, unless
     the raffle has the new-member exemption enabled and the user joined the
     server within the last J days (join date read from the guild member
     object at check time).
   - User has not already entered.
3. On success: entry recorded, ephemeral confirmation to user, audit log
   entry written.
4. On failure: ephemeral message explaining which check failed (mods may
   configure whether blacklist rejections give a generic message instead).

### Win cooldown
- Configurable per guild, overridable per raffle.
- Two modes, either or both:
  - Time-based: cannot enter for Z days after a win.
  - Count-based: must skip the next N raffles after a win.
- Checked at entry time against the wins table.

### Blacklist
- Mod-only commands: /raffle ban, /raffle unban, /raffle banlist.
- Fields: user, banned by, timestamp, optional reason, optional expiry.
- Banning a user with an active entry in an open raffle removes that entry;
  the removal is logged to the audit channel with a timestamp.
- Reasons are visible to mods only; the audit channel shows that a removal
  happened without necessarily showing why.

## Provably fair draw
Goal: anyone can verify the winner was selected fairly, without trusting the
bot operator.

Recommended scheme (commit-reveal plus public randomness):
1. At raffle close, the bot publishes the frozen entrant list (user ids,
   sorted) and its SHA-256 hash to the audit channel.
2. The bot commits to a draw formula in advance, for example:
   - `seed = SHA-256(entrant_list_hash + drand_round_R_signature)`
   - where R is a specific future drand round number announced at close.
3. When round R is published by the drand beacon (public, verifiable,
   unpredictable), the bot computes the seed, derives an index
   (`seed mod entrant_count`), and announces the winner.
4. Anyone can recompute all steps from public data.

For multiple winners, iterate the hash (seed_n = SHA-256(seed_{n-1})) and
skip already-selected indices.

Fallback if drand integration is deferred for v1: commit-reveal with a bot
secret (publish SHA-256(secret) before close, reveal secret after draw). This
proves no rerolling but still requires trusting that the secret was not chosen
after seeing entrants, so prefer drand for the final version.

## Auditability
- A designated audit channel (read-only for members) receives:
  - Raffle created, edited, opened, closed, drawn, cancelled.
  - Entry accepted (user, raffle, timestamp).
  - Entry removed (blacklist or withdrawal).
  - Blacklist additions and removals (without private reasons).
  - Draw commitment data and draw results with verification data.
- All events also stored in the database with timestamps for export.
- Optional: /raffle audit <raffle_id> command that outputs the full event
  history and verification instructions for a raffle.
- Privacy note: publish user ids or mentions, not message contents. Activity
  counts of non-entrants are never published.

## Commands (slash commands)

### User
- /raffle enter [raffle] - enter an open raffle (also available as a button).
- /raffle status [raffle] - own eligibility: activity progress, cooldown,
  entry status. Ephemeral.
- /raffle list - open and upcoming raffles.

### Moderator (permission-gated by role)
- /raffle create - opens a guided wizard (see below). Power users can pass
  options directly on the command to prefill steps.
- /raffle edit - modify a draft or scheduled raffle. Open raffles allow only
  end-time extension, and edits are audit-logged.
- /raffle cancel <raffle> <reason>.
- /raffle draw <raffle> - manual draw trigger if configured.
- /raffle reroll <raffle> - if a winner is disqualified; must be logged with
  reason, and the reroll uses the next iteration of the seed so it remains
  verifiable.
- /raffle ban <user> [duration] [reason], /raffle unban <user>,
  /raffle banlist.
- /raffle config - guild defaults: audit channel, counted channels, hourly
  count cap, default cooldown, default minimum account age, mod role.

### Raffle creation wizard
The primary way mods create raffles. Designed for non-technical users: no
options to memorize, sensible defaults from guild config, plain-language
labels, and nothing is published until the final confirmation.

Flow (ephemeral message, driven by buttons, select menus, and modals):
1. Basics modal: name, description, prize text.
2. Schedule modal: start and end time. Accept friendly input ("tomorrow
   20:00", "in 3 days") parsed to UTC, and echo back using Discord timestamp
   markup so the mod sees it in their own timezone before confirming.
3. Eligibility step: select menus for window anchor and new-member
   exemption, plus a modal for X messages, Y days, minimum account age.
   Each field shows the guild default and can be left as-is.
4. Draw step: winner count, draw mode (auto at close or manual), cooldown
   override.
5. Summary card showing every setting in plain language (for example "To
   enter, members must have sent at least 20 messages in the 14 days before
   the raffle starts"), with buttons: Confirm and schedule, Edit a step,
   Save as draft, Cancel.

Details:
- The raffle exists in draft status from step 1, so an abandoned wizard
  loses nothing; /raffle edit reopens the wizard on a draft.
- Every raffle-level setting has a guild default so steps 3 and 4 can be
  skipped entirely with a "Use defaults" button.
- Validation happens per step with friendly error messages (for example end
  time before start time, X of 0).
- Wizard state is keyed to the draft raffle id in the database, not held in
  memory, so a bot restart mid-wizard does not lose progress.

## Data model (SQLite to start)

```sql
guilds (
  guild_id        TEXT PRIMARY KEY,
  audit_channel   TEXT,
  announce_channel TEXT,             -- default channel raffles announce in
  mod_role        TEXT,
  hourly_cap      INTEGER,          -- null = uncapped
  default_cooldown_days   INTEGER,
  default_cooldown_count  INTEGER,
  default_min_account_age_days INTEGER,  -- null = no requirement
  created_at      TEXT
)

counted_channels (
  guild_id   TEXT,
  channel_id TEXT,
  mode       TEXT,                  -- include or exclude
  PRIMARY KEY (guild_id, channel_id)
)

activity (
  guild_id  TEXT,
  user_id   TEXT,
  day       TEXT,                   -- ISO date, UTC
  count     INTEGER,
  PRIMARY KEY (guild_id, user_id, day)
)
-- prune rows older than the longest lookback window in use

raffles (
  raffle_id       INTEGER PRIMARY KEY,
  guild_id        TEXT,
  name            TEXT,
  description     TEXT,
  prize           TEXT,
  status          TEXT,             -- draft/scheduled/open/closed/drawn/completed/cancelled
  starts_at       TEXT,             -- UTC ISO timestamp
  ends_at         TEXT,
  winner_count    INTEGER DEFAULT 1,
  req_messages    INTEGER,          -- X
  req_days        INTEGER,          -- Y
  window_anchor   TEXT DEFAULT 'start', -- 'start' (raffle start) or 'rolling' (entry time)
  new_member_exempt INTEGER DEFAULT 0, -- 1 = exemption enabled
  new_member_days INTEGER,          -- J, joined within J days bypasses activity check
  min_account_age_days INTEGER,     -- null = guild default
  cooldown_days   INTEGER,          -- null = guild default
  cooldown_count  INTEGER,
  draw_mode       TEXT,             -- auto or manual
  channel_id      TEXT,             -- channel to announce in (override; else guild default)
  message_id      TEXT,             -- the announcement/entry message
  entrants_hash   TEXT,             -- set at close
  drand_round     INTEGER,          -- committed at close
  created_by      TEXT,
  created_at      TEXT
)

entries (
  raffle_id  INTEGER,
  user_id    TEXT,
  entered_at TEXT,
  removed_at TEXT,                  -- null unless removed
  removed_reason TEXT,
  PRIMARY KEY (raffle_id, user_id)
)

wins (
  win_id     INTEGER PRIMARY KEY,
  raffle_id  INTEGER,
  user_id    TEXT,
  won_at     TEXT,
  rerolled   INTEGER DEFAULT 0      -- 1 if later disqualified
)

blacklist (
  guild_id   TEXT,
  user_id    TEXT,
  banned_by  TEXT,
  reason     TEXT,
  banned_at  TEXT,
  expires_at TEXT,                  -- null = permanent
  PRIMARY KEY (guild_id, user_id)
)

audit_log (
  event_id   INTEGER PRIMARY KEY,
  guild_id   TEXT,
  raffle_id  INTEGER,               -- nullable
  event_type TEXT,
  actor_id   TEXT,                  -- user or bot
  payload    TEXT,                  -- JSON details
  created_at TEXT
)

wizard_state (
  raffle_id  INTEGER PRIMARY KEY,   -- the draft raffle being built
  step       TEXT,                  -- basics/schedule/eligibility/draw/summary
  updated_at TEXT
)
-- Resumption pointer only: the collected values live in the draft raffles row,
-- so a restart mid-wizard resumes at the right step with nothing lost.
```

## Technical stack
- Language: TypeScript with discord.js (or Python with discord.py; pick one
  and stick with it, discord.js suggested for library maturity around buttons
  and slash commands).
- Database: SQLite via better-sqlite3 for v1. Schema kept portable so a move
  to Postgres is straightforward if multi-guild scale demands it.
- Scheduler: in-process interval task checking raffle transitions. On startup,
  reconcile any transitions missed while offline.
- Hosting: small VPS or always-on container. The bot must run continuously to
  count messages; serverless is unsuitable.
- Private bot: "Public Bot" disabled in the developer portal so only the
  owner can invite it. On startup and on guild join, leave any guild whose
  id is not the configured home guild.
- Time handling: store everything in UTC; render in server-local time in
  announcements where possible (Discord timestamp markup <t:epoch:F> handles
  this automatically per viewer).

## Edge cases and decisions to confirm
- Bot downtime: messages sent while offline are not counted. Acceptable for
  v1; note it in the audit channel if downtime exceeds some threshold.
- User leaves the server after entering: entry stands or is removed? Suggest
  removed at draw time, logged.
- Ties between blacklist expiry and open raffles: expiry lifts the ban but
  does not restore removed entries.
- Editing activity requirements after entries exist: disallow; only end-time
  extension is editable while open.
- Winner selection when entrant count is 0: raffle marked drawn with no
  winner, logged.
- Multiple concurrent raffles per guild: supported; entry button binds to a
  specific raffle id.
- Rate limits: batch activity writes (in-memory counter flushed every N
  seconds) to keep database write volume low on busy servers.

## Out of scope for v1 (future ideas)
- Web dashboard for configuration and public audit viewing.
- drand integration if fallback commit-reveal is used first.
- Role-based entry requirements (e.g. must have role R).
- Server join age requirements beyond the new-member exemption logic.
- Export of audit history as CSV/JSON via command.

## Testing
Framework: Vitest. Test suite must run with `npm test` and pass before merge.

Architecture rule that enables testing: core logic (eligibility, cooldowns,
window math, draw selection) is written as pure functions with no Discord
dependencies. The Discord layer only parses interactions, calls core
functions, and formats replies.

- Unit tests for eligibility: each check (open state, blacklist, account
  age, cooldown, activity window in both anchor modes, new-member
  exemption, duplicate entry) with passing and failing cases, including
  boundary values (exactly X messages, window edges at UTC midnight).
- Draw tests: deterministic given a seed (fixed seed in, same winner out),
  correct multi-winner iteration without duplicates, reroll uses the next
  seed iteration, zero-entrant case.
- Database tests against in-memory SQLite (better-sqlite3 `:memory:`),
  covering activity bucket writes and pruning, entry uniqueness, and audit
  log writes on every state change.
- Scheduler tests: raffle state transitions at start and end times,
  reconciliation of transitions missed during downtime.
- Regression rule: bug fixes include a test reproducing the bug.

## Legal note
Even free raffles can fall under prize promotion or lottery regulations
depending on jurisdiction and prize value. Verify local requirements before
launch.
