# Vernissage — Command reference

Every command Vernissage exposes, with its options and worked examples. This is
the "how to use it" companion to [design.md](design.md); the "why it behaves this
way" rules — the eligibility order, the draw scheme, cooldown and test/reset
semantics — live there, and each command below links to the relevant section.

All functionality hangs off a single `/raffle` command as subcommands, so the bot
registers exactly one command. Options are shown as `<required>` and
`[optional]`. After changing the command surface, run `npm run deploy-commands`
to re-register (guild commands update instantly). Moving the bot between
allowlisted servers needs no re-run: it registers its commands itself when it
joins an allowlisted guild and reconciles at startup.

**Permissions.** User commands are open to everyone. Moderator commands are
hidden from ordinary members (they require the Manage Server permission) and are
additionally gated at run time by the configured mod role — see
[`/raffle config set`](#raffle-config-set). Replies noted as *ephemeral* are
visible only to the member who ran the command.

---

## User commands

### `/raffle enter [raffle]`
Enter an open raffle. The same thing the **Enter** button on the raffle
announcement does. `raffle` is the raffle id, needed only when more than one
raffle is open at once. Eligibility is checked at entry time and, on failure, the
reply tells you exactly which gate you missed (see
[Entry flow](design.md#entry-flow)). Ephemeral.

```
/raffle enter
/raffle enter raffle:42
```

### `/raffle withdraw [raffle]`
Withdraw your own entry from an open raffle. The withdrawal is logged, the
raffle's entry count updates, and you can re-enter at any time while the raffle
is still open (re-entry is re-checked against all
[eligibility rules](design.md#entry-flow)). `raffle` is only needed when more
than one raffle is open. Ephemeral.

```
/raffle withdraw
/raffle withdraw raffle:42
```

### `/raffle status [raffle]`
Show your own standing for a raffle: activity progress toward the requirement,
any win cooldown, and whether you have entered. Ephemeral.

```
/raffle status raffle:42
```

### `/raffle list`
List the raffles that are open now or scheduled to open soon.

### `/raffle claim [raffle]`
Claim a prize you won in a raffle that has a claim window, before its deadline.
If you miss the deadline the slot is re-drawn to someone else (see
[Winner claim window](design.md#winner-claim-window)). `raffle` is only needed if
you have an unclaimed win in more than one. Ephemeral.

```
/raffle claim raffle:42
```

---

## Moderator commands

### `/raffle create [name] [prize]`
Open the guided creation wizard (walkthrough [below](#the-creation-wizard)).
`name` and `prize` optionally prefill the first step for power users; everything
else is set in the wizard.

```
/raffle create
/raffle create name:"Summer Vinyl Giveaway" prize:"A record of your choice"
```

### `/raffle edit <raffle>`
Reopen the wizard on a draft or scheduled raffle to change any setting. On an
**open** raffle only the end time may change — moved earlier or later to fix a
mis-scheduled close, but never before the raffle's start — and the change is
audit-logged. Drawn or later raffles cannot be edited.

```
/raffle edit raffle:42
```

### `/raffle cancel <raffle> <reason>`
Cancel a raffle before it is drawn (any of draft, scheduled, open, or closed).
The reason is logged.

```
/raffle cancel raffle:42 reason:"Prize fell through"
```

### `/raffle draw <raffle>`
Draw a closed raffle now. Needed for raffles set to manual draw, or to force one
that has not auto-drawn yet. Idempotent — an already-drawn raffle reports so. The
selection and its verification data are published per the
[provably-fair scheme](design.md#provably-fair-draw).

```
/raffle draw raffle:42
```

### `/raffle reroll <raffle> <winner> <reason>`
Replace a disqualified winner. The replacement is re-selected from the *same*
base seed with the disqualified winner excluded, so it stays verifiable from
public data (see [Reroll semantics](design.md#provably-fair-draw)). The reason is
kept in the audit log (mod-only), not published.

```
/raffle reroll raffle:42 winner:@alice reason:"Duplicate account"
```

### `/raffle ban <user> [duration] [reason]`
Blacklist a user from raffles. `duration` accepts values like `30m`, `24h`,
`7d`, `2w`; leave it blank for a permanent ban. Banning a user who has an active
entry in an open raffle removes that entry (logged). The reason is mod-only.

```
/raffle ban user:@spammer duration:7d reason:"Raffle spam"
/raffle ban user:@spammer
```

### `/raffle unban <user>`
Lift a user's blacklist. Does **not** restore entries removed by the ban.

```
/raffle unban user:@spammer
```

### `/raffle banlist`
List the server's current blacklist, with each ban's expiry and mod-only reason.
Ephemeral.

### `/raffle reset <user> <scope>`
Reset one member's raffle standing in this server when something goes wrong — a
mis-run test that awarded a real cooldown, a spam wave that inflated someone's
counts, a win that should not have gated re-entry. Always scoped to one member in
one server; it never touches anyone else. Full semantics:
[Resetting eligibility](design.md#resetting-eligibility).

`scope` is one of:
- **cooldown** — waive the member's still-gating wins, lifting both their win
  cooldown and the prior-winner bar. Win/claim records are preserved.
- **activity** — delete the member's counted-message history (and drop any counts
  still buffered in memory, so a flush can't bring them back).
- **all** — both.

It does not lift a blacklist (use `/raffle unban`) or remove active entries.

```
/raffle reset user:@alice scope:cooldown
/raffle reset user:@alice scope:all
```

### `/raffle eligible`
Show how many members — and which ones — would be eligible right now under the
server's **default** entry settings, with no raffle running. A standing view of
the pool a new raffle would draw from, useful for sanity-checking the defaults
before opening one. Ephemeral. Full semantics:
[Listing the eligible pool](design.md#listing-the-eligible-pool).

It reuses the real entry gate, so it agrees with what members would actually
hit — with these limits, because there is no raffle to read from:
- It finds candidates from counted activity, so it needs a default activity
  requirement (`req-messages` / `req-days`); set one first if you haven't. It
  cannot see members who have never sent a counted message.
- It applies the guild-wide bars it can measure from stored data — the activity
  requirement (messages **and** distinct active days), minimum account age, and
  win cooldown — over a rolling window ending now. The **server-tenure** floor is
  skipped (no member join dates without a live fetch), and the per-raffle gates
  (role gates, prior-winner bar, open-to-everyone) have no server default, so a
  specific raffle may narrow — or widen — the pool further.

```
/raffle eligible
```

---

## Server configuration

`/raffle config` holds the per-server defaults and message-counting rules. All
replies are ephemeral.

### `/raffle config show`
Show the current configuration: audit and announce channels, mod role, hourly
cap, default cooldown, default minimum account age, default minimum time in the
server, default activity requirement (messages, active days, and window),
timezone, blacklist-message style, and the counted-channel rules with their
resulting precedence. If audit-channel posts have been failing (e.g.
the bot's access was revoked after the channel was set), the audit-channel line
carries a warning with the time the failures started.

### `/raffle config set …`
Set one or more server defaults in a single call. All options are optional; pass
only what you want to change.

| Option | Meaning |
| --- | --- |
| `audit-channel` | Channel that receives the audit-log mirror. |
| `announce-channel` | Default channel raffles announce in (a raffle can override). |
| `mod-role` | Role allowed to manage raffles (in addition to Manage Server). |
| `hourly-cap` | Max counted messages per member per hour (anti-spam). |
| `cooldown-days` | Default days a winner waits before re-entering. |
| `cooldown-count` | Default number of raffles a winner must skip. |
| `min-account-age-days` | Default minimum Discord account age to enter (server-wide). |
| `min-server-age-days` | Default minimum time in the server before entering — a tenure lockout for brand-new joiners (server-wide). |
| `req-messages` | Default messages required to enter (X). |
| `req-days` | Default activity window in days (Y). |
| `req-active-days` | Default separate active days required within the window (K) — a burst-resistant floor; 0 = no spread requirement. |
| `timezone` | IANA timezone for friendly schedule input, e.g. `Europe/Copenhagen`. |
| `blacklist-generic-message` | Show blacklisted members a generic failure instead of "blacklisted". |
| `clear` | Unset a single setting back to its default (choose which). |

The `audit-channel` and `announce-channel` options are checked before saving:
if the bot lacks **View Channel** or **Send Messages** in the chosen channel
(e.g. a private channel it hasn't been granted), the setting is rejected with
an explanation instead of failing silently at post time.

```
/raffle config set audit-channel:#raffle-log mod-role:@Mods
/raffle config set req-messages:20 req-days:14 req-active-days:3 timezone:Europe/Copenhagen
/raffle config set min-server-age-days:14
/raffle config set clear:"hourly cap"
```

### `/raffle config channels <action> [channel]`
Manage which channels' messages count toward activity. `action` is one of
`include`, `exclude`, `clear`, or `list`. The include/exclude/clear actions each
act on one channel and are run repeatedly to build up a multi-channel set; `list`
takes no channel and shows every rule.

Counting precedence (also shown by `list`): an **exclude** always wins; if any
**includes** exist they form an allowlist (only those channels count); otherwise
every channel counts.

> `channels` is a single subcommand with an `action` option rather than
> `channels include …` as separate subcommands, because Discord caps command
> nesting at command → group → subcommand and `config` already uses the group
> level.

```
/raffle config channels action:exclude channel:#bot-commands
/raffle config channels action:include channel:#general
/raffle config channels action:include channel:#music
/raffle config channels action:list
/raffle config channels action:clear channel:#general
```

---

## The creation wizard

`/raffle create` opens a guided, mostly button-and-menu-driven wizard — the
primary way mods build raffles. It is designed for non-technical users: no
options to memorize, sensible defaults from the server config, plain-language
labels, and **nothing is published until the final confirmation**. The design
rationale (drafts, restart safety) is in
[design.md](design.md#raffle-creation-wizard-design).

The flow (all on one ephemeral message that updates in place):

1. **Basics** — name, prize, and an optional description.
2. **Schedule** — start and end time. Friendly input like `now`, `tomorrow
   20:00`, or `in 3 days` is parsed to UTC and echoed back as Discord timestamp
   markup, so you see it in your own timezone before confirming (interpreted in
   the server's configured `timezone`). A start of `now` opens the raffle on
   the first scheduler sweep after you confirm.
3. **Eligibility** — the window anchor and an **Open to everyone?** toggle via
   menus, plus a modal for X messages / Y days / K separate active days. "Open
   to everyone" waives every requirement (see
   [Entry flow](design.md#entry-flow)) and can't be combined with a role gate.
   Minimum account age and server tenure are **server-wide** settings (in
   `/raffle config set`), not per-raffle. A **More restrictions…** sub-screen
   holds the optional per-raffle gates: bar prior winners, and require or exclude
   a role.
4. **Draw** — winner count, draw mode (auto at close or manual), cooldown
   override, an optional claim window in hours, and a **test-mode** toggle
   (default off — see [Test raffles](design.md#test-raffles)).
5. **Summary** — every setting in plain language (for example, "To enter, members
   must have sent at least 20 messages on at least 3 different days in the 14
   days before the raffle starts"), with buttons: **Confirm & schedule**, **Edit
   a step**, **Save as draft**, **Cancel**.

Useful behaviors:
- The raffle exists as a **draft** from step 1, so an abandoned wizard loses
  nothing — resume it any time with `/raffle edit`.
- Each of steps 3 and 4 has a **Use defaults** button that fills the still-unset
  fields from the server config.
- A bot restart mid-wizard does not lose progress; the wizard resumes at the
  right step.

## Recipes

Worked setups for common situations. All values are starting points — watch a
raffle or two and adjust.

### First-time setup for a small server

For a server of ~200 members with ~40 active in a week, running monthly
raffles, where the goal is keeping out lurkers and members who only join for
raffles:

```
/raffle config set audit-channel:#raffle-log announce-channel:#raffles mod-role:@Mods
/raffle config set req-messages:10 req-days:14 req-active-days:3 min-account-age-days:30 min-server-age-days:14 hourly-cap:10 cooldown-count:1
/raffle config channels action:exclude channel:#bot-spam
```

- **Activity 10 messages across 3 days / 14-day window**: a low bar on purpose —
  it filters, it doesn't rank. The **3 separate days** matter more than the
  count: they're what stop a one-off greeting burst from qualifying a member who
  then goes quiet. A casual-but-real member chatting a few times a week passes;
  pure lurkers and prize tourists don't. If it excludes people you consider
  active, lower `req-active-days` first, then `req-messages`, before widening
  `req-days`.
- **Account age 30 days**: blocks throwaway/alt accounts; inconveniences nobody
  legitimate.
- **Server tenure 14 days**: closes the join-for-the-raffle path — a brand-new
  member can't enter until they've been around two weeks. Pair it with the
  active-days floor and a newcomer earns eligibility by actually taking part,
  not just by showing up. For a specific one-off "everyone welcome" raffle, use
  the wizard's **Open to everyone** toggle instead of lowering these.
- **Hourly cap 10**: no real member sustains 10 counted messages an hour; it
  makes farming the (unpublished) activity bar slow.
- **Cooldown: sit out 1 raffle** rather than a day count — self-adjusting for a
  monthly cadence, and with a small eligible pool a longer cooldown thins the
  field fast.
- **Exclude bot/spam channels** from counting so measured activity is real
  conversation.

With ~40 weekly actives, expect roughly 20–35 eligible entrants; far fewer
means the bar is too high for your crowd.

### A special raffle: no recent winners

For a bigger prize where anyone who has won in the last six months should sit
out, override the cooldown on that one raffle in the wizard's **Draw** step
("Set winners & cooldown" → Winner cooldown in days: `180`). The raffle-level
value replaces the server default for that raffle only — it does not stack —
and your regular raffles are unaffected. Notes:

- Test-raffle wins and wins waived via `/raffle reset` don't count against the
  cooldown.
- The entry message states the cooldown plainly (it is not gameable, unlike
  the activity numbers, which are never published — see
  [design.md](design.md#raffle-lifecycle)).
- For the harder rule — never won here, ever — use **More restrictions… →
  Past winners: barred** (`exclude_prior_winners`) instead; it ignores time
  entirely.
