# Vernissage

Vernissage is a Discord bot for running free, activity-gated raffles. Entry costs
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

3. Register the slash commands with Discord (see Registering commands below):

   ```
   docker compose run --rm bot node dist/src/deploy-commands.js
   ```

4. Watch the logs to confirm it started:

   ```
   docker compose logs -f
   ```

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
2. In the same directory, create a `compose.yaml`:

   ```yaml
   services:
     bot:
       image: ghcr.io/kara-eressea/vernissage:latest
       restart: unless-stopped
       init: true
       env_file: .env
       environment:
         DATABASE_PATH: /data/vernissage.db
       volumes:
         - vernissage-data:/data

   volumes:
     vernissage-data:
   ```

3. Pull the image and start the bot:

   ```
   docker compose pull
   docker compose up -d
   ```

4. Register the slash commands (a one-time step, and again when commands
   change):

   ```
   docker compose run --rm bot node dist/src/deploy-commands.js
   ```

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

The provided `compose.yaml` does not publish any ports, which is correct and
intentional. The container still reaches Discord through normal outbound
networking.

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

3. Register the slash commands once (and again whenever commands change):

   ```
   npm run deploy-commands
   ```

4. Start the bot. Either run directly from the TypeScript source:

   ```
   npm run dev
   ```

   or build first and run the compiled output:

   ```
   npm run build
   npm start
   ```

## Registering commands

Slash commands must be registered with Discord before they appear in the server.
This is a separate step from starting the bot. Run it once after first setup,
and again any time the set of commands changes. Starting the bot does not
register commands on its own.

- From source: `npm run deploy-commands`
- In Docker: `docker compose run --rm bot node dist/src/deploy-commands.js`

## First-time configuration in your server

After the bot is running and the commands are registered, a moderator should set
up the server:

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

All commands are subcommands of `/raffle`.

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
| `/raffle config show`                       | Show the server settings.                                                |
| `/raffle config set [options]`              | Change server settings.                                                  |
| `/raffle config channel <channel> <mode>`   | Include or exclude a channel from message counting.                      |

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

All state is stored in a single SQLite database file. By default this is
`vernissage.db` in the working directory, or the path set in `DATABASE_PATH`.
When running with Docker, the file lives in a named volume.

To back it up, copy that one file while the bot is idle or stopped. To restore,
put the file back in place before starting the bot. There is nothing else to
back up.

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
