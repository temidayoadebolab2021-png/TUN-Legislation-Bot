# TUN Legislative & Election Bot — Getting Started (Beginner Guide)

This bot runs the legislative pipeline for your Union of Nations server:

**Propose → Sponsor → Review → Debate → Vote (weighted, button-based) → Archive**

Nothing important is hardcoded — roles, channels, percentages, durations, and
resolution templates are all set through Discord commands using `/config` and
`/template`, not by editing code.

## What's built right now (Phase 1)

- Fully configurable settings (`/config ...`)
- Custom resolution templates with up to 5 fields each (`/template ...`)
- Propose → Sponsor → Review → Debate → Vote → Archive pipeline
- Interactive voting cards with Yes/No/Abstain buttons, live tallies, ephemeral vote confirmations
- Configurable weighted voting per role
- Quorum, majority, and supermajority checks
- Automatic resolution numbering (e.g. `UNGA/2026/001`)
- Automatic stage advancement (debate ends → voting opens → voting ends → certified)
- Audit log channel + notification channel
- Resolution lookup/archive browsing (`/resolution view`, `/resolution list`)

## Not built yet (roadmap / Phase 2)

Security Council (separate track), Veto system, Amendment system, full Election
module (secret ballots, candidates, runoffs), Statistics/Reports exports. Come
back and we'll add these the same way, one module at a time.

---

## Step 1 — Install Node.js

You already have Node v24, so you're set. Just confirm in a terminal:

```
node -v
```

## Step 2 — Download this folder

Save this whole `tun-legislation-bot` folder somewhere on your computer, e.g.
your Desktop.

## Step 3 — Install the bot's dependencies

Open a terminal **inside the `tun-legislation-bot` folder** (on Windows:
right-click the folder → "Open in Terminal"; on Mac: right-click → "New
Terminal at Folder"), then run:

```
npm install
```

This downloads `discord.js` and `dotenv` — the two libraries the bot needs.
You'll see a new `node_modules` folder appear; that's normal, ignore it.

## Step 4 — Get your bot's credentials

Go to https://discord.com/developers/applications, click your bot's
application (the one you already created and invited).

1. **Bot Token**: left sidebar → "Bot" → click "Reset Token" → copy it.
   ⚠️ Treat this like a password. Never share it or post it publicly.
2. **Application (Client) ID**: left sidebar → "General Information" → copy
   "Application ID".
3. **Server (Guild) ID**: in Discord, turn on Developer Mode
   (User Settings → Advanced → Developer Mode), then right-click your
   server's icon → "Copy Server ID".

## Step 5 — Create your `.env` file

In the `tun-legislation-bot` folder, copy `.env.example` and rename the copy
to exactly `.env`. Open it and paste in your three values from Step 4:

```
DISCORD_TOKEN=your_real_token
CLIENT_ID=your_real_client_id
GUILD_ID=your_real_server_id
```

## Step 6 — Make sure your bot has the right permissions in Discord

When you invited your bot, it needs these permissions in your server:
Send Messages, Embed Links, Read Message History, Use Slash Commands, and
ideally "Manage Roles"/"View Channels" for the channels it posts in. Also, in
the Developer Portal, under "Bot", turn ON **Server Members Intent** (the bot
needs this to count eligible voters).


## Step 7 — Register the slash commands

Every time you add or change a command, run this once:

```
npm run deploy
```

You should see `✅ Slash commands registered successfully to your server.`

## Step 8 — Start the bot

```
npm start
```

You should see `✅ Logged in as YourBotName#1234`. Leave this terminal window
open — closing it stops the bot. (When you move to Railway in Step 10, it
will stay online 24/7 without you needing a terminal open.)

## Step 9 — Configure it inside Discord

In your server, run these (you need "Manage Server" permission or an Admin role):

```
/config set-channel key:Review channel:#review
/config set-channel key:Debate channel:#debate
/config set-channel key:Voting channel:#voting
/config set-channel key:Archive channel:#archive
/config set-channel key:Audit Log channel:#audit-log
/config set-channel key:Notifications channel:#announcements

/config set-role key:Admin role:@Officials
/config set-role key:General Assembly Voter role:@Member

/config set-weight role:@Minister weight:2
/config set-weight role:@Secretary-General weight:3

/config set-number key:Quorum % value:50
/config set-number key:Majority % value:50
/config set-number key:Supermajority % value:66.7
/config set-number key:Debate duration (minutes) value:1440
/config set-number key:Voting duration (minutes) value:1440
/config set-number key:Sponsors required value:2
```

Then create your first template:

```
/template create name:Military Intervention fields:Target,Purpose,Objectives,Duration,Funding supermajority:True
```

Now anyone can run `/propose`, pick "Military Intervention" from the dropdown,
fill out the pop-up form, and the whole pipeline takes over automatically.

## Step 10 — Deploy to Railway (so it runs 24/7)

1. Push this folder to a GitHub repository (or use Railway's "Deploy from
   local folder" option if offered).
2. On https://railway.app, create a New Project → "Deploy from GitHub repo"
   → select your repo.
3. In Railway's project settings → **Variables**, add the same three values
   from your `.env` file: `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`.
   (Do NOT upload your `.env` file itself — Railway uses its own Variables
   screen instead, and `.gitignore` already keeps `.env` out of GitHub.)
4. Railway will automatically run `npm install` then `npm start` (from
   `package.json`). Once it's live, run `npm run deploy` **locally once more**
   (or add it as a one-off Railway command) any time you change commands —
   this step doesn't need to run continuously.
5. Check Railway's "Deployments" logs for `✅ Logged in as...` to confirm it's
   live.

## Everyday commands cheat sheet

| Who | Command | What it does |
|---|---|---|
| Admin | `/config ...` | Change any bot setting |
| Admin | `/template create/list/toggle/delete` | Manage resolution categories |
| Anyone | `/propose` | Start a new resolution |
| Anyone eligible | `/sponsor add` / `/sponsor remove` | Endorse a resolution |
| Admin | `/review` | Approve / reject / send back a resolution |
| Admin | `/debate close` | End debate early |
| Admin | `/vote start` / `/vote close` | Manually control voting |
| Anyone | `/resolution view` / `/resolution list` | Look up resolutions |

If anything errors, check the terminal (or Railway logs) — the message there
will usually tell you exactly what's wrong (e.g. a missing channel ID).
