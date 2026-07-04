// CATBOY — pump.fun Telegram buy bot.
//
// Streams live trades for your token from PumpPortal's public WebSocket and
// posts a buy alert (with a GIF) to your Telegram chat on every buy over the
// threshold. No paid API needed. Runs anywhere Node 18+ runs (your DO box).
//
// Configure with a .env file (see .env.example) or real env vars.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- minimal .env loader (no dependency) --------------------------------
async function loadEnv() {
  try {
    const txt = await fs.readFile(path.join(__dirname, ".env"), "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch { /* no .env file — rely on real env vars */ }
}
await loadEnv();

const CFG = {
  token: process.env.TELEGRAM_BOT_TOKEN || "",
  chatId: process.env.TELEGRAM_CHAT_ID || "",
  mint: process.env.TOKEN_MINT || "",
  minBuySol: parseFloat(process.env.MIN_BUY_SOL || "0.05"),
  emoji: process.env.BUY_EMOJI || "🐾",
  media: process.env.BUY_MEDIA || path.join(__dirname, "media", "buy.mp4"), // local path or http(s) URL (mp4 or gif)
  ticker: process.env.TOKEN_TICKER || "CATBOY",
  ws: process.env.PUMPPORTAL_WS || "wss://pumpportal.fun/api/data",
  site: process.env.SITE_URL || "https://www.catboyonsol.fun",
  emojiStepSol: parseFloat(process.env.EMOJI_STEP_SOL || "0.1"), // one emoji per this many SOL
  emojiMax: parseInt(process.env.EMOJI_MAX || "96", 10),
};

const API = `https://api.telegram.org/bot${CFG.token}`;
const log = (...a) => console.log(new Date().toISOString(), ...a);

if (!CFG.token || !CFG.chatId) { console.error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID"); process.exit(1); }
if (!CFG.mint) log("WARNING: TOKEN_MINT not set yet — set it at launch and restart. Waiting anyway.");

// ---- SOL/USD price (cached 5 min, best-effort) --------------------------
let _price = { usd: 0, at: 0 };
async function solPrice() {
  if (_price.usd && Date.now() - _price.at < 300000) return _price.usd;
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const j = await r.json();
    if (j?.solana?.usd) { _price = { usd: j.solana.usd, at: Date.now() }; }
  } catch {}
  return _price.usd;
}

// ---- Telegram senders ---------------------------------------------------
async function tgSendMessage(text) {
  try {
    await fetch(`${API}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CFG.chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch (e) { log("tgSendMessage error", e.message); }
}

let _cachedFileId = null; // reuse the uploaded GIF so we only upload once
async function tgSendBuy(caption) {
  try {
    const isUrl = /^https?:\/\//i.test(CFG.media);
    if (isUrl || _cachedFileId) {
      const r = await fetch(`${API}/sendAnimation`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CFG.chatId, animation: _cachedFileId || CFG.media, caption, parse_mode: "HTML" }),
      });
      const j = await r.json();
      if (j.ok && j.result?.animation?.file_id) _cachedFileId = j.result.animation.file_id;
      if (!j.ok) throw new Error(j.description || "sendAnimation failed");
      return;
    }
    // upload the local GIF (multipart)
    const buf = await fs.readFile(CFG.media);
    const ext = CFG.media.toLowerCase().endsWith(".gif") ? "gif" : "mp4";
    const type = ext === "gif" ? "image/gif" : "video/mp4";
    const fd = new FormData();
    fd.set("chat_id", CFG.chatId);
    fd.set("caption", caption);
    fd.set("parse_mode", "HTML");
    fd.set("animation", new Blob([buf], { type }), "buy." + ext);
    const r = await fetch(`${API}/sendAnimation`, { method: "POST", body: fd });
    const j = await r.json();
    if (j.ok && j.result?.animation?.file_id) _cachedFileId = j.result.animation.file_id;
    if (!j.ok) throw new Error(j.description || "sendAnimation failed");
  } catch (e) {
    log("tgSendBuy error", e.message, "— falling back to text");
    await tgSendMessage(caption);
  }
}

// ---- formatting ---------------------------------------------------------
const short = (a) => (a ? a.slice(0, 4) + "…" + a.slice(-4) : "");
const fmt = (n, d = 2) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: d });
function emojiBar(sol) {
  const n = Math.max(3, Math.min(CFG.emojiMax, Math.round(sol / CFG.emojiStepSol)));
  return CFG.emoji.repeat(n);
}

async function onBuy(t) {
  const sol = Number(t.solAmount ?? t.sol_amount ?? 0);
  if (!sol || sol < CFG.minBuySol) return;
  const tokens = Number(t.tokenAmount ?? t.token_amount ?? 0);
  const mcSol = Number(t.marketCapSol ?? t.market_cap_sol ?? 0);
  const buyer = t.traderPublicKey || t.trader || t.owner || "";
  const sig = t.signature || "";
  const px = await solPrice();
  const usd = px ? sol * px : 0;
  const mcUsd = px && mcSol ? mcSol * px : 0;
  const isNew = (t.newTokenBalance != null && tokens && Math.abs(Number(t.newTokenBalance) - tokens) < 1);

  const lines = [];
  lines.push(`<b>${CFG.ticker} Buy!</b> ${isNew ? "🆕" : ""}`);
  lines.push(emojiBar(sol));
  lines.push("");
  lines.push(`💵 <b>${fmt(sol, 3)} SOL</b>${usd ? ` ($${fmt(usd)})` : ""}`);
  if (tokens) lines.push(`🪙 Got <b>${fmt(tokens, 0)} ${CFG.ticker}</b>`);
  if (mcSol) lines.push(`📊 Market Cap: <b>${mcUsd ? "$" + fmt(mcUsd) : fmt(mcSol, 1) + " SOL"}</b>`);
  if (buyer) lines.push(`👤 <a href="https://solscan.io/account/${buyer}">${short(buyer)}</a>${isNew ? " · new holder" : ""}`);
  const links = [];
  if (sig) links.push(`<a href="https://solscan.io/tx/${sig}">TX</a>`);
  if (CFG.mint) links.push(`<a href="https://pump.fun/coin/${CFG.mint}">Pump.fun</a>`);
  if (CFG.mint) links.push(`<a href="https://dexscreener.com/solana/${CFG.mint}">Chart</a>`);
  links.push(`<a href="${CFG.site}">Website</a>`);
  lines.push(links.join(" · "));

  await tgSendBuy(lines.join("\n"));
  log(`BUY ${fmt(sol, 3)} SOL${usd ? " ($" + fmt(usd) + ")" : ""} by ${short(buyer)}`);
}

// ---- PumpPortal WebSocket (auto-reconnect) ------------------------------
const seen = new Set(); // signature dedupe
let ws, backoff = 1000;

function connect() {
  log("connecting to PumpPortal…");
  ws = new WebSocket(CFG.ws);

  ws.on("open", () => {
    backoff = 1000;
    log("connected. subscribing to token trades:", CFG.mint || "(no mint set)");
    if (CFG.mint) ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [CFG.mint] }));
  });

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.message || msg.errors) return; // subscription ack / errors
    const trades = Array.isArray(msg) ? msg : [msg];
    for (const t of trades) {
      if (!t || t.mint !== CFG.mint) continue;
      const type = (t.txType || t.type || "").toLowerCase();
      if (type !== "buy") continue;
      if (t.signature && seen.has(t.signature)) continue;
      if (t.signature) { seen.add(t.signature); if (seen.size > 5000) seen.clear(); }
      onBuy(t).catch((e) => log("onBuy error", e.message));
    }
  });

  ws.on("close", () => { log("socket closed — reconnecting in", backoff, "ms"); scheduleReconnect(); });
  ws.on("error", (e) => { log("socket error", e.message); try { ws.close(); } catch {} });
}
function scheduleReconnect() {
  setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 30000);
}

// allow changing the mint at runtime without a redeploy: TOKEN_MINT via SIGHUP reload
process.on("SIGHUP", async () => { await loadEnv(); CFG.mint = process.env.TOKEN_MINT || CFG.mint; log("reloaded env; mint =", CFG.mint); try { ws.close(); } catch {} });

log(`CATBOY buy bot starting — token=${CFG.ticker} mint=${CFG.mint || "(unset)"} minBuy=${CFG.minBuySol} SOL`);
tgSendMessage(`🐾 <b>${CFG.ticker} buy bot online.</b> Watching for buys ≥ ${CFG.minBuySol} SOL.`);
connect();
