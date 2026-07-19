# One-time droplet setup — do this ONCE, then never SSH again

After these steps, your DigitalOcean droplet auto-pulls every commit I push and restarts
itself within ~60s. I handle all fixes, tuning, and deploys from here via git. You keep
exactly one control: the go-live switch (DRY_RUN in your .env).

## Steps (SSH into the droplet, paste these)

```bash
# 1. Node 20 + pm2 (skip if already installed)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo npm install -g pm2

# 2. Clone the repo on the bot branch
git clone https://github.com/PettyMiggzy/catboy.git ~/catboy
cd ~/catboy && git checkout claude/catboy-website-nspovy && npm install --no-audit --no-fund

# 3. Secrets (only lives on your server, never committed)
cp autocopy/deploy/.env.example autocopy/deploy/.env
nano autocopy/deploy/.env          # fill BOT_TOKEN, PRIVATE_KEY, RPC_URL, RPC_WSS — leave DRY_RUN=1

# 4. Start the bot + the auto-updater, make them survive reboots
pm2 start autocopy/deploy/ecosystem.config.cjs
pm2 save
pm2 startup                        # run the one command it prints back
```

Done. It's now running in PAPER mode and self-updating.

## From here on
- I push a fix/tuning  ->  your server pulls + restarts within 60s. You do nothing.
- Watch it:  `pm2 logs autocopy`   (or just watch the Telegram DMs)
- **Go live (your switch only):**  `nano autocopy/deploy/.env` -> set `DRY_RUN=0` -> `pm2 restart autocopy`
- Pause anytime:  `pm2 stop autocopy`

The go-live flip stays yours on purpose — neither a bot nor I should ever turn real money on without you.
