# Vernissage

Vernissage (presented to users as **Tombola**) is a Discord bot for running
free, activity-gated raffles. Vernissage is the project's codename; the Discord
application, its profile, and anything members see use the product name
Tombola. Entry costs
nothing, but only members who have been active recently can enter, and winners
are chosen in a way that anyone can independently verify was fair. It is a
private bot: it serves only the servers you configure and leaves any other server
it is added to. It is typically run for one server, but supports several (for
example a test server alongside your main one); each server's activity, raffles,
and settings are kept separate.

## What it does

- Counts how many messages each member sends, in the channels you choose, and
  uses those counts to decide who is eligible to enter a raffle. Only counts are
  stored, never message text.
- Lets moderators create raffles with a step-by-step wizard: name and prize, a
  schedule, an activity requirement, a winner count, a draw mode, and optional
  extra restrictions (see Raffle options below).
- Opens and closes raffles automatically at their scheduled times.
- Draws winners using a provably fair scheme, so a third party can recompute the
  result from public data and confirm nothing was rigged.
- Optionally requires winners to claim their prize within a time limit, and
  automatically re-draws any prize left unclaimed — still provably fair.
- Lets moderators re-draw a disqualified winner and block specific users from
  entering.
- Writes every significant action to a log and can mirror those actions to a
  private audit channel.

For the full design, including the raffle lifecycle, eligibility rules, cooldown
rules, the draw scheme, and the data model, see [docs/design.md](docs/design.md).

## Naming and presentation

The Discord application is named **Tombola**. Individual servers can override
it with a nickname as usual. Copy-paste material for the application page
(General Information in the [Developer Portal](https://discord.com/developers/applications);
all of it can be added or changed at any time):

**Description** (max 400 characters):

> Tombola runs free, provably fair raffles for your community. Entry is
> activity-gated — members earn their ticket by being active, not by spamming —
> with account-age checks, winner cooldowns, and claim windows. Every entry,
> draw, and reroll is audit-logged, and winners are drawn from a published
> commitment so results are verifiable.

**Tags** (max 5): `raffle`, `giveaway`, `community`, `events`, `moderation`.

## Requirements

- Node.js version 20 or newer, to run from source or to build the container.
- A Discord account with permission to create an application and add a bot to
  your server.
- Docker and the Docker Compose plugin, if you want to run it on a server (this
  is the recommended way).

## Discord setup

You need three values from Discord: a bot token, an application ID, and your
server's ID. For a detailed, step-by-step walkthrough with troubleshooting, see
[docs/discord-setup.md](docs/discord-setup.md). The short version is below.

1. Open the Discord Developer Portal and create a new application.
2. On the General Information page, copy the Application ID. This is your
   `DISCORD_APP_ID`.
3. Open the Bot tab. Reveal the token (you may need to reset it first) and copy
   it. This is your `DISCORD_TOKEN`. Keep it secret. Anyone with the token can
   control the bot.
4. Still on the Bot tab, under Privileged Gateway Intents, leave all three
   switches off. This bot does not need the Presence, Server Members, or Message
   Content intents.
5. Turn off Public Bot so that only you can add the bot to servers.
6. Invite the bot to your server. Under OAuth2, use the URL Generator. Select
   the scopes `bot` and `applications.commands`. Under Bot Permissions, select
   View Channels and Send Messages. Open the generated URL and add the bot to
   your server.
7. Get your server's ID. In Discord, enable Developer Mode (User Settings,
   Advanced), then right-click your server and choose Copy Server ID. This is
   your `GUILD_IDS`. To run in more than one server (for example a test server),
   list each ID separated by commas, and repeat this step and the invite step for
   each server.

The bot serves only the servers you list in `GUILD_IDS`. If it is ever added to
any other server, it leaves on its own.

## Configuration

The bot reads its settings from environment variables. Copy `.env.example` to
`.env` and fill in the values.

| Variable          | Required | Description                                                        |
| ----------------- | -------- | ------------------------------------------------------------------ |
| `DISCORD_TOKEN`   | Yes      | The bot token from the Developer Portal.                           |
| `DISCORD_APP_ID`  | Yes      | The application ID, used to register slash commands.               |
| `GUILD_IDS`       | Yes      | Comma-separated list of server IDs the bot may operate in. One ID for a single server, or several (for example a test server and your main server). The bot leaves any server not listed. |
| `DATABASE_PATH`   | No       | Path to the SQLite database file. Defaults to `./vernissage.db`.   |

The old single-server variable `HOME_GUILD_ID` still works as a fallback when
`GUILD_IDS` is not set, so existing setups need no change.

Everything else, such as the audit channel, the moderator role, and default
raffle settings, is configured from inside Discord with the `/raffle config`
command after the bot is running.

## Running on a server with Docker

This is the recommended way to run the bot around the clock.

1. Copy `.env.example` to `.env` and fill in the three required values.
2. Build the image and start the bot in the background:

   ```
   docker compose up -d --build
   ```

3. Watch the logs to confirm it started:

   ```
   docker compose logs -f
   ```

The bot registers its slash commands on startup, so there is no separate
registration step; see [Registering commands](#registering-commands).

To stop the bot, run `docker compose down`. Your data is kept in a named volume
and is not deleted.

The steps above build the image locally from a clone of this repository. If you
would rather not build it yourself, use the published image instead, as
described next.

### Using the published image

Each tagged release is published as a container image to the GitHub Container
Registry at `ghcr.io/kara-eressea/vernissage`. To run that image instead of
building your own, you only need a `.env` file and a small `compose.yaml`; you do
not need to clone the repository.

1. Create a `.env` file with the three required values (see Configuration
   above), in an empty directory.
2. In the same directory, put a `compose.yaml`. A ready-made one lives in this
   repository at [`deploy/compose.published.yaml`](deploy/compose.published.yaml)
   — copy it, or fetch it without cloning:

   ```
   curl -o compose.yaml https://raw.githubusercontent.com/kara-eressea/vernissage/main/deploy/compose.published.yaml
   ```

   It defines the `bot` service and an optional `dashboard` service; delete the
   `dashboard` block if you don't want the web UI. Every backup archive also
   contains a copy of this file, so a host rebuilt from a backup already has it.

3. Pull the image and start the bot:

   ```
   docker compose pull
   docker compose up -d
   ```

The bot registers its slash commands on startup, so there is nothing else to
run; see [Registering commands](#registering-commands).

To update later, run `docker compose pull` followed by `docker compose up -d`.
Pin to a specific version instead of `latest` (for example
`ghcr.io/kara-eressea/vernissage:0.1.0`) if you prefer to control upgrades.

The image is tied to this repository. If the package is private, either make it
public in the repository's package settings, or log in to the registry first
with `docker login ghcr.io` using a GitHub token that has the `read:packages`
scope.

### Networking: no inbound ports needed

The bot only makes outbound connections to Discord, over the standard HTTPS port
443. It does not accept any incoming connections and does not listen on any
port. Because of that:

- You do not need to open any port in your firewall. A firewall that allows
  outbound traffic, which is the common default, needs no changes.
- You do not need a reverse proxy. There is nothing to proxy, because the bot
  serves no web traffic.
- If you already run a web server such as Caddy or nginx on ports 80 and 443,
  this bot does not conflict with it, because the bot does not listen on those
  ports or any others.

The provided `compose.yaml`'s **bot** service does not publish any ports, which
is correct and intentional. The container still reaches Discord through normal
outbound networking.

This is true of the bot itself. The **optional moderator dashboard** (below) is
the one exception: it is a web service, so it does listen — and it expects a
reverse proxy in front of it.

### Optional: the moderator dashboard

`compose.yaml` also defines a `dashboard` service — a separate, **read-only**
web app for moderators (Discord login, a home overview of live raffles, the
eligible-pool count, and recent activity). It is entirely optional; comment the
service out if you don't want it, and the bot runs exactly as before.

If you do run it:

- It opens the **same** database read-only (sharing the volume), so it can never
  take the bot down or corrupt data. The bot stays the sole writer.
- It never holds the bot token. It needs its own OAuth2 credentials and a
  session secret — set `DISCORD_CLIENT_SECRET`, `DASHBOARD_BASE_URL`, and
  `DASHBOARD_SESSION_SECRET` in `.env` (see `.env.example`), and add
  `<DASHBOARD_BASE_URL>/auth/callback` as an OAuth2 redirect in the Developer
  Portal.
- It expects TLS to be terminated by a **reverse proxy** (Caddy or nginx) in
  front of it; the service publishes only on `127.0.0.1:8080` for the proxy to
  forward to. A minimal Caddyfile:

  ```
  tombola.example.com {
      reverse_proxy 127.0.0.1:8080
  }
  ```

- For now, sign-in requires the **Manage Server** permission (or guild
  ownership) on an allowlisted server; a moderator who only holds the configured
  mod-role can't sign in yet. See [docs/dashboard.md](docs/dashboard.md).

### Run only one instance

The bot keeps a single connection to Discord and runs its scheduler inside one
process. Do not run more than one copy against the same server or the same
database. Two copies would count messages twice and could draw a raffle twice.

## Running from source (for development)

1. Copy `.env.example` to `.env` and fill in the values.
2. Install dependencies:

   ```
   npm ci
   ```

3. Start the bot. Either run directly from the TypeScript source:

   ```
   npm run dev
   ```

   or build first and run the compiled output:

   ```
   npm run build
   npm start
   ```

## Registering commands

The bot registers its slash commands itself: at startup, in every allowlisted
guild it is already a member of, and again the moment it joins one. Starting it
is enough — after a first setup, an upgrade, or a move to a new host, the
commands are there without a separate step.

`deploy-commands` is a manual escape hatch for registering without restarting
the bot, which is mostly useful while developing:

- From source: `npm run deploy-commands`
- In Docker: `docker compose run --rm bot node dist/src/deploy-commands.js`

Either way, commands are registered per guild rather than globally, so they
appear as soon as they are registered instead of propagating slowly. Allowlisted
guilds the bot has not joined yet are skipped, not errors.

## First-time configuration in your server

After the bot is running, a moderator should set up the server:

1. Run `/raffle config set` and choose an audit channel, an announce channel,
   and a moderator role. The announce channel is where raffles are posted. The
   audit channel receives a log of actions. The moderator role controls who may
   run the moderator commands.
2. Optionally set default activity requirements, cooldowns, a minimum account
   age, and a timezone, so the raffle creation wizard can fill those in for you.
3. Use `/raffle config channel` to include or exclude specific channels from
   message counting, for example to exclude a bot-commands channel.
4. Run `/raffle config show` at any time to review the current settings.

Until a moderator role is set, the server owner and anyone with the Manage
Server permission can run the moderator commands.

## Command reference

All commands are subcommands of `/raffle`. This is a quick overview; for every
option and worked examples, see [docs/commands.md](docs/commands.md).

### For everyone

| Command                  | What it does                                                                 |
| ------------------------ | --------------------------------------------------------------------------- |
| `/raffle enter [raffle]` | Enter an open raffle. You can also press the Enter button on the raffle post. |
| `/raffle status [raffle]`| See your own eligibility: activity progress, cooldown, and entry status. Only you see the reply. |
| `/raffle list`           | Show open and upcoming raffles.                                             |
| `/raffle claim [raffle]` | Claim a prize you won, for raffles that have a claim window. Claim before the deadline shown in the winner announcement or the prize is re-drawn. |

### For moderators

| Command                                     | What it does                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| `/raffle create`                            | Start the guided wizard to create a raffle.                              |
| `/raffle edit <raffle>`                     | Edit a draft or scheduled raffle. On an open raffle you can correct the end time (earlier or later, but not before it started). |
| `/raffle cancel <raffle> <reason>`          | Cancel a raffle before it is drawn.                                      |
| `/raffle draw <raffle>`                     | Draw a closed raffle now, if it is not set to draw automatically.        |
| `/raffle reroll <raffle> <winner> <reason>` | Replace a disqualified winner. Recorded with the reason.                 |
| `/raffle ban <user> [duration] [reason]`    | Block a user from entering. Duration examples: `30m`, `24h`, `7d`, `2w`. Leave blank for a permanent block. |
| `/raffle unban <user>`                      | Remove a user's block. Does not restore entries that were already removed. |
| `/raffle banlist`                           | List currently blocked users. Only you see the reply.                    |
| `/raffle reset <user> <scope>`              | Reset a member's standing: `cooldown`, `activity`, or `all`. Scoped to that one member. |
| `/raffle config show`                       | Show the server settings.                                                |
| `/raffle config set [options]`              | Change server settings.                                                  |
| `/raffle config channels <action> [channel]`| Include, exclude, or clear a counted channel, or `list` the rules. Run per channel to build a multi-channel set. |

## Raffle options

When a moderator creates a raffle with `/raffle create`, the wizard offers these
settings. Most have a server-wide default (set with `/raffle config`) that the
wizard pre-fills, so you only change what you want to differ for that raffle.

- **Activity requirement** — how many messages a member must have sent, over how
  many days, to be eligible. The window can end at the raffle's start (the
  default, so activity after the announcement doesn't count) or roll up to the
  moment each person enters.
- **Minimum account age** — optionally require that a member's Discord account is
  at least a certain age.
- **New-member exemption** — optionally let members who joined the server very
  recently enter without meeting the activity requirement.
- **Winner cooldown** — after winning, a member can be barred from entering again
  for a number of days and/or for a number of future raffles.
- **Winner count and draw mode** — how many winners to draw, and whether the draw
  runs automatically at close or is triggered by a moderator.
- **Test mode** — mark a raffle as a test: it is badged as having no prize and its
  result never affects anyone's eligibility (no cooldown, no prior-winner bar),
  so you can rehearse the full flow in a live server safely.

Under **More restrictions** in the wizard's eligibility step, these optional
gates are all off by default:

- **Bar past winners** — exclude anyone who has ever won a raffle in this server
  (a permanent bar, separate from the temporary winner cooldown).
- **Require a role** — only members with a chosen role may enter.
- **Exclude a role** — members with a chosen role may not enter (for example, to
  keep staff out).

The person who created a raffle can never enter it themselves; this is always
enforced and needs no setting.

In the draw step you can also set a **claim window**: a number of hours within
which each winner must claim their prize with `/raffle claim`. The winner
announcement shows the deadline. If a winner doesn't claim in time, the bot
automatically re-draws their prize to the next eligible entrant (who then gets
their own claim window), keeping the draw provably fair. Leave it blank to give
prizes out with no claim step.

## How it works, briefly

- Activity counting: the bot listens for messages in the channels you count and
  keeps a per-member daily total. It never reads or stores message text, only
  the totals. A raffle's activity requirement (for example, at least 20 messages
  in the last 14 days) is checked against these totals when someone tries to
  enter.
- Provably fair draw: when a raffle closes, the bot freezes the list of
  entrants, publishes a fingerprint of that list, and publishes a commitment to
  a secret value. When it draws, it reveals the secret. Anyone can combine the
  entrant list and the secret to recompute the winners and confirm they were not
  chosen after the fact.

The full details are in [docs/design.md](docs/design.md).

## Data and backups

All data lives in a single SQLite database file — by default `vernissage.db` in
the working directory, or the path set in `DATABASE_PATH`. Under Docker it sits
in the named volume `vernissage-data`.

Don't copy that file by hand. The bot keeps the database in WAL mode, so a
running bot may have committed data that is not in `vernissage.db` yet, and a
plain copy would silently lose it. Use the backup command instead:

```
docker compose run --rm -v "$PWD:/backup" bot node dist/src/backup.js /backup
```

That writes `vernissage-backup-<timestamp>.tar.gz` into the current directory.
It is safe to run while the bot is running: the snapshot is taken through a
read-only connection and captures every committed transaction and no
half-finished one. From a source clone, `npm run backup` does the same.

The container runs as a non-root user (uid 1000), so the directory you mount at
`/backup` must be writable by it. If you keep the stack somewhere root-owned
such as `/root/tombola`, the command fails with a permission error; either back
up into a directory you own, or add `--user root` to the `docker compose run`.

The archive contains:

| Entry | What it is |
| --- | --- |
| `vernissage.db` | The database snapshot, verified and checksummed |
| `manifest.json` | When it was taken, the schema version, row counts, and the snapshot's SHA-256 |
| `env.template` | Your configuration, **with every secret left blank** |
| `compose.yaml` | A ready-to-run compose file for a new host |

**Your credentials are deliberately not included** — no bot token, OAuth client
secret, session secret or handoff secret. Keep a copy of your `.env` somewhere
secure as well, since without it you would have to reissue those.
`env.template` records which of them were set and carries the non-secret values
across, so on a new host you only need to fill in the blanks.

The database itself is still sensitive, so treat the archive as private rather
than as something to drop in a shared folder. It holds per-member message
counts, blacklist entries and the moderator notes attached to them, and — for
any raffle that has closed but not yet been drawn — that raffle's
`draw_secret`. That secret is what the published commitment commits to, and it
is meant to stay unknown until the draw is announced; anyone holding it can work
out the winners in advance. Raffles set to draw manually can sit in that state
for as long as the moderator leaves them. Once a raffle is drawn its secret is
published anyway, so only the not-yet-drawn ones matter.

For the same reason, restore replaces the database rather than merging into it,
and verifies a checksum first: the entrant hashes, commitments and revealed
secrets of past raffles have to come back exactly as they were, or the
verification page and anyone checking a past draw by hand would no longer agree.

To restore, stop the bot first — two processes must never share one database —
then:

```
docker compose stop bot dashboard
docker compose run --rm -v "$PWD:/backup" bot \
  node dist/src/restore.js /backup/vernissage-backup-20260909T101500Z.tar.gz --yes --force
docker compose up -d
```

(Drop `dashboard` from the `stop` if you don't run that service. `--force` is
what allows an existing database to be replaced — leave it off when restoring
onto a host that has none, and restore will refuse if it finds one. See
[Restoring while a raffle is running](#restoring-while-a-raffle-is-running) if a
raffle is mid-flight.)

Restore refuses to do anything questionable: it verifies the archive's checksum,
runs an integrity check, and rejects an archive made by a *newer* version of the
bot than the image you are restoring onto. The database it replaces is kept
alongside as `vernissage.db.pre-restore-<timestamp>` rather than deleted. An
older database is migrated forward automatically when it is opened.

### Restoring while a raffle is running

Backing up is always safe, whatever is going on — the snapshot is read-only and
the bot never pauses. Restoring is the one to think about, and what matters is
not the age of the backup but the state of the raffles it would overwrite.

**The case to avoid:** restoring a backup that was taken *before* a raffle
closed, onto a database where that raffle has since closed and drawn. The bot
publishes a commitment when a raffle closes and reveals the matching secret when
it draws. A backup from before the close does not carry that commitment, so on
restart the bot sees an uncommitted raffle, generates a **new** secret, posts a
second commitment, and draws again from a different seed — quite possibly
picking different winners than the ones it already announced. The published
proof and the announced result would no longer agree, and that is not something
a later restore can put right.

Restore detects this and refuses, naming the raffle, so you do not have to
remember the rule:

```
Restore failed: This restore would rewrite a draw that has already been announced:
  - raffle 1 ("Summer vinyl giveaway") has a published draw commitment that this
    backup does not carry. ...
```

Pass `--rewrite-published-draws` only if you genuinely mean to redo that draw.

**Restoring a backup taken after the raffle drew is fine.** It carries the same
commitment and secret, so the bot reuses them and reaches the same winners.

Everything else is ordinary data loss rather than a broken promise, and restore
lists it after the fact rather than blocking:

- Entries made after the backup are gone. Those members were told they were in,
  and now are not.
- Wins recorded after the backup are gone, so win cooldowns and claim deadlines
  revert with them.
- Raffles created after the backup disappear.

Separately, the bot cannot count messages while it is stopped, and that feeds
activity eligibility — so keep any restore window short if a raffle is open.

**The short version:** back up whenever you like; restore from the newest backup
you have, ideally when nothing is between closing and being drawn.

## Moving to a new host

1. On the old host, stop the bot, then take the backup:

   ```
   docker compose down
   docker compose run --rm -v "$PWD:/backup" bot node dist/src/backup.js /backup
   ```

   Backing up while the bot runs is safe, but for a move it is the wrong order:
   anything counted between the snapshot and the shutdown would be lost. Stopping
   first makes the archive the complete final state of the old host. Leave it
   down afterwards — if it counts a message or draws a raffle once the backup is
   taken, the archive no longer matches it and the two databases have diverged.

   Messages sent while the bot is down are not counted, so keep the gap short.

2. Copy the archive and your `.env` to the new host.

3. On the new host, in an empty directory holding your `.env`:

   ```
   tar -xzf vernissage-backup-20260909T101500Z.tar.gz compose.yaml
   docker compose pull
   docker compose run --rm -v "$PWD:/backup" bot \
     node dist/src/restore.js /backup/vernissage-backup-20260909T101500Z.tar.gz --yes
   docker compose up -d
   ```

   Use your archive's real filename — `docker compose run` does not expand
   wildcards. Slash commands re-register themselves on startup, so there is no
   separate registration step.

4. Check the things a backup cannot carry:

   - If you run the dashboard, its OAuth redirect URI in the Discord Developer
     Portal must match the new `DASHBOARD_BASE_URL` (that URL plus
     `/auth/callback`).
   - Move the reverse-proxy configuration and its TLS certificates, and point
     DNS at the new host.

5. Confirm it worked: `docker compose logs -f bot` should show it connecting,
   `/raffle list` in Discord should show your raffles, and — the sharpest check
   that nothing was lost — the dashboard's verification page should still
   reproduce the proof for a past draw.

## Development

- Install dependencies: `npm ci`
- Run the tests: `npm test`
- Type-check without building: `npm run typecheck`
- Build to `dist/`: `npm run build`

The tests use an in-memory database and do not connect to Discord.

### Cutting a release

Releases are driven by version tags. Pushing a tag that looks like `v1.2.3`
triggers the release workflow (`.github/workflows/release.yml`), which builds the
container image for amd64 and arm64 and publishes it to
`ghcr.io/kara-eressea/vernissage`.

```
git tag v0.1.0
git push origin v0.1.0
```

The workflow tags the image with the full version and the major and minor
versions (for example `0.1.0`, `0.1`, and `0`), and moves the `latest` tag for
stable releases. Pre-release tags such as `v0.1.0-rc.1` are published but do not
move `latest`. Use annotated, semantic version tags so the tags come out as
expected.

## License

See [LICENSE](LICENSE).
