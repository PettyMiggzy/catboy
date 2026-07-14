// $STAGWIFHOOD Telegram bot - AI IMAGE GENERATOR (Vercel webhook).
//
// A real paid image generator for the $STAG community, all in-chat:
//   /pfp [style]     -> on-character $STAG profile pic (Venice image/edit off the
//                       approved art; identity locked, fresh pose every time).
//                       ONE free per person from the shared launch pool; after that
//                       it costs credits.
//   /image <prompt>  -> put the $STAG character into ANY scene you describe. Costs credits.
//   /vid <prompt>    -> a short animated $STAG clip of your scene. Costs credits (owner free).
//   /credits         -> your credit balance + the free-pool status.
//   /buy             -> buy credits with $STAG (live-priced); send, then /claim <txhash>.
//   /claim <txhash>  -> verify your $STAG payment on Robinhood Chain and top up.
//   /verify [txhash] -> prove you hold 1M+ $STAG with a no-connect micro-deposit,
//                       to unlock 50% off all credits (holder perk).
//   /start /help     -> how it works.
//
// Economics (all env-tunable): credits are the internal unit; 1 credit ≈ $0.00125 of
// generation cost (so the 4000-credit free pool ≈ $5). A PFP/image costs 144 credits.
// Buying credits costs 3× that (markup = profit); verified 1M holders pay half.
//
// Required Vercel env (PUBLIC repo - only NAMES here, never values):
//   STAG_BOT_TOKEN   Telegram token for @STAGZBOT
//   STAG_VENICE_KEY  Venice *inference* key (NOT the admin key)     [or VENICE_KEY]
//   DATABASE_URL     Neon Postgres
//   STAG_TREASURY    EVM wallet that receives $STAG buys (Robinhood Chain)  [for /buy]
// Optional:
//   STAG_VERIFY_WALLET  wallet that receives verify micro-deposits (default = STAG_TREASURY)
//   STAG_BOT_SECRET     Telegram webhook secret-token header (recommended)
//   STAG_PFP_MODEL(nano-banana-pro-edit) STAG_GEN_MODEL(nano-banana-pro)
//   STAG_PFP_COST(144) STAG_GEN_COST(144) STAG_PFP_BUDGET(4000) STAG_PFP_COOLDOWN(45)
//   STAG_CREDIT_USD(0.00125) STAG_MARKUP(3) STAG_HOLDER_DISCOUNT(0.5) STAG_HOLD_MIN(1000000)
//
// SECURITY: never mentions catboy. Venice key must be an inference key. No secrets in repo.

import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { STAG_REF_B64 } from "./_stagref.js";
import { STAG_WELCOME_B64 } from "./_stagwelcome.js";
import { TRIVIA } from "./_trivia.js";
import { bjCommand, bjCallback, bjLeaderboard } from "./_blackjack.js";
import { verifyStagPayment, verifyMicroDeposit, stagBalanceWhole, stagTotalSupplyWhole, rpc, STAG_TOKEN, DEAD, stakingStats, nftMintStats, walletStake, topStakers } from "./_rhchain.js";

const CONN = (process.env.DATABASE_URL || process.env.POSTGRES_URL || "").trim();
const TOKEN = (process.env.STAG_BOT_TOKEN || "").trim();
const HOOK_SECRET = (process.env.STAG_BOT_SECRET || "").trim();
const TREASURY = (process.env.STAG_TREASURY || "").trim();
const VERIFY_WALLET = (process.env.STAG_VERIFY_WALLET || TREASURY).trim();
// Whale-gated group: prove you hold WHALE_MIN+ $STAG (across one or more wallets) via the
// same no-connect micro-deposit, then get a single-use invite link to the whale chat.
const WHALE_CHAT = (process.env.STAG_WHALE_CHAT || "-1004295600427").trim();
const WHALE_MIN = parseFloat(process.env.STAG_WHALE_MIN || "10000000"); // 10M $STAG
const whHash = (w) => createHash("sha256").update(w.toLowerCase()).digest("hex"); // dedup wallets WITHOUT storing them

// Fast edit model (~14s) - pro-edit (~39s) blows Vercel's 60s function limit and
// never delivers the image. nano-banana-2 still holds identity + the style lock.
const PFP_MODEL = (process.env.STAG_PFP_MODEL || "nano-banana-2-edit").trim();
const GEN_MODEL = (process.env.STAG_GEN_MODEL || "nano-banana-2").trim();
const PFP_COST = parseInt(process.env.STAG_PFP_COST || "80", 10);    // credits / PFP ($0.10)
const GEN_COST = parseInt(process.env.STAG_GEN_COST || "80", 10);    // credits / image
const OWNERS = (process.env.STAG_OWNER || "6820752140").split(",").map((x) => x.trim()).filter(Boolean); // TG ids: unlimited, no limits, free
const isOwnerId = (id) => OWNERS.includes(String(id));
const OWNER_NAME = (process.env.STAG_OWNER_NAME || "King Petty").trim();
const BOT_USERNAME = (process.env.STAG_BOT_USERNAME || "STAGZBOT").replace(/^@/, "").trim();
const BUDGET = parseInt(process.env.STAG_PFP_BUDGET || "4000", 10);  // free pool (credits)
const COOLDOWN = parseInt(process.env.STAG_PFP_COOLDOWN || "45", 10) * 1000;
const REQ_TTL = 7 * 24 * 3600 * 1000; // buy/verify request validity - long is safe now that
                                      // the payment must also be newer than the request (below)

const CREDIT_USD = parseFloat(process.env.STAG_CREDIT_USD || "0.00125"); // cost basis / credit
const MARKUP = parseFloat(process.env.STAG_MARKUP || "3");               // retail = 3× cost
const HOLDER_DISCOUNT = parseFloat(process.env.STAG_HOLDER_DISCOUNT || "0.5"); // holders pay ½
const HOLD_MIN = parseFloat(process.env.STAG_HOLD_MIN || "1000000");     // $STAG for holder perk
const BUNDLES_USD = (process.env.STAG_BUNDLES || "3,10,25").split(",").map((x) => parseFloat(x));
// ── Video tier (async render; owner free, everyone else pays) ────────────────────
// Cost basis (Venice kling-v3-pro 5s) ≈ $0.92. VIDEO_COST credits × CREDIT_USD × MARKUP
// = retail; 540 × 0.00125 × 3 ≈ $2.03, safely above cost so a sale never loses money.
const VIDEO_MODEL = (process.env.STAG_VIDEO_MODEL || "kling-v3-pro-image-to-video").trim();
const VIDEO_DURATION = (process.env.STAG_VIDEO_DURATION || "5s").trim();
const VIDEO_COST = parseInt(process.env.STAG_VIDEO_COST || "540", 10);
const VIDEO_COOLDOWN = parseInt(process.env.STAG_VIDEO_COOLDOWN || "60", 10) * 1000;
// ── Trivia game ──────────────────────────────────────────────────────────────────
// /trivia posts a card, first to reply A/B/C/D wins a point; weekly #1 gets credits.
const TRIVIA_REWARD = parseInt(process.env.STAG_TRIVIA_REWARD || "2000", 10); // credits to weekly champ
const LINKS = {
  site: process.env.STAG_SITE || "https://www.stagwifhood.fun",
  x: process.env.STAG_X || "https://x.com/StagWifHood",
  tg: process.env.STAG_TG || "https://t.me/StagWifHood",
  chart: "https://dexscreener.com/robinhood/" + STAG_TOKEN,
};
// /raid - post-content generator. Wraps the user's content with random hashtags +
// a random link so every posted raid looks different (dodges X spam detection).
const HASHTAG_SETS = (process.env.STAG_HASHTAGS ||
  "#StagWifHood #RobinhoodChain #memecoin;#STAG #RobinhoodChain #crypto;#StagWifHood #memecoins #100x;#STAG #Robinhood #altcoin #gems")
  .split(";").map((s) => s.trim()).filter(Boolean);
const RAID_LINES = [
  "The hooded stag is coming for the whole timeline. 🏹🦌",
  "$STAG doesn't miss. Antlers up. 🦌",
  "Robin Hood of Robinhood Chain. Steal the pump, feed the holders. 🏹",
  "Early is an understatement. $STAGWIFHOOD 🦌💚",
  "One bow. One target. The moon. 🏹🌙",
];

const TG = (m) => `https://api.telegram.org/bot${TOKEN}/${m}`;
// Vercel Pro allows up to 300s; give slow renders real headroom so they finish and
// deliver instead of being killed at 60s (which left a stuck spinner with no image).
export const config = { maxDuration: 120 };

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
// Identity + art-style lock (no framing) - used by BOTH /pfp and /image so every
// image stays on-character. /image adds a free scene; /pfp adds portrait framing.
const IDENTITY_LOCK =
  " CRITICAL: match the reference art style EXACTLY - dark cinematic digital painting," +
  " gritty realistic dark-fantasy, dramatic moody lighting, intense neon-green glow," +
  " cyber-forest vibe, ultra detailed, epic and premium. NOT flat cartoon, NOT clean" +
  " vector. Keep his identity EXACTLY: large antlers, green Robin-Hood hood, glowing" +
  " green eyes, muscular build. no text, no watermark.";
const STYLE_LOCK = IDENTITY_LOCK + " Head-and-shoulders square profile picture, centered.";
const BANNED = /\b(nude|naked|nsfw|sex|sexual|porn|explicit|hentai|nipple|genital|underage|child|loli|shota|rape|gore|beastiality|cp)\b/i;

// Cool "working on it" lines shown while an image renders (picked at random).
const SPINUP = [
  "⚡ Spinning the $STAG agent up…",
  "🏹 Nocking the arrow… rendering incoming",
  "🌲 Summoning the stag from the cyber-forest…",
  "⚙️ Booting the forge - antlers loading…",
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
const say = (chatId, replyTo, text) => tg("sendMessage", { chat_id: chatId, reply_to_message_id: replyTo, allow_sending_without_reply: true, parse_mode: "Markdown", disable_web_page_preview: true, text });
async function sendPhoto(chatId, pngBuf, caption, replyTo, parseMode, mime = "image/png", fname = "stag.png") {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  if (caption) fd.append("caption", caption);
  if (parseMode) fd.append("parse_mode", parseMode);
  if (replyTo) { fd.append("reply_to_message_id", String(replyTo)); fd.append("allow_sending_without_reply", "true"); }
  fd.append("photo", new Blob([pngBuf], { type: mime }), fname);
  try { const r = await fetch(TG("sendPhoto"), { method: "POST", body: fd }); return await r.json().catch(() => ({})); }
  catch { return {}; }
}
// Blackjack helpers: send a photo WITH an inline keyboard, and swap a photo in place (editMessageMedia).
async function bjSendCards(chatId, img, caption, keyboard, replyTo) {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  if (caption) { fd.append("caption", caption); fd.append("parse_mode", "Markdown"); }
  if (replyTo) { fd.append("reply_to_message_id", String(replyTo)); fd.append("allow_sending_without_reply", "true"); }
  if (keyboard) fd.append("reply_markup", JSON.stringify(keyboard));
  fd.append("photo", new Blob([img.buf], { type: img.mime }), "bj." + img.ext);
  try { const r = await fetch(TG("sendPhoto"), { method: "POST", body: fd }); return await r.json().catch(() => ({})); } catch { return {}; }
}
async function bjEditPhoto(chatId, msgId, img, caption, keyboard) {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  fd.append("message_id", String(msgId));
  fd.append("media", JSON.stringify({ type: "photo", media: "attach://photo", caption, parse_mode: "Markdown" }));
  if (keyboard) fd.append("reply_markup", JSON.stringify(keyboard));
  fd.append("photo", new Blob([img.buf], { type: img.mime }), "bj." + img.ext);
  try { const r = await fetch(TG("editMessageMedia"), { method: "POST", body: fd }); return await r.json().catch(() => ({})); } catch { return {}; }
}
// Blackjack is played in DMs; winners + the leaderboard get announced in the main group.
const BJ_ANNOUNCE = (process.env.STAG_ANNOUNCE_CHAT || "-1003369963744").trim();
const bjCtx = { tg, sendCards: bjSendCards, editPhoto: bjEditPhoto, announceChat: BJ_ANNOUNCE, botUser: BOT_USERNAME };
async function sendVideo(chatId, mp4Buf, caption, replyTo) {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  if (caption) fd.append("caption", caption);
  if (replyTo) { fd.append("reply_to_message_id", String(replyTo)); fd.append("allow_sending_without_reply", "true"); }
  fd.append("video", new Blob([mp4Buf], { type: "video/mp4" }), "stag.mp4");
  try { const r = await fetch(TG("sendVideo"), { method: "POST", body: fd }); return await r.json().catch(() => ({})); }
  catch { return {}; }
}
// Static cards (trivia/hype/menu) never change, so the first upload's Telegram file_id is
// reusable forever. Cache key->file_id and send the tiny id string instead of re-uploading
// the JPEG every time - the multipart upload was the main source of trivia lag.
const _fileIds = new Map();
async function sendPhotoKeyed(chatId, key, bufFn, caption, replyTo, parseMode = "Markdown", mime = "image/jpeg", fname = "stag.jpg") {
  const cached = _fileIds.get(key);
  if (cached) {
    const r = await tg("sendPhoto", { chat_id: chatId, photo: cached, caption, parse_mode: parseMode, reply_to_message_id: replyTo, allow_sending_without_reply: true });
    if (r && r.ok) return r;
    _fileIds.delete(key); // id went stale - fall through and re-upload
  }
  let buf = null;
  try { buf = bufFn(); } catch {}
  if (!buf) return null;
  const r = await sendPhoto(chatId, buf, caption, replyTo, parseMode, mime, fname);
  try { const ph = r && r.result && r.result.photo; if (ph && ph.length) _fileIds.set(key, ph[ph.length - 1].file_id); } catch {}
  return r;
}

// Decoded once - the embedded $STAG character, reused as the welcome image.
let _welcomeBuf = null;
const welcomeImg = () => (_welcomeBuf ||= Buffer.from(STAG_WELCOME_B64, "base64"));

// ── Venice generation ────────────────────────────────────────────────────────────
async function editPfp(prompt) {
  const key = veniceKey(); if (!key) throw new Error("venice_not_configured");
  // Abort a slow render before Vercel silently kills the whole function, so the user
  // always gets a "try again" reply instead of a stuck spinner with no image/message.
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 105000); // just under maxDuration so a hung render fails gracefully
  try {
    const r = await fetch("https://api.venice.ai/api/v1/image/edit", {
      method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: PFP_MODEL, prompt, image: STAG_REF_B64 }), signal: ac.signal,
    });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return buf; // PNG magic
    let msg = "venice_" + r.status; try { const j = JSON.parse(buf.toString("utf8")); msg = (j && (j.error || j.message)) || msg; } catch {}
    throw new Error(msg);
  } catch (e) { throw (e && e.name === "AbortError") ? new Error("render_timeout") : e; }
  finally { clearTimeout(t); }
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
// Queue an async video render off the $STAG reference. Returns a queue_id; the
// /api/stag-video-cron poller retrieves + delivers it (or refunds on failure).
// Animate a SCENE still (base64 PNG) into a clip. The still already depicts the user's
// scene (built via editPfp), so image-to-video brings THAT to life - not the bare reference.
async function queueVideo(sceneImgB64, motionPrompt) {
  const key = veniceKey(); if (!key) throw new Error("venice_not_configured");
  const r = await fetch("https://api.venice.ai/api/v1/video/queue", {
    method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ model: VIDEO_MODEL, prompt: motionPrompt, duration: VIDEO_DURATION, image_url: "data:image/png;base64," + sceneImgB64 }),
  });
  const j = await r.json().catch(() => ({}));
  const qid = j.queue_id || j.id;
  if (!r.ok || !qid) throw new Error((j && j.error) || "venice_" + r.status);
  return qid;
}

// ── DB ───────────────────────────────────────────────────────────────────────────
let _ensured = false; // schema is idempotent - only run the DDL once per warm instance
async function ensure(s) {
  if (_ensured) return;
  await s`CREATE TABLE IF NOT EXISTS stag_pool (id INT PRIMARY KEY, used INT NOT NULL DEFAULT 0)`;
  await s`INSERT INTO stag_pool (id, used) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`;
  await s`CREATE TABLE IF NOT EXISTS stag_bal (tid TEXT PRIMARY KEY, credits INT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE TABLE IF NOT EXISTS stag_free (tid TEXT PRIMARY KEY, used INT NOT NULL DEFAULT 0)`;
  await s`CREATE TABLE IF NOT EXISTS stag_log (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tid TEXT, uname TEXT, kind TEXT, credits INT, created_at TIMESTAMPTZ DEFAULT now())`;
  await s`ALTER TABLE stag_log ADD COLUMN IF NOT EXISTS uname TEXT`; // for the /leaderboard tool
  await s`CREATE TABLE IF NOT EXISTS stag_claims (txhash TEXT PRIMARY KEY, tid TEXT, credits INT, created_at TIMESTAMPTZ DEFAULT now())`;
  // A purchase is bound to the buyer by a server-assigned EXACT $STAG amount (the odd
  // whole-token tail is their secret) so nobody can front-run/steal a stranger's tx.
  await s`CREATE TABLE IF NOT EXISTS stag_buy_req (tid TEXT PRIMARY KEY, expected NUMERIC NOT NULL, credits INT NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE TABLE IF NOT EXISTS stag_verified (tid TEXT PRIMARY KEY, wallet TEXT, at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE UNIQUE INDEX IF NOT EXISTS stag_verified_wallet ON stag_verified(wallet)`; // one wallet -> one account (atomic)
  await s`CREATE TABLE IF NOT EXISTS stag_verify_req (tid TEXT PRIMARY KEY, wei TEXT, created_at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE TABLE IF NOT EXISTS stag_verify_used (txhash TEXT PRIMARY KEY, tid TEXT, at TIMESTAMPTZ DEFAULT now())`;
  // Whale gate: pending micro-deposit amount, running multi-wallet tally (wallet HASHES only,
  // never raw addresses), and used-tx dedup. Progress rows are deleted once the user is let in.
  await s`CREATE TABLE IF NOT EXISTS stag_whale_req (tid TEXT PRIMARY KEY, wei TEXT, created_at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE TABLE IF NOT EXISTS stag_whale_prog (tid TEXT PRIMARY KEY, total NUMERIC NOT NULL DEFAULT 0, wallets JSONB NOT NULL DEFAULT '[]', updated_at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE TABLE IF NOT EXISTS stag_whale_used (txhash TEXT PRIMARY KEY, tid TEXT, at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE TABLE IF NOT EXISTS stag_cool (tid TEXT PRIMARY KEY, last_at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE TABLE IF NOT EXISTS stag_seen (uid BIGINT PRIMARY KEY, at TIMESTAMPTZ DEFAULT now())`;
  // Async video renders: queued here, delivered/refunded by the /api/stag-video-cron poller.
  await s`CREATE TABLE IF NOT EXISTS stag_video_jobs (queue_id TEXT PRIMARY KEY, tid TEXT, chat_id TEXT, reply_to TEXT, uname TEXT, credits INT NOT NULL DEFAULT 0, funded TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT now())`;
  // Trivia: one live question per chat; weekly scores (global); paid-weeks ledger.
  await s`CREATE TABLE IF NOT EXISTS stag_trivia_active (chat_id TEXT PRIMARY KEY, qidx INT, answer TEXT, started_at TIMESTAMPTZ DEFAULT now(), miss_shown BOOLEAN NOT NULL DEFAULT false, prev_answer TEXT)`;
  await s`ALTER TABLE stag_trivia_active ADD COLUMN IF NOT EXISTS miss_shown BOOLEAN NOT NULL DEFAULT false`;
  await s`ALTER TABLE stag_trivia_active ADD COLUMN IF NOT EXISTS prev_answer TEXT`;
  await s`CREATE TABLE IF NOT EXISTS stag_trivia_score (tid TEXT, uname TEXT, week TEXT, points INT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (tid, week))`;
  await s`CREATE TABLE IF NOT EXISTS stag_trivia_paid (week TEXT PRIMARY KEY, at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE TABLE IF NOT EXISTS stag_trivia_miss (chat_id TEXT, round TIMESTAMPTZ, tid TEXT, at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (chat_id, round, tid))`;
  await s`CREATE TABLE IF NOT EXISTS stag_trivia_recent (chat_id TEXT, qidx INT, at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE INDEX IF NOT EXISTS stag_trivia_recent_chat ON stag_trivia_recent(chat_id, at DESC)`;
  _ensured = true;
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
const pick = (a) => a[Math.floor(Math.random() * a.length)];
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
      buys24: Number(p.txns?.h24?.buys || 0), sells24: Number(p.txns?.h24?.sells || 0),
      // ETH/USD derived from the pair: (USD per $STAG) / (WETH per $STAG) = USD per WETH.
      ethUsd: (Number(p.priceUsd) && Number(p.priceNative)) ? Number(p.priceUsd) / Number(p.priceNative) : 0,
    };
  } catch { return null; }
}
// Holder count via the Robinhood Chain block explorer (Blockscout).
async function holdersCount() {
  try {
    const r = await fetch("https://robinhoodchain.blockscout.com/api/v2/tokens/" + STAG_TOKEN);
    const j = await r.json();
    const n = Number(j.holders || j.holders_count || 0);
    return n > 0 ? n : null;
  } catch { return null; }
}
const shortAddr = (a) => a.slice(0, 6) + "…" + a.slice(-4);

// ── Trivia helpers ─────────────────────────────────────────────────────────────
// A trivia "week" runs Friday -> Thursday; the key is that period's Friday date (UTC).
// The champ is settled/paid each Friday, on the first play after the new period starts.
function weekKey(d = new Date()) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const daysSinceFri = (dt.getUTCDay() - 5 + 7) % 7; // Fri = 5
  dt.setUTCDate(dt.getUTCDate() - daysSinceFri);
  return dt.toISOString().slice(0, 10);
}
// Answer speed -> [hit-image zone, points, label]. Faster = closer to bullseye.
function speedTier(ms) {
  if (ms < 3500) return [0, 10, "BULLSEYE"];
  if (ms < 7000) return [1, 7, "Inner ring"];
  if (ms < 13000) return [2, 5, "Solid hit"];
  if (ms < 25000) return [3, 3, "Outer ring"];
  return [4, 1, "Grazed it"];
}
async function sendHitCard(chatId, replyTo, zone, caption) {
  const r = await sendPhotoKeyed(chatId, `hit${zone}`, () => readFileSync(`${process.cwd()}/assets/trivia/hit${zone}.jpg`), caption, replyTo);
  if (!r || r.ok === false) await say(chatId, replyTo, caption);
}
async function sendMissCard(chatId, replyTo, caption) {
  const r = await sendPhotoKeyed(chatId, "miss", () => readFileSync(`${process.cwd()}/assets/trivia/miss.jpg`), caption, replyTo);
  if (!r || r.ok === false) await say(chatId, replyTo, caption);
}
// Hype commands: send the on-brand $STAG art card with the text as caption; fall back to text.
async function hypeSend(chatId, replyTo, name, text) {
  const r = await sendPhotoKeyed(chatId, `hype_${name}`, () => readFileSync(`${process.cwd()}/assets/trivia/hype/${name}.jpg`), text, replyTo);
  if (!r || r.ok === false) await say(chatId, replyTo, text);
}
async function sendTriviaCard(chatId, replyTo, idx, q) {
  const caption = `🦌 *${q.cat === "STAG" ? "$STAG" : "Crypto"} Trivia* — reply *A / B / C / D*. Answer fast: quicker = closer to bullseye = more points! 🏹`;
  const r = await sendPhotoKeyed(chatId, `t${String(idx + 1).padStart(2, "0")}`, () => readFileSync(`${process.cwd()}/assets/trivia/t${String(idx + 1).padStart(2, "0")}.jpg`), caption, replyTo);
  if (r && r.ok !== false) return;
  // text fallback if the card file isn't bundled
  await say(chatId, replyTo, `❓ *${q.q}*\n\nA) ${q.A}\nB) ${q.B}\nC) ${q.C}\nD) ${q.D}\n\n_Reply A/B/C/D — first right wins!_`);
}
// Settle EVERY unpaid past week (not just last week) so a quiet stretch never skips a
// champion. Idempotent: the paid-weeks ledger claims each week exactly once.
async function settleTriviaWeek(s, chatId) {
  const cur = weekKey();
  let weeks = [];
  try { weeks = await s`SELECT DISTINCT week FROM stag_trivia_score WHERE week < ${cur} ORDER BY week ASC`; } catch { return; }
  for (const w of weeks) {
    const wk = w.week;
    const claimed = await s`INSERT INTO stag_trivia_paid (week) VALUES (${wk}) ON CONFLICT (week) DO NOTHING RETURNING week`;
    if (!claimed.length) continue; // already settled (or a concurrent request just did)
    const top = await s`SELECT tid, uname, points FROM stag_trivia_score WHERE week=${wk} ORDER BY points DESC, updated_at ASC LIMIT 1`;
    if (top.length && top[0].points > 0 && TRIVIA_REWARD > 0) {
      await addCredits(s, top[0].tid, TRIVIA_REWARD);
      await say(chatId, null, `👑 *Trivia Champion — week of ${wk}: ${top[0].uname}!*\n${top[0].points} points → *${TRIVIA_REWARD} $STAG AI credits* awarded. 🏹🦌\nNew week, fresh hunt: /trivia`);
    }
  }
  // Bloat control: drop stale per-round miss + recent-question rows.
  try { await s`DELETE FROM stag_trivia_miss WHERE at < now() - interval '2 days'`; } catch {}
  try { await s`DELETE FROM stag_trivia_recent WHERE at < now() - interval '3 days'`; } catch {}
}
// Pick a question for this chat avoiding the ~30 most-recently served (less repetition),
// then record it. Falls back to any question if everything is recent.
async function pickQuestion(s, chatId) {
  let avoid = new Set();
  try { const r = await s`SELECT qidx FROM stag_trivia_recent WHERE chat_id=${String(chatId)} ORDER BY at DESC LIMIT 30`; avoid = new Set(r.map((x) => x.qidx)); } catch {}
  let idx = Math.floor(Math.random() * TRIVIA.length), tries = 0;
  while (avoid.has(idx) && tries < 60) { idx = Math.floor(Math.random() * TRIVIA.length); tries++; }
  try { await s`INSERT INTO stag_trivia_recent (chat_id, qidx) VALUES (${String(chatId)}, ${idx})`; } catch {}
  return idx;
}

// ── Handler ──────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Warm-up ping (Vercel cron GET): return immediately so an idle instance stays hot and
  // real Telegram webhooks don't pay a cold-start penalty. No work, no DB, just keep-alive.
  if (req.method === "GET") return res.status(200).json({ ok: true, warm: true });
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).end(); }
  // Fail closed: without the shared secret we cannot prove a request is really from
  // Telegram, so anyone could spoof updates and drain the pool / spend others' credits.
  if (!TOKEN || !CONN || !HOOK_SECRET) return res.status(200).json({ ok: false, error: "not_configured" });
  if (req.headers["x-telegram-bot-api-secret-token"] !== HOOK_SECRET) return res.status(401).end();

  const update = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  // Inline-button taps (Blackjack Hit/Stand/Double) arrive as callback queries, not messages.
  if (update.callback_query) {
    try { const sc = neon(CONN); await bjCallback(sc, bjCtx, update.callback_query); } catch (e) {}
    return res.status(200).json({ ok: true });
  }
  const msg = update.message || update.edited_message;
  const text = (msg && msg.text) || "";
  if (!msg || !msg.from || !msg.from.id || !msg.chat) return res.status(200).json({ ok: true });
  if (!text.trim().startsWith("/")) {
    // Trivia answer? A bare A/B/C/D while a question is live in this chat.
    const am = text.trim().toUpperCase().match(/^([ABCD])[).:]?$/);
    if (am) {
      const ans = am[1];
      // Points count only in group/supergroup chats. A private DM has no competition, so a
      // solo player could otherwise farm the weekly reward - DMs still play, just no scoring.
      const scored = msg.chat.type === "group" || msg.chat.type === "supergroup";
      try {
        const st = neon(CONN);
        // Only the FIRST correct answer clears the live row (atomic single-winner).
        const won = await st`DELETE FROM stag_trivia_active WHERE chat_id=${String(msg.chat.id)} AND answer=${ans} RETURNING started_at, qidx`;
        if (won.length) {
          const who = msg.from.username ? "@" + msg.from.username : (msg.from.first_name || "ranger");
          const elapsed = Date.now() - new Date(won[0].started_at).getTime();
          const [zone, pts, label] = speedTier(elapsed);
          const secs = (elapsed / 1000).toFixed(1);
          let caption;
          if (scored) {
            const wk = weekKey();
            await st`INSERT INTO stag_trivia_score (tid, uname, week, points) VALUES (${String(msg.from.id)}, ${who}, ${wk}, ${pts}) ON CONFLICT (tid, week) DO UPDATE SET points = stag_trivia_score.points + ${pts}, uname = ${who}, updated_at = now()`;
            const pr = await st`SELECT points FROM stag_trivia_score WHERE tid=${String(msg.from.id)} AND week=${wk}`;
            caption = `🎯 *${who} — ${label}!*  Answered in *${secs}s* → *+${pts} pts* (this week: *${(pr[0] && pr[0].points) || pts}*). 🏹\nBoard: /triviatop  ·  next question incoming...`;
          } else {
            caption = `🎯 *${who} — ${label}!*  Answered in *${secs}s*. 🏹\n_Practice mode — play in the group to score._  next question incoming...`;
          }
          await sendHitCard(msg.chat.id, msg.message_id, zone, caption);
          // Auto-post the next question (no-repeat), and remember the answer just used so a
          // stale double-tap / late answer / webhook retry isn't mis-scored as a miss.
          const nidx = await pickQuestion(st, msg.chat.id);
          const nq = TRIVIA[nidx];
          await st`INSERT INTO stag_trivia_active (chat_id, qidx, answer, prev_answer) VALUES (${String(msg.chat.id)}, ${nidx}, ${nq.answer}, ${ans}) ON CONFLICT (chat_id) DO UPDATE SET qidx=${nidx}, answer=${nq.answer}, started_at=now(), miss_shown=false, prev_answer=${ans}`;
          await sendTriviaCard(msg.chat.id, null, nidx, nq);
        } else {
          // Wrong guess while a question is live -> call out each person who misses ONCE per
          // question (one spammer can't flood), and dock a point if they have one to lose.
          const live = await st`SELECT started_at, prev_answer FROM stag_trivia_active WHERE chat_id=${String(msg.chat.id)}`;
          if (live.length) {
            // Ignore a stale answer to the question that was JUST replaced (double-tap, a late
            // correct answer, or a webhook retry): the previous round's answer within a few
            // seconds of the new question starting is not a real miss - stay silent, no penalty.
            const justAdvanced = (Date.now() - new Date(live[0].started_at).getTime()) < 5000;
            if (!(justAdvanced && ans === live[0].prev_answer)) {
              const fresh = await st`INSERT INTO stag_trivia_miss (chat_id, round, tid) VALUES (${String(msg.chat.id)}, ${live[0].started_at}, ${String(msg.from.id)}) ON CONFLICT DO NOTHING RETURNING tid`;
              if (fresh.length) {
                const who = msg.from.username ? "@" + msg.from.username : (msg.from.first_name || "ranger");
                let tail;
                if (scored) {
                  const wk = weekKey();
                  const lost = await st`UPDATE stag_trivia_score SET points = points - 1, updated_at = now() WHERE tid=${String(msg.from.id)} AND week=${wk} AND points > 0 RETURNING points`;
                  tail = lost.length ? `*-1 point* (this week: *${lost[0].points}*).` : `No points to lose yet - get one right!`;
                } else {
                  tail = `_Practice mode — play in the group to score._`;
                }
                await sendMissCard(msg.chat.id, msg.message_id, `❌ *${who} missed the mark!* ${tail} 🏹🦌`);
              }
            }
          }
        }
      } catch {}
      return res.status(200).json({ ok: true });
    }
    // Never reveal the underlying AI/model. Answer identity questions (in DMs, or when
    // the bot is @-mentioned) with the on-brand line; else stay silent (no group spam).
    const addressed = msg.chat.type === "private" || /@stagzbot\b/i.test(text);
    if (addressed && /\b(what|which|who|are you|u using|you using).{0,30}(a\.?i|model|bot|made|built|train|power|run|gpt|chatgpt|claude|openai|anthropic|llm|venice|grok|gemini|language\s*model)\b/i.test(text)) {
      await tg("sendMessage", { chat_id: msg.chat.id, reply_to_message_id: msg.message_id, text: `Built and trained by ${OWNER_NAME}. 🦌👑` });
    }
    return res.status(200).json({ ok: true });
  }

  // Split on the first run of whitespace (space/tab/newline), tolerant of leading space.
  const tt = text.trim();
  const mm = tt.match(/^(\S+)\s+([\s\S]*)$/);
  let cmd = (mm ? mm[1] : tt).toLowerCase().split("@")[0];
  const arg = mm ? mm[2].trim() : "";
  const chatId = msg.chat.id, replyTo = msg.message_id;
  const isPrivate = msg.chat.type === "private";
  const tid = String((msg.from && msg.from.id) || "");
  const uname = (msg.from && (msg.from.username ? "@" + msg.from.username : msg.from.first_name)) || "stag";

  const s = neon(CONN);
  try {
    await ensure(s);
    if (update.update_id != null) {
      const seen = await s`INSERT INTO stag_seen (uid) VALUES (${update.update_id}) ON CONFLICT (uid) DO NOTHING RETURNING uid`;
      if (!seen.length) return res.status(200).json({ ok: true, dup: true });
    }

    // ---------- menu / help (image + commands - pinnable community card) ----------
    if (cmd === "/start" || cmd === "/help" || cmd === "/menu" || cmd === "/commands") {
      const menu =
        "🏹 *$STAGWIFHOOD - AI IMAGE GENERATOR*\n" +
        "_Make $STAG art right here in chat._\n\n" +
        "🦌 `/pfp` - your $STAG profile pic *(1 FREE!)*\n" +
        "🎨 `/pfp cyber samurai` - add any theme\n" +
        "🖼️ `/image <scene>` - drop the stag into *any* scene you want\n" +
        "🎥 `/vid <scene>` - a 5s animated $STAG clip\n" +
        "🏹 `/trivia` - play trivia, win $STAG credits  ·  `/triviatop`\n" +
        "🃏 `/bj <bet>` - play *Blackjack* in my DMs *(1000 FREE to start!)*  ·  `/bjtop` leaders\n\n" +
        "💰 *Want more?* Grab credits:\n" +
        "💳 `/buy` - pay in $STAG  ·  `/credits` - your balance\n" +
        "🔐 `/verify` - hold *1M+ $STAG* → *50% OFF*\n\n" +
        "🔒 *NFT & Staking:* `/mints` `/staked` `/pool` `/mystake 0x…` `/topstakers` - live\n" +
        "🐋 `/whale` - join the *Whale Room* (hold 10M+ $STAG, no connect)\n" +
        "🔥 *Hype:* `/fomo` `/pump` `/wagmi` `/gm` `/moon` `/hodl` `/green` `/fud`\n\n" +
        "🆓 *Free tools:* `/price` `/burn` `/holders` `/ca` `/links` - full list: `/tools`\n\n" +
        "🔓 *No wallet connection - ever.* Just send $STAG, no connect, no signing.\n" +
        "_Use me in the group or DM me privately. Antlers up. 💚🦌_";
      // Standalone (no reply) so it's a clean card the community can pin.
      const r = await sendPhotoKeyed(chatId, "welcome", () => welcomeImg(), menu, null, "Markdown", "image/png", "stag.png");
      if (!r || r.ok === false) await say(chatId, null, menu); // text fallback
      return res.status(200).json({ ok: true });
    }

    // ---------- BLACKJACK (DM-only play; wins + leaders announced in the group) ----------
    if (cmd === "/bj" || cmd === "/blackjack" || cmd === "/21") {
      await bjCommand(s, bjCtx, { chatId, tid, uname, replyTo, arg, isPrivate });
      return res.status(200).json({ ok: true });
    }
    if (cmd === "/bjtop" || cmd === "/bjleaders" || cmd === "/blackjacktop" || cmd === "/21top") {
      // From the group: post the board right here. From a DM: push it to the group so leaders show publicly.
      await bjLeaderboard(s, bjCtx, { chatId, toGroup: isPrivate });
      if (isPrivate) await say(chatId, replyTo, "🏆 Posted the blackjack leaderboard to the group. 🦌");
      return res.status(200).json({ ok: true });
    }

    // ---------- about (identity - never reveals the model) ----------
    if (cmd === "/about" || cmd === "/whoami") {
      await say(chatId, replyTo, `🦌 The *$STAGWIFHOOD* generator - built and trained by *${OWNER_NAME}*. 👑\nThat's all you need to know. 🏹`);
      return res.status(200).json({ ok: true });
    }

    // ---------- FREE TOOLS: price / market cap ----------
    if (cmd === "/price" || cmd === "/mc" || cmd === "/chart" || cmd === "/stats" || cmd === "/marketcap") {
      const d = await stagStats();
      if (!d) { await say(chatId, replyTo, "⚠️ Couldn't load $STAG stats right now - try again in a sec."); return res.status(200).json({ ok: true }); }
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
      await say(chatId, replyTo, `📜 *$STAG contract* - Robinhood Chain\n\`${STAG_TOKEN}\`\n\n⚠️ Only ever trust *this* address. Verify before you buy.`);
      return res.status(200).json({ ok: true });
    }
    if (cmd === "/links" || cmd === "/socials" || cmd === "/official") {
      await say(chatId, replyTo,
        `🔗 *$STAGWIFHOOD - official links*\n\n` +
        `🌐 [Website](${LINKS.site})\n🐦 [X / Twitter](${LINKS.x})\n💬 [Telegram](${LINKS.tg})\n📈 [Chart](${LINKS.chart})\n\n📜 CA: \`${STAG_TOKEN}\``);
      return res.status(200).json({ ok: true });
    }

    // ---------- FREE TOOLS: total burned ----------
    if (cmd === "/burn" || cmd === "/burns" || cmd === "/burned") {
      try {
        const [burned, supply] = await Promise.all([stagBalanceWhole(DEAD), stagTotalSupplyWhole()]);
        const pct = supply > 0 ? (burned / supply * 100) : 0;
        await say(chatId, replyTo, `🔥 *$STAG BURNED*\n\nTotal burned: *${fmt(burned)}* $STAG\n🔥 *${pct.toFixed(2)}%* of supply gone forever`);
      } catch { await say(chatId, replyTo, "⚠️ Couldn't read burn data right now - try again."); }
      return res.status(200).json({ ok: true });
    }

    // ---------- FREE TOOLS: all-tools list ----------
    if (cmd === "/tools" || cmd === "/free") {
      await say(chatId, replyTo,
        "🆓 *$STAG free tools*\n\n" +
        "📊 `/price` `/mc` - price & market cap\n" +
        "🔥 `/burn` - total burned\n" +
        "📈 `/buys` - 24h buys vs sells\n" +
        "👥 `/holders` - holder count\n" +
        "🪙 `/supply` - supply & circulating\n" +
        "👛 `/wallet <addr>` - any wallet's $STAG\n" +
        "🧮 `/convert 1000000` - $STAG ↔ USD\n" +
        "⛽ `/gas` - Robinhood Chain gas\n" +
        "🏆 `/leaderboard` - top creators\n" +
        "🚨 `/raid <your text>` - ready-to-post raid content\n" +
        "📜 `/ca` · 🔗 `/links`");
      return res.status(200).json({ ok: true });
    }

    // ---------- FREE TOOLS: 24h buys vs sells ----------
    if (cmd === "/buys" || cmd === "/txns" || cmd === "/volume" || cmd === "/vol") {
      const d = await stagStats();
      if (!d) { await say(chatId, replyTo, "⚠️ Couldn't load that right now - try again."); return res.status(200).json({ ok: true }); }
      const tot = d.buys24 + d.sells24;
      const bp = tot ? Math.round(d.buys24 / tot * 100) : 0;
      await say(chatId, replyTo, `📈 *$STAG - last 24h*\n\n🟢 Buys: *${d.buys24}*\n🔴 Sells: *${d.sells24}*\n📊 ${bp}% buy pressure\n💵 Volume: ${money(d.vol24)}`);
      return res.status(200).json({ ok: true });
    }

    // ---------- FREE TOOLS: holders ----------
    if (cmd === "/holders") {
      const n = await holdersCount();
      await say(chatId, replyTo, n ? `👥 *$STAGWIFHOOD holders*\n\n*${n.toLocaleString("en-US")}* holders and growing 🦌` : "⚠️ Couldn't read holder count right now - try again.");
      return res.status(200).json({ ok: true });
    }

    // ---------- FREE TOOLS: supply ----------
    if (cmd === "/supply") {
      try {
        const [supply, burned] = await Promise.all([stagTotalSupplyWhole(), stagBalanceWhole(DEAD)]);
        const circ = Math.max(0, supply - burned);
        await say(chatId, replyTo, `🪙 *$STAG supply*\n\nTotal: *${fmt(supply)}*\n🔥 Burned: ${fmt(burned)}\n🟢 Circulating: *${fmt(circ)}*`);
      } catch { await say(chatId, replyTo, "⚠️ Couldn't read supply right now - try again."); }
      return res.status(200).json({ ok: true });
    }

    // ---------- ON-CHAIN: staking + NFT stats (Hooded Twenty) ----------
    if (cmd === "/staked" || cmd === "/totalstaked" || cmd === "/staking") {
      try {
        const st = await stakingStats();
        await hypeSend(chatId, replyTo, "staked", `🔒🦌 *$STAG Staking*\n\nTotal staked: *${fmt(st.stagStaked)} $STAG*\nNFTs staked: *${st.nftsStaked}/20* Hooded Twenty\nReward pool: *${st.poolEth.toFixed(4)} ETH*\n\n_Stake $STAG or your Hooded Twenty to earn ETH._ 💚`);
      } catch { await say(chatId, replyTo, "⚠️ Couldn't read staking right now - try again."); }
      return res.status(200).json({ ok: true });
    }
    if (cmd === "/pool" || cmd === "/rewards" || cmd === "/apr") {
      try {
        const st = await stakingStats();
        const active = st.periodFinish > Math.floor(Date.now() / 1000);
        const daily = st.rewardEthPerSec * 86400;
        await hypeSend(chatId, replyTo, "pool", `💰🏹 *Staking Reward Pool*\n\nPool: *${st.poolEth.toFixed(4)} ETH*\n${active ? `🟢 Emitting ~*${daily.toFixed(4)} ETH/day*` : "🔴 Rewards paused - awaiting top-up"}\n\nStaked: *${fmt(st.stagStaked)} $STAG* · *${st.nftsStaked}* NFTs`);
      } catch { await say(chatId, replyTo, "⚠️ Couldn't read the pool right now - try again."); }
      return res.status(200).json({ ok: true });
    }
    if (cmd === "/mints" || cmd === "/minted" || cmd === "/mintstatus") {
      try {
        const n = await nftMintStats();
        await hypeSend(chatId, replyTo, "mints", `🦌🏹 *Hooded Twenty NFT*\n\nMinted: *${n.minted}/${n.max}*  ·  Left: *${n.remaining}*\nMint: ${n.active ? "🟢 *LIVE*" : "🔴 not open yet"}${n.price > 0 ? `  ·  ~*${n.price} ETH*` : ""}`);
      } catch { await say(chatId, replyTo, "⚠️ Couldn't read mint status - try again."); }
      return res.status(200).json({ ok: true });
    }
    if (cmd === "/mystake" || cmd === "/mystaking" || cmd === "/position" || cmd === "/mypos") {
      const w = (arg.trim().split(/\s+/)[0] || "");
      if (!/^0x[0-9a-fA-F]{40}$/.test(w)) { await say(chatId, replyTo, "Usage: `/mystake 0x…` - your Robinhood Chain wallet."); return res.status(200).json({ ok: true }); }
      try {
        const p = await walletStake(w);
        if (p.stakedStag <= 0 && p.nftsStaked <= 0) {
          await say(chatId, replyTo, `🦌 \`${shortAddr(w)}\` isn't staking yet.\nStake $STAG or your Hooded Twenty to earn ETH. 🏹`);
        } else {
          const now = Math.floor(Date.now() / 1000);
          const lock = p.locked && p.unlockAt > now ? `\n🔒 Locked until *${new Date(p.unlockAt * 1000).toISOString().slice(0, 10)}*` : "\n🔓 Unlocked";
          const ids = p.nftIds.length ? ` (#${p.nftIds.join(", #")})` : "";
          await say(chatId, replyTo, `🔒🦌 *Your Staking* \`${shortAddr(w)}\`\n\nStaked: *${fmt(p.stakedStag)} $STAG*\nNFTs staked: *${p.nftsStaked}*${ids}\nPending rewards: *${p.pendingEth.toFixed(6)} ETH*${lock}`);
        }
      } catch { await say(chatId, replyTo, "⚠️ Couldn't read that wallet's staking - check the address."); }
      return res.status(200).json({ ok: true });
    }
    if (cmd === "/topstakers" || cmd === "/topstake" || cmd === "/stakers" || cmd === "/stakingtop") {
      try {
        const top = await topStakers(10);
        if (!top.length) { await say(chatId, replyTo, "🔒 No stakers yet - be the FIRST. Stake $STAG or your Hooded Twenty to earn ETH. 🦌🏹"); return res.status(200).json({ ok: true }); }
        const medal = (i) => ["🥇", "🥈", "🥉"][i] || `${i + 1}.`;
        const list = top.map((s, i) => `${medal(i)} \`${shortAddr(s.wallet)}\` - *${s.share.toFixed(1)}%*${s.nfts ? ` · ${s.nfts}🦌` : ""}`).join("\n");
        await say(chatId, replyTo, `🏆🔒 *Top $STAG Stakers*\n\n${list}\n\n_Share of the reward pool by stake weight. 🦌_`);
      } catch { await say(chatId, replyTo, "⚠️ Couldn't load stakers right now - try again."); }
      return res.status(200).json({ ok: true });
    }

    // ---------- FOMO / bullish hype commands ----------
    if (cmd === "/fomo") {
      const hooks = [
        "You're still early, ranger. The hood is filling up. 🏹",
        "Every dip is a gift. Steal the pump, feed the holders. 🦌",
        "Blink and you'll be telling people you were here at THIS market cap. 👀",
        "Sherwood doesn't wait. Antlers up. 🌿",
        "Weak hands feed the legend. Diamond antlers stay. 💚",
      ];
      try {
        const [d, h, n] = await Promise.all([stagStats(), holdersCount().catch(() => 0), nftMintStats().catch(() => null)]);
        let m = `🚨🦌 *$STAG FOMO CHECK* 🦌🚨\n\n`;
        if (d) m += `🏦 MC: *${money(d.mcap)}*  ·  ${d.change24 >= 0 ? "🟢 +" : "🔴 "}${d.change24.toFixed(1)}% 24h\n`;
        if (h) m += `👥 Holders: *${h.toLocaleString("en-US")}* and climbing\n`;
        if (n && n.remaining > 0) m += `🎟️ NFTs left: *${n.remaining}/${n.max}*${n.active ? " · 🟢 minting now" : ""}\n`;
        m += `\n${pick(hooks)}\n\n_Antlers up. Not financial advice._`;
        await hypeSend(chatId, replyTo, "fomo", m);
      } catch { await say(chatId, replyTo, "🚨🦌 *$STAG* - you're early, ranger. Antlers up. 🏹"); }
      return res.status(200).json({ ok: true });
    }
    if (cmd === "/pump" || cmd === "/pumpit") {
      await hypeSend(chatId, replyTo, "pump", `${pick([
        "📈🟢🟢 SEND IT 🟢🟢📈", "🚀 $STAG doesn't pump - it STAMPEDES. 🦌💨",
        "Green candles incoming. Grab your antlers. 🕯️💚", "🏹 One arrow, one target: UP.",
        "Bears in Sherwood? The stag hunts back. 🐻➡️🦌",
      ])}\n\n🟩🟩🟩🟩🟩🟩🟩🟩\n*WAGMI, ranger.* 🦌`);
      return res.status(200).json({ ok: true });
    }
    if (cmd === "/wagmi") {
      await hypeSend(chatId, replyTo, "wagmi", `💚🦌 *WAGMI* 🦌💚\n\n${pick([
        "We're All Gonna Make It. Antlers up. 🏹", "The hood takes care of its own. 💚",
        "Steal the pump. Feed the holders. WAGMI.", "Diamond antlers, ranger. We ride. 💎🦌",
      ])}`);
      return res.status(200).json({ ok: true });
    }
    if (cmd === "/gm") {
      await say(chatId, replyTo, pick([
        "GM rangers. New day, same mission: steal the pump. 🌅🦌", "GM. Antlers up, hood on. Let's hunt. 🏹",
        "GM legends. Sherwood is green today. 🌿💚", "GM. The stag already ate. Have you? 🦌",
      ]));
      return res.status(200).json({ ok: true });
    }
    if (cmd === "/gn") {
      await say(chatId, replyTo, pick([
        "GN rangers. The stag never sleeps on the bag. 🌙🦌", "GN. Rest up, we hunt at dawn. 🏹",
        "GN legends. Dream green. 💚",
      ]));
      return res.status(200).json({ ok: true });
    }
    if (cmd === "/moon" || cmd === "/wen") {
      await hypeSend(chatId, replyTo, "moon", pick([
        "Wen moon? The hood doesn't ask - the hood accumulates. 🌕🦌", "Moon's not a question, it's a checkpoint. 🚀",
        "Wen? When weak hands finish leaving. 💎", "The stag WALKS to the moon. It's in no rush. 🦌🌙",
      ]));
      return res.status(200).json({ ok: true });
    }
    if (cmd === "/hodl" || cmd === "/diamond" || cmd === "/dh") {
      await hypeSend(chatId, replyTo, "hodl", pick([
        "💎🦌 Diamond antlers. Never sold, never will.", "Paper hands feed the legend. HODL, ranger. 🏹",
        "The hood holds - through red, through green, through everything. 💚", "Sold? In THIS forest? Never. 🌿💎",
      ]));
      return res.status(200).json({ ok: true });
    }
    if (cmd === "/green" || cmd === "/greencandle" || cmd === "/candles") {
      await say(chatId, replyTo, `🕯️💚 *GREEN CANDLES* 💚🕯️\n\`\`\`\n          🟩\n        🟩🟩\n     🟩🟩🟩\n   🟩🟩🟩🟩\n 🟩🟩🟩🟩🟩\n\`\`\`\n$STAG only knows one direction. Antlers up. 🦌📈`);
      return res.status(200).json({ ok: true });
    }
    if (cmd === "/fud") {
      await say(chatId, replyTo, pick([
        "FUD detected. The stag doesn't flinch. 🦌🛡️", "Every FUDder is tomorrow's holder. Zoom out. 🔭",
        "FUD is just fear in a costume. Antlers up. 🏹", "Nice try, sheriff. The hood stays. 💚",
      ]));
      return res.status(200).json({ ok: true });
    }
    if (cmd === "/send" || cmd === "/sendit" || cmd === "/lfg") {
      await say(chatId, replyTo, pick([
        "🏹 SEND IT. No hesitation. 🦌", "Arrow's nocked. LFG. 🟢🟢🟢", "Full send, ranger. Sherwood or bust. 💚🦌",
      ]));
      return res.status(200).json({ ok: true });
    }
    if (cmd === "/based") {
      await say(chatId, replyTo, pick(["Based and antlers-pilled. 🦌", "Certified based, ranger. 💚", "The hood approves. Based. 🏹"]));
      return res.status(200).json({ ok: true });
    }

    // ---------- FREE TOOLS: wallet balance lookup ----------
    if (cmd === "/wallet" || cmd === "/bal" || cmd === "/holdings") {
      const w = (arg.trim().split(/\s+/)[0] || "");
      if (!/^0x[0-9a-fA-F]{40}$/.test(w)) { await say(chatId, replyTo, "Usage: `/wallet 0x…` (any Robinhood Chain address)."); return res.status(200).json({ ok: true }); }
      try {
        const [bal, d] = await Promise.all([stagBalanceWhole(w), stagStats()]);
        const usd = d ? bal * d.priceUsd : 0;
        await say(chatId, replyTo, `👛 \`${shortAddr(w)}\`\nholds *${fmt(bal)}* $STAG${d ? ` ≈ *$${usd.toFixed(2)}*` : ""}`);
      } catch { await say(chatId, replyTo, "⚠️ Couldn't read that wallet - check the address."); }
      return res.status(200).json({ ok: true });
    }

    // ---------- FREE TOOLS: convert $STAG <-> USD ----------
    if (cmd === "/convert" || cmd === "/calc") {
      const raw = arg.trim();
      const num = parseFloat(raw.replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(num) || num <= 0) { await say(chatId, replyTo, "Usage: `/convert 1000000` (→ USD) or `/convert $50` (→ $STAG)."); return res.status(200).json({ ok: true }); }
      const d = await stagStats();
      if (!d) { await say(chatId, replyTo, "⚠️ Price feed hiccup - try again."); return res.status(200).json({ ok: true }); }
      if (raw.includes("$")) await say(chatId, replyTo, `🧮 *$${fmt(num)}* = *${fmt(num / d.priceUsd)}* $STAG`);
      else await say(chatId, replyTo, `🧮 *${fmt(num)}* $STAG = *$${(num * d.priceUsd).toFixed(2)}*`);
      return res.status(200).json({ ok: true });
    }

    // ---------- FREE TOOLS: gas (shown as USD cost of a transaction) ----------
    if (cmd === "/gas") {
      try {
        const wei = Number(BigInt(await rpc("eth_gasPrice")));
        const txEth = wei * 21000 / 1e18;            // a standard transfer = 21k gas
        const d = await stagStats();
        const txUsd = d && d.ethUsd ? txEth * d.ethUsd : null;
        const usdStr = txUsd == null ? null : (txUsd < 0.01 ? "$" + txUsd.toFixed(4) : "$" + txUsd.toFixed(2));
        await say(chatId, replyTo,
          `⛽ *Robinhood Chain gas*\n\n` +
          (usdStr ? `A transaction costs about *${usdStr}*.\n` : `Fractions of a cent per transaction.\n`) +
          `Basically free. 🟢`);
      } catch { await say(chatId, replyTo, "⚠️ Couldn't read gas right now - try again."); }
      return res.status(200).json({ ok: true });
    }

    // ---------- FREE TOOLS: creator leaderboard ----------
    if (cmd === "/leaderboard" || cmd === "/lb" || cmd === "/top") {
      const rows = await s`SELECT uname, COUNT(*)::int AS n FROM stag_log WHERE uname IS NOT NULL GROUP BY uname ORDER BY n DESC LIMIT 10`;
      if (!rows.length) { await say(chatId, replyTo, "🏆 No art made yet - be the first with /pfp!"); return res.status(200).json({ ok: true }); }
      const medals = ["🥇", "🥈", "🥉"];
      // Plain text (no Markdown): usernames can contain _ * ` [ which would break a Markdown parse.
      const list = rows.map((r, i) => `${medals[i] || `${i + 1}.`} ${r.uname} - ${r.n}`).join("\n");
      await tg("sendMessage", { chat_id: chatId, reply_to_message_id: replyTo, disable_web_page_preview: true, text: `🏆 $STAG top creators\n\n${list}` });
      return res.status(200).json({ ok: true });
    }

    // ---------- RAID: generate ready-to-post content ----------
    if (cmd === "/raid") {
      const content = arg.trim().replace(/`/g, "").slice(0, 220) || RAID_LINES[Math.floor(Math.random() * RAID_LINES.length)];
      const tags = HASHTAG_SETS[Math.floor(Math.random() * HASHTAG_SETS.length)];
      const linkPool = [LINKS.site, LINKS.chart, LINKS.x];
      const link = Math.random() < 0.7 ? linkPool[Math.floor(Math.random() * linkPool.length)] : ""; // random link, if any
      const post = `${content}\n\n$STAGWIFHOOD ${tags}${link ? `\n${link}` : ""}`;
      await say(chatId, replyTo,
        "🏹 *Raid post ready - copy & drop on X:*\n\n```\n" + post + "\n```\n_Run /raid again for a fresh variation._");
      return res.status(200).json({ ok: true });
    }

    // ---------- reset (OWNER ONLY) ----------
    if (cmd === "/reset") {
      if (!isOwnerId(tid)) return res.status(200).json({ ok: true }); // silently ignore for everyone else
      const scope = arg.trim().toLowerCase();
      await s`UPDATE stag_pool SET used = 0 WHERE id = 1`; // zero the free-pool counter
      if (scope === "all") {
        await s`TRUNCATE stag_free, stag_log, stag_cool`;   // fresh launch: everyone gets their free again
        await say(chatId, replyTo, "🧹 *Full reset* - free pool zeroed, everyone's free PFP + cooldowns cleared. Clean launch. 🦌");
      } else {
        await say(chatId, replyTo, `🧹 Free pool reset to *0 / ${BUDGET}*. (Use \`/reset all\` to also clear per-user free grants + cooldowns.)`);
      }
      return res.status(200).json({ ok: true });
    }

    // ---------- credits / pool ----------
    if (cmd === "/credits" || cmd === "/balance" || cmd === "/pfpcredits") {
      const [bal, used, verified] = [await balOf(s, tid), await poolUsed(s), await isVerified(s, tid)];
      const freeLeft = Math.max(0, BUDGET - used);
      if (isOwnerId(tid)) { await say(chatId, replyTo, `👑 *Owner* - unlimited generations, no cooldown, no cost.\nYour Telegram id: \`${tid}\``); return res.status(200).json({ ok: true }); }
      await say(chatId, replyTo,
        `🎯 *Your $STAG credits:* ${bal} (~${Math.floor(bal / PFP_COST)} images)\n` +
        `_Your Telegram id: ${tid}_\n` +
        `${verified ? "✅ *Verified holder* - 50% off\n" : ""}` +
        `Free launch pool: ${used}/${BUDGET} used (~${Math.floor(freeLeft / PFP_COST)} free PFPs left)\n\n` +
        `Top up: /buy  •  Holder discount: /verify`);
      return res.status(200).json({ ok: true });
    }

    // Payment + verification MUST happen in DM: the unique amount is a per-user secret,
    // and showing it in a group would let anyone see (and try to claim) it.
    if (["/buy", "/topup", "/claim", "/verify"].includes(cmd) && !isPrivate) {
      await say(chatId, replyTo, `🔒 For your security, do that in a private chat.\n👉 [Tap here to DM me](https://t.me/${BOT_USERNAME}?start=${cmd.slice(1)}) and run \`${cmd}\` there.`);
      return res.status(200).json({ ok: true });
    }

    // ---------- buy (step 1: list; step 2: lock a unique exact amount) ----------
    if (cmd === "/buy" || cmd === "/topup") {
      if (!TREASURY) { await say(chatId, replyTo, "🛠️ Buying opens shortly - hang tight, ranger."); return res.status(200).json({ ok: true }); }
      const px = await stagPriceUsd();
      if (!px) { await say(chatId, replyTo, "⚠️ Price feed hiccup - try /buy again in a sec."); return res.status(200).json({ ok: true }); }
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
      // Server-assigned unique whole-token amount = the buyer's binding. It MUST be unique
      // among all active pending buys, otherwise an attacker could re-roll /buy until their
      // amount matches a victim's and then claim the victim's tx. Reroll on any clash.
      let expected = null;
      for (let tries = 0; tries < 20; tries++) {
        const cand = Math.ceil(baseStag) + 1000 + Math.floor(Math.random() * 9000);
        const clash = await s`SELECT 1 FROM stag_buy_req WHERE expected=${cand} AND tid<>${tid} AND created_at > now() - interval '7 days'`;
        if (!clash.length) { expected = cand; break; }
      }
      if (expected == null) { await say(chatId, replyTo, "🛠️ Too many active buys right now - try `/buy` again in a minute."); return res.status(200).json({ ok: true }); }
      await s`INSERT INTO stag_buy_req (tid, expected, credits, created_at) VALUES (${tid}, ${expected}, ${credits}, now())
              ON CONFLICT (tid) DO UPDATE SET expected=${expected}, credits=${credits}, created_at=now()`;
      await say(chatId, replyTo,
        `💳 *$${pickUsd} → ${credits} credits*${holder ? " _(holder 50% off)_" : ""}\n\n` +
        `1️⃣ Send *EXACTLY* \`${expected.toLocaleString("en-US")}\` $STAG to:\n\`${TREASURY}\`\n` +
        `   _(that exact amount is your secret - send the precise number)_\n` +
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
      if (Date.now() - new Date(reqRow[0].created_at).getTime() > REQ_TTL) { await say(chatId, replyTo, "That buy expired - run `/buy` again."); return res.status(200).json({ ok: true }); }
      let pay;
      try { pay = await verifyStagPayment(txh, TREASURY); }
      catch { await say(chatId, replyTo, "⚠️ Network hiccup reading the chain - your $STAG is safe, run /claim again in a moment."); return res.status(200).json({ ok: true }); }
      if (!pay.ok) { await say(chatId, replyTo, `⚠️ Couldn't verify that payment (${pay.err}). Make sure it's confirmed and sent $STAG to the treasury.`); return res.status(200).json({ ok: true }); }
      const expected = Number(reqRow[0].expected), credits = Number(reqRow[0].credits);
      // Must match the assigned amount EXACTLY. The unique amount is the whole binding;
      // a tolerance band would let an attacker park at expected±1 (which doesn't clash)
      // and claim a stranger's tx. $STAG is a Uniswap-V3 token with no transfer tax, so a
      // whole-token send always arrives exact - no tolerance needed.
      if (Math.round(pay.amountWhole) !== expected) {
        await say(chatId, replyTo, `⚠️ That tx sent ${fmt(pay.amountWhole)} $STAG but your locked amount is *${expected.toLocaleString("en-US")}*. Send the *exact* amount, then /claim.`);
        return res.status(200).json({ ok: true });
      }
      // The payment must be confirmed and NEWER than the locked amount. Fail CLOSED if we
      // can't read the block time (retryable) - never credit without proving freshness.
      const reqTime = new Date(reqRow[0].created_at).getTime();
      if (!pay.blockTime) {
        await say(chatId, replyTo, "⚠️ Couldn't confirm that tx's block yet - if you just sent it, wait a few seconds and `/claim` again.");
        return res.status(200).json({ ok: true });
      }
      if (pay.blockTime * 1000 < reqTime - 120000) {
        await say(chatId, replyTo, "⚠️ That payment predates your locked amount. Run `/buy` for a fresh amount, send it, then `/claim`.");
        return res.status(200).json({ ok: true });
      }
      // Atomic idempotency: only the INSERT winner credits.
      const ins = await s`INSERT INTO stag_claims (txhash, tid, credits) VALUES (${txh}, ${tid}, ${credits}) ON CONFLICT (txhash) DO NOTHING RETURNING txhash`;
      if (!ins.length) { await say(chatId, replyTo, "That tx was already claimed. ✅"); return res.status(200).json({ ok: true }); }
      // If crediting fails after the claim is recorded, roll the claim back so the payer
      // can retry (never leave a paid tx marked-claimed-but-uncredited).
      try { await addCredits(s, tid, credits); }
      catch { await s`DELETE FROM stag_claims WHERE txhash=${txh}`; await say(chatId, replyTo, "⚠️ Network hiccup crediting - your payment is safe, run `/claim` again in a moment."); return res.status(200).json({ ok: true }); }
      await s`DELETE FROM stag_buy_req WHERE tid=${tid}`;
      await say(chatId, replyTo, `✅ Credited *${credits}* credits. Balance: *${await balOf(s, tid)}*.\nGo wild: /pfp or /image 🏹`);
      return res.status(200).json({ ok: true });
    }

    // ---------- holder verify (no-connect micro-deposit) ----------
    if (cmd === "/verify") {
      if (!VERIFY_WALLET) { await say(chatId, replyTo, "🛠️ Verification opens shortly."); return res.status(200).json({ ok: true }); }
      const txh = (arg.trim().split(/\s+/)[0] || "").toLowerCase();
      if (!txh) {
        // Step 1: issue a unique tiny amount as the secret (server-assigned, ~cents,
        // wide range so two pending requests practically never collide).
        // Amount MUST be unique among active pending verifies, else an attacker could
        // re-roll to match a whale's pending deposit and hijack it. Reroll on any clash.
        let wei = null;
        for (let tries = 0; tries < 20; tries++) {
          const rnd = 100000 + Math.floor(Math.random() * 900000);
          const cand = (10n ** 13n + BigInt(rnd) * 10n ** 7n).toString(); // ~0.00001-0.00002 ETH, unique tail
          const clash = await s`SELECT 1 FROM stag_verify_req WHERE wei=${cand} AND tid<>${tid} AND created_at > now() - interval '7 days'`;
          if (!clash.length) { wei = cand; break; }
        }
        if (wei == null) { await say(chatId, replyTo, "🛠️ Busy right now - try `/verify` again in a minute."); return res.status(200).json({ ok: true }); }
        await s`INSERT INTO stag_verify_req (tid, wei, created_at) VALUES (${tid}, ${wei}, now()) ON CONFLICT (tid) DO UPDATE SET wei=${wei}, created_at=now()`;
        const eth = (Number(wei) / 1e18).toFixed(9);
        await say(chatId, replyTo,
          "🔐 *Verify you hold 1M+ $STAG - no wallet connect.*\n\n" +
          `1️⃣ From your wallet, send *exactly* \`${eth}\` ETH to:\n\`${VERIFY_WALLET}\`\n` +
          "   _(that exact odd amount is your one-time secret)_\n" +
          "2️⃣ Then run \`/verify <your-tx-hash>\`\n\n" +
          "Just a normal send - no connect, no approval. Unlocks *50% off* all credits. 🦌");
        return res.status(200).json({ ok: true });
      }
      if (!/^0x[0-9a-f]{64}$/.test(txh)) { await say(chatId, replyTo, "Usage: `/verify` first, then `/verify 0x<txhash>`."); return res.status(200).json({ ok: true }); }
      // A given deposit tx can verify at most ONE account.
      if ((await s`SELECT 1 FROM stag_verify_used WHERE txhash=${txh}`).length) { await say(chatId, replyTo, "That tx was already used to verify. Run `/verify` for a fresh amount."); return res.status(200).json({ ok: true }); }
      const reqRow = await s`SELECT wei, created_at FROM stag_verify_req WHERE tid=${tid}`;
      if (!reqRow.length) { await say(chatId, replyTo, "Run `/verify` first to get your unique amount."); return res.status(200).json({ ok: true }); }
      if (Date.now() - new Date(reqRow[0].created_at).getTime() > REQ_TTL) { await say(chatId, replyTo, "That verify request expired - run `/verify` again."); return res.status(200).json({ ok: true }); }
      let chk;
      try { chk = await verifyMicroDeposit(txh, VERIFY_WALLET, reqRow[0].wei); }
      catch { await say(chatId, replyTo, "⚠️ Network hiccup reading the chain - try /verify <txhash> again in a moment."); return res.status(200).json({ ok: true }); }
      if (!chk.ok) { await say(chatId, replyTo, `⚠️ Couldn't match that (${chk.err}). Send the *exact* amount, then paste the confirmed tx hash.`); return res.status(200).json({ ok: true }); }
      // Deposit must be confirmed and NEWER than the verify request. Fail CLOSED if the
      // block time can't be read (retryable) - never verify without proving freshness.
      if (!chk.blockTime) {
        await say(chatId, replyTo, "⚠️ Couldn't confirm that deposit's block yet - if you just sent it, wait a few seconds and paste the hash again.");
        return res.status(200).json({ ok: true });
      }
      if (chk.blockTime * 1000 < new Date(reqRow[0].created_at).getTime() - 120000) {
        await say(chatId, replyTo, "⚠️ That deposit predates your verify request. Run `/verify` for a fresh amount, send it, then paste the hash.");
        return res.status(200).json({ ok: true });
      }
      // Claim this tx as used before granting (atomic; loser bails).
      const usedIns = await s`INSERT INTO stag_verify_used (txhash, tid) VALUES (${txh}, ${tid}) ON CONFLICT (txhash) DO NOTHING RETURNING txhash`;
      if (!usedIns.length) { await say(chatId, replyTo, "That tx was already used to verify."); return res.status(200).json({ ok: true }); }
      const held = await stagBalanceWhole(chk.from);
      if (held < HOLD_MIN) { await say(chatId, replyTo, `🦌 That wallet holds ${fmt(held)} $STAG - need ${fmt(HOLD_MIN)}+ for the holder perk. Stack more and re-verify.`); return res.status(200).json({ ok: true }); }
      // One wallet unlocks the discount for ONE account. The unique index on wallet makes
      // this atomic (a concurrent second account's INSERT throws and is caught below); the
      // pre-check just gives a friendlier message in the common non-racing case.
      const otherOwner = await s`SELECT tid FROM stag_verified WHERE wallet=${chk.from} AND tid<>${tid}`;
      if (otherOwner.length) { await say(chatId, replyTo, "🦌 That wallet is already linked to another account. Use a different holder wallet."); return res.status(200).json({ ok: true }); }
      try {
        await s`INSERT INTO stag_verified (tid, wallet) VALUES (${tid}, ${chk.from}) ON CONFLICT (tid) DO UPDATE SET wallet=${chk.from}, at=now()`;
      } catch {
        await say(chatId, replyTo, "🦌 That wallet is already linked to another account. Use a different holder wallet.");
        return res.status(200).json({ ok: true });
      }
      await s`DELETE FROM stag_verify_req WHERE tid=${tid}`;
      await say(chatId, replyTo, `✅ *Verified holder!* ${fmt(held)} $STAG. You now get *50% off* all credits. 🏹💚\n/buy to stock up cheap.`);
      return res.status(200).json({ ok: true });
    }

    // ---------- whale gate (prove WHALE_MIN+ $STAG across wallets -> single-use invite) ----------
    if (cmd === "/whale") {
      if (!isPrivate) { await say(chatId, replyTo, `🐋 DM me to join the whale room privately → @${BOT_USERNAME}`); return res.status(200).json({ ok: true }); }
      if (!VERIFY_WALLET || !WHALE_CHAT) { await say(chatId, replyTo, "🛠️ The whale room opens shortly."); return res.status(200).json({ ok: true }); }
      const txh = (arg.trim().split(/\s+/)[0] || "").toLowerCase();
      if (!txh) {
        // Step 1: unique odd amount, unique among active whale requests (so nobody can hijack yours).
        // Base 3e13 keeps whale amounts in a DISJOINT range from /verify (base 1e13, tops out < 2e13),
        // so a whale amount can never collide with a pending verify amount and steal its deposit tx.
        let wei = null;
        for (let tries = 0; tries < 20; tries++) {
          const rnd = 100000 + Math.floor(Math.random() * 900000);
          const cand = (3n * 10n ** 13n + BigInt(rnd) * 10n ** 7n).toString();
          const clash = await s`SELECT 1 FROM stag_whale_req WHERE wei=${cand} AND tid<>${tid} AND created_at > now() - interval '7 days'`;
          if (!clash.length) { wei = cand; break; }
        }
        if (wei == null) { await say(chatId, replyTo, "🛠️ Busy right now - try `/whale` again in a minute."); return res.status(200).json({ ok: true }); }
        await s`INSERT INTO stag_whale_req (tid, wei, created_at) VALUES (${tid}, ${wei}, now()) ON CONFLICT (tid) DO UPDATE SET wei=${wei}, created_at=now()`;
        const prog = await s`SELECT total FROM stag_whale_prog WHERE tid=${tid}`;
        const sofar = prog.length ? Number(prog[0].total) : 0;
        const eth = (Number(wei) / 1e18).toFixed(9);
        const cap =
          `🐋 *Join the $STAG Whale Room* - hold *${fmt(WHALE_MIN)}+ $STAG*, no wallet connect.\n\n` +
          `1️⃣ From your whale wallet, send *exactly* \`${eth}\` ETH to:\n\`${VERIFY_WALLET}\`\n` +
          "   _(that odd amount is your one-time secret - proves the wallet is yours)_\n" +
          "2️⃣ Then run \`/whale <your-tx-hash>\`\n\n" +
          (sofar > 0 ? `Tally so far: *${fmt(sofar)} / ${fmt(WHALE_MIN)} $STAG*.\n` : "") +
          "💚 *Bag split across wallets?* Repeat this for each - balances add up.\n" +
          "🔒 Your wallets are only *checked*, never stored.";
        // Post the whale art with the instructions as the caption (fallback to text).
        const r = await sendPhotoKeyed(chatId, "whale", () => readFileSync(`${process.cwd()}/assets/trivia/whale.jpg`), cap, replyTo);
        if (!r || r.ok === false) await say(chatId, replyTo, cap);
        return res.status(200).json({ ok: true });
      }
      if (!/^0x[0-9a-f]{64}$/.test(txh)) { await say(chatId, replyTo, "Usage: `/whale` first, then `/whale 0x<txhash>`."); return res.status(200).json({ ok: true }); }
      if ((await s`SELECT 1 FROM stag_whale_used WHERE txhash=${txh}`).length) { await say(chatId, replyTo, "That tx was already counted. Run `/whale` for a fresh amount."); return res.status(200).json({ ok: true }); }
      const reqRow = await s`SELECT wei, created_at FROM stag_whale_req WHERE tid=${tid}`;
      if (!reqRow.length) { await say(chatId, replyTo, "Run `/whale` first to get your unique amount."); return res.status(200).json({ ok: true }); }
      if (Date.now() - new Date(reqRow[0].created_at).getTime() > REQ_TTL) { await say(chatId, replyTo, "That request expired - run `/whale` again."); return res.status(200).json({ ok: true }); }
      let chk;
      try { chk = await verifyMicroDeposit(txh, VERIFY_WALLET, reqRow[0].wei); }
      catch { await say(chatId, replyTo, "⚠️ Network hiccup reading the chain - paste the hash again in a moment."); return res.status(200).json({ ok: true }); }
      if (!chk.ok) { await say(chatId, replyTo, `⚠️ Couldn't match that (${chk.err}). Send the *exact* amount, then paste the confirmed tx hash.`); return res.status(200).json({ ok: true }); }
      if (!chk.blockTime) { await say(chatId, replyTo, "⚠️ Couldn't confirm that deposit's block yet - wait a few seconds and paste the hash again."); return res.status(200).json({ ok: true }); }
      if (chk.blockTime * 1000 < new Date(reqRow[0].created_at).getTime() - 120000) { await say(chatId, replyTo, "⚠️ That deposit predates your request. Run `/whale` for a fresh amount, send it, then paste the hash."); return res.status(200).json({ ok: true }); }
      const usedIns = await s`INSERT INTO stag_whale_used (txhash, tid) VALUES (${txh}, ${tid}) ON CONFLICT (txhash) DO NOTHING RETURNING txhash`;
      if (!usedIns.length) { await say(chatId, replyTo, "That tx was already counted."); return res.status(200).json({ ok: true }); }
      const held = await stagBalanceWhole(chk.from);
      const wh = whHash(chk.from); // hash, so the raw wallet is never stored
      // Already counted this wallet? (UX pre-check; the atomic upsert below is the real guard.)
      const dup = await s`SELECT total FROM stag_whale_prog WHERE tid=${tid} AND wallets @> to_jsonb(${wh}::text)`;
      if (dup.length) {
        await s`DELETE FROM stag_whale_req WHERE tid=${tid}`;
        await say(chatId, replyTo, `🐋 That wallet's already in your tally (*${fmt(Number(dup[0].total))} / ${fmt(WHALE_MIN)} $STAG*). Add a *different* wallet with \`/whale\`.`);
        return res.status(200).json({ ok: true });
      }
      // Atomic add: Postgres serializes concurrent upserts on the same tid via the ON CONFLICT row
      // lock, and the CASE dedup makes a same-wallet double-submit a no-op - so a wallet can never be
      // counted twice, even under two simultaneous /whale <tx> requests for the same wallet.
      const up = await s`
        INSERT INTO stag_whale_prog (tid, total, wallets, updated_at)
        VALUES (${tid}, ${held}, to_jsonb(ARRAY[${wh}]::text[]), now())
        ON CONFLICT (tid) DO UPDATE SET
          total   = CASE WHEN stag_whale_prog.wallets @> to_jsonb(${wh}::text) THEN stag_whale_prog.total ELSE stag_whale_prog.total + ${held} END,
          wallets = CASE WHEN stag_whale_prog.wallets @> to_jsonb(${wh}::text) THEN stag_whale_prog.wallets ELSE stag_whale_prog.wallets || to_jsonb(${wh}::text) END,
          updated_at = now()
        RETURNING total`;
      const total = Number(up[0].total);
      await s`DELETE FROM stag_whale_req WHERE tid=${tid}`;
      if (total < WHALE_MIN) {
        await say(chatId, replyTo, `✅ Wallet counted: *+${fmt(held)} $STAG*.\nTally: *${fmt(total)} / ${fmt(WHALE_MIN)}*.\nNot a whale *yet* - add another wallet with \`/whale\`. 🐋`);
        return res.status(200).json({ ok: true });
      }
      // Whale! But if they're ALREADY in the room, don't mint another link (blocks invite farming -
      // otherwise a whale could re-verify the same bag over and over to hand out links to non-whales).
      try {
        const gm = await tg("getChatMember", { chat_id: WHALE_CHAT, user_id: tid });
        if (gm && gm.ok && ["member", "administrator", "creator"].includes(gm.result.status)) {
          await s`DELETE FROM stag_whale_prog WHERE tid=${tid}`;
          await say(chatId, replyTo, "🐋 You're already in the Whale Room. Antlers up. 🦌");
          return res.status(200).json({ ok: true });
        }
      } catch {}
      // Single-use invite link that only works for them, then wipe their tally.
      let link = null;
      try { const r = await tg("createChatInviteLink", { chat_id: WHALE_CHAT, member_limit: 1, name: `whale-${tid}` }); if (r && r.ok) link = r.result.invite_link; } catch {}
      await s`DELETE FROM stag_whale_prog WHERE tid=${tid}`;
      if (!link) { await say(chatId, replyTo, "🐋 You qualify! But I couldn't mint your invite - make sure I'm an admin in the whale room with invite permission, then run `/whale` again."); return res.status(200).json({ ok: true }); }
      await say(chatId, replyTo, `🐋💚 *WELCOME, WHALE.* Verified *${fmt(total)} $STAG*.\nYour *one-time* invite below works once, only for you. Antlers up. 🦌🏹`);
      await tg("sendMessage", { chat_id: chatId, text: link });
      return res.status(200).json({ ok: true });
    }

    // ---------- trivia game ----------
    if (cmd === "/trivia" || cmd === "/quiz") {
      await settleTriviaWeek(s, chatId);
      const cur = await s`SELECT started_at FROM stag_trivia_active WHERE chat_id=${String(chatId)}`;
      if (cur.length && (Date.now() - new Date(cur[0].started_at).getTime()) < 20 * 1000) {
        await say(chatId, replyTo, "🏹 A question's already live - answer it (A/B/C/D)! Or wait a moment to skip."); return res.status(200).json({ ok: true });
      }
      const idx = await pickQuestion(s, chatId);
      const q = TRIVIA[idx];
      await s`INSERT INTO stag_trivia_active (chat_id, qidx, answer, prev_answer) VALUES (${String(chatId)}, ${idx}, ${q.answer}, ${null}) ON CONFLICT (chat_id) DO UPDATE SET qidx=${idx}, answer=${q.answer}, started_at=now(), miss_shown=false, prev_answer=${null}`;
      await sendTriviaCard(chatId, replyTo, idx, q);
      return res.status(200).json({ ok: true });
    }
    if (cmd === "/triviatop" || cmd === "/tlb" || cmd === "/triviaboard") {
      await settleTriviaWeek(s, chatId);
      const wk = weekKey();
      const rows = await s`SELECT uname, points FROM stag_trivia_score WHERE week=${wk} ORDER BY points DESC, updated_at ASC LIMIT 10`;
      if (!rows.length) { await say(chatId, replyTo, "🏹 No scores yet this week - start with /trivia!"); return res.status(200).json({ ok: true }); }
      const medal = (i) => ["🥇", "🥈", "🥉"][i] || `${i + 1}.`;
      const list = rows.map((r, i) => `${medal(i)} ${r.uname} - *${r.points}*`).join("\n");
      await say(chatId, replyTo, `🏆 *Trivia - this week*\n${list}\n\n⚡ Faster answers score more (bullseye = 10). Miss = -1 point.\n👑 #1 every *Friday* wins *${TRIVIA_REWARD}* $STAG AI credits.\nPlay: /trivia`);
      return res.status(200).json({ ok: true });
    }

    // ---------- video generation (async: queue now, poller delivers) ----------
    if (cmd === "/vid") { // /vid (not /video) to avoid clashing with other bots in group chats
      const scene = arg.slice(0, 400);
      if (!scene) { await say(chatId, replyTo, "🎥 Give me a scene: `/vid the stag firing a glowing arrow off a neon rooftop`"); return res.status(200).json({ ok: true }); }
      if (BANNED.test(scene)) { await say(chatId, replyTo, "🚫 Keep it clean, ranger."); return res.status(200).json({ ok: true }); }
      const owner = isOwnerId(tid); // owner: unlimited, free, no cooldown
      if (VIDEO_COOLDOWN > 0 && !owner) {
        const cr = await s`SELECT last_at FROM stag_cool WHERE tid=${tid}`;
        if (cr.length) { const wait = VIDEO_COOLDOWN - (Date.now() - new Date(cr[0].last_at).getTime()); if (wait > 0) { await say(chatId, replyTo, `⏳ Easy - ${Math.ceil(wait / 1000)}s til your next render.`); return res.status(200).json({ ok: true }); } }
      }
      // Fund: owner free; everyone else pays VIDEO_COST up front (NO free videos).
      let vfunded = owner ? "owner" : null;
      if (!vfunded) {
        if ((await spend(s, tid, VIDEO_COST)) == null) {
          const bal = await balOf(s, tid);
          await say(chatId, replyTo, `🎥 Videos are *${VIDEO_COST}* credits - you have *${bal}*.\nTop up: /buy${(await isVerified(s, tid)) ? "" : "  •  Hold 1M+ for 50% off: /verify"}`);
          return res.status(200).json({ ok: true });
        }
        vfunded = "balance";
      }
      await say(chatId, replyTo, `🎥 Spinning your $STAG video up... it'll drop right here in ~2-4 min. ${owner ? "👑" : `-${VIDEO_COST} credits`} 🏹`);
      // Build the SCENE first (SAME edit path as /image), then animate THAT still - so the
      // video depicts what they asked for, never the bare reference image.
      let qid;
      try {
        const still = await editPfp(`THIS exact character, in this scene: ${scene}.` + IDENTITY_LOCK);
        qid = await queueVideo(still.toString("base64"), `${scene}. Bring the $STAG stag to life: cinematic camera, smooth natural motion, keep his identity (large antlers, green Robin-Hood hood, glowing green eyes). No text.`);
      } catch (e) {
        if (vfunded === "balance") await addCredits(s, tid, VIDEO_COST);
        await say(chatId, replyTo, "⚠️ The render hiccuped - credits refunded. Try again.");
        return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
      }
      await s`INSERT INTO stag_video_jobs (queue_id, tid, chat_id, reply_to, uname, credits, funded, status) VALUES (${qid}, ${tid}, ${String(chatId)}, ${String(replyTo)}, ${uname}, ${owner ? 0 : VIDEO_COST}, ${vfunded}, 'pending') ON CONFLICT (queue_id) DO NOTHING`;
      if (!owner) await s`INSERT INTO stag_cool (tid, last_at) VALUES (${tid}, now()) ON CONFLICT (tid) DO UPDATE SET last_at=now()`;
      return res.status(200).json({ ok: true });
    }

    // ---------- generation: /pfp and /image (both locked to the $STAG character) ----------
    const isPfp = cmd === "/pfp";
    const isGen = cmd === "/image" || cmd === "/gen"; // the $STAG stag dropped into any scene you describe (locked)
    if (!isPfp && !isGen) return res.status(200).json({ ok: true }); // ignore other commands

    const style = isPfp ? arg.slice(0, 200) : "";
    const genPrompt = isGen ? arg.slice(0, 400) : "";
    if (isGen && !genPrompt) { await say(chatId, replyTo, "Give me a scene: `/image the stag on a neon rooftop` — the $STAG character always stars in it"); return res.status(200).json({ ok: true }); }
    if (BANNED.test(style + " " + genPrompt)) { await say(chatId, replyTo, "🚫 Keep it clean, ranger."); return res.status(200).json({ ok: true }); }

    const isOwner = isOwnerId(tid); // owner(s): unlimited, no cooldown, no credit cost

    // cooldown (anti-spam pacing) - owner exempt
    if (COOLDOWN > 0 && !isOwner) {
      const cr = await s`SELECT last_at FROM stag_cool WHERE tid=${tid}`;
      if (cr.length) {
        const wait = COOLDOWN - (Date.now() - new Date(cr[0].last_at).getTime());
        if (wait > 0) { await say(chatId, replyTo, `⏳ Easy - ${Math.ceil(wait / 1000)}s til your next one.`); return res.status(200).json({ ok: true }); }
      }
    }

    const cost = isPfp ? PFP_COST : GEN_COST;
    // Funding: owner is always free/unlimited; else PFP can use the one free-pool grant;
    // otherwise spend paid credits.
    let funded = isOwner ? "owner" : null; // 'owner' | 'pool' | 'balance'
    if (!funded && isPfp) {
      // Atomically claim the one free slot: only the FIRST concurrent request for this
      // tid gets a row back (ON CONFLICT DO NOTHING), so a burst can't pull multiple frees.
      const gotFree = (await s`INSERT INTO stag_free (tid, used) VALUES (${tid}, 1) ON CONFLICT (tid) DO NOTHING RETURNING tid`).length > 0;
      if (gotFree) {
        if ((await reservePool(s, cost)) != null) funded = "pool";
        else await s`DELETE FROM stag_free WHERE tid=${tid}`; // pool empty → release the slot for later
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
        // /image: the $STAG character dropped into the user scene, identity ALWAYS locked.
        const prompt = `THIS exact character, in this scene: ${genPrompt}.` + IDENTITY_LOCK;
        png = await editPfp(prompt);
        caption = `🎨 ${uname} (as the stag) 🏹\n"${genPrompt.slice(0, 120)}"`;
      }
      const tag = funded === "owner" ? "👑" : funded === "pool" ? "🎁 that was your free one" : `-${cost} credits`;
      await sendPhoto(chatId, png, caption + `\n\n${tag}  •  another? /pfp /image  •  /credits`, replyTo);
      // Image is delivered — post-delivery bookkeeping must NEVER fall into the refund
      // catch, or a DB hiccup here would hand back the free slot / credits AFTER the user
      // already got the image (a path to a 2nd free). Swallow logging errors instead.
      try { await s`INSERT INTO stag_log (tid, uname, kind, credits) VALUES (${tid}, ${uname}, ${isPfp ? "pfp" : "gen"}, ${funded === "owner" ? 0 : cost})`; } catch {}
      return res.status(200).json({ ok: true });
    } catch (e) {
      // refund whatever funded it (owner paid nothing). Pool refund releases the free
      // slot entirely (DELETE) so the user can re-claim it - the grant is now claim-once.
      if (funded === "pool") { await refundPool(s, cost); await s`DELETE FROM stag_free WHERE tid=${tid}`; }
      else if (funded === "balance") { await addCredits(s, tid, cost); }
      if (!isOwner) await s`DELETE FROM stag_cool WHERE tid=${tid}`; // failed run shouldn't burn their cooldown
      await say(chatId, replyTo, "⚠️ The forge hiccuped - no credits spent. Try again.");
      return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
    }
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
