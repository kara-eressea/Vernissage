# Getting started on Discord

This guide walks through creating the Discord application for Vernissage,
getting the three values the bot needs, and inviting it to your server. It
assumes you can manage the Discord server you want to run raffles in.

By the end you will have three values for your `.env` file:

- `DISCORD_TOKEN`: the bot's secret token.
- `DISCORD_APP_ID`: the application's ID.
- `GUILD_IDS`: the ID of your server, or a comma-separated list of servers.

Vernissage is a private bot. It is usually run for one server, but it can serve
several (for example a test server alongside your main one); each server's
activity, raffles, and settings are kept separate. It does not need any
privileged intents, and it does not read the text of your messages. It only
counts how many messages members send in the channels you choose.

## 1. Create the application

1. Open the Discord Developer Portal at https://discord.com/developers/applications
   and sign in with your Discord account.
2. Click New Application and give it the bot's user-facing name, "Tombola"
   (the project codename "Vernissage" stays out of anything members see).
   Accept the terms and click Create.
3. Optional, can be done any time later: on General Information, add an icon,
   a description, and up to five tags. Suggested description and tags live in
   the README's "Naming and presentation" section.
4. Still on General Information, find Application ID and click Copy. Save it
   somewhere safe. This is your `DISCORD_APP_ID`.

## 2. Add the bot and copy the token

1. In the left sidebar, open the Bot tab.
2. Under the bot's username you will find the token. Click Reset Token (you may
   be asked to confirm), then Copy. Save it somewhere safe. This is your
   `DISCORD_TOKEN`.
3. Treat the token like a password. Anyone who has it can fully control the bot.
   If it is ever exposed, come back here and reset it, then update your `.env`.

The token is shown only once when you reset it. If you lose it, reset it again to
get a new one.

## 3. Turn off the privileged intents

Still on the Bot tab, scroll to Privileged Gateway Intents. Leave all three
switches off:

- Presence Intent: off.
- Server Members Intent: off.
- Message Content Intent: off.

Vernissage does not need any of these. It counts messages using the ordinary
message events, which do not require the Message Content intent, and it never
stores message text. Leaving these off is both simpler and more private.

## 4. Make the bot private

The goal here is to turn off Public Bot on the Bot tab, so only you can add the
bot to servers. Discord will not let an app be private while it still advertises
a default install link, so do this first:

1. In the left sidebar, open the Installation tab.
2. Find Install Link and change the dropdown to None. Save changes. (This does
   not affect how you invite the bot; you will invite it with an explicit
   OAuth2 URL in the next step.)
3. Go back to the Bot tab and turn off Public Bot. It now saves without the
   "Private application cannot have a default authorisation link" error.

If you skipped ahead and saw that error, this is the fix: set Install Link to
None on the Installation tab, then turn off Public Bot.

As an extra safeguard, the bot leaves any server that is not on its configured
allowlist (`GUILD_IDS`), so even if it is added elsewhere it will not operate
there.

## 5. Invite the bot to your server

1. In the left sidebar, open OAuth2, then URL Generator.
2. Under Scopes, check:
   - `bot`
   - `applications.commands`
3. A Bot Permissions box appears below. Check:
   - View Channels
   - Send Messages
4. Copy the generated URL at the bottom of the page, open it in your browser,
   choose your server, and authorize.

These two permissions are all the bot needs: it reads message events to count
activity, and it sends and edits its own messages (raffle posts, the audit log,
and announcements). It does not need any moderator or management permissions in
Discord itself; who may run its moderator commands is controlled separately,
inside the bot, with `/raffle config`.

Make sure the bot can actually see and post in the channels you plan to use for
raffles, announcements, and the audit log. If those channels restrict access by
role or permission, give the bot's role View Channel and Send Messages there.

## 6. Get your server's ID

1. In Discord, open User Settings, then Advanced, and turn on Developer Mode.
2. Right-click your server's icon or name and choose Copy Server ID. This is your
   `GUILD_IDS`.

To run in more than one server, repeat the invite step (step 5) for each server,
collect each server's ID here, and list them all in `GUILD_IDS` separated by
commas.

## 7. Put the values in your .env file

Copy `.env.example` to `.env` and fill in the three values you collected:

```
DISCORD_TOKEN=your-bot-token
DISCORD_APP_ID=your-application-id
GUILD_IDS=your-server-id
```

For several servers, separate the IDs with commas, for example
`GUILD_IDS=111111111111111111,222222222222222222`.

Do not commit `.env` to version control. It contains your secret token.

## 8. Start the bot and register its commands

Follow the run instructions in the [README](../README.md). In short:

1. Start the bot (with Docker, or from source).
2. Register the slash commands. This is a separate one-time step; starting the
   bot does not register commands on its own:
   - From source: `npm run deploy-commands`
   - In Docker: `docker compose run --rm bot node dist/src/deploy-commands.js`
3. Wait a moment, then type `/raffle` in your server to confirm the commands
   appear.

## 9. Configure the server

Once the bot is running and commands are registered, a moderator sets things up
from inside Discord:

1. Run `/raffle config set` to choose an announce channel (where raffles are
   posted), an audit channel (where a log of actions is mirrored), and a
   moderator role (who may run the moderator commands).
2. Optionally set default activity requirements, cooldowns, a minimum account
   age, and a timezone, so the raffle creation wizard can prefill them.
3. Use `/raffle config channel` to include or exclude specific channels from
   message counting.
4. Run `/raffle config show` at any time to review the settings.

Until a moderator role is set, the server owner and anyone with the Manage Server
permission can run the moderator commands.

See the [command reference in the README](../README.md#command-reference) for the
full list of commands.

## Troubleshooting

- The commands do not appear when I type `/raffle`. Make sure you ran the
  command registration step (`deploy-commands`). Newly registered commands can
  take a short while to show up; try again after a minute, or restart your
  Discord client.
- The bot appears offline. Check that it is actually running and that
  `DISCORD_TOKEN` is correct. A wrong or reset token will prevent it from
  connecting. The bot logs an error on startup if the token is invalid.
- The bot joined and then left immediately. That means the server it joined is
  not listed in `GUILD_IDS`. Confirm the server's ID is included and restart the
  bot.
- The bot cannot post in a channel. Give the bot's role View Channel and Send
  Messages in that channel.
