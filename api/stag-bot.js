// $STAGWIFHOOD Telegram bot — AI IMAGE GENERATOR (Vercel webhook).
//
// A real paid image generator for the $STAG community, all in-chat:
//   /pfp [style]     -> on-character $STAG profile pic (Venice image/edit off the
//                       approved art; identity locked, fresh pose every time).
//                       ONE free per person from the shared launch pool; after that
//                       it costs credits.
//   /imagine <prompt>-> generate ANY image from a prompt (open generator). Costs credits.
//   /credits         -> your credit balance + the free-pool status.
//   /buy             -> buy credits with $STAG (live-priced); send, then /claim <txhash>.
//   /claim <txhash>  -> verify your $STAG payment on Robinhood Chain and top up.
//   /verify [txhash] -> prove you hold 1M+ $STAG with a no-connect micro-deposit,
//                       to unlock 50% off all credits (holder perk).
//   /start /help     -> how it works.
//
// Economics (all env-tunable): credits are the internal unit; 1 credit ≈ $0.00125 of
// generation cost (so the 4000-credit free pool ≈ $5). A PFP/image costs 144 credits.
// Buying credits costs 2× that (markup = profit); verified 1M holders pay half.
//
// Required Vercel env (PUBLIC repo — only NAMES here, never values):
//   STAG_BOT_TOKEN   Telegram token for @STAGZBOT
//   STAG_VENICE_KEY  Venice *inference* key (NOT the admin key)     [or VENICE_KEY]
//   DATABASE_URL     Neon Postgres
//   STAG_TREASURY    EVM wallet that receives $STAG buys (Robinhood Chain)  [for /buy]
// Optional:
//   STAG_VERIFY_WALLET  wallet that receives verify micro-deposits (default = STAG_TREASURY)
//   STAG_BOT_SECRET     Telegram webhook secret-token header (recommended)
//   STAG_PFP_MODEL(nano-banana-pro-edit) STAG_GEN_MODEL(nano-banana-pro)
//   STAG_PFP_COST(144) STAG_GEN_COST(144) STAG_PFP_BUDGET(4000) STAG_PFP_COOLDOWN(45)
//   STAG_CREDIT_USD(0.00125) STAG_MARKUP(2) STAG_HOLDER_DISCOUNT(0.5) STAG_HOLD_MIN(1000000)
//
// SECURITY: never mentions catboy. Venice key must be an inference key. No secrets in repo.

import { neon } from "@neondatabase/serverless";
import { STAG_REF_B64 } from "./_stagref.js";
import { verifyStagPayment, verifyMicroDeposit, stagBalanceWhole, STAG_TOKEN } from "./_rhchain.js";

const CONN = (process.env.DATABASE_URL || process.env.POSTGRES_URL || "").trim();
const TOKEN = (process.env.STAG_BOT_TOKEN || "").trim();
const HOOK_SECRET = (process.env.STAG_BOT_SECRET || "").trim();
const TREASURY = (process.env.STAG_TREASURY || "").trim();
const VERIFY_WALLET = (process.env.STAG_VERIFY_WALLET || TREASURY).trim();

const PFP_MODEL = (process.env.STAG_PFP_MODEL || "nano-banana-pro-edit").trim();
const GEN_MODEL = (process.env.STAG_GEN_MODEL || "nano-banana-pro").trim();
const PFP_COST = parseInt(process.env.STAG_PFP_COST || "144", 10);   // credits / PFP
const GEN_COST = parseInt(process.env.STAG_GEN_COST || "144", 10);   // credits / image
const BUDGET = parseInt(process.env.STAG_PFP_BUDGET || "4000", 10);  // free pool (credits)
const COOLDOWN = parseInt(process.env.STAG_PFP_COOLDOWN || "45", 10) * 1000;

const CREDIT_USD = parseFloat(process.env.STAG_CREDIT_USD || "0.00125"); // cost basis / credit
const MARKUP = parseFloat(process.env.STAG_MARKUP || "2");               // retail = 2× cost
const HOLDER_DISCOUNT = parseFloat(process.env.STAG_HOLDER_DISCOUNT || "0.5"); // holders pay ½
const HOLD_MIN = parseFloat(process.env.STAG_HOLD_MIN || "1000000");     // $STAG for holder perk
const BUNDLES_USD = (process.env.STAG_BUNDLES || "3,10,25").split(",").map((x) => parseFloat(x));

const TG = (m) => `https://api.telegram.org/bot${TOKEN}/${m}`;
export const config = { maxDuration: 60 };

// ── Venice inference key (prefix words are PART of the key) ──────────────────────
const VK_PREFIX = "VENICE_INFERENCE_KEY_";
function veniceKey() {
  const direct = process.env.STAG_VENICE_KEY || process.env.VENICE_KEY ||
                 process.env.VENICE_API_KEY || process.env.VENICE_INFERENCE_KEY;
  if (direct && direct.startsWith(VK_PREFIX)) return direct;
  const venice = Object.entries(process.env).filter(([n, v]) => /^VENICE/i.test(n) && v);
  for (const [, v] of venice) if (v.startsWith(VK_PREFIX)) return v;
  for (const [n, v] of venice) if (/^VENICE_INFERENCE_KEY_*$/i.test(n)) return VK_PREFIX + v;
  return direct || (venice[0] && venice[0][1]) || "";
}

// ── Pose variety + style lock (approved dark-cinematic look) ─────────────────────
const POSES = [
  "drawing a glowing emerald arrow on a longbow, fierce focus",
  "arms crossed, hood up, smirking confidently",
  "mid-leap firing an arrow, cape flaring, motion energy",
  "regal three-quarter portrait, chin up, commanding",
  "perched on a neon-lit rooftop overlooking a cyber-forest city at dusk",
  "battle-worn close-up, one eye glowing brighter, embers drifting",
  "raising a fist of green flame, triumphant",
  "cloaked in shadow with only the antlers and glowing eyes catching light",
  "leaning on the longbow, relaxed but dangerous, faint grin",
  "war-cry mid-shout, antlers wreathed in green lightning",
  "stealthy crouch in emerald mist, arrow nocked",
  "heroic hero-shot, wind in the cloak, sunrise-green backlight",
  "holding a glowing $STAG coin, sly collector's grin",
  "storm brewing behind him, rain-slick armor, eyes ablaze",
  "sitting on a throne of antlers and vines, king of the forest",
  "back-to-back silhouette turn, glancing over the shoulder",
];
const STYLE_LOCK =
  " CRITICAL: match the reference art style EXACTLY — dark cinematic digital painting," +
  " gritty realistic dark-fantasy, dramatic moody lighting, intense neon-green glow," +
  " cyber-forest vibe, ultra detailed, epic and premium. NOT flat cartoon, NOT clean" +
  " vector. Keep his identity: large antlers, green Robin-Hood hood, glowing green eyes," +
  " muscular build. Head-and-shoulders square profile picture, centered, no text, no watermark.";
const BANNED = /\b(nude|naked|nsfw|sex|sexual|porn|explicit|hentai|nipple|genital|underage|child|loli|shota|rape|gore|beastiality|cp)\b/i;

// ── Telegram helpers ─────────────────────────────────────────────────────────────
async function tg(method, payload) {
  try {
    const r = await fetch(TG(method), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return await r.json().catch(() => ({}));
  } catch { return {}; }
}
const say = (chatId, replyTo, text) => tg("sendMessage", { chat_id: chatId, reply_to_message_id: replyTo, parse_mode: "Markdown", disable_web_page_preview: true, text });
async function sendPhoto(chatId, pngBuf, caption, replyTo) {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  if (caption) fd.append("caption", caption);
  if (replyTo) fd.append("reply_to_message_id", String(replyTo));
  fd.append("photo", new Blob([pngBuf], { type: "image/png" }), "stag.png");
  try { const r = await fetch(TG("sendPhoto"), { method: "POST", body: fd }); return await r.json().catch(() => ({})); }
  catch { return {}; }
}

// ── Venice generation ────────────────────────────────────────────────────────────
async function editPfp(prompt) {
  const key = veniceKey(); if (!key) throw new Error("venice_not_configured");
  const r = await fetch("https://api.venice.ai/api/v1/image/edit", {
    method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ model: PFP_MODEL, prompt, image: STAG_REF_B64 }),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return buf; // PNG magic
  let msg = "venice_" + r.status; try { const j = JSON.parse(buf.toString("utf8")); msg = (j && (j.error || j.message)) || msg; } catch {}
  throw new Error(msg);
}
async function genImage(prompt) {
  const key = veniceKey(); if (!key) throw new Error("venice_not_configured");
  const r = await fetch("https://api.venice.ai/api/v1/image/generate", {
    method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ model: GEN_MODEL, prompt, width: 1024, height: 1024, format: "png" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.images || !j.images[0]) throw new Error((j && j.error) || "venice_" + r.status);
  return Buffer.from(j.images[0], "base64");
}

// ── DB ───────────────────────────────────────────────────────────────────────────
async function ensure(s) {
  await s`CREATE TABLE IF NOT EXISTS stag_pool (id INT PRIMARY KEY, used INT NOT NULL DEFAULT 0)`;
  await s`INSERT INTO stag_pool (id, used) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`;
  await s`CREATE TABLE IF NOT EXISTS stag_bal (tid TEXT PRIMARY KEY, credits INT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE TABLE IF NOT EXISTS stag_free (tid TEXT PRIMARY KEY, used INT NOT NULL DEFAULT 0)`;
  await s`CREATE TABLE IF NOT EXISTS stag_log (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tid TEXT, kind TEXT, credits INT, created_at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE TABLE IF NOT EXISTS stag_claims (txhash TEXT PRIMARY KEY, tid TEXT, credits INT, created_at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE TABLE IF NOT EXISTS stag_verified (tid TEXT PRIMARY KEY, wallet TEXT, at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE TABLE IF NOT EXISTS stag_verify_req (tid TEXT PRIMARY KEY, wei TEXT, created_at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE TABLE IF NOT EXISTS stag_cool (tid TEXT PRIMARY KEY, last_at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE TABLE IF NOT EXISTS stag_seen (uid BIGINT PRIMARY KEY, at TIMESTAMPTZ DEFAULT now())`;
}
const balOf = async (s, tid) => { const r = await s`SELECT credits FROM stag_bal WHERE tid=${tid}`; return r.length ? Number(r[0].credits) : 0; };
const addCredits = (s, tid, n) => s`INSERT INTO stag_bal (tid, credits) VALUES (${tid}, ${n}) ON CONFLICT (tid) DO UPDATE SET credits = stag_bal.credits + ${n}, updated_at = now()`;
// Atomic spend from paid balance (returns remaining, or null if insufficient).
async function spend(s, tid, n) {
  const r = await s`UPDATE stag_bal SET credits = credits - ${n}, updated_at = now() WHERE tid=${tid} AND credits >= ${n} RETURNING credits`;
  return r.length ? Number(r[0].credits) : null;
}
async function reservePool(s, n) {
  const r = await s`UPDATE stag_pool SET used = used + ${n} WHERE id=1 AND used + ${n} <= ${BUDGET} RETURNING used`;
  return r.length ? Number(r[0].used) : null;
}
const refundPool = (s, n) => s`UPDATE stag_pool SET used = GREATEST(0, used - ${n}) WHERE id=1`;
const poolUsed = async (s) => { const r = await s`SELECT used FROM stag_pool WHERE id=1`; return r.length ? Number(r[0].used) : 0; };
const isVerified = async (s, tid) => (await s`SELECT 1 FROM stag_verified WHERE tid=${tid}`).length > 0;

// ── Live $STAG price (DexScreener, Robinhood Chain) ──────────────────────────────
let _px = { usd: 0, at: 0 };
async function stagPriceUsd() {
  if (_px.usd > 0 && Date.now() - _px.at < 5 * 60 * 1000) return _px.usd;
  try {
    const r = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + STAG_TOKEN);
    const j = await r.json();
    const pairs = (j.pairs || []).filter((p) => p.priceUsd);
    pairs.sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0));
    const p = pairs[0] && Number(pairs[0].priceUsd);
    if (p > 0) { _px = { usd: p, at: Date.now() }; return p; }
  } catch {}
  return _px.usd || 0;
}
// $STAG needed for `credits`, honoring the holder discount.
function stagForCredits(credits, priceUsd, holder) {
  const usd = credits * CREDIT_USD * MARKUP * (holder ? HOLDER_DISCOUNT : 1);
  return usd / priceUsd;
}
// credits granted for `amountWhole` $STAG received (inverse of above).
function creditsForStag(amountWhole, priceUsd, holder) {
  const usd = amountWhole * priceUsd;
  return Math.floor(usd / (CREDIT_USD * MARKUP * (holder ? HOLDER_DISCOUNT : 1)));
}
const fmt = (n) => n >= 1000 ? Math.round(n).toLocaleString("en-US") : n.toPrecision(3);

// ── Handler ──────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).end(); }
  if (HOOK_SECRET && req.headers["x-telegram-bot-api-secret-token"] !== HOOK_SECRET) return res.status(401).end();
  if (!TOKEN || !CONN) return res.status(200).json({ ok: false, error: "not_configured" });

  const update = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const msg = update.message || update.edited_message;
  const text = (msg && msg.text) || "";
  if (!msg || !text.startsWith("/")) return res.status(200).json({ ok: true });

  const sp = text.trim().indexOf(" ");
  let cmd = (sp === -1 ? text.trim() : text.slice(0, sp)).toLowerCase().split("@")[0];
  const arg = sp === -1 ? "" : text.slice(sp + 1).trim();
  const chatId = msg.chat.id, replyTo = msg.message_id;
  const tid = String((msg.from && msg.from.id) || "");
  const uname = (msg.from && (msg.from.username ? "@" + msg.from.username : msg.from.first_name)) || "stag";

  const s = neon(CONN);
  try {
    await ensure(s);
    if (update.update_id != null) {
      const seen = await s`INSERT INTO stag_seen (uid) VALUES (${update.update_id}) ON CONFLICT (uid) DO NOTHING RETURNING uid`;
      if (!seen.length) return res.status(200).json({ ok: true, dup: true });
    }

    // ---------- help ----------
    if (cmd === "/start" || cmd === "/help") {
      await say(chatId, replyTo,
        "🏹 *$STAGWIFHOOD AI image generator*\n\n" +
        "• `/pfp` — your $STAG profile pic (1 *free*, then credits)\n" +
        "• `/pfp cyber samurai` — add a theme\n" +
        "• `/imagine a stag on mars, neon` — generate *any* image (credits)\n" +
        "• `/credits` — your balance\n" +
        "• `/buy` — top up with $STAG\n" +
        "• `/verify` — prove *1M+ $STAG* → *50% off everything* 🦌\n\n" +
        "On-character, fresh every time. Antlers up. 💚");
      return res.status(200).json({ ok: true });
    }

    // ---------- credits / pool ----------
    if (cmd === "/credits" || cmd === "/balance" || cmd === "/pfpcredits") {
      const [bal, used, verified] = [await balOf(s, tid), await poolUsed(s), await isVerified(s, tid)];
      const freeLeft = Math.max(0, BUDGET - used);
      await say(chatId, replyTo,
        `🎯 *Your $STAG credits:* ${bal} (~${Math.floor(bal / PFP_COST)} images)\n` +
        `${verified ? "✅ *Verified holder* — 50% off\n" : ""}` +
        `Free launch pool: ${used}/${BUDGET} used (~${Math.floor(freeLeft / PFP_COST)} free PFPs left)\n\n` +
        `Top up: /buy  •  Holder discount: /verify`);
      return res.status(200).json({ ok: true });
    }

    // ---------- buy ----------
    if (cmd === "/buy" || cmd === "/topup") {
      if (!TREASURY) { await say(chatId, replyTo, "🛠️ Buying opens shortly — hang tight, ranger."); return res.status(200).json({ ok: true }); }
      const px = await stagPriceUsd();
      if (!px) { await say(chatId, replyTo, "⚠️ Price feed hiccup — try /buy again in a sec."); return res.status(200).json({ ok: true }); }
      const holder = await isVerified(s, tid);
      let lines = BUNDLES_USD.map((usd) => {
        const credits = Math.round(usd / (CREDIT_USD * MARKUP)); // retail credits for this $ tier
        const stag = stagForCredits(credits, px, holder);
        return `• *$${usd}* → *${credits}* credits (~${Math.floor(credits / PFP_COST)} imgs) = *${fmt(stag)} $STAG*`;
      }).join("\n");
      await say(chatId, replyTo,
        `💳 *Buy $STAG credits*${holder ? " _(holder 50% off applied)_" : ""}\n\n${lines}\n\n` +
        `1️⃣ Send the $STAG amount to:\n\`${TREASURY}\`\n` +
        `2️⃣ Then run \`/claim <your-tx-hash>\`\n\n` +
        `_Priced live • any amount works, you're credited for what you send._` +
        (holder ? "" : "\n\nHold 1M+ $STAG? /verify for 50% off."));
      return res.status(200).json({ ok: true });
    }

    // ---------- claim a $STAG payment ----------
    if (cmd === "/claim") {
      if (!TREASURY) { await say(chatId, replyTo, "🛠️ Buying isn't live yet."); return res.status(200).json({ ok: true }); }
      const txh = arg.trim().split(/\s+/)[0];
      if (!/^0x[0-9a-fA-F]{64}$/.test(txh)) { await say(chatId, replyTo, "Usage: `/claim 0x<txhash>` (the tx where you sent $STAG)."); return res.status(200).json({ ok: true }); }
      if ((await s`SELECT 1 FROM stag_claims WHERE txhash=${txh.toLowerCase()}`).length) { await say(chatId, replyTo, "That tx was already claimed. ✅"); return res.status(200).json({ ok: true }); }
      const pay = await verifyStagPayment(txh, TREASURY);
      if (!pay.ok) { await say(chatId, replyTo, `⚠️ Couldn't verify that payment (${pay.err}). Make sure it's confirmed and sent $STAG to the treasury.`); return res.status(200).json({ ok: true }); }
      const px = await stagPriceUsd();
      if (!px) { await say(chatId, replyTo, "⚠️ Price feed hiccup — try /claim again shortly (your $STAG is safe)."); return res.status(200).json({ ok: true }); }
      const holder = await isVerified(s, tid);
      const credits = creditsForStag(pay.amountWhole, px, holder);
      if (credits <= 0) { await say(chatId, replyTo, "That payment was below the minimum — send a bit more $STAG."); return res.status(200).json({ ok: true }); }
      // Atomic idempotency: only the INSERT winner credits.
      const ins = await s`INSERT INTO stag_claims (txhash, tid, credits) VALUES (${txh.toLowerCase()}, ${tid}, ${credits}) ON CONFLICT (txhash) DO NOTHING RETURNING txhash`;
      if (!ins.length) { await say(chatId, replyTo, "That tx was already claimed. ✅"); return res.status(200).json({ ok: true }); }
      await addCredits(s, tid, credits);
      await say(chatId, replyTo, `✅ Credited *${credits}* credits (${fmt(pay.amountWhole)} $STAG). Balance: *${await balOf(s, tid)}*.\nGo wild: /pfp or /imagine 🏹`);
      return res.status(200).json({ ok: true });
    }

    // ---------- holder verify (no-connect micro-deposit) ----------
    if (cmd === "/verify") {
      if (!VERIFY_WALLET) { await say(chatId, replyTo, "🛠️ Verification opens shortly."); return res.status(200).json({ ok: true }); }
      const txh = arg.trim().split(/\s+/)[0];
      if (!txh) {
        // Step 1: issue a unique tiny amount as the secret.
        const rnd = 1000 + Math.floor(Math.random() * 9000);
        const wei = (10n ** 13n + BigInt(rnd) * 10n ** 9n).toString(); // ~0.00001 ETH + unique tail
        await s`INSERT INTO stag_verify_req (tid, wei, created_at) VALUES (${tid}, ${wei}, now()) ON CONFLICT (tid) DO UPDATE SET wei=${wei}, created_at=now()`;
        const eth = (Number(wei) / 1e18).toFixed(8);
        await say(chatId, replyTo,
          "🔐 *Verify you hold 1M+ $STAG — no wallet connect.*\n\n" +
          `1️⃣ From your wallet, send *exactly* \`${eth}\` ETH to:\n\`${VERIFY_WALLET}\`\n` +
          "   _(that exact odd amount is your one-time secret)_\n" +
          "2️⃣ Then run \`/verify <your-tx-hash>\`\n\n" +
          "Just a normal send — no connect, no approval. Unlocks *50% off* all credits. 🦌");
        return res.status(200).json({ ok: true });
      }
      if (!/^0x[0-9a-fA-F]{64}$/.test(txh)) { await say(chatId, replyTo, "Usage: `/verify` first, then `/verify 0x<txhash>`."); return res.status(200).json({ ok: true }); }
      const reqRow = await s`SELECT wei, created_at FROM stag_verify_req WHERE tid=${tid}`;
      if (!reqRow.length) { await say(chatId, replyTo, "Run `/verify` first to get your unique amount."); return res.status(200).json({ ok: true }); }
      if (Date.now() - new Date(reqRow[0].created_at).getTime() > 30 * 60 * 1000) { await say(chatId, replyTo, "That verify request expired — run `/verify` again."); return res.status(200).json({ ok: true }); }
      const chk = await verifyMicroDeposit(txh, VERIFY_WALLET, reqRow[0].wei);
      if (!chk.ok) { await say(chatId, replyTo, `⚠️ Couldn't match that (${chk.err}). Send the *exact* amount, then paste the confirmed tx hash.`); return res.status(200).json({ ok: true }); }
      const held = await stagBalanceWhole(chk.from);
      if (held < HOLD_MIN) { await say(chatId, replyTo, `🦌 That wallet holds ${fmt(held)} $STAG — need ${fmt(HOLD_MIN)}+ for the holder perk. Stack more and re-verify.`); return res.status(200).json({ ok: true }); }
      await s`INSERT INTO stag_verified (tid, wallet) VALUES (${tid}, ${chk.from}) ON CONFLICT (tid) DO UPDATE SET wallet=${chk.from}, at=now()`;
      await s`DELETE FROM stag_verify_req WHERE tid=${tid}`;
      await say(chatId, replyTo, `✅ *Verified holder!* ${fmt(held)} $STAG. You now get *50% off* all credits. 🏹💚\n/buy to stock up cheap.`);
      return res.status(200).json({ ok: true });
    }

    // ---------- generation: /pfp and /imagine ----------
    const isPfp = cmd === "/pfp";
    const isGen = cmd === "/imagine" || cmd === "/gen" || cmd === "/image";
    if (!isPfp && !isGen) return res.status(200).json({ ok: true }); // ignore other commands

    const style = isPfp ? arg.slice(0, 200) : "";
    const genPrompt = isGen ? arg.slice(0, 400) : "";
    if (isGen && !genPrompt) { await say(chatId, replyTo, "Give me something to draw: `/imagine a hooded stag archer on a neon rooftop`"); return res.status(200).json({ ok: true }); }
    if (BANNED.test(style + " " + genPrompt)) { await say(chatId, replyTo, "🚫 Keep it clean, ranger."); return res.status(200).json({ ok: true }); }

    // cooldown (anti-spam pacing)
    if (COOLDOWN > 0) {
      const cr = await s`SELECT last_at FROM stag_cool WHERE tid=${tid}`;
      if (cr.length) {
        const wait = COOLDOWN - (Date.now() - new Date(cr[0].last_at).getTime());
        if (wait > 0) { await say(chatId, replyTo, `⏳ Easy — ${Math.ceil(wait / 1000)}s til your next one.`); return res.status(200).json({ ok: true }); }
      }
    }

    const cost = isPfp ? PFP_COST : GEN_COST;
    // Funding: PFP can use the one free-pool grant; otherwise spend paid credits.
    let funded = null; // 'pool' | 'balance'
    if (isPfp) {
      const freeRow = await s`SELECT used FROM stag_free WHERE tid=${tid}`;
      const freeUsed = freeRow.length ? Number(freeRow[0].used) : 0;
      if (freeUsed < 1 && (await reservePool(s, cost)) != null) {
        await s`INSERT INTO stag_free (tid, used) VALUES (${tid}, 1) ON CONFLICT (tid) DO UPDATE SET used = stag_free.used + 1`;
        funded = "pool";
      }
    }
    if (!funded) {
      if ((await spend(s, tid, cost)) == null) {
        const bal = await balOf(s, tid);
        await say(chatId, replyTo,
          `🎯 You're out of credits (balance ${bal}, need ${cost}).\n` +
          `Top up with $STAG: /buy${(await isVerified(s, tid)) ? "" : "  •  Hold 1M+ for 50% off: /verify"}`);
        return res.status(200).json({ ok: true });
      }
      funded = "balance";
    }
    await s`INSERT INTO stag_cool (tid, last_at) VALUES (${tid}, now()) ON CONFLICT (tid) DO UPDATE SET last_at=now()`;

    await tg("sendChatAction", { chat_id: chatId, action: "upload_photo" });
    await say(chatId, replyTo, isPfp ? "🎨 Conjuring your $STAG… 🏹" : "🎨 Painting it… give me a few seconds. 🏹");

    try {
      let png, caption;
      if (isPfp) {
        let seed = 0; for (const c of tid) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
        const pose = POSES[(seed + (await poolUsed(s)) + Date.now() % POSES.length) % POSES.length];
        const prompt = `Head-and-shoulders profile-picture portrait of THIS exact character. New pose/scene: ${pose}.` +
          (style ? ` Also work in this theme: ${style}.` : "") + STYLE_LOCK;
        png = await editPfp(prompt);
        caption = `🦌 ${uname}, your $STAGWIFHOOD is minted. 🏹💚`;
      } else {
        const prompt = genPrompt + ". High quality, detailed, dramatic lighting, no text, no watermark.";
        png = await genImage(prompt);
        caption = `🎨 ${uname} — /imagine "${genPrompt.slice(0, 80)}"`;
      }
      await sendPhoto(chatId, png, caption + `\n${funded === "pool" ? "That was your free one 🎁" : `-${cost} credits`} • /credits`, replyTo);
      await s`INSERT INTO stag_log (tid, kind, credits) VALUES (${tid}, ${isPfp ? "pfp" : "gen"}, ${cost})`;
      return res.status(200).json({ ok: true });
    } catch (e) {
      // refund whatever funded it
      if (funded === "pool") { await refundPool(s, cost); await s`UPDATE stag_free SET used = GREATEST(0, used - 1) WHERE tid=${tid}`; }
      else { await addCredits(s, tid, cost); }
      await say(chatId, replyTo, "⚠️ The forge hiccuped — no credits spent. Try again.");
      return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
    }
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
