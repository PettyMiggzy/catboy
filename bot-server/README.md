# STAG bot — self-hosted (always-hot, no cold starts)

Runs the exact same bot as Vercel (`api/stag-bot.js`), but as a persistent process using
Telegram **long-polling** — so no cold starts, the file_id cache + DB stay warm, and replies
are consistently fast. No public URL/HTTPS needed. The website + (optionally) the crons stay
on Vercel; only the latency-sensitive bot moves here.

## Deploy on the droplet

```bash
# 1. tooling (skip what's already installed)  — needs Node 20+
node -v || (curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs)
sudo npm i -g pm2

# 2. get the code + the one dependency the bot needs
git clone https://github.com/PettyMiggzy/catboy.git ~/catboy   # or your fork/URL
cd ~/catboy
npm i @neondatabase/serverless

# 3. configure secrets
cp bot-server/.env.example bot-server/.env
nano bot-server/.env            # fill in STAG_BOT_TOKEN, STAG_BOT_SECRET, DATABASE_URL, STAG_VENICE_KEY

# 4. run it (starts polling, clears the old webhook automatically)
pm2 start bot-server/ecosystem.config.cjs
pm2 save && pm2 startup        # run the line pm2 prints so it survives reboots

# 5. verify
pm2 logs stag-bot              # look for "STAG bot online — long-polling"
```

Test in Telegram: `/help`, `/price`, `/trivia`. First card of each type uploads once, then
every repeat is instant (file_id cache lives forever on a persistent process).

## Important notes
- **Webhook vs polling:** Telegram allows only one. This runner calls `deleteWebhook` on start,
  so Telegram stops sending updates to Vercel and this process serves the bot instead. To go
  back to Vercel: stop this (`pm2 delete stag-bot`) and re-run the Vercel `setWebhook`.
- **Crons:** `RUN_CRONS=0` keeps the on-chain announcer + video poller on Vercel (recommended).
  Set `RUN_CRONS=1` to run them here too — the DB dedup makes double-runs safe, but pick one home.
- **Updates:** `cd ~/catboy && git pull && pm2 restart stag-bot` to ship bot changes.
- **Secrets:** live only in `bot-server/.env` on the server (gitignored). Never commit them.
- Run from the **repo root** (the pm2 config sets `cwd` for you) so `assets/trivia/*` resolves.

## Health / ops
```bash
pm2 status                 # process state, restarts, memory
pm2 logs stag-bot --lines 100
pm2 restart stag-bot
pm2 monit                  # live CPU/mem
```
