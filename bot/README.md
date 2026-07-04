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

## 4. At launch (when you have the mint)
Set the token address and reload — no redeploy needed:
```bash
# edit .env -> TOKEN_MINT=<your pump.fun mint>
pm2 restart catboy-buybot
# (or, without editing files: export TOKEN_MINT=... then `kill -HUP <pid>`)
```

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
