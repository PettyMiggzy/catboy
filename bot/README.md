# CATBOY Buy Bot 🐾

Real-time **pump.fun buy alerts** to your Telegram, powered by PumpPortal's free
WebSocket + DexScreener. No paid API. Node 18+. Built to run on your DigitalOcean droplet.

Each buy over your threshold posts the buy GIF + amount (SOL & USD), tokens
received, market cap, buyer, and quick links (TX / Pump.fun / Chart / Website).

**Covers the whole launch lifecycle:**
- **Bonding curve** buys stream live from PumpPortal the moment you set the mint.
- **DexScreener** is polled for accurate USD price & market cap (used in every alert).
- Auto-announces **📈 "chart is LIVE"** the instant DexScreener indexes the token.
- Auto-announces **🎓 "GRADUATED"** when it migrates to Raydium/PumpSwap/etc.
- Posts **🎯 market-cap milestone** hype ($10k → $25k → $50k → $100k → …).
- Post-graduation trades keep streaming (PumpPortal covers PumpSwap/Raydium too).

All lifecycle alerts are edge-triggered and primed on first poll, so restarting
the bot mid-run never re-spams events that already happened.

---

## 1. Create the Telegram bot
1. Message **@BotFather** → `/newbot` → get your **bot token**.
2. Set its picture: `/setuserpic` → upload `media/pfp.png`.
3. Add the bot to your group **as an admin** (so it can post).
4. Get the group **chat id** (add **@RawDataBot** to the group briefly, or use
   **@userinfobot**). Group ids look like `-1001234567890`.

## 2. Configure
```bash
cp .env.example .env
nano .env   # fill TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, MIN_BUY_SOL
# leave TOKEN_MINT blank until launch
```

## 3. Deploy on DigitalOcean (Ubuntu)
```bash
# one-time: install Node 18+ and pm2
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm i -g pm2

# in the bot folder
npm install
pm2 start ecosystem.config.cjs
pm2 save            # persist across reboots
pm2 startup         # follow the printed command so it boots on restart
pm2 logs catboy-buybot   # watch it
```
When you `pm2 start`, the bot posts "buy bot online" to your chat so you know it's live.

## 4. Launch day 🚀
Start the bot ahead of time (it posts **“Armed for launch”** and waits). Then,
the moment the token is live, lock it on. Three ways, easiest first:

**A) Paste the CA to the bot (recommended — works even if you don't know the
launch wallet).** DM the bot:
```
/setmint <contract address>
```
It instantly locks on, DMs you a **BUY NOW** link, posts **“$CATBOY IS LIVE”** +
the CA to the group, and starts buy alerts. Set `NOTIFY_CHAT_ID` to your user id
so the bot recognizes you as the owner (DM the bot → `/id` → it replies with your
id → put it in `.env`).

**B) Creator-wallet auto-detect.** If you know the exact wallet that will create
the token, set `CREATOR_WALLET` — the bot auto-locks the instant it launches, no
`/setmint` needed. (It also DMs you candidate CAs for any token matching
`MATCH_SYMBOL`, but never auto-locks on a symbol since copycats spoof it.)

**C) Env + reload.** Set `TOKEN_MINT=<mint>` in `.env` and `pm2 restart catboy-buybot`.

> The bot can only DM you if you've opened a chat with it and pressed **Start** —
> Telegram bots can't message first. The group post needs the bot added to
> @CatBoyOnSolana as an **admin**.

### Owner commands (DM the bot)
| command | what it does |
|---|---|
| `/id` | replies with your chat id (use it for `NOTIFY_CHAT_ID`) |
| `/setmint <CA>` | lock onto the token + start alerts (launch!) |
| `/status` | show current mint / watch state |

## Config reference (.env)
| var | meaning |
|---|---|
| `TELEGRAM_BOT_TOKEN` | from @BotFather (required) |
| `TELEGRAM_CHAT_ID` | group/channel id to post in (required) |
| `TOKEN_MINT` | your pump.fun token mint (set at launch) |
| `TOKEN_TICKER` | shown in alerts (default CATBOY) |
| `MIN_BUY_SOL` | ignore buys under this (default 0.05) |
| `BUY_EMOJI` / `EMOJI_STEP_SOL` / `EMOJI_MAX` | the buy bar |
| `BUY_MEDIA` | local path (`media/buy.gif`) or an https URL |
| `SITE_URL` | website link in alerts |
| `DEX_POLL_MS` | DexScreener poll interval (default 30000ms, min 15000) |
| `ANNOUNCE_MIGRATION` | `1` announce graduation to a DEX, `0` off |
| `MCAP_MILESTONES` | comma-separated USD milestones (blank to disable) |
| `CREATOR_WALLET` | launching wallet — auto-detect the mint at creation |
| `MATCH_SYMBOL` | fallback launch match by ticker (default CATBOY) |
| `NOTIFY_CHAT_ID` | your DM chat for a priority “BUY NOW” launch ping |

## Notes
- Works on the bonding curve (pre-graduation) via PumpPortal. After graduation to
  Raydium/PumpSwap, PumpPortal still streams trades for the same mint.
- DexScreener has no public per-trade stream, so it enriches alerts (price/mcap)
  and drives the chart-live / graduation / milestone announcements — the actual
  per-buy feed is always PumpPortal.
- The GIF is uploaded once, then reused by Telegram `file_id` (fast, no re-upload).
- Alternative to pm2: a `systemd` service — ask and I'll drop in a unit file.

Alt run (no pm2):
```bash
npm install && node index.js
```
