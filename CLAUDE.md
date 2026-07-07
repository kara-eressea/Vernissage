# Vernissage

Discord bot for running auditable, activity-gated free raffles, primarily for
the Musicorum server. "Vernissage" is the project codename; the bot presents to
users as "Tombola" — user-facing copy that names the bot must say Tombola,
never Vernissage. Private bot: an allowlist of one or more guilds (GUILD_IDS,
usually just one), not distributed. Per-guild data (activity, raffles, wins,
blacklist, config) is scoped by guild_id and kept separate.

## Source of truth
Read docs/design.md before making changes. It defines the raffle lifecycle,
eligibility rules, data model, and the provably fair draw scheme — the "why". If
a code change alters behavior described there, update the doc in the same commit.

docs/commands.md is the command reference — the slash-command surface (every
subcommand, its options, and examples), the "how to use". If a change adds,
renames, or reworks a command or its options, update commands.md in the same
commit. Keep the split clean: behavioral rules live in design.md and commands.md
links to them; don't restate rules in both.

## Stack
- TypeScript, discord.js, better-sqlite3, Vitest
- Single process, persistent gateway connection, in-process scheduler,
  must run 24/7

## Conventions
- All timestamps stored in UTC ISO format
- Never store message content, only counts
- Every state change (raffle, entry, blacklist) writes an audit_log row
- Eligibility checks happen at entry time, in the order listed in the design doc
- Core logic (eligibility, cooldowns, draw) is pure functions with no
  Discord dependencies; the Discord layer only parses, calls, and formats
- The bot leaves any guild not on the configured allowlist (GUILD_IDS)

## Testing
- Run tests with: npm test
- New logic requires tests, especially eligibility, cooldowns, and draw selection
- The draw must be deterministic given a seed; test it with fixed seeds
- Bug fixes include a test reproducing the bug
- 
