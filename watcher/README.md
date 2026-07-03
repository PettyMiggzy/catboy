# CATBOY Launch Watcher 🐾

Emails you when a **new Solana / pump.fun token sets a website** — the moment it
publishes a DexScreener profile with a website link. Great for catching launches
that put in real effort (a website filters out most low-effort rugs).

- **Data sources (both, merged):**
  1. **pump.fun live feed** — new coins appear **seconds** after creation, with
     the `website` field already set. This is the instant trigger.
  2. **DexScreener token-profiles** — backup/cross-check once indexed.
  Alerts are deduped across both, tagged with the source and the coin's age.
- **Runs:** GitHub Action, every 5 minutes (`.github/workflows/launch-watcher.yml`).
- **Alerts:** email digest via Gmail.
- **Cost:** free. **No wallet key involved** — this only watches and emails.

## Setup (5 minutes)

### 1. Make a Gmail App Password (for the burner account)
1. Sign in to the burner Gmail.
2. Turn on **2-Step Verification** (Google Account → Security). App passwords need it.
3. Go to **Google Account → Security → App passwords**, create one named `catboy-watcher`.
4. Copy the 16-character password (looks like `abcd efgh ijkl mnop`).

### 2. Add repo secrets
In GitHub: **Settings → Secrets and variables → Actions → New repository secret**. Add:

| Secret | Value |
|--------|-------|
| `SMTP_USER` | the burner Gmail address (sends the mail) |
| `SMTP_PASS` | the 16-char App Password (no spaces) |
| `ALERT_TO`  | where to receive alerts (can be the same burner, or your main inbox) |

### 3. Enable Actions
**Settings → Actions → General →** allow actions. Open the **Actions** tab →
**Launch Watcher** → **Run workflow** to test it now. The first run seeds the
current list and sends you a **"watcher is LIVE"** email so you know it works.
After that you'll only get emails for **new** tokens.

## Tuning (edit `.github/workflows/launch-watcher.yml` → `env:`)
- `PUMP_ONLY` — `"true"` = only pump.fun mints (addresses ending in `pump`).
  Set `"false"` to watch **all** Solana tokens that set a website.
- `REQUIRE_WEBSITE` — `"true"` = only tokens with a website. Set `"false"` to
  alert on any new profile (much noisier).
- `KEYWORDS` — comma list, e.g. `"cat,ai,dog"`. Only alerts if the name/symbol/
  description contains one. Empty = everything.
- `MAX_ALERTS` — cap per email so a busy 5-min window doesn't spam you.

## Notes
- GitHub's cron can drift a few minutes under load — this is an **alert** tool,
  not a same-block sniper. For sub-second reaction you'd run `scan.py` on a
  short loop on your own droplet instead (same env vars).
- A website is **not** proof of safety. Always DYOR.

## Run it on your droplet (FASTER — polls every ~25s)

On the droplet:
```bash
# 1. get the code
git clone https://github.com/PettyMiggzy/catboy.git   # or: git pull
cd catboy/watcher

# 2. configure secrets (never committed)
cp .env.example .env
nano .env            # fill SMTP_USER / SMTP_PASS / ALERT_TO, set POLL=25

# 3a. quick test (foreground, Ctrl-C to stop)
./run_loop.sh

# 3b. run it forever as a service (survives reboots)
sudo cp catboy-watcher.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now catboy-watcher
journalctl -u catboy-watcher -f     # live logs
```

`.env` knobs: `POLL` (seconds between checks), `PUMP_ONLY`, `REQUIRE_WEBSITE`,
`KEYWORDS`, `MAX_ALERTS`. First run seeds the current list and emails you a
"watcher is LIVE" note; after that only **new** tokens trigger email.

> Website detection also catches **custom domains** (e.g. `1234.xyz`) — any http
> link that isn't a known social counts as a website, so your test token will
> trip it. Note DexScreener can take a few minutes to index a brand-new token.

Use either the GitHub Action **or** the droplet — no need for both.
