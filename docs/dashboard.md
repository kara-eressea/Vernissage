# Vernissage — Moderator Dashboard (design note)

**Status: exploratory / not built.** This is a forward-looking note, not a
description of shipped behaviour. Nothing here is a commitment; it captures the
shape a read-only moderator dashboard would take so the idea is ready to pick up
later. It deliberately stays inside the project's existing values (auditable,
fair, privacy-preserving) — see [design.md](design.md) for those.

## Why a dashboard at all

Two pressures point at a presentation layer rather than more configuration:

- **Config legibility.** The eligibility gate has grown a fair number of dials
  (message floor, distinct active days, window length, anchor mode, account age,
  server tenure, cooldowns, role gates, prior-winner bar). Each one is
  defensible on its own, but together they are hard to hold in your head. Past a
  point the right answer is a place to *see* what a set of values does, not
  another knob.
- **The auditable pitch.** The provably-fair draw is designed for third-party
  verification, but today that verification lives in audit-channel text. A web
  view can make "anyone can check this" real instead of aspirational.

The through-line: the dashboard should make the existing system **legible**, not
add new behaviour to it.

## Guiding principles

1. **Read-only.** The dashboard never writes to the database. Every state change
   continues to flow through Discord slash commands, which already write the
   audit trail. This is not a limitation to work around — it is the design (see
   "Generate the command, don't run it" below).
2. **Reuse the core, don't reimplement it.** Eligibility, cooldowns, window
   math, and the draw are already pure functions with no Discord or DB
   dependency. The dashboard calls the *same* functions the bot does, so a report
   can never drift from the real gate — the same rule that lets `/raffle
   eligible` exist.
3. **The audit log stays the single source of truth.** Because the dashboard
   makes no state changes, there is nothing new to audit and no second write path
   to keep consistent.

## Architecture sketch

- **A separate process, sharing the SQLite file read-only.** The bot "must run
  24/7 to count messages," so the dashboard should not be able to take the
  gateway down. Run it as its own process opening the same database in read-only
  mode (WAL mode allows concurrent readers alongside the bot's writes). A web bug
  then can't stop message counting, and a read-only connection sidesteps write
  contention entirely.
- **Auth: Discord OAuth2 for identity, existing logic for authorization.** The
  OAuth flow needs only the `identify` scope — enough to learn *who* the visitor
  is. Whether they are a moderator is then answered by the bot's existing check
  (`ensureModerator`: the configured mod role or Manage Server, scoped per
  guild). The hard part of "moderator-gated" is already written; OAuth just
  supplies a trusted user id and a signed session cookie carries it.
- **Server-rendered pages.** For a read-only tool, plain server-rendered HTML
  avoids a frontend build and a client-side API surface. A little client-side JS
  is worth it only where interactivity earns it (the simulator's live re-query,
  the public verifier's in-browser hash check).

## The centrepiece: an eligibility simulator

The feature that motivated this note: let a moderator **play with the knobs and
immediately see who would be eligible, who would not, and why** — then carry the
chosen values back to Discord.

This is cheap because it is almost entirely built already. `/raffle eligible` is
powered by `snapshotEligibleUsers` / `buildSnapshotInput`
(`src/core/eligibilitySnapshot.ts`), which enumerates candidates from the
`activity` table and runs the pure `checkEligibility` against a set of default
settings. The simulator is that same machinery with one substitution: **feed it
the values from a web form instead of the guild's stored defaults.**

- **"Who."** The eligible/ineligible split is the snapshot's existing output.
- **"Why."** `checkEligibility` already returns a machine-readable reason for the
  first gate a candidate fails (`{ ok: false, reason: "insufficient_activity" }`,
  etc.). Rendering that as a reason column is nearly free.
- **Live tuning.** As the moderator changes a value, re-run the (pure, fast)
  check over the candidate set and update the table and an "N of M eligible"
  counter. No writes, no Discord round-trip.

### One small piece of genuinely new core logic

`checkEligibility` short-circuits on the first failed gate, so a rejected member
shows a single reason — correct for the entry flow (it mirrors what the member is
told), but a tuning tool often wants the *whole* picture ("this person fails
activity **and** is in cooldown") so the moderator can see everything a slider
move would need to clear. That is a modest, pure, testable companion to the
existing function: evaluate every gate without short-circuiting and return the
list of failures. It lives in core next to `checkEligibility` and is independently
unit-tested; the entry flow keeps using the short-circuiting version.

### Generate the command, don't run it

The dashboard already knows the values the moderator dialled in, so it can render
the **exact `/raffle config set …` (or per-raffle wizard override) command** to
paste back into Discord — even the whole command, ready to copy.

This is the elegant part, not a compromise. The change still flows through the
normal audited command path, so:

- there is **no write surface** on the web app (no CSRF, no validation duplicated
  from the wizard, no web/bot write races, no risk of a web bug corrupting state);
- the **audit trail stays intact** — the config change is recorded exactly as if
  the moderator had typed it, because they did;
- the moderator gets the **UX of a visual editor** anyway.

To keep the generated commands from drifting, build them from the same option
definitions the real commands register, not a hand-maintained copy.

### Fidelity: be honest about what the simulator can and can't see

The simulator inherits the snapshot's known blind spots, and a moderator should
understand them rather than over-trust a green checkmark:

- It sees **only members who have sent a counted message** — candidates come from
  the `activity` table, so never-posted members are invisible.
- It cannot evaluate **server tenure** or **role gates** (no join dates or live
  roles without fetching guild members), so it *approximates* a tenure- or
  role-gated raffle. It is exact for activity, account age, cooldown, and
  blacklist.
- Its activity window **ends now** — there is no raffle start to anchor to — so
  it models "the last Y days" ending now, not the anchored-at-start window a real
  raffle uses.

Two tiers follow naturally:

- **Tier 1 (cheap, ship first): activity-centric reuse.** Exactly the snapshot,
  parameterised. High value, little new code.
- **Tier 2 (later): full fidelity via member fetch.** A backend holding the bot's
  token can fetch guild members to fill in roles and join dates, letting the
  simulator model role/tenure gates and even members with no message history.
  Costs a privileged intent and member pagination, so it is a deliberate add-on,
  not the starting point.

Because the simulator is a moderator-only, ephemeral read-out, it may show exact
numbers — the "never show the activity bar to members" rule governs
member-facing surfaces, and `/raffle eligible` and `/raffle config show` already
print these figures to moderators.

## Beyond the simulator — what else this surface unlocks

Once there is an authenticated read-only view over the same data and pure
functions, several things become cheap. Roughly ordered by value-for-effort, and
flagged by whether they lean on data we already store:

- **Activity distribution with the bar drawn on it (cheap; uses stored daily
  counts).** A histogram of members by message count over the window, with the
  candidate threshold drawn as a line: "set X = 10 and you cut the pool here."
  This is the single best answer to *"what number should I pick?"* — it turns
  guessing into reading. Pairs naturally with the simulator's live counter.
- **Activity trends over time (cheap).** We already keep daily buckets; plotting
  guild-wide activity, or the size of the eligible pool week over week, tells a
  moderator whether the server is warming up or cooling off before they schedule
  anything.
- **Raffle history and outcomes (cheap).** Past raffles, entrant counts, winners,
  rerolls, and how often winners actually claimed. A high unclaimed rate is a
  signal the claim window is too short — a tuning insight you can't see from a
  single raffle.
- **A fairness lens (cheap; uses the `wins` table).** Distribution of wins across
  members over time — has the same handful of people won repeatedly? This is the
  question a suspicious community actually asks, and the data to answer it is
  already there. Surfacing it pre-empts the "it's rigged" complaint the whole
  provably-fair scheme exists to defuse.
- **An audit timeline (cheap).** The audit log rendered as a browsable,
  filterable per-raffle timeline instead of a scroll of channel messages. A
  natural home for the CSV/JSON audit export listed as a future idea in
  design.md.
- **Config health checks (cheap).** Passive warnings the bot can't easily nag
  about in chat: no announce channel set, no counted channels configured, an
  activity window shorter than the distinct-days floor it requires, a cooldown
  longer than any raffle ever runs. Catch mis-config before a raffle, not after.
- **A public verification page (medium; the strongest trust win).** An
  *unauthenticated* read-only view of a finished raffle: the entrant-list hash,
  the revealed secret, the derived seed, the winners, and the check itself —
  `SHA-256(secret) == commitment`, `seed = SHA-256(hash + secret)` — recomputed
  **in the visitor's browser** so a green "verified" badge needs no trust in us
  at all. This is arguably the highest-value page on the whole dashboard for the
  auditable pitch, and it needs no login, which can make it the *simplest* thing
  to ship first.
- **Per-draft raffle dry-run (medium; needs Tier-2 member fetch).** The simulator
  aimed at a *specific* draft's real settings — role gates, tenure, prior-winner
  bar included — so a moderator can preview the actual pool a configured raffle
  would draw from before opening it.

A theme runs through these: the dashboard's best material is the data we are
*already* collecting for eligibility and auditing. It mostly needs presenting, not
gathering.

## Security and operations

Adding a dashboard turns the bot from an **outbound-only** worker (it dials
Discord and accepts nothing) into an **internet-facing service**. That shift is
the real cost, more than any single feature:

- TLS termination (a reverse proxy such as Caddy or nginx, or a platform that
  terminates it).
- OAuth client secret and redirect URI registered in the Discord developer
  portal; secrets kept out of the repo.
- Session security (signed, `HttpOnly`, `Secure` cookies), and basic rate
  limiting on the login and simulator endpoints.
- Process isolation as above, so the web surface can never take down message
  counting.

None of this is exotic, but it is a new operational posture and should be a
conscious decision, not a side effect of wanting nicer charts.

## Suggested sequencing

1. **Public verification page.** No auth, high trust payoff, reuses the draw
   formatting and the pure verification math. The smallest first brick.
2. **Read-only mod shell + OAuth `identify` + `ensureModerator` gating.** The
   frame everything authenticated hangs on.
3. **Eligibility simulator (Tier 1) + generate-the-command.** The feature that
   motivated this, and the cheapest high-leverage thing once the shell exists.
4. **Activity distribution / trends and raffle-history views.** Presentation over
   data we already keep.
5. **Tier-2 member fetch** (role/tenure fidelity, per-draft dry-run) and **audit
   export**, if and when they earn their keep.

## What this is deliberately not

- **Not a second write path.** No editing config or raffles from the web; the
  generate-the-command pattern gives the editing UX without the write surface. If
  that ever changes, it is a separate, carefully-scoped decision (CSRF,
  validation parity with the wizard, audit writes, write-race handling).
- **Not a member-facing surface.** It is moderator-gated, so it may show exact
  activity numbers; nothing here relaxes the rule that members never see the bar.
- **Not anomaly detection.** Judging "this looks like farming" stays with
  moderators and the blacklist. The dashboard shows facts and lets a human
  decide.
