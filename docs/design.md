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
- Cross-server raffles (a raffle belongs to one guild). The bot can run in more
  than one guild via the GUILD_IDS allowlist, but each guild's raffles,
  activity, wins, blacklist, and config are independent and never mixed.

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
- **open**: entries accepted between start and end time. A member may withdraw
  their own entry (`/raffle withdraw`) while the raffle is open: the entry is
  soft-removed with reason "withdrawn" and an `entry_withdrawn` audit row, and
  the member may re-enter freely while it stays open — re-entry reinstates the
  removed row and runs the full eligibility checks again. The entry message is
  one blockquote card — heading, description, then Prize / Starts / Ends /
  Hosted by / Entries — re-edited in place as entries arrive so the count stays
  live. The eligibility line is rendered as subtext and deliberately vague
  ("you must have been active in the X days …", no message count) so the
  activity bar cannot be gamed by a burst of filler messages. The private
  entry-failure and status replies are equally vague about activity (a pass or
  a "not enough yet", never have/need counts, which would let a member farm
  precisely to the bar); non-gameable numbers — account age, cooldown
  remaining — are stated exactly.
- **closed**: end time reached, entries frozen, awaiting draw. The entry
  card is edited to drop the Enter button (via the stored `message_id`) and
  state that entries are closed.
- **drawn**: winner(s) selected and announced; the entry card's closed notice
  is replaced by the winner line (kept current across rerolls).
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
   - User is not the raffle's creator. A raffle's creator (the mod who made it,
     stored in `raffles.created_by`) can never enter their own raffle. This is
     always enforced and needs no configuration or extra storage.
   - **Open to everyone**: if the raffle sets `open_to_all`, every check below is
     waived — anyone not blacklisted (and not the creator) may enter. It is the
     deliberate escape hatch for a "no requirements" raffle and it overrides the
     activity, account-age, tenure, cooldown, and prior-winner gates alike (so
     even a recent or prior winner can enter). It cannot be combined with a role
     gate; the wizard rejects that combination. When it is off, the remaining
     checks apply, in order:
   - Role gates, if configured (both optional, off by default): the user holds
     the raffle's `required_role_id`, and does not hold its `excluded_role_id`.
     Roles are read live from the guild member object at check time, so gaining
     or losing a role takes effect immediately; no membership is stored.
   - User's Discord account meets the minimum account age, if set. This is a
     **server-wide default** (`guilds.default_min_account_age_days`), not a
     per-raffle setting; it is derived from the user id snowflake, no extra
     storage needed.
   - User has been in the server at least the minimum tenure, if set. Also a
     **server-wide default** (`guilds.default_min_server_age_days`): a lockout
     that keeps brand-new joiners from entering for their first N days, closing
     the join-for-the-raffle path. The join date is read live from the guild
     member object at check time; a leave-and-rejoin resets it, and an unknown
     join date fails the check (a tenure we cannot verify blocks entry).
   - User is not within a win cooldown.
   - If the raffle has `exclude_prior_winners` set, the user has no prior
     non-rerolled win in this guild (a lifetime bar, distinct from the win
     cooldown's time/count window; off by default). A rerolled/disqualified win
     does not count, mirroring the cooldown rule.
   - User meets the activity requirement: at least **X messages** spread across
     at least **K distinct active days** within the Y-day window (a day counts
     as active with any single counted message). The two floors are independent
     — a member can fail on either the total or the spread. The distinct-day
     floor is what makes the gate burst-resistant: a single day of greetings,
     however loud, is one active day and cannot satisfy a multi-day requirement,
     so measured activity reflects sustained participation rather than one
     session. Both X and K are server defaults a raffle may override
     (`req_messages`/`req_days`/`req_active_days`); K of 0 imposes no spread
     floor (volume-only, the old behavior). The window anchor is set per raffle:
     "anchored" measures the Y days before raffle start (default, prevents
     qualifying by spamming after the announcement), "rolling" measures the Y
     days before the entry attempt.
   - User has not already entered.

All of these are evaluated at entry time and short-circuit on the first failure,
so a rejected user is told exactly which gate they failed and is never recorded
as entered — they cannot mistake ineligibility for a lost draw. The exact
activity thresholds (X and K) are never shown to members — not on the entry
card, the failure reply, or /raffle status — so the bar cannot be farmed to;
non-gameable gates (account age, tenure, cooldown) are stated exactly.
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
- "Raffles since last win" (the count mode) means raffles in the guild whose
  draw has completed (status `drawn` or `completed`) and whose start time is
  after the user's most recent non-rerolled win. A rerolled (disqualified) win
  does not gate re-entry.

### Winner claim window
- Optional, per raffle (`claim_window_hours`), off by default. When set, a winner
  must claim their prize before a per-win deadline or forfeit the slot.
- At draw, each winner's `wins.claim_deadline` is set to the draw instant plus the
  window; `wins.claimed_at` is null until they claim. A winner claims with
  `/raffle claim` (the public winner announcement tells them to and shows the
  deadline). Claiming is idempotent and guarded, so a double-click or a race with
  the expiry sweep records at most one claim.
- An in-process sweep (alongside the scheduler's other periodic tasks) finds wins
  whose deadline has passed with no claim, on raffles still `drawn`, and rerolls
  each lapsed slot via the normal reroll (reason `unclaimed`): the same base seed,
  the disqualified/rerolled ids excluded, the next eligible entrant selected over
  the frozen committed list — so it stays provably fair. The replacement starts
  its own claim window from the reroll instant, and a still-unclaimed replacement
  is caught on a later sweep. When the eligible pool is exhausted the reroll fills
  no slot and logs it (`no_eligible_winners`, mirroring the draw failsafe). The
  sweep also runs once at startup, catching deadlines that lapsed while offline.
- A claim writes a `win_claimed` audit row; the reason on an `unclaimed` reroll
  stays in the audit payload, not the public post, mirroring the blacklist rule.

### Test raffles
- Optional, per raffle (`is_test`), off by default. A test raffle lets mods
  rehearse the full flow in a live server without awarding a prize or disturbing
  anyone's standing.
- It runs through every normal stage (schedule, open, entry, close, draw) and
  applies every eligibility gate exactly as a real raffle would, so what mods
  see is representative. Only two things change:
  - **Prize-free badge.** The entry message, summary, public winner
    announcement, and audit commitment/result posts are all marked as a test
    with no prize.
  - **Eligibility-neutral result.** A test win never gates the winner's future
    entries: it is excluded from the win-cooldown history and the prior-winner
    bar (both read the same win history via `getUserWins`, which skips
    `is_test` raffles). A drawn test raffle is likewise excluded from
    `countRafflesSince`, so it never advances anyone's count-based cooldown. The
    win row is still written (so the claim flow can be tested), just ignored by
    the eligibility checks.
- Nothing else is special-cased: activity counting, the provably-fair draw, and
  the audit trail all behave normally, so a test raffle is a faithful dry run.

### Resetting eligibility
- Mod-only command: /raffle reset <user> <scope>. A maintenance tool for when a
  raffle goes wrong (a mis-scheduled test that awarded a real cooldown, a spam
  wave that inflated someone's counts, a win that should not have gated re-entry).
  It is always scoped to one member in one guild and never touches anyone else.
- Scopes:
  - **cooldown**: waive the member's still-gating wins in this guild
    (`wins.cooldown_waived = 1`), which lifts both the win cooldown and the
    prior-winner bar (both read `getUserWins`). The win rows are preserved —
    winner and claim history stay intact — only their re-entry-gating effect is
    removed. Idempotent.
  - **activity**: delete the member's counted-message history in this guild
    (their `activity` rows) *and* drop any counts still buffered in memory
    (`MessageCounter.forgetUser`), so the next flush can't re-create what was
    just deleted.
  - **all**: both of the above.
- Every reset writes an `eligibility_reset` audit_log row (with the scope and the
  affected counts) and mirrors a count-free line to the audit channel — the audit
  formatter shows the scope but never the numbers, mirroring the activity-privacy
  rule. A reset that finds nothing to clear still runs and is still logged.
- Not in scope: it does not lift a blacklist (use /raffle unban) and does not
  remove active entries.

### Listing the eligible pool
- Mod-only command: /raffle eligible. A read-only snapshot of who would be
  eligible *right now* under the guild's default entry settings, with no raffle
  in play — a standing view of the pool a new raffle would draw from, so a mod
  can sanity-check the defaults before opening one. It changes no state and
  writes no audit row.
- It reuses the same pure eligibility check the entry flow uses, so the report
  can never drift from the real gate. It is not, and cannot be, a preview of a
  *specific* raffle — there is no raffle, so the per-raffle fields (role gates,
  the prior-winner bar, the open-to-all escape hatch) are not applied. The
  server-tenure floor is also skipped: like the entry snapshot it has no member
  join dates. What it does apply are the guild-wide bars it can evaluate from
  stored data: not blacklisted, account old enough
  (`default_min_account_age_days`), off any win cooldown
  (`default_cooldown_days`/`default_cooldown_count`), and the default activity
  requirement — `default_req_messages` across `default_req_active_days` distinct
  days within `default_req_days` (the distinct-day floor **is** applied, since
  the daily buckets are stored).
- The activity window is **rolling**, ending now — a real raffle usually anchors
  its window to its start, but a no-raffle snapshot has no start to anchor to, so
  "the last Y days" is the only meaningful reading.
- It is a DB-only view: candidates are enumerated from the `activity` table, so
  it needs a default activity requirement to apply and it cannot see members who
  have never sent a counted message. Enumerating the full membership would need a
  privileged member fetch the bot does not assume; the activity-scoped
  approximation is deliberate.
- Because the report is mod-only and ephemeral, it may state the applied default
  numbers — the activity-privacy rule (never publish the message bar to members)
  governs member-facing surfaces, not a moderator read-out; the same numbers are
  already shown by /raffle config show.

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

v1 implements this fallback. At close the bot freezes the entrant list, stores
its hash (`raffles.entrants_hash`), generates a random secret, and stores the
secret (`raffles.draw_secret`) alongside its commitment
(`raffles.draw_commitment = SHA-256(secret)`); the hash and commitment are
published to the audit channel. Persisting the secret and commitment on the
raffle row means a restart between close and draw loses nothing. At draw the
seed is `SHA-256(entrant_list_hash + secret)` and the secret is revealed with
the results. The randomness source sits behind `deriveSeed(entrants_hash,
randomness)`, so a drand round signature can replace the revealed secret later
without changing the selection code.

**Reroll semantics.** A reroll re-runs the *same* selection from the *same*
base seed with the disqualified winner(s) added to an exclusion set: the seed
is iterated as usual but excluded ids are skipped, so surviving winners keep
their slots and the disqualified slot is filled by the next eligible id. This
is fully reproducible from public data (base seed + entrant list + disqualified
set) and needs no per-win seed stored. The disqualifying reason is recorded in
the audit_log row (mod-visible) but not published, mirroring the blacklist
rule.

Crucially, the reroll (and the draw failsafe below) re-run selection over the
*frozen committed entrant list* (the exact list the published hash covers), not
the current set of active entries. The draw failsafe soft-removes winners
who left or were blacklisted, so the live entry list can be smaller than the
committed one; those removed ids are frozen in `raffles.draw_disqualified` and
added back (then excluded) when reconstructing the committed list, so the
entrant count and therefore every selection index stay identical to the draw a
verifier reproduces from public data.

## Auditability
- A designated audit channel (read-only for members) receives:
  - Raffle created, edited, opened, closed, drawn, cancelled.
  - Entry accepted (user, raffle, timestamp).
  - Entry removed (blacklist or withdrawal).
  - Blacklist additions and removals (without private reasons).
  - Eligibility resets (the scope, without the activity counts involved).
  - Draw commitment data and draw results with verification data.
- All events also stored in the database with timestamps for export.
- Optional: /raffle audit <raffle_id> command that outputs the full event
  history and verification instructions for a raffle.
- Privacy note: publish user ids or mentions, not message contents. Activity
  counts of non-entrants are never published.

## Commands (slash commands)

The full command surface — every subcommand, its options, and worked examples —
is documented in [commands.md](commands.md). This section records only the
*design intent* behind that surface; the behavioral rules each command enforces
live in the sections above (entry flow, cooldowns, the draw scheme, test raffles,
resetting eligibility), and commands.md links back to them.

- All functionality is one `/raffle` command with subcommands, so the bot
  registers exactly one command.
- User commands (enter, status, list, claim) are open to everyone; moderator
  commands are hidden behind Manage Server and additionally gated at run time by
  the configured mod role.
- Command-surface changes must be reflected in commands.md in the same commit
  (see CLAUDE.md's source-of-truth rule).

### Raffle creation wizard (design)
The primary way mods create raffles, and the reason a raffle row is filled
incrementally rather than in one shot. Designed for non-technical users: no
options to memorize, sensible defaults from guild config, plain-language labels,
and nothing is published until the final confirmation. The step-by-step
walkthrough lives in [commands.md](commands.md#the-creation-wizard); the design
decisions that shape it:

- The raffle exists in draft status from step 1, so an abandoned wizard loses
  nothing; /raffle edit reopens the wizard on a draft.
- Every raffle-level setting has a guild default, so the eligibility and draw
  steps can each be skipped with a "Use defaults" button.
- The optional entry gates (bar prior winners, require/exclude a role) live on a
  "More restrictions" sub-screen because Discord caps a message at five component
  rows; the creator self-exclusion is always on and needs no control.
- Validation happens per step with friendly error messages (for example end time
  before start time, or X of 0).
- Wizard state is keyed to the draft raffle id in the database, not held in
  memory, so a bot restart mid-wizard does not lose progress (see wizard_state).

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
  default_min_account_age_days INTEGER,  -- null = no requirement (server-wide)
  default_min_server_age_days  INTEGER,  -- tenure lockout, null = none (server-wide)
  default_req_messages    INTEGER,       -- default X for "Use defaults"
  default_req_days        INTEGER,       -- default Y for "Use defaults"
  default_req_active_days INTEGER,       -- default K (distinct active days)
  timezone        TEXT,                  -- IANA zone for wizard schedule input
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
  req_days        INTEGER,          -- Y (window length)
  req_active_days INTEGER,          -- K, distinct active days required; null/0 = no spread floor
  window_anchor   TEXT DEFAULT 'start', -- 'start' (raffle start) or 'rolling' (entry time)
  open_to_all     INTEGER DEFAULT 0, -- 1 = skip every gate but blacklist + creator self-exclusion
  -- DEPRECATED (v15): min_account_age_days, new_member_exempt, new_member_days are
  -- retained but unused — account age is now a server-wide default and the
  -- new-member exemption was replaced by open_to_all. Safe to drop later.
  exclude_prior_winners INTEGER DEFAULT 0, -- 1 = bar anyone who has won here before
  required_role_id TEXT,            -- must hold this role to enter; null = no gate
  excluded_role_id TEXT,            -- barred from entering if held; null = no gate
  cooldown_days   INTEGER,          -- null = guild default
  cooldown_count  INTEGER,
  claim_window_hours INTEGER,       -- winners must claim within N hours; null/0 = off
  is_test         INTEGER DEFAULT 0, -- 1 = test raffle: prize-free, eligibility-neutral
  draw_mode       TEXT,             -- auto or manual; 'auto' from draft creation
  channel_id      TEXT,             -- channel to announce in (override; else guild default)
  message_id      TEXT,             -- the entry message; edited at close to remove the Enter button
  entrants_hash   TEXT,             -- set at close
  draw_commitment TEXT,             -- SHA-256(secret), published at close (commit-reveal)
  draw_secret     TEXT,             -- the secret, revealed at draw
  draw_disqualified TEXT,           -- JSON array of ids the draw failsafe removed (frozen for reroll)
  drand_round     INTEGER,          -- committed at close (reserved for the drand path)
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
  rerolled   INTEGER DEFAULT 0,     -- 1 if later disqualified
  claim_deadline TEXT,              -- claim window: must claim by this instant; null = no claim
  claimed_at     TEXT,              -- when the winner claimed; null until claimed
  cooldown_waived INTEGER DEFAULT 0 -- 1 if /raffle reset waived this win from gating re-entry
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
- Scheduler: in-process interval tasks checking raffle transitions, expired
  claim windows, and activity pruning. On startup, reconcile anything missed
  while offline (transitions, pending draws, and lapsed claim windows).
- Hosting: small VPS or always-on container. The bot must run continuously to
  count messages; serverless is unsuitable.
- Private bot: "Public Bot" disabled in the developer portal so only the
  owner can invite it. The bot serves an allowlist of one or more guilds
  (`GUILD_IDS`, comma-separated; the legacy single-value `HOME_GUILD_ID` is
  still honored as a fallback). On startup and on guild join, it leaves any
  guild not on the allowlist. The allowlist may be provisioned ahead of time:
  the deploy-commands script registers slash commands only in allowlisted
  guilds the bot is a member of (skipping the rest), and the running bot
  registers them itself the moment it joins an allowlisted guild and, to catch
  joins that happened while it was offline, in every allowlisted guild it is in
  at startup — so moving it to a pre-listed server needs no redeploy, and
  deploy-commands is a manual escape hatch. Per-guild data is scoped by
  `guild_id`; a member's activity and win cooldown in one guild never affect
  another.
- Time handling: store everything in UTC; render in server-local time in
  announcements where possible (Discord timestamp markup <t:epoch:F> handles
  this automatically per viewer). Friendly schedule input in the wizard is
  interpreted in the guild's configured `timezone` (an IANA name); "now" means
  the current instant — as a start time the raffle opens on the first scheduler
  sweep after confirmation, and schedule validation allows a start up to 15
  minutes past so a typed "now" survives the remaining wizard steps. The offset is
  resolved for the *target* instant so a raffle scheduled across a DST boundary
  lands on the intended wall clock. With no timezone set, input is read as UTC.

## Edge cases and decisions to confirm
- Bot downtime: messages sent while offline are not counted. Acceptable for
  v1; note it in the audit channel if downtime exceeds some threshold.
- User leaves the server after entering: handled as a failsafe on the pulled
  winners, not the whole entrant list. At draw, each selected winner is checked
  against current guild membership and the blacklist; a winner who has left the
  server or been blacklisted since entering has their entry removed (logged),
  recorded in `raffles.draw_disqualified`, and excluded, and the draw re-runs
  from the same base seed with them excluded (verifiable exactly like a reroll,
  since the excluded ids are published). Selection runs over the frozen committed
  entrant list, so a later reroll reproduces the same indices even though the
  live entry list shrank. If every eligible winner is disqualified the raffle is
  drawn with no winner and logged as `no_eligible_winners` (distinct from the
  genuinely empty `no_entrants`). Only winners are checked, so this stays cheap
  regardless of entrant count. A non-winning entrant who left is harmless and
  left untouched.
- Ties between blacklist expiry and open raffles: expiry lifts the ban but
  does not restore removed entries.
- Editing activity requirements after entries exist: disallow; only the end time
  is editable while open. It may be corrected earlier or later (to fix a
  mis-scheduled close) but never before the raffle's start; entries already
  placed are kept. An end moved to at/before "now" simply closes the raffle on
  the scheduler's next tick.
- Winner selection when entrant count is 0: raffle marked drawn with no
  winner, logged.
- Multiple concurrent raffles per guild: supported; entry button binds to a
  specific raffle id.
- Rate limits: batch activity writes (in-memory counter flushed every N
  seconds) to keep database write volume low on busy servers.

## Out of scope for v1 (future ideas)
- Web dashboard for configuration and public audit viewing.
- drand integration if fallback commit-reveal is used first.
- Export of audit history as CSV/JSON via command.

## Testing
Framework: Vitest. Test suite must run with `npm test` and pass before merge.

Architecture rule that enables testing: core logic (eligibility, cooldowns,
window math, draw selection) is written as pure functions with no Discord
dependencies. The Discord layer only parses interactions, calls core
functions, and formats replies.

- Unit tests for eligibility: each check (open state, blacklist, creator,
  open-to-all short-circuit, role gates, account age, server tenure, cooldown,
  prior-winner bar, the activity gate — X messages and K distinct active days —
  in both anchor modes, duplicate entry) with passing and failing cases,
  including boundary values (exactly X messages, exactly K days, window edges at
  UTC midnight).
- Draw tests: deterministic given a seed (fixed seed in, same winner out),
  correct multi-winner iteration without duplicates, reroll re-selecting over
  the frozen committed list from the same base seed with disqualified ids
  excluded (including after a draw-time failsafe removal), zero-entrant case.
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
