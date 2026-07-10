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
import { STAG_WELCOME_B64 } from "./_stagwelcome.js";
import { verifyStagPayment, verifyMicroDeposit, stagBalanceWhole, stagTotalSupplyWhole, STAG_TOKEN, DEAD } from "./_rhchain.js";

const CONN = (process.env.DATABASE_URL || process.env.POSTGRES_URL || "").trim();
const TOKEN = (process.env.STAG_BOT_TOKEN || "").trim();
const HOOK_SECRET = (process.env.STAG_BOT_SECRET || "").trim();
const TREASURY = (process.env.STAG_TREASURY || "").trim();
const VERIFY_WALLET = (process.env.STAG_VERIFY_WALLET || TREASURY).trim();

// Fast edit model (~14s) — pro-edit (~39s) blows Vercel's 60s function limit and
// never delivers the image. nano-banana-2 still holds identity + the style lock.
const PFP_MODEL = (process.env.STAG_PFP_MODEL || "nano-banana-2-edit").trim();
const GEN_MODEL = (process.env.STAG_GEN_MODEL || "nano-banana-2").trim();
const PFP_COST = parseInt(process.env.STAG_PFP_COST || "80", 10);    // credits / PFP ($0.10)
const GEN_COST = parseInt(process.env.STAG_GEN_COST || "80", 10);    // credits / image
const OWNER = (process.env.STAG_OWNER || "6820752140").trim();       // unlimited, no limits, free
const OWNER_NAME = (process.env.STAG_OWNER_NAME || "King Petty").trim();
const BUDGET = parseInt(process.env.STAG_PFP_BUDGET || "4000", 10);  // free pool (credits)
const COOLDOWN = parseInt(process.env.STAG_PFP_COOLDOWN || "45", 10) * 1000;

const CREDIT_USD = parseFloat(process.env.STAG_CREDIT_USD || "0.00125"); // cost basis / credit
const MARKUP = parseFloat(process.env.STAG_MARKUP || "2");               // retail = 2× cost
const HOLDER_DISCOUNT = parseFloat(process.env.STAG_HOLDER_DISCOUNT || "0.5"); // holders pay ½
const HOLD_MIN = parseFloat(process.env.STAG_HOLD_MIN || "1000000");     // $STAG for holder perk
const BUNDLES_USD = (process.env.STAG_BUNDLES || "3,10,25").split(",").map((x) => parseFloat(x));
const LINKS = {
  site: process.env.STAG_SITE || "https://www.stagwifhood.fun",
  x: process.env.STAG_X || "https://x.com/StagWifHood",
  tg: process.env.STAG_TG || "https://t.me/StagWifHood",
  chart: "https://dexscreener.com/robinhood/" + STAG_TOKEN,
};

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

// Cool "working on it" lines shown while an image renders (picked at random).
const SPINUP = [
  "⚡ Spinning the $STAG agent up…",
  "🏹 Nocking the arrow… rendering incoming",
  "🌲 Summoning the stag from the cyber-forest…",
  "⚙️ Booting the forge — antlers loading…",
  "🟢 Agent online. Painting your $STAG…",
  "🔮 Channeling emerald energy…",
  "🦌 Waking the hooded one…",
  "💚 Charging the neon core… hold tight",
];
const spinLine = () => SPINUP[Math.floor(Math.random() * SPINUP.length)];

// ── Telegram helpers ─────────────────────────────────────────────────────────────
async function tg(method, payload) {
  try {
    const r = await fetch(TG(method), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return await r.json().catch(() => ({}));
  } catch { return {}; }
}
const say = (chatId, replyTo, text) => tg("sendMessage", { chat_id: chatId, reply_to_message_id: replyTo, parse_mode: "Markdown", disable_web_page_preview: true, text });
async function sendPhoto(chatId, pngBuf, caption, replyTo, parseMode) {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  if (caption) fd.append("caption", caption);
  if (parseMode) fd.append("parse_mode", parseMode);
  if (replyTo) fd.append("reply_to_message_id", String(replyTo));
  fd.append("photo", new Blob([pngBuf], { type: "image/png" }), "stag.png");
  try { const r = await fetch(TG("sendPhoto"), { method: "POST", body: fd }); return await r.json().catch(() => ({})); }
  catch { return {}; }
}
// Decoded once — the embedded $STAG character, reused as the welcome image.
let _welcomeBuf = null;
const welcomeImg = () => (_welcomeBuf ||= Buffer.from(STAG_WELCOME_B64, "base64"));

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
  // A purchase is bound to the buyer by a server-assigned EXACT $STAG amount (the odd
  // whole-token tail is their secret) so nobody can front-run/steal a stranger's tx.
  await s`CREATE TABLE IF NOT EXISTS stag_buy_req (tid TEXT PRIMARY KEY, expected NUMERIC NOT NULL, credits INT NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE TABLE IF NOT EXISTS stag_verified (tid TEXT PRIMARY KEY, wallet TEXT, at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE TABLE IF NOT EXISTS stag_verify_req (tid TEXT PRIMARY KEY, wei TEXT, created_at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE TABLE IF NOT EXISTS stag_verify_used (txhash TEXT PRIMARY KEY, tid TEXT, at TIMESTAMPTZ DEFAULT now())`;
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
const fmt = (n) => n >= 1000 ? Math.round(n).toLocaleString("en-US") : n.toPrecision(3);
const money = (n) => "$" + (n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : Number(n).toFixed(2));

// Live $STAG stats (DexScreener, Robinhood Chain) for the free /price + /mc tools.
async function stagStats() {
  try {
    const r = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + STAG_TOKEN);
    const j = await r.json();
    const pairs = (j.pairs || []).filter((p) => p.priceUsd);
    pairs.sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0));
    const p = pairs[0]; if (!p) return null;
    return {
      priceUsd: Number(p.priceUsd), mcap: Number(p.marketCap || p.fdv || 0),
      change24: Number(p.priceChange?.h24 || 0), liq: Number(p.liquidity?.usd || 0),
      vol24: Number(p.volume?.h24 || 0), url: p.url || ("https://dexscreener.com/robinhood/" + STAG_TOKEN),
    };
  } catch { return null; }
}

// ── Handler ──────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).end(); }
  // Fail closed: without the shared secret we cannot prove a request is really from
  // Telegram, so anyone could spoof updates and drain the pool / spend others' credits.
  if (!TOKEN || !CONN || !HOOK_SECRET) return res.status(200).json({ ok: false, error: "not_configured" });
  if (req.headers["x-telegram-bot-api-secret-token"] !== HOOK_SECRET) return res.status(401).end();

  const update = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const msg = update.message || update.edited_message;
  const text = (msg && msg.text) || "";
  if (!msg) return res.status(200).json({ ok: true });
  if (!text.startsWith("/")) {
    // Never reveal the underlying AI/model. Answer identity questions (in DMs, or when
    // the bot is @-mentioned) with the on-brand line; else stay silent (no group spam).
    const addressed = msg.chat.type === "private" || /@stagzbot\b/i.test(text);
    if (addressed && /\b(what|which|who|are you|u using|you using).{0,30}(a\.?i|model|bot|made|built|train|power|run|gpt|chatgpt|claude|openai|anthropic|llm|venice|grok|gemini|language\s*model)\b/i.test(text)) {
      await tg("sendMessage", { chat_id: msg.chat.id, reply_to_message_id: msg.message_id, text: `Built and trained by ${OWNER_NAME}. 🦌👑` });
    }
    return res.status(200).json({ ok: true });
  }

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

    // ---------- menu / help (image + commands — pinnable community card) ----------
    if (cmd === "/start" || cmd === "/help" || cmd === "/menu" || cmd === "/commands") {
      const menu =
        "🏹 *$STAGWIFHOOD — AI IMAGE GENERATOR*\n" +
        "_Make $STAG art right here in chat._\n\n" +
        "🦌 `/pfp` — your $STAG profile pic *(1 FREE!)*\n" +
        "🎨 `/pfp cyber samurai` — add any theme\n" +
        "🖼️ `/imagine <anything>` — generate *any* image\n\n" +
        "💰 *Want more?* Grab credits:\n" +
        "💳 `/buy` — pay in $STAG  ·  `/credits` — your balance\n" +
        "🔐 `/verify` — hold *1M+ $STAG* → *50% OFF*\n\n" +
        "🆓 *Free tools:* `/price` `/burn` `/ca` `/links`\n\n" +
        "🔓 *No wallet connection — ever.* Just send $STAG, no connect, no signing.\n" +
        "_Use me in the group or DM me privately. Antlers up. 💚🦌_";
      // Standalone (no reply) so it's a clean card the community can pin.
      const r = await sendPhoto(chatId, welcomeImg(), menu, null, "Markdown");
      if (!r || r.ok === false) await say(chatId, null, menu); // text fallback
      return res.status(200).json({ ok: true });
    }

    // ---------- about (identity — never reveals the model) ----------
    if (cmd === "/about" || cmd === "/whoami") {
      await say(chatId, replyTo, `🦌 The *$STAGWIFHOOD* generator — built and trained by *${OWNER_NAME}*. 👑\nThat's all you need to know. 🏹`);
      return res.status(200).json({ ok: true });
    }

    // ---------- FREE TOOLS: price / market cap ----------
    if (cmd === "/price" || cmd === "/mc" || cmd === "/chart" || cmd === "/stats" || cmd === "/marketcap") {
      const d = await stagStats();
      if (!d) { await say(chatId, replyTo, "⚠️ Couldn't load $STAG stats right now — try again in a sec."); return res.status(200).json({ ok: true }); }
      const up = d.change24 >= 0;
      await say(chatId, replyTo,
        `📊 *$STAGWIFHOOD*\n\n` +
        `💵 Price: *$${d.priceUsd.toPrecision(3)}*\n` +
        `🏦 Market cap: *${money(d.mcap)}*\n` +
        `${up ? "🟢" : "🔴"} 24h: *${up ? "+" : ""}${d.change24.toFixed(1)}%*\n` +
        `💧 Liquidity: ${money(d.liq)}\n` +
        `📈 24h volume: ${money(d.vol24)}\n\n` +
        `[View chart 📈](${d.url})`);
      return res.status(200).json({ ok: true });
    }

    // ---------- FREE TOOLS: contract + links ----------
    if (cmd === "/ca" || cmd === "/contract") {
      await say(chatId, replyTo, `📜 *$STAG contract* — Robinhood Chain\n\`${STAG_TOKEN}\`\n\n⚠️ Only ever trust *this* address. Verify before you buy.`);
      return res.status(200).json({ ok: true });
    }
    if (cmd === "/links" || cmd === "/socials" || cmd === "/official") {
      await say(chatId, replyTo,
        `🔗 *$STAGWIFHOOD — official links*\n\n` +
        `🌐 [Website](${LINKS.site})\n🐦 [X / Twitter](${LINKS.x})\n💬 [Telegram](${LINKS.tg})\n📈 [Chart](${LINKS.chart})\n\n📜 CA: \`${STAG_TOKEN}\``);
      return res.status(200).json({ ok: true });
    }

    // ---------- FREE TOOLS: total burned ----------
    if (cmd === "/burn" || cmd === "/burns" || cmd === "/burned") {
      try {
        const [burned, supply] = await Promise.all([stagBalanceWhole(DEAD), stagTotalSupplyWhole()]);
        const pct = supply > 0 ? (burned / supply * 100) : 0;
        await say(chatId, replyTo, `🔥 *$STAG BURNED*\n\nTotal burned: *${fmt(burned)}* $STAG\n🔥 *${pct.toFixed(2)}%* of supply gone forever`);
      } catch { await say(chatId, replyTo, "⚠️ Couldn't read burn data right now — try again."); }
      return res.status(200).json({ ok: true });
    }

    // ---------- reset (OWNER ONLY) ----------
    if (cmd === "/reset") {
      if (tid !== OWNER) return res.status(200).json({ ok: true }); // silently ignore for everyone else
      const scope = arg.trim().toLowerCase();
      await s`UPDATE stag_pool SET used = 0 WHERE id = 1`; // zero the free-pool counter
      if (scope === "all") {
        await s`TRUNCATE stag_free, stag_log, stag_cool`;   // fresh launch: everyone gets their free again
        await say(chatId, replyTo, "🧹 *Full reset* — free pool zeroed, everyone's free PFP + cooldowns cleared. Clean launch. 🦌");
      } else {
        await say(chatId, replyTo, `🧹 Free pool reset to *0 / ${BUDGET}*. (Use \`/reset all\` to also clear per-user free grants + cooldowns.)`);
      }
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

    // ---------- buy (step 1: list; step 2: lock a unique exact amount) ----------
    if (cmd === "/buy" || cmd === "/topup") {
      if (!TREASURY) { await say(chatId, replyTo, "🛠️ Buying opens shortly — hang tight, ranger."); return res.status(200).json({ ok: true }); }
      const px = await stagPriceUsd();
      if (!px) { await say(chatId, replyTo, "⚠️ Price feed hiccup — try /buy again in a sec."); return res.status(200).json({ ok: true }); }
      const holder = await isVerified(s, tid);
      const pickUsd = parseFloat((arg.trim().split(/\s+/)[0] || "").replace(/[^0-9.]/g, ""));
      if (!BUNDLES_USD.includes(pickUsd)) {
        const lines = BUNDLES_USD.map((usd) => {
          const credits = Math.round(usd / (CREDIT_USD * MARKUP));
          return `• \`/buy ${usd}\` → *${credits}* credits (~${Math.floor(credits / PFP_COST)} imgs)`;
        }).join("\n");
        await say(chatId, replyTo,
          `💳 *Buy $STAG credits*${holder ? " _(holder 50% off)_" : ""}\n\n${lines}\n\n` +
          `Pick one (e.g. \`/buy ${BUNDLES_USD[0]}\`) and I'll give you an *exact* amount to send.` +
          (holder ? "" : "\n\nHold 1M+ $STAG? /verify for 50% off."));
        return res.status(200).json({ ok: true });
      }
      const credits = Math.round(pickUsd / (CREDIT_USD * MARKUP));
      const baseStag = stagForCredits(credits, px, holder);
      // Unique whole-token tail (server-assigned) = the buyer's secret. Cheap (~cents),
      // human-typable, and binds this payment to THIS user so nobody can claim it.
      const nonce = 1000 + Math.floor(Math.random() * 9000);
      const expected = Math.ceil(baseStag) + nonce;
      await s`INSERT INTO stag_buy_req (tid, expected, credits, created_at) VALUES (${tid}, ${expected}, ${credits}, now())
              ON CONFLICT (tid) DO UPDATE SET expected=${expected}, credits=${credits}, created_at=now()`;
      await say(chatId, replyTo,
        `💳 *$${pickUsd} → ${credits} credits*${holder ? " _(holder 50% off)_" : ""}\n\n` +
        `1️⃣ Send *EXACTLY* \`${expected.toLocaleString("en-US")}\` $STAG to:\n\`${TREASURY}\`\n` +
        `   _(that exact amount is your secret — send the precise number)_\n` +
        `2️⃣ Then run \`/claim <your-tx-hash>\`\n\n_Locks for 30 min. Re-run /buy for a new amount._`);
      return res.status(200).json({ ok: true });
    }

    // ---------- claim: bound to THIS user's pending exact amount ----------
    if (cmd === "/claim") {
      if (!TREASURY) { await say(chatId, replyTo, "🛠️ Buying isn't live yet."); return res.status(200).json({ ok: true }); }
      const txh = (arg.trim().split(/\s+/)[0] || "").toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(txh)) { await say(chatId, replyTo, "Usage: `/claim 0x<txhash>` (the tx where you sent $STAG)."); return res.status(200).json({ ok: true }); }
      if ((await s`SELECT 1 FROM stag_claims WHERE txhash=${txh}`).length) { await say(chatId, replyTo, "That tx was already claimed. ✅"); return res.status(200).json({ ok: true }); }
      const reqRow = await s`SELECT expected, credits, created_at FROM stag_buy_req WHERE tid=${tid}`;
      if (!reqRow.length) { await say(chatId, replyTo, "Run `/buy` first to lock your amount, then send + /claim."); return res.status(200).json({ ok: true }); }
      if (Date.now() - new Date(reqRow[0].created_at).getTime() > 30 * 60 * 1000) { await say(chatId, replyTo, "That buy expired — run `/buy` again."); return res.status(200).json({ ok: true }); }
      const pay = await verifyStagPayment(txh, TREASURY);
      if (!pay.ok) { await say(chatId, replyTo, `⚠️ Couldn't verify that payment (${pay.err}). Make sure it's confirmed and sent $STAG to the treasury.`); return res.status(200).json({ ok: true }); }
      const expected = Number(reqRow[0].expected), credits = Number(reqRow[0].credits);
      // Must match the assigned amount EXACTLY (±1 token for truncation). The unique
      // odd tail is the whole security mechanism — a loose band would let a same-bundle
      // buyer claim a stranger's tx, so we do not tolerate a range here. (Assumes $STAG
      // has no transfer tax; if it does, this binding needs a different design.)
      if (Math.abs(Math.round(pay.amountWhole) - expected) > 1) {
        await say(chatId, replyTo, `⚠️ That tx sent ${fmt(pay.amountWhole)} $STAG but your locked amount is *${expected.toLocaleString("en-US")}*. Send the *exact* amount, then /claim.`);
        return res.status(200).json({ ok: true });
      }
      // Atomic idempotency: only the INSERT winner credits.
      const ins = await s`INSERT INTO stag_claims (txhash, tid, credits) VALUES (${txh}, ${tid}, ${credits}) ON CONFLICT (txhash) DO NOTHING RETURNING txhash`;
      if (!ins.length) { await say(chatId, replyTo, "That tx was already claimed. ✅"); return res.status(200).json({ ok: true }); }
      await addCredits(s, tid, credits);
      await s`DELETE FROM stag_buy_req WHERE tid=${tid}`;
      await say(chatId, replyTo, `✅ Credited *${credits}* credits. Balance: *${await balOf(s, tid)}*.\nGo wild: /pfp or /imagine 🏹`);
      return res.status(200).json({ ok: true });
    }

    // ---------- holder verify (no-connect micro-deposit) ----------
    if (cmd === "/verify") {
      if (!VERIFY_WALLET) { await say(chatId, replyTo, "🛠️ Verification opens shortly."); return res.status(200).json({ ok: true }); }
      const txh = (arg.trim().split(/\s+/)[0] || "").toLowerCase();
      if (!txh) {
        // Step 1: issue a unique tiny amount as the secret (server-assigned, ~cents,
        // wide range so two pending requests practically never collide).
        const rnd = 100000 + Math.floor(Math.random() * 900000);
        const wei = (10n ** 13n + BigInt(rnd) * 10n ** 7n).toString(); // ~0.00001–0.00002 ETH, unique tail
        await s`INSERT INTO stag_verify_req (tid, wei, created_at) VALUES (${tid}, ${wei}, now()) ON CONFLICT (tid) DO UPDATE SET wei=${wei}, created_at=now()`;
        const eth = (Number(wei) / 1e18).toFixed(9);
        await say(chatId, replyTo,
          "🔐 *Verify you hold 1M+ $STAG — no wallet connect.*\n\n" +
          `1️⃣ From your wallet, send *exactly* \`${eth}\` ETH to:\n\`${VERIFY_WALLET}\`\n` +
          "   _(that exact odd amount is your one-time secret)_\n" +
          "2️⃣ Then run \`/verify <your-tx-hash>\`\n\n" +
          "Just a normal send — no connect, no approval. Unlocks *50% off* all credits. 🦌");
        return res.status(200).json({ ok: true });
      }
      if (!/^0x[0-9a-f]{64}$/.test(txh)) { await say(chatId, replyTo, "Usage: `/verify` first, then `/verify 0x<txhash>`."); return res.status(200).json({ ok: true }); }
      // A given deposit tx can verify at most ONE account.
      if ((await s`SELECT 1 FROM stag_verify_used WHERE txhash=${txh}`).length) { await say(chatId, replyTo, "That tx was already used to verify. Run `/verify` for a fresh amount."); return res.status(200).json({ ok: true }); }
      const reqRow = await s`SELECT wei, created_at FROM stag_verify_req WHERE tid=${tid}`;
      if (!reqRow.length) { await say(chatId, replyTo, "Run `/verify` first to get your unique amount."); return res.status(200).json({ ok: true }); }
      if (Date.now() - new Date(reqRow[0].created_at).getTime() > 30 * 60 * 1000) { await say(chatId, replyTo, "That verify request expired — run `/verify` again."); return res.status(200).json({ ok: true }); }
      const chk = await verifyMicroDeposit(txh, VERIFY_WALLET, reqRow[0].wei);
      if (!chk.ok) { await say(chatId, replyTo, `⚠️ Couldn't match that (${chk.err}). Send the *exact* amount, then paste the confirmed tx hash.`); return res.status(200).json({ ok: true }); }
      // Claim this tx as used before granting (atomic; loser bails).
      const usedIns = await s`INSERT INTO stag_verify_used (txhash, tid) VALUES (${txh}, ${tid}) ON CONFLICT (txhash) DO NOTHING RETURNING txhash`;
      if (!usedIns.length) { await say(chatId, replyTo, "That tx was already used to verify."); return res.status(200).json({ ok: true }); }
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

    const isOwner = tid === OWNER; // owner: unlimited, no cooldown, no credit cost

    // cooldown (anti-spam pacing) — owner exempt
    if (COOLDOWN > 0 && !isOwner) {
      const cr = await s`SELECT last_at FROM stag_cool WHERE tid=${tid}`;
      if (cr.length) {
        const wait = COOLDOWN - (Date.now() - new Date(cr[0].last_at).getTime());
        if (wait > 0) { await say(chatId, replyTo, `⏳ Easy — ${Math.ceil(wait / 1000)}s til your next one.`); return res.status(200).json({ ok: true }); }
      }
    }

    const cost = isPfp ? PFP_COST : GEN_COST;
    // Funding: owner is always free/unlimited; else PFP can use the one free-pool grant;
    // otherwise spend paid credits.
    let funded = isOwner ? "owner" : null; // 'owner' | 'pool' | 'balance'
    if (!funded && isPfp) {
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
    if (!isOwner) await s`INSERT INTO stag_cool (tid, last_at) VALUES (${tid}, now()) ON CONFLICT (tid) DO UPDATE SET last_at=now()`;

    await tg("sendChatAction", { chat_id: chatId, action: "upload_photo" });
    await say(chatId, replyTo, spinLine());

    try {
      let png, caption;
      if (isPfp) {
        let seed = 0; for (const c of tid) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
        const pose = POSES[(seed + (await poolUsed(s)) + Date.now() % POSES.length) % POSES.length];
        const prompt = `Head-and-shoulders profile-picture portrait of THIS exact character. New pose/scene: ${pose}.` +
          (style ? ` Also work in this theme: ${style}.` : "") + STYLE_LOCK;
        png = await editPfp(prompt);
        caption = `🦌 ${uname}, your $STAGWIFHOOD is ready. 🏹💚` + (style ? `\n🎨 "${style}"` : "");
      } else {
        const prompt = genPrompt + ". High quality, detailed, dramatic lighting, no text, no watermark.";
        png = await genImage(prompt);
        caption = `🎨 ${uname} asked → delivered 🏹\n"${genPrompt.slice(0, 120)}"`;
      }
      const tag = funded === "owner" ? "👑" : funded === "pool" ? "🎁 that was your free one" : `–${cost} credits`;
      await sendPhoto(chatId, png, caption + `\n\n${tag}  •  another? /pfp /imagine  •  /credits`, replyTo);
      await s`INSERT INTO stag_log (tid, kind, credits) VALUES (${tid}, ${isPfp ? "pfp" : "gen"}, ${funded === "owner" ? 0 : cost})`;
      return res.status(200).json({ ok: true });
    } catch (e) {
      // refund whatever funded it (owner paid nothing)
      if (funded === "pool") { await refundPool(s, cost); await s`UPDATE stag_free SET used = GREATEST(0, used - 1) WHERE tid=${tid}`; }
      else if (funded === "balance") { await addCredits(s, tid, cost); }
      if (!isOwner) await s`DELETE FROM stag_cool WHERE tid=${tid}`; // failed run shouldn't burn their cooldown
      await say(chatId, replyTo, "⚠️ The forge hiccuped — no credits spent. Try again.");
      return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
    }
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
