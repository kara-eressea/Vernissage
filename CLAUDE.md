# Vernissage

Discord bot for running auditable, activity-gated free raffles in the
Musicorum server. Private bot: single home guild, not distributed.

## Source of truth
Read docs/design.md before making changes. It defines the raffle lifecycle,
eligibility rules, data model, and the provably fair draw scheme. If a code
change alters behavior described there, update the doc in the same commit.

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
- The bot leaves any guild that is not the configured home guild

## Testing
- Run tests with: npm test
- New logic requires tests, especially eligibility, cooldowns, and draw selection
- The draw must be deterministic given a seed; test it with fixed seeds
- Bug fixes include a test reproducing the bug
- 
