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
  emoji: process.env.BUY_EMOJI || "❤️",
  media: process.env.BUY_MEDIA || path.join(__dirname, "media", "buy.mp4"), // local path or http(s) URL (mp4 or gif)
  ticker: process.env.TOKEN_TICKER || "CATBOY",
  ws: process.env.PUMPPORTAL_WS || "wss://pumpportal.fun/api/data",
  site: process.env.SITE_URL || "https://www.catboyonsol.fun",
  emojiStepSol: parseFloat(process.env.EMOJI_STEP_SOL || "0.1"), // one emoji per this many SOL
  emojiMax: parseInt(process.env.EMOJI_MAX || "96", 10),
  // DexScreener: real price/mcap + "chart live" / "graduated" / milestone alerts
  dexApi: process.env.DEXSCREENER_API || "https://api.dexscreener.com/latest/dex/tokens/",
  dexPollMs: Math.max(15000, parseInt(process.env.DEX_POLL_MS || "30000", 10)),
  announceMigration: (process.env.ANNOUNCE_MIGRATION ?? "1") !== "0",
  milestones: (process.env.MCAP_MILESTONES ?? "10000,25000,50000,100000,250000,500000,1000000")
    .split(",").map((s) => parseFloat(s.trim())).filter((n) => n > 0).sort((a, b) => a - b),
  // Launch auto-detect: watch pump.fun's new-token stream and grab the mint the
  // instant it's created — no manual TOKEN_MINT needed at launch.
  creator: (process.env.CREATOR_WALLET || "").trim(), // the wallet that will create the token (most reliable match)
  matchSymbol: (process.env.MATCH_SYMBOL || "").trim().toUpperCase(), // fallback match by ticker symbol
  notifyChatId: (process.env.NOTIFY_CHAT_ID || "").trim(), // your personal chat for a priority "BUY NOW" ping
  adminId: (process.env.ADMIN_CHAT_ID || process.env.NOTIFY_CHAT_ID || "").trim(), // who can run /setmint etc.
  // AI chat personality (optional, cheap/free — e.g. Groq). Off unless LLM_API_KEY is set.
  llmKey: (process.env.LLM_API_KEY || "").trim(),
  llmBase: process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1/chat/completions", // OpenAI-compatible
  llmModel: process.env.LLM_MODEL || "llama-3.3-70b-versatile",
  replyChance: Math.min(1, Math.max(0, parseFloat(process.env.REPLY_CHANCE || "0.06"))), // odds of chiming in on a random post
  llmMaxPerMin: parseInt(process.env.LLM_MAX_PER_MIN || "6", 10), // spam/cost guard
  // Burn detection: poll supply, announce when it drops.
  rpcUrl: process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
  burnPollMs: Math.max(30000, parseInt(process.env.BURN_POLL_MS || "60000", 10)),
  announceBurns: (process.env.ANNOUNCE_BURNS ?? "1") !== "0",
  // On-chain buy detection via YOUR RPC — reliable primary source (PumpPortal's
  // free WS drops trades). Polls the mint's recent signatures and parses buys.
  useChain: (process.env.USE_CHAIN_TRADES ?? "1") !== "0",
  chainPollMs: Math.max(3000, parseInt(process.env.CHAIN_POLL_MS || "5000", 10)),
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
async function tgSendTo(chatId, text) {
  if (!chatId) return;
  try {
    await fetch(`${API}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch (e) { log("tgSend error", e.message); }
}
const tgSendMessage = (text) => tgSendTo(CFG.chatId, text);
async function tgReplyTo(chatId, msgId, text) {
  try {
    await fetch(`${API}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, reply_to_message_id: msgId, parse_mode: "HTML", disable_web_page_preview: true, allow_sending_without_reply: true }),
    });
  } catch (e) { log("tgReply error", e.message); }
}

// ---- bot identity (for @mention / reply detection) ----------------------
let botId = 0, botUsername = "";
async function getMe() {
  try { const j = await (await fetch(`${API}/getMe`)).json(); if (j.ok) { botId = j.result.id; botUsername = (j.result.username || "").toLowerCase(); log("bot identity:", "@" + botUsername); } } catch {}
}

// ---- AI chat personality (optional; OpenAI-compatible, e.g. Groq) --------
const PERSONA =
  "You are Catboy, the mascot of $CATBOY — a meme coin on Solana. You're a witty, " +
  "playful, degen cat-boy with cattitude and big community-hype energy. Reply SHORT " +
  "(1-2 sentences), fun and meme-y, casual lowercase vibe, an occasional 🐾. Hype the " +
  "holders and the raids. NEVER give financial advice, never predict or promise price, " +
  "never share links unless asked. If you don't know something, be funny about it. Stay in character.";
const _replyTimes = [];
function llmRateOk() {
  const now = Date.now();
  while (_replyTimes.length && now - _replyTimes[0] > 60000) _replyTimes.shift();
  if (_replyTimes.length >= CFG.llmMaxPerMin) return false;
  _replyTimes.push(now); return true;
}
function addressedToBot(m) {
  if (m.reply_to_message && m.reply_to_message.from && m.reply_to_message.from.id === botId) return true;
  const t = (m.text || "").toLowerCase();
  if (botUsername && t.includes("@" + botUsername)) return true;
  if (/\bcatboy\b/i.test(m.text || "")) return true; // name-drop
  return false;
}
async function llmReply(userText, name) {
  if (!CFG.llmKey) return null;
  try {
    const r = await fetch(CFG.llmBase, {
      method: "POST",
      headers: { Authorization: "Bearer " + CFG.llmKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CFG.llmModel, max_tokens: 120, temperature: 0.9,
        messages: [{ role: "system", content: PERSONA }, { role: "user", content: `${name}: ${userText}` }],
      }),
    });
    const j = await r.json();
    const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    return txt ? String(txt).trim().slice(0, 500) : null;
  } catch (e) { log("llm error", e.message); return null; }
}
async function handleChat(m) {
  if (!CFG.llmKey || !m.text) return;
  if (m.from && m.from.is_bot) return;
  const inGroup = m.chat && (m.chat.type === "group" || m.chat.type === "supergroup");
  if (inGroup && CFG.chatId && String(m.chat.id) !== String(CFG.chatId)) return; // only our group
  const addressed = addressedToBot(m);
  if (!addressed && Math.random() >= CFG.replyChance) return; // sometimes chime in
  if (!llmRateOk()) return;
  try { fetch(`${API}/sendChatAction`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: m.chat.id, action: "typing" }) }); } catch {}
  const who = (m.from && (m.from.first_name || m.from.username)) || "anon";
  const reply = await llmReply(m.text, who);
  if (reply) await tgReplyTo(m.chat.id, m.message_id, reply);
}

// ---- burn detection (supply drop -> announce) ---------------------------
let _lastSupply = null;
async function solRpc(method, params) {
  try {
    const r = await fetch(CFG.rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json(); return j.result;
  } catch { return null; }
}
async function checkBurns() {
  if (!CFG.mint || !CFG.announceBurns) return;
  const s = await solRpc("getTokenSupply", [CFG.mint]);
  const ui = s && s.value ? Number(s.value.uiAmount) : NaN;
  if (!isFinite(ui) || ui <= 0) return;
  if (_lastSupply == null) { _lastSupply = ui; return; } // prime silently
  if (ui < _lastSupply - 1) {
    const burned = _lastSupply - ui;
    const pct = burned / _lastSupply * 100;
    _lastSupply = ui;
    await tgSendMessage(`🔥🔥 <b>${fmt(burned, 0)} ${CFG.ticker} BURNED!</b> (${pct >= 0.01 ? pct.toFixed(2) : "<0.01"}% of supply)\nSupply now <b>${fmt(ui, 0)}</b>. Deflationary cattitude 🐾🔥`);
    log("burn announced:", burned);
  } else if (ui > _lastSupply) { _lastSupply = ui; } // mint/rebase — just track
}

// ---- Telegram command listener (long-poll getUpdates) -------------------
// Lets the owner DM the bot to control it at launch — most importantly
// `/setmint <CA>` to lock onto the token the instant it's live.
let _updOffset = 0;
function isAdmin(m) {
  const ids = [CFG.notifyChatId, CFG.adminId].filter(Boolean).map(String);
  if (!ids.length) return false;
  return ids.includes(String(m.chat && m.chat.id)) || ids.includes(String(m.from && m.from.id));
}
async function handleCommand(m) {
  const text = (m.text || "").trim();
  if (!text.startsWith("/")) return;
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/@.*$/, ""); // strip @botname
  const arg = (parts[1] || "").trim();
  if (cmd === "/start" || cmd === "/help" || cmd === "/id") {
    return tgSendTo(m.chat.id,
      `🐾 <b>${CFG.ticker} bot</b>\nYour chat id: <code>${m.chat.id}</code>` +
      `\n\nOwner commands (from your NOTIFY chat):\n` +
      `<code>/setmint &lt;CA&gt;</code> — lock onto the token at launch\n` +
      `<code>/status</code> — show current state`);
  }
  if (!isAdmin(m)) return; // only the owner can run the rest
  if (cmd === "/setmint" || cmd === "/mint" || cmd === "/launch") {
    if (!MINT_RE.test(arg)) return tgSendTo(m.chat.id, "⚠️ Usage: <code>/setmint &lt;contract address&gt;</code>");
    const ok = await armToken(arg, "manual");
    return tgSendTo(m.chat.id, ok ? `✅ Locked on <code>${arg}</code> — buy alerts are live.` : `Already tracking <code>${CFG.mint}</code>.`);
  }
  if (cmd === "/status") {
    return tgSendTo(m.chat.id,
      `mint: ${CFG.mint ? "<code>" + CFG.mint + "</code>" : "(unset — waiting)"}\n` +
      `watching: ${watchingNewTokens() ? "symbol " + (CFG.matchSymbol || "-") + (CFG.creator ? ", creator set" : "") : "—"}\n` +
      `minBuy: ${CFG.minBuySol} SOL\n` +
      `AI chat: ${CFG.llmKey ? "on (" + CFG.llmModel + ")" : "off"}\n` +
      `burn alerts: ${CFG.announceBurns ? "on" : "off"}`);
  }
}
async function pollUpdates() {
  if (!CFG.token) return;
  try {
    const r = await fetch(`${API}/getUpdates?timeout=25&offset=${_updOffset}`);
    const j = await r.json();
    if (j.ok) for (const u of j.result) {
      _updOffset = u.update_id + 1;
      const m = u.message;
      if (!m || !m.text) continue;
      if (m.text.startsWith("/")) await handleCommand(m).catch((e) => log("cmd error", e.message));
      else await handleChat(m).catch((e) => log("chat error", e.message)); // AI reactions
    }
    setTimeout(pollUpdates, 200);
  } catch (e) { setTimeout(pollUpdates, 3000); }
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
const usd0 = (n) => "$" + fmt(n, 0);
function chartUrl() { return dex.pairUrl || `https://dexscreener.com/solana/${CFG.mint}`; }

// ---- DexScreener (real price/mcap + chart-live / graduation / milestones) --
// PumpPortal is the live per-trade feed (bonding curve AND post-graduation).
// DexScreener is polled for accurate USD numbers and lifecycle events. It has
// no public per-trade stream, so it enriches — it doesn't replace — the WS feed.
const MAJOR_DEXES = new Set(["raydium", "raydium-clmm", "pumpswap", "meteora", "orca", "fluxbeam"]);
let dex = { at: 0, priceUsd: 0, marketCap: 0, liqUsd: 0, vol24: 0, pairUrl: "", dexId: "", pairs: 0 };
let dexPrimed = false, dexLiveAnnounced = false, migratedAnnounced = false;
let milestonesHit = new Set();

function resetDexState() {
  dex = { at: 0, priceUsd: 0, marketCap: 0, liqUsd: 0, vol24: 0, pairUrl: "", dexId: "", pairs: 0 };
  dexPrimed = false; dexLiveAnnounced = false; migratedAnnounced = false; milestonesHit = new Set();
}

async function refreshDex() {
  if (!CFG.mint) return dex;
  let pairs = [];
  try {
    const r = await fetch(CFG.dexApi + CFG.mint, { headers: { accept: "application/json" } });
    if (r.ok) {
      const j = await r.json();
      pairs = Array.isArray(j?.pairs) ? j.pairs.filter((p) => p?.chainId === "solana") : [];
    }
  } catch (e) { log("dex refresh error", e.message); return dex; }

  if (pairs.length) {
    pairs.sort((a, b) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0)); // best = deepest liquidity
    const p = pairs[0];
    dex = {
      at: Date.now(),
      priceUsd: Number(p.priceUsd) || 0,
      marketCap: Number(p.marketCap || p.fdv) || 0,
      liqUsd: Number(p?.liquidity?.usd) || 0,
      vol24: Number(p?.volume?.h24) || 0,
      pairUrl: p.url || "",
      dexId: (p.dexId || "").toLowerCase(),
      pairs: pairs.length,
    };
  } else {
    dex.at = Date.now();
  }
  const majorPair = pairs.find((p) => MAJOR_DEXES.has((p.dexId || "").toLowerCase()));

  // First successful poll = prime silently to current state, so a restart mid-run
  // never re-fires "chart live"/graduation/milestones for events already in the past.
  if (!dexPrimed) {
    dexPrimed = true;
    if (dex.priceUsd > 0) dexLiveAnnounced = true;
    if (majorPair) migratedAnnounced = true;
    for (const m of CFG.milestones) if (dex.marketCap >= m) milestonesHit.add(m);
    log(`dex primed — live=${dexLiveAnnounced} mcap=${dex.marketCap ? usd0(dex.marketCap) : "n/a"} on=${majorPair ? majorPair.dexId : "bonding"}`);
    return dex;
  }

  // Edge-triggered launch events -------------------------------------------
  if (!dexLiveAnnounced && dex.priceUsd > 0) {
    dexLiveAnnounced = true;
    tgSendMessage(
      `📈 <b>${CFG.ticker} chart is LIVE on DexScreener!</b>\n` +
      `Price <b>$${fmt(dex.priceUsd, 6)}</b>${dex.marketCap ? ` · MC <b>${usd0(dex.marketCap)}</b>` : ""}\n` +
      `<a href="${chartUrl()}">📊 Chart</a> · <a href="https://pump.fun/coin/${CFG.mint}">Pump.fun</a> · <a href="${CFG.site}">Website</a>`
    );
    log("announced: chart live");
  }
  if (CFG.announceMigration && !migratedAnnounced && majorPair) {
    migratedAnnounced = true;
    const name = (majorPair.dexId || "a DEX").replace(/-clmm$/, "").toUpperCase();
    tgSendMessage(
      `🎓🚀 <b>${CFG.ticker} HAS GRADUATED!</b>\nNow trading on <b>${name}</b>.${dex.liqUsd ? ` Liquidity <b>${usd0(dex.liqUsd)}</b>.` : ""}\n` +
      `<a href="${majorPair.url || chartUrl()}">📊 Chart</a> · <a href="${CFG.site}">Website</a>`
    );
    log("announced: graduation to", majorPair.dexId);
  }
  if (dex.marketCap > 0) {
    for (const m of CFG.milestones) {
      if (dex.marketCap >= m && !milestonesHit.has(m)) {
        milestonesHit.add(m);
        tgSendMessage(
          `🎯🔥 <b>${CFG.ticker} just crossed ${usd0(m)} market cap!</b>\n` +
          `Now at <b>${usd0(dex.marketCap)}</b>. Keep raiding. 🐾\n<a href="${chartUrl()}">📊 Chart</a>`
        );
        log("announced: milestone", usd0(m));
      }
    }
  }
  return dex;
}

const postedBuys = new Set(); // shared dedupe across WS + on-chain paths (by signature)
async function onBuy(t) {
  const sig0 = t.signature || "";
  if (sig0 && postedBuys.has(sig0)) return;           // already alerted (other source)
  if (sig0) { postedBuys.add(sig0); if (postedBuys.size > 8000) postedBuys.clear(); }
  const sol = Number(t.solAmount ?? t.sol_amount ?? 0);
  if (!sol || sol < CFG.minBuySol) { log(`skip small buy: ${fmt(sol, 3)} SOL (< ${CFG.minBuySol})`); return; }
  const tokens = Number(t.tokenAmount ?? t.token_amount ?? 0);
  const mcSol = Number(t.marketCapSol ?? t.market_cap_sol ?? 0);
  const buyer = t.traderPublicKey || t.trader || t.owner || "";
  const sig = t.signature || "";
  const px = await solPrice();
  // Prefer DexScreener's live USD numbers; fall back to SOL-price math.
  const usd = px ? sol * px : (dex.priceUsd && tokens ? dex.priceUsd * tokens : 0);
  const mcUsd = dex.marketCap || (px && mcSol ? mcSol * px : 0);
  const isNew = (t.newTokenBalance != null && tokens && Math.abs(Number(t.newTokenBalance) - tokens) < 1);

  const lines = [];
  lines.push(`<b>${CFG.ticker} Buy!</b> ${isNew ? "🆕" : ""}`);
  lines.push(emojiBar(sol));
  lines.push("");
  lines.push(`💵 <b>${fmt(sol, 3)} SOL</b>${usd ? ` ($${fmt(usd)})` : ""}`);
  if (tokens) lines.push(`🪙 Got <b>${fmt(tokens, 0)} ${CFG.ticker}</b>`);
  if (mcUsd) lines.push(`📊 Market Cap: <b>$${fmt(mcUsd)}</b>`);
  else if (mcSol) lines.push(`📊 Market Cap: <b>${fmt(mcSol, 1)} SOL</b>`);
  if (buyer) lines.push(`👤 <a href="https://solscan.io/account/${buyer}">${short(buyer)}</a>${isNew ? " · new holder" : ""}`);
  const links = [];
  if (sig) links.push(`<a href="https://solscan.io/tx/${sig}">TX</a>`);
  if (CFG.mint) links.push(`<a href="https://pump.fun/coin/${CFG.mint}">Pump.fun</a>`);
  if (CFG.mint) links.push(`<a href="${chartUrl()}">Chart</a>`);
  links.push(`<a href="${CFG.site}">Website</a>`);
  lines.push(links.join(" · "));

  await tgSendBuy(lines.join("\n"));
  log(`BUY ${fmt(sol, 3)} SOL${usd ? " ($" + fmt(usd) + ")" : ""} by ${short(buyer)}`);
}

// ---- on-chain trade detection (via YOUR RPC) ----------------------------
// PumpPortal's free WS silently drops trades, so we read buys straight off the
// chain: poll the mint's recent signatures, fetch each new tx, and detect a buy
// as "the fee-payer's balance of this token went UP". Works on the bonding curve
// AND post-graduation (Raydium/PumpSwap) — anywhere the token trades.
const seenChainSig = new Set();
let _chainPrimed = false;
function parseTrade(tx) {
  try {
    const meta = tx.meta; if (!meta || meta.err) return null;
    const msg = tx.transaction.message;
    const keys = (msg.accountKeys || []).map((k) => (typeof k === "string" ? k : k.pubkey));
    const trader = keys[0]; // fee payer = the trader on pump.fun / most swaps
    if (!trader) return null;
    const pre = meta.preTokenBalances || [], post = meta.postTokenBalances || [];
    const bal = (arr) => { const b = arr.find((x) => x.mint === CFG.mint && x.owner === trader); return b ? Number(b.uiTokenAmount.uiAmount || 0) : 0; };
    const preTok = bal(pre), postTok = bal(post), delta = postTok - preTok;
    if (Math.abs(delta) < 1) return null;                 // not a trade for our token by the signer
    const solDelta = (Number(meta.preBalances[0]) - Number(meta.postBalances[0])) / 1e9; // + = spent
    if (delta > 0) return { type: "buy", trader, tokens: delta, sol: Math.max(0, solDelta), newBal: postTok };
    return { type: "sell", trader, tokens: -delta, sol: -solDelta, newBal: postTok };
  } catch { return null; }
}
async function pollChainTrades() {
  if (!CFG.mint || !CFG.useChain) return;
  try {
    const sigs = await solRpc("getSignaturesForAddress", [CFG.mint, { limit: 30 }]);
    if (!Array.isArray(sigs) || !sigs.length) return;
    // newest-first → collect the run of unseen sigs, then process oldest→newest
    const fresh = [];
    for (const s of sigs) { if (seenChainSig.has(s.signature)) break; fresh.push(s); }
    for (const s of sigs) { seenChainSig.add(s.signature); }
    if (seenChainSig.size > 12000) seenChainSig.clear();
    if (!_chainPrimed) { _chainPrimed = true; log(`chain trades: primed on ${fresh.length} recent sigs (watching for new buys)`); return; }
    fresh.reverse();
    for (const s of fresh) {
      if (s.err) continue;
      const tx = await solRpc("getTransaction", [s.signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed", commitment: "confirmed" }]);
      const tr = parseTrade(tx);
      if (!tr) continue;
      log(`chain ${tr.type}: ${fmt(tr.sol, 3)} SOL ${short(tr.trader)}`);
      if (tr.type === "buy") {
        await onBuy({ solAmount: tr.sol, tokenAmount: tr.tokens, traderPublicKey: tr.trader,
          signature: s.signature, newTokenBalance: tr.newBal }).catch((e) => log("onBuy error", e.message));
      }
    }
  } catch (e) { log("chain poll error", e.message); }
}

// ---- launch auto-detect -------------------------------------------------
// When we don't yet have a mint but know the creator wallet (or ticker), watch
// pump.fun's new-token firehose and grab the mint the instant it's created.
const watchingNewTokens = () => !CFG.mint && (CFG.creator || CFG.matchSymbol);

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // base58 Solana address
const suggested = new Set(); // symbol-match candidates already surfaced

// Lock the bot onto a mint: switch the WS subscription, announce, start alerts.
// Used by both the manual /setmint command and creator-wallet auto-detect.
async function armToken(mint, source) {
  if (!mint || mint === CFG.mint) return false;
  CFG.mint = mint;
  resetDexState(); seen.clear();
  seenChainSig.clear(); _chainPrimed = false; postedBuys.clear(); // re-prime on-chain poller for the new token
  log(`🚀 armed on ${mint} (${source})`);
  try {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ method: "unsubscribeNewToken" }));
      ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mint] }));
    } else { try { ws.close(); } catch {} } // reconnect will subscribe trades
  } catch {}
  const buy = `https://pump.fun/coin/${mint}`;
  if (CFG.notifyChatId) {
    await tgSendTo(CFG.notifyChatId,
      `🚨🚀 <b>${CFG.ticker} LOCKED ON — BUY NOW</b> 🚀🚨\n<code>${mint}</code>\n<a href="${buy}">👉 BUY on Pump.fun</a>`);
  }
  await tgSendMessage(
    `🚨🚀 <b>${CFG.ticker} IS LIVE ON PUMP.FUN!</b> 🚀🚨\n\nCA: <code>${mint}</code>\n\n` +
    `<a href="${buy}">🟢 BUY NOW</a> · <a href="${chartUrl()}">📊 Chart</a> · <a href="${CFG.site}">🌐 Website</a>\n\nLFG 🐾`);
  refreshDex().catch((e) => log("dex refresh error", e.message));
  return true;
}

// A new token matching our ticker appeared. We DON'T auto-lock (copycats spoof
// the symbol during a hyped launch) — we DM the owner the candidate CA so they
// can confirm with /setmint. Auto-lock only happens on a matching CREATOR_WALLET.
async function suggestCandidate(t) {
  if (!CFG.notifyChatId || suggested.has(t.mint)) return;
  if (suggested.size >= 15) return; // cap the noise
  suggested.add(t.mint);
  const buy = `https://pump.fun/coin/${t.mint}`;
  await tgSendTo(CFG.notifyChatId,
    `👀 <b>Possible ${CFG.ticker} launch</b>\nname: ${t.name || "?"} · symbol: ${t.symbol || "?"}\n` +
    `by <code>${t.traderPublicKey || "?"}</code>\nCA: <code>${t.mint}</code> · <a href="${buy}">open</a>\n\n` +
    `If this is ours, reply: <code>/setmint ${t.mint}</code>`);
}

// route a new-token create event: auto-lock on creator match, else suggest
async function onNewToken(t) {
  const type = (t.txType || t.type || "").toLowerCase();
  if (type !== "create" || !t.mint) return;
  const creator = (t.traderPublicKey || t.creator || t.trader || "").trim();
  if (CFG.creator && creator && creator === CFG.creator) { await armToken(t.mint, "auto:creator"); return; }
  const sym = (t.symbol || t.ticker || "").trim().toUpperCase();
  if (CFG.matchSymbol && sym === CFG.matchSymbol) await suggestCandidate(t);
}

// ---- PumpPortal WebSocket (auto-reconnect) ------------------------------
const seen = new Set(); // signature dedupe
let ws, backoff = 1000;

function connect() {
  log("connecting to PumpPortal…");
  ws = new WebSocket(CFG.ws);

  ws.on("open", () => {
    backoff = 1000;
    if (CFG.mint) {
      log("connected. subscribing to token trades:", CFG.mint);
      ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [CFG.mint] }));
    } else if (watchingNewTokens()) {
      log("connected. WATCHING FOR LAUNCH — creator:", CFG.creator || "(none)", "symbol:", CFG.matchSymbol || "(none)");
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    } else {
      log("connected. no mint set and no creator/symbol to watch — set TOKEN_MINT at launch.");
    }
  });

  ws.on("message", async (data) => {
    _wsMsgCount++;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.message || msg.errors) { log("ws ack:", JSON.stringify(msg).slice(0, 160)); return; } // subscription ack / errors
    const events = Array.isArray(msg) ? msg : [msg];
    for (const t of events) {
      if (!t) continue;
      // launch detection (only while we don't have a mint yet)
      if (!CFG.mint && watchingNewTokens()) {
        await onNewToken(t).catch((e) => log("onNewToken error", e.message));
        continue;
      }
      if (t.mint !== CFG.mint) continue;
      _wsTradeCount++;
      const type = (t.txType || t.type || "").toLowerCase();
      log("trade:", type, fmt(Number(t.solAmount ?? t.sol_amount ?? 0), 3), "SOL", short(t.traderPublicKey || t.trader || t.owner || "")); // debug: feed visibility
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

// allow changing config at runtime without a redeploy: SIGHUP reloads .env
process.on("SIGHUP", async () => {
  await loadEnv();
  const next = process.env.TOKEN_MINT || CFG.mint;
  if (next !== CFG.mint) { resetDexState(); seen.clear(); } // new token — start its lifecycle fresh
  CFG.mint = next;
  CFG.creator = (process.env.CREATOR_WALLET || CFG.creator).trim();
  CFG.matchSymbol = (process.env.MATCH_SYMBOL || CFG.matchSymbol).trim().toUpperCase();
  CFG.notifyChatId = (process.env.NOTIFY_CHAT_ID || CFG.notifyChatId).trim();
  CFG.adminId = (process.env.ADMIN_CHAT_ID || process.env.NOTIFY_CHAT_ID || CFG.adminId).trim();
  log("reloaded env; mint =", CFG.mint || "(unset)");
  try { ws.close(); } catch {} // reconnect picks the right subscription
  refreshDex().catch((e) => log("dex refresh error", e.message));
});

// ---- DexScreener poll loop ----------------------------------------------
if (CFG.mint) refreshDex().catch((e) => log("dex refresh error", e.message));
setInterval(() => { if (CFG.mint) refreshDex().catch((e) => log("dex refresh error", e.message)); }, CFG.dexPollMs);

// on-chain buy detection (primary source — reliable via your RPC)
if (CFG.useChain) {
  log(`on-chain trade polling ${CFG.mint ? "ON" : "waiting for mint"} every ${CFG.chainPollMs}ms via ${CFG.rpcUrl.replace(/\/v2\/.*/, "/v2/***").replace(/\?.*/, "")}`);
  if (CFG.mint) pollChainTrades().catch(() => {});
  setInterval(() => { if (CFG.mint) pollChainTrades().catch((e) => log("chain poll error", e.message)); }, CFG.chainPollMs);
}

const watchNote = CFG.mint ? `mint=${CFG.mint}`
  : watchingNewTokens() ? `auto-detecting launch (creator=${CFG.creator || "-"}, symbol=${CFG.matchSymbol || "-"})`
  : "no mint — set TOKEN_MINT at launch";
log(`CATBOY buy bot starting — token=${CFG.ticker} ${watchNote} minBuy=${CFG.minBuySol} SOL`);
if (CFG.mint) {
  // Post-launch: fine to greet the group.
  tgSendMessage(`🐾 <b>${CFG.ticker} buy bot online.</b>\nWatching pump.fun + DexScreener for buys ≥ ${CFG.minBuySol} SOL.`);
} else {
  // PRE-LAUNCH: stay completely silent in the public group — the launch is a
  // secret. Only confirm privately to the owner that the bot is armed.
  tgSendTo(CFG.notifyChatId,
    `🐾 <b>${CFG.ticker} bot armed (private).</b>\nI'm watching quietly and will say nothing in the group until you go live.\n` +
    `At launch, DM me <code>/setmint &lt;CA&gt;</code> and I'll lock on + announce to the group. (I'll also DM you any $${CFG.ticker} launches I spot.)`);
}
getMe();      // learn our @username for mention detection
connect();
pollUpdates(); // listen for /setmint, owner commands, and AI chat
if (CFG.announceBurns) setInterval(() => { checkBurns().catch((e) => log("burn error", e.message)); }, CFG.burnPollMs);
if (CFG.llmKey) log(`AI chat ON (${CFG.llmModel}) — replies to @mentions/replies, ${Math.round(CFG.replyChance * 100)}% on random posts`);
