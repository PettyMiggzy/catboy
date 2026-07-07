// $CATBOY AI — in-chat image/video generation (Telegram side).
//   /img <prompt>   -> charge credits, generate a Catboy image, post in-chat
//   /vid <prompt>   -> (if enabled) charge credits, animate a Catboy clip
//   /credits        -> DM a top-up link (buy credits with $CATBOY)
//   /balance        -> show the user's credit balance
//   /ban  (reply)   -> admin: ban the user who made that generation + delete it
//   /aistats        -> admin: usage + provider health
//
// Every generation posts in the group so mods can watch. Refund on failure,
// per-user cooldown, prompt bl&#8203;ocklist, low-balance alert to the dev.
//
// SECRECY: the AI provider, base URL, and model ids are read from env ONLY —
// never hardcoded — so this public repo reveals no source. Set on the droplet:
//   AI_PROVIDER_KEY, AI_PROVIDER_BASE, AI_IMAGE_MODEL, AI_VIDEO_MODEL
// Plus: DATABASE_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TOKEN_MINT,
//   AI_SECRET (matches the site), AI_SITE, AI_IMG_PRICE_CENTS(=30),
//   AI_VID_PRICE_CENTS(=150), AI_COOLDOWN_SEC(=20), AI_ENABLE_VIDEO,
//   AI_LOW_BALANCE_USD(=10), ADMIN_CHAT_ID / NOTIFY_CHAT_ID.
import { neon } from "@neondatabase/serverless";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Load .env from this file's dir BEFORE reading the constants below (ESM
// imports evaluate before the importer's body; standalone runs load nothing).
try {
  const _dir = path.dirname(fileURLToPath(import.meta.url));
  for (const line of readFileSync(path.join(_dir, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
} catch { /* rely on real env */ }

const CONN = (process.env.DATABASE_URL || process.env.POSTGRES_URL || "").trim();
const SECRET = (process.env.AI_SECRET || "").trim();
const SITE = (process.env.AI_SITE || "https://www.catboyonsol.fun").replace(/\/$/, "");
const AI_KEY = (process.env.AI_PROVIDER_KEY || "").trim();
const AI_BASE = (process.env.AI_PROVIDER_BASE || "").replace(/\/$/, "").trim();
const IMG_MODEL = (process.env.AI_IMAGE_MODEL || "").trim();
const VID_MODEL = (process.env.AI_VIDEO_MODEL || "").trim();
const IMG_CENTS = Math.max(1, parseInt(process.env.AI_IMG_PRICE_CENTS || "30", 10));
const VID_CENTS = Math.max(1, parseInt(process.env.AI_VID_PRICE_CENTS || "150", 10));
const COOLDOWN = Math.max(0, parseInt(process.env.AI_COOLDOWN_SEC || "20", 10)) * 1000;
const VIDEO_ON = /^(1|true|on|yes)$/i.test(process.env.AI_ENABLE_VIDEO || "");
const LOW_BAL_USD = Math.max(0, parseFloat(process.env.AI_LOW_BALANCE_USD || "10"));

const sql = () => (CONN ? neon(CONN) : null);
const hmac = (d) => crypto.createHmac("sha256", SECRET).update(d).digest("hex");
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const usd = (cents) => "$" + (cents / 100).toFixed(2);

// Locked character prompt — every generation is OUR Catboy, users set the scene.
const CATBOY_DNA =
  "masterpiece anime illustration of CATBOY, a young man with messy spiky blonde hair, " +
  "fluffy tan cat ears with white fur inside, glowing electric-blue eyes, wearing a black " +
  "cyberpunk bomber jacket with glowing cyan and magenta neon trim and a silver Solana chain necklace. ";
const CATBOY_TAIL =
  ". consistent character design, vibrant cyan magenta and gold palette, cinematic dramatic " +
  "lighting, ultra detailed, safe for work, no text no words no watermark.";

// Prompt moderation — reject before spending a credit. Keep it broad/simple.
const BLOCK = /\b(nsfw|nude|naked|nudes|porn|sex|sexual|hentai|rape|underage|loli|shota|cp|child|kids?\s+(nude|sex)|gore|behead|corpse|nazi|hitler|swastika|isis|terror|bomb\s+making|kill\s+(yourself|myself)|suicide)\b/i;
const looksBad = (p) => BLOCK.test(p);

const cooldowns = new Map(); // tid -> last ms
let _lowBalPinged = 0;

// -------- DB --------
async function ensure(s) {
  await s`CREATE TABLE IF NOT EXISTS ai_credits (tid TEXT PRIMARY KEY, balance_cents BIGINT NOT NULL DEFAULT 0, spent_cents_month BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE TABLE IF NOT EXISTS ai_gens (id BIGSERIAL PRIMARY KEY, tid TEXT NOT NULL, kind TEXT NOT NULL, prompt TEXT, cost_cents BIGINT NOT NULL, status TEXT NOT NULL, tg_msg_id BIGINT, chat_id TEXT, created_at TIMESTAMPTZ DEFAULT now())`;
}
async function balanceOf(s, tid) {
  const r = await s`SELECT balance_cents FROM ai_credits WHERE tid=${tid}`;
  return r.length ? Number(r[0].balance_cents) : 0;
}
async function charge(s, tid, cents) {
  const r = await s`UPDATE ai_credits SET balance_cents = balance_cents - ${cents}, spent_cents_month = spent_cents_month + ${cents}, updated_at=now()
                    WHERE tid=${tid} AND balance_cents >= ${cents} RETURNING balance_cents`;
  return r.length ? Number(r[0].balance_cents) : null; // null = insufficient
}
async function refund(s, tid, cents) {
  await s`UPDATE ai_credits SET balance_cents = balance_cents + ${cents}, spent_cents_month = GREATEST(0, spent_cents_month - ${cents}), updated_at=now() WHERE tid=${tid}`;
}

// -------- provider (details all from env) --------
async function providerJSON(pathname, body) {
  const r = await fetch(AI_BASE + pathname, {
    method: "POST",
    headers: { Authorization: "Bearer " + AI_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); const e = new Error("provider_" + r.status); e.status = r.status; e.body = t; throw e; }
  return r.json();
}
// image -> returns a Buffer (PNG)
async function genImage(prompt) {
  const d = await providerJSON("/image/generate", {
    model: IMG_MODEL, prompt: CATBOY_DNA + prompt + CATBOY_TAIL,
    width: 1024, height: 1024, format: "png", safe_mode: true,
  });
  const b64 = (d.images || [])[0];
  if (!b64) throw new Error("no_image");
  return Buffer.from(b64, "base64");
}
// video -> generate the still, animate it, return a Buffer (MP4)
async function genVideo(prompt) {
  const still = await genImage(prompt);
  const q = await providerJSON("/video/queue", {
    model: VID_MODEL,
    prompt: "Bring the catboy to life with dynamic motion and action: " + prompt + ". cinematic camera, epic.",
    image_url: "data:image/png;base64," + still.toString("base64"),
    duration: "5s",
  });
  const qid = q.queue_id;
  if (!qid) throw new Error("queue_failed");
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 8000));
    const rr = await fetch(AI_BASE + "/video/retrieve", {
      method: "POST", headers: { Authorization: "Bearer " + AI_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model: VID_MODEL, queue_id: qid }),
    });
    const ct = rr.headers.get("content-type") || "";
    if (ct.includes("video/mp4")) return Buffer.from(await rr.arrayBuffer());
    if (ct.includes("json")) { const j = await rr.json().catch(() => ({})); if (j.download_url) { const v = await fetch(j.download_url); return Buffer.from(await v.arrayBuffer()); } }
  }
  throw new Error("video_timeout");
}

// -------- telegram media (multipart upload of raw bytes) --------
async function sendMedia(API, chatId, kind, buf, caption) {
  const field = kind === "vid" ? "video" : "photo";
  const method = kind === "vid" ? "sendVideo" : "sendPhoto";
  const fname = kind === "vid" ? "catboy.mp4" : "catboy.png";
  const type = kind === "vid" ? "video/mp4" : "image/png";
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append(field, new Blob([buf], { type }), fname);
  const r = await fetch(`${API}/${method}`, { method: "POST", body: form });
  const j = await r.json();
  if (!j.ok) throw new Error(j.description || "send_failed");
  return j.result?.message_id;
}

async function pingLowBalance(ctx, why) {
  const admin = (process.env.NOTIFY_CHAT_ID || process.env.ADMIN_CHAT_ID || "").trim();
  const now = Date.now();
  if (now - _lowBalPinged < 3600000) return; // once/hour
  _lowBalPinged = now;
  const msg = `⚠️ <b>$CATBOY AI needs funds</b> — ${why}. Generations are failing/refunding until topped up.`;
  try { await ctx.tgSendTo(ctx.CHAT_ID, msg); } catch {}
  if (admin) { try { await ctx.tgSendTo(admin, msg); } catch {} }
}

// -------- main handler --------
export async function aiCommand(cmd, arg, m, ctx) {
  const { API, tgSendTo, isAdmin, log } = ctx;
  const s = sql();
  const tid = String(m.from?.id || "");
  const chat = m.chat || {};
  const reply = (t) => tgSendTo(chat.id, t);

  if (!s) return reply("🐾 $CATBOY AI isn't configured yet.");
  await ensure(s);

  // ----- /balance -----
  if (cmd === "/balance") {
    const bal = await balanceOf(s, tid);
    return reply(`💳 <b>Your $CATBOY AI credits:</b> ${usd(bal)}\n≈ ${Math.floor(bal / IMG_CENTS)} images · top up with /credits`);
  }

  // ----- /credits (DM a signed top-up link) -----
  if (cmd === "/credits" || cmd === "/topup" || cmd === "/buycredits") {
    if (!SECRET) return reply("Top-ups aren't configured yet.");
    const t = Date.now().toString();
    const link = `${SITE}/credits.html?tid=${tid}&t=${t}&h=${hmac(`${tid}.${t}`)}`;
    const dm = await tgSendTo(tid, `💳 <b>Load $CATBOY AI credits</b>\nTap to top up with $CATBOY (secure, one wallet signature):\n${link}\n\nCredits never expire. Hold $CATBOY for monthly rebates. 🐾`).catch(() => null);
    if (dm && dm.ok !== false) { if (chat.type !== "private") return reply("📩 Sent you a DM with your top-up link. 🐾"); return; }
    const bu = ctx.botUsername ? `https://t.me/${ctx.botUsername}` : "";
    return reply(`Start a chat with me first, then send <b>/credits</b> again.${bu ? ` 👉 <a href="${bu}">Open bot</a>` : ""}`);
  }

  // ----- /aistats (admin) -----
  if (cmd === "/aistats") {
    if (!isAdmin(m)) return;
    const day = (await s`SELECT count(*)::int c, coalesce(sum(cost_cents),0)::bigint rev FROM ai_gens WHERE status='ok' AND created_at > now() - interval '1 day'`)[0];
    const users = (await s`SELECT count(*)::int c, coalesce(sum(balance_cents),0)::bigint bal FROM ai_credits`)[0];
    return reply(`📊 <b>$CATBOY AI</b>\nLast 24h: <b>${day.c}</b> gens · rev <b>${usd(Number(day.rev))}</b>\nUsers: <b>${users.c}</b> · outstanding credits <b>${usd(Number(users.bal))}</b>\nVideo: <b>${VIDEO_ON ? "ON" : "OFF"}</b>`);
  }

  // ----- /ban (admin, reply to a generation) -----
  if (cmd === "/ban") {
    if (!isAdmin(m)) return;
    const rm = m.reply_to_message;
    if (!rm) return reply("Reply to a generated image with /ban to remove its creator.");
    const row = (await s`SELECT tid FROM ai_gens WHERE tg_msg_id=${rm.message_id} AND chat_id=${String(chat.id)}`)[0];
    const target = row?.tid || String(rm.from?.id || "");
    if (!target) return reply("Couldn't find who made that.");
    try {
      await fetch(`${API}/banChatMember`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat.id, user_id: Number(target) }) });
      await fetch(`${API}/deleteMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat.id, message_id: rm.message_id }) });
    } catch (e) { log && log("ai ban error", e.message); }
    return reply("🔨 Banned and removed.");
  }

  // ----- /img and /vid -----
  const isVid = cmd === "/vid";
  if (cmd !== "/img" && !isVid) return;
  if (isVid && !VIDEO_ON) return reply("🎬 Video is coming soon. Use /img for now. 🐾");
  if (chat.type === "private") return reply("Use /img in the group so everyone can see your Catboy. 🐾");
  if (!AI_KEY || !AI_BASE || !(isVid ? VID_MODEL : IMG_MODEL)) return reply("🐾 $CATBOY AI isn't configured yet.");

  const prompt = (arg || "").trim();
  if (!prompt) return reply(`Add a scene! e.g. <code>${cmd} riding a dragon over the city</code>`);
  if (prompt.length > 400) return reply("Keep it under 400 characters. ✂️");
  if (looksBad(prompt)) return reply("🚫 That prompt isn't allowed. Keep it SFW. 🐾");

  const now = Date.now();
  const last = cooldowns.get(tid) || 0;
  if (now - last < COOLDOWN) return reply(`⏳ Slow down — try again in ${Math.ceil((COOLDOWN - (now - last)) / 1000)}s.`);

  const cost = isVid ? VID_CENTS : IMG_CENTS;
  const left = await charge(s, tid, cost);
  if (left === null) {
    const bal = await balanceOf(s, tid);
    return reply(`💳 Not enough credits — you have ${usd(bal)}, need ${usd(cost)}. Top up with /credits 🐾`);
  }
  cooldowns.set(tid, now);

  const who = m.from?.username ? "@" + m.from.username : (m.from?.first_name || "someone");
  await reply(isVid ? "🎬 Animating your Catboy… (~1–2 min)" : "🎨 Painting your Catboy…");

  try {
    const buf = isVid ? await genVideo(prompt) : await genImage(prompt);
    const caption = `🐾 <b>${esc(who)}</b>: <i>${esc(prompt)}</i>\n— made with $CATBOY AI`;
    const msgId = await sendMedia(API, chat.id, isVid ? "vid" : "img", buf, caption);
    await s`INSERT INTO ai_gens (tid, kind, prompt, cost_cents, status, tg_msg_id, chat_id) VALUES (${tid}, ${isVid ? "vid" : "img"}, ${prompt}, ${cost}, 'ok', ${msgId || null}, ${String(chat.id)})`;
  } catch (e) {
    await refund(s, tid, cost);
    await s`INSERT INTO ai_gens (tid, kind, prompt, cost_cents, status, chat_id) VALUES (${tid}, ${isVid ? "vid" : "img"}, ${prompt}, ${cost}, 'refunded', ${String(chat.id)})`;
    log && log("ai gen fail", e.status || "", e.message, (e.body || "").slice(0, 160));
    if (e.status === 402 || /insufficient|balance|quota/i.test(e.body || "")) await pingLowBalance({ tgSendTo, CHAT_ID: ctx.CHAT_ID }, "provider balance low");
    return reply("😿 That one didn't work — you were <b>not</b> charged. Try again.");
  }
}
