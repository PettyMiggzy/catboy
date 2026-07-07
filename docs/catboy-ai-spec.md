# $CATBOY AI — Build Spec

In-chat AI image & video generation for the Telegram group. Users pay in
$CATBOY for credits, generate custom Catboy art/video with `/img` and `/vid`,
and holders earn monthly rebates. This document is the build blueprint.

> **Source secrecy:** the AI provider, model ids, and endpoint are NEVER
> hardcoded in this repo (it's public). They live only in droplet env vars
> (`AI_*` below). All public copy calls it "the $CATBOY AI engine."

---

## 1. User-facing commands (in the group)

| Command | Who | Does |
|---|---|---|
| `/img <prompt>` | anyone w/ credits | Generate a Catboy image, post it in-chat (~5s) |
| `/vid <prompt>` | anyone w/ credits | Generate a 5s Catboy clip, post it in-chat (~1–2 min) |
| `/credits` | anyone | DM a top-up link (buy credits with $CATBOY) |
| `/balance` | anyone | Reply with the user's current credit balance |
| `/ban` (reply to a generation) | mods/admin | Ban the user who made that image + delete it |
| `/aistats` | admin | Provider balance, today's gens, revenue, low-balance status |

- Generations **always post in the group** (never DM) so mods can watch and
  `/ban` abusers. Each post is tagged with the requester + their prompt.
- Per-user cooldown (default 20s) to prevent flooding.

---

## 2. Pricing & rebates (LOCKED)

- **Image:** $0.30 per generation
- **Video:** $1.50 per 5s clip
- Prices are **USD-denominated**; charged in $CATBOY at the **live rate** at
  top-up time (same price feed the ticker/buybot use).
- Credits are internal USD cents (1 credit = $0.01) → image = 30 credits,
  video = 150 credits. Sell in bundles ($5 / $15 / $50).

**Holder rebate (monthly, paid in $CATBOY):**

| Held | Rebate | Held | Rebate |
|---|---|---|---|
| 1M | 0.5% | 6M | 3.0% |
| 2M | 1.0% | 7M | 3.5% |
| 3M | 1.5% | 8M | 4.0% |
| 4M | 2.0% | 9M | 4.5% |
| 5M | 2.5% | **10M+** | **20%** 🐋 |

- Formula: `holdings < 10M → floor(holdings / 1M) * 0.5%`, capped 4.5%;
  `holdings >= 10M → 20%`.
- Rebate = that % of the user's **total spend that month**, sent back in
  $CATBOY to their verified wallet. Runs as a monthly cron.
- Wallet↔Telegram binding reuses the **whale-gate verify link** (already built).

**Economics (all in the green):**

| | Charge | −20% rebate | Cost | Profit |
|---|---|---|---|---|
| Image | $0.30 | $0.24 | ~$0.08 | **+$0.16 (2×)** |
| Video | $1.50 | $1.20 | ~$0.47 | **+$0.73 (2.5×)** |

---

## 3. Architecture (reuse what exists)

- **Telegram handler:** new `bot/aigen.js`, dispatched from `bot/index.js`
  (same pattern as `whaleCommand`). Fork mode, own pm2 process optional.
- **Payments / credits:** reuse the merch/mint Token-2022 flow + the whale-gate
  signed link for wallet↔tid binding.
- **Provider calls:** thin client in `bot/aigen.js`, all provider specifics in
  env (see §7). Image = sync generate. Video = queue + poll (like the existing
  promo video flow).
- **DB:** Neon (same `DATABASE_URL`). New tables in §6.
- **Price feed:** reuse the existing $CATBOY/USD source.

---

## 4. Generation engine

- **Locked Catboy prompt prefix** (server-side, prepended to every user prompt
  so output is always our mascot):
  > `masterpiece anime illustration of CATBOY, a young man with messy spiky
  > blonde hair, fluffy tan cat ears with white fur inside, glowing
  > electric-blue eyes, black cyberpunk bomber jacket with glowing cyan and
  > magenta neon trim and a silver Solana chain necklace. {USER_PROMPT}.
  > consistent character design, vibrant cyan-magenta-gold palette, cinematic
  > lighting, ultra detailed, safe for work, no text no watermark.`
- **Image:** provider model in `AI_IMAGE_MODEL`, 1024×1024, `safe_mode:true`.
  ~5s, ~$0.08. (Proven: consistent character across scenes.)
- **Video:** generate the still first (image), then image-to-video via
  `AI_VIDEO_MODEL` (queue+poll). Character preserved because it animates the
  actual still. ~$0.47 all-in, ~75s.
- **Negative prompt / safe_mode** always on; reject prompts matching a
  blocklist (nsfw/violence/hate/celebrity/illegal) before spending.

---

## 5. Moderation & safety

1. `safe_mode: true` on every call (provider-side filter).
2. Prompt blocklist check before charging.
3. Every generation posts in-chat → mods see all output live.
4. `/ban` (admin, reply-to-image) → ban user + delete message.
5. Per-user rate limit / cooldown.
6. Log every generation (user, prompt, cost, result) for audit.

---

## 6. Failure handling & alerts

- **Refund on failure:** charge → generate → if the provider errors/times out,
  **auto-refund the credit** and reply "try again, you weren't charged."
- **Low provider-balance alert:** before/after each gen, check provider balance;
  when it drops below `AI_LOW_BALANCE_USD` (default $10), post a warning in-chat
  **and** DM the dev/admin so funds go out before service stops. Throttle to
  once/hour.

---

## 7. DB schema (Neon)

```sql
CREATE TABLE IF NOT EXISTS ai_credits (
  tid          TEXT PRIMARY KEY,        -- telegram user id
  balance_cents BIGINT NOT NULL DEFAULT 0,
  spent_cents_month BIGINT NOT NULL DEFAULT 0,  -- resets on rebate run
  updated_at   TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ai_topups (
  sig          TEXT PRIMARY KEY,        -- payment tx sig (idempotent)
  tid          TEXT NOT NULL,
  usd_cents    BIGINT NOT NULL,
  catboy_paid  NUMERIC NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ai_gens (
  id           BIGSERIAL PRIMARY KEY,
  tid          TEXT NOT NULL,
  kind         TEXT NOT NULL,           -- 'img' | 'vid'
  prompt       TEXT,
  cost_cents   BIGINT NOT NULL,
  status       TEXT NOT NULL,           -- 'ok' | 'refunded' | 'failed'
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ai_rebates (
  id           BIGSERIAL PRIMARY KEY,
  tid          TEXT NOT NULL,
  wallet       TEXT NOT NULL,
  month        TEXT NOT NULL,           -- 'YYYY-MM'
  spend_cents  BIGINT NOT NULL,
  pct          NUMERIC NOT NULL,
  catboy_sent  NUMERIC,
  status       TEXT NOT NULL DEFAULT 'pending',
  UNIQUE (tid, month)
);
-- wallet↔tid binding: reuse whale_wallets (already exists)
```

---

## 8. Env vars (as implemented)

**Droplet `bot/.env`** (provider secrets live here ONLY):
```
AI_PROVIDER_KEY      # provider API key
AI_PROVIDER_BASE     # provider base url (e.g. .../api/v1) — no default, keeps repo clean
AI_IMAGE_MODEL       # image model id
AI_VIDEO_MODEL       # image-to-video model id
AI_SECRET            # HMAC for the top-up link — MUST match Vercel
AI_SITE=https://www.catboyonsol.fun
AI_IMG_PRICE_CENTS=30
AI_VID_PRICE_CENTS=150
AI_COOLDOWN_SEC=20
AI_ENABLE_VIDEO=false   # flip to true for phase 2
AI_LOW_BALANCE_USD=10
# reuses: DATABASE_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TOKEN_MINT,
#         NOTIFY_CHAT_ID/ADMIN_CHAT_ID (for /ban + low-balance alert)
```

**Vercel** (payments only — NO provider keys):
```
AI_SECRET            # same value as the droplet
AI_TREASURY          # wallet that receives $CATBOY top-ups
TOKEN_MINT           # $CATBOY mint (already set)
SOLANA_RPC           # already set
AI_DECIMALS=6
```
Bundles ($5/$15/$50) and prices are defined in `api/credits.js` / `bot/aigen.js`.

---

## 9. Build order

1. **DB + credits ledger** (`ai_credits`, `/balance`).
2. **Top-up flow** — `/credits` → signed link → pay $CATBOY → credit (reuse
   whale link + merch pay). Idempotent by tx sig.
3. **`/img`** — charge → locked-prompt generate → post in-chat → refund on fail.
4. **`/ban` + cooldown + blocklist + logging.**
5. **Low-balance alert.**
6. **`/vid`** (phase 2) — image→video queue/poll, premium price.
7. **Monthly rebate cron** — compute per-tid rebate, pay $CATBOY, reset month.

Ship 1–5 first (images live), then 6, then 7.

---

## 10. Open decisions (confirm before/at build)

- Bundle sizes ($5 / $15 / $50?) and whether to allow SOL top-up too (default: $CATBOY only).
- Smooth the 9M→10M rebate cliff, or keep the hard jump (current: hard jump — strong "push to 10M" incentive).
- One video tier (standard) now, premium tier later? (default: standard only.)
- Rebate minimum payout threshold (skip dust payouts under e.g. $1).
