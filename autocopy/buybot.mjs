// HoodXChange Buy Bot — MVP (audited)
// Projects add @hoodxchangebot to their group (admin), /register <CA>, /setmedia, /setlinks, /test.
// Watches registered token pools on Robinhood Chain via Alchemy and posts buy alerts.
import { createPublicClient, http, keccak256, toHex } from "viem";
import fs from "fs";

// ---- env: buybot.env (local, gitignored) OR autocopy/deploy/.env (droplet) OR process.env (pm2) ----
function loadEnvFile(url) {
  try {
    if (!fs.existsSync(url)) return {};
    return Object.fromEntries(
      fs.readFileSync(url, "utf8").trim().split("\n")
        .filter(l => l.includes("=") && !l.trim().startsWith("#"))
        .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
    );
  } catch { return {}; }
}
// precedence low->high: droplet .env  <  local buybot.env  <  real process.env
const env = {
  ...loadEnvFile(new URL("./deploy/.env", import.meta.url)),
  ...loadEnvFile(new URL("./buybot.env", import.meta.url)),
  ...process.env,
};
if (!env.TG_BOT_TOKEN) { console.error("FATAL: no TG_BOT_TOKEN in buybot.env / deploy/.env / process.env"); process.exit(1); }
const BOT = env.TG_BOT_TOKEN;
const HTTP = env.ALCHEMY_HTTP;
const ETHUSD = Number(env.ETHUSD || 1872);

// ---- HoodX products (set real URLs in buybot.env; these are the billboard on every alert) ----
const HOODX = {
  pad: env.HOODX_PAD || "https://hoodxchange.fun",
  bridge: env.HOODX_BRIDGE || "https://hoodxchange.fun/bridge",
  trendingBuy: env.HOODX_TRENDING_BUY || "https://t.me/hoodxchangebot?start=trending",
};
// Rotating sponsor slot shown on every buy alert (network-wide ad inventory).
// Default entries promote HoodX; paid trending tokens get pushed in and rotate through.
let sponsors = [
  `📣 <b>Ads:</b> Launch your token free on <a href="${HOODX.pad}">HoodXChange</a> 🔥`,
  `🌉 Bridge to Robinhood Chain — <a href="${HOODX.bridge}">HoodBridge</a>`,
  `📈 <a href="${HOODX.trendingBuy}">Get your token Trending</a> on HoodX`,
];
let sponIdx = 0;
const sponsorLine = () => sponsors[(sponIdx++) % sponsors.length];
function kb(c) {
  const row1 = [];
  if (c.links?.chart) row1.push({ text: "📊 Chart", url: c.links.chart });
  row1.push({ text: "⚡ Buy Fast", url: c.links?.buy || HOODX.pad });
  return { inline_keyboard: [
    row1,
    [{ text: "🌉 HoodBridge", url: HOODX.bridge }, { text: "🚀 HoodX Pad", url: HOODX.pad }],
    [{ text: `🗳️ Vote ${ticker(c.sym)} Trending`, callback_data: `vote:${c.ca}` }],
    [{ text: "🔥 Get Trending", url: HOODX.trendingBuy }],
  ] };
}

const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73".toLowerCase();
const V3 = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const chain = { id: 4663, name: "rh", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [HTTP] } } };
const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
const pub = createPublicClient({ chain, transport: http(PUBLIC_RPC, { timeout: 15000, retryCount: 2 }) });         // public RPC: reads (Alchemy key hit monthly capacity cap → 429 on every eth_call)
const scan = createPublicClient({ chain, transport: http(PUBLIC_RPC, { timeout: 20000, retryCount: 1 }) });        // public RPC: getLogs history + real-time swap polling (no capacity cap)

const FAC = [{ name: "getPool", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }], outputs: [{ type: "address" }] }];
const POOLABI = [{ name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }];
const ERC20 = [
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];
const swapTopic = keccak256(toHex("Swap(address,address,int256,int256,uint160,uint128,int24)"));
const ZERO = "0x0000000000000000000000000000000000000000";
const s256 = h => { let n = BigInt("0x" + h); if (n >= 2n ** 255n) n -= 2n ** 256n; return n; };
const abs = n => n < 0n ? -n : n;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); // HTML-safe (attrs too)
const safeUrl = u => (typeof u === "string" && /^https?:\/\//i.test(u) && !/[\s"'<>]/.test(u)) ? u : null; // only clean http(s) URLs into hrefs
// atomic JSON write (tmp + rename) so a crash mid-write can't corrupt state; safe load tolerates a bad file
const saveJSON = (fileURL, data) => { const tmp = new URL(fileURL.href + ".tmp"); fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, fileURL); };
const loadJSON = (fileURL, fallback) => { try { return fs.existsSync(fileURL) ? JSON.parse(fs.readFileSync(fileURL, "utf8")) : fallback; } catch (e) { console.error("state load failed, using fallback:", fileURL.href, e.message); return fallback; } };
// branded HoodX custom emoji (Venice-made, owned by the bot). ce() → <tg-emoji> with a standard-emoji fallback for old/non-premium clients
const EMOJI = loadJSON(new URL("./emoji_ids.json", import.meta.url), {});
const ce = (name, fallback) => EMOJI[name] ? `<tg-emoji emoji-id="${EMOJI[name]}">${fallback}</tg-emoji>` : fallback;
const vlen = s => s.replace(/<[^>]+>/g, "").length; // visible length (Telegram's 1024 cap ignores HTML/emoji tags)
// buy-bar emoji: a project's choice is either a standard emoji (string) or a custom emoji ({ceid, fb}); default is the branded HoodX gem
const BUY_DEFAULT = EMOJI.buy ? { ceid: EMOJI.buy, fb: "🟢" } : "🟢";
const emojiUnit = e => (e && typeof e === "object" && e.ceid) ? `<tg-emoji emoji-id="${e.ceid}">${esc(e.fb || "🟢")}</tg-emoji>` : String(e || "🟢");
const ticker = s => "$" + String(s).replace(/^\$+/, "").trim();                                // exactly one leading $

// ---- telegram helpers ----
const api = (m, p) => fetch(`https://api.telegram.org/bot${BOT}/${m}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) }).then(r => r.json()).catch(e => ({ ok: false, e: e.message }));
const send = (chat_id, text, extra = {}) => api("sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
const sendMedia = (chat_id, media, caption, extra = {}) => {
  let method, key, val;
  if (media && typeof media === "object" && media.id) {          // uploaded file (stored file_id)
    ({ photo: ["sendPhoto", "photo"], animation: ["sendAnimation", "animation"], video: ["sendVideo", "video"] }[media.kind] || ["sendPhoto", "photo"]).forEach((x, i) => i === 0 ? method = x : key = x);
    val = media.id;
  } else {                                                        // url string
    const isVid = /\.(mp4|gif)$/i.test(media) || String(media).startsWith("vid:");
    method = isVid ? "sendAnimation" : "sendPhoto"; key = isVid ? "animation" : "photo"; val = String(media).replace(/^vid:/, "");
  }
  return api(method, { chat_id, [key]: val, caption, parse_mode: "HTML", ...extra });
};

// ---- registry ----
const REGF = new URL("./registry.json", import.meta.url);
let reg = loadJSON(REGF, {});
for (const k in reg) { if (reg[k]?.sym) reg[k].sym = ticker(reg[k].sym); if (reg[k]?.emoji === "🟢") reg[k].emoji = null; } // clean stale $; old hardcoded 🟢 default → HoodX default
const saveReg = () => { const t = new URL(REGF.href + ".tmp"); fs.writeFileSync(t, JSON.stringify(reg, null, 2)); fs.renameSync(t, REGF); };
const awaiting = new Set(); // chatIds that ran /setmedia and should upload next
function extractMedia(msg) {
  if (msg.photo?.length) return { id: msg.photo[msg.photo.length - 1].file_id, kind: "photo" };
  if (msg.animation) return { id: msg.animation.file_id, kind: "animation" };
  if (msg.video) return { id: msg.video.file_id, kind: "video" };
  const mt = msg.document?.mime_type || "";
  if (msg.document && /image|gif|video/i.test(mt)) return { id: msg.document.file_id, kind: /video|gif/i.test(mt) ? "animation" : "photo" };
  return null;
}

async function resolvePool(ca) {
  for (const f of [10000, 3000, 500, 100]) {
    try { const p = await pub.readContract({ address: V3, abi: FAC, functionName: "getPool", args: [ca, WETH, f] }); if (p && p.toLowerCase() !== ZERO) return { pool: p, fee: f }; } catch {}
  }
  return null;
}

// ---- token stats + safety scan (reuses this session's anti-rug logic) ----
const NPM = "0x73991a25c818bf1f1128deaab1492d45638de0d3";
const SLOT0 = [{ name: "slot0", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }] }];
const BAL = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];
const OWNEROF = [{ name: "ownerOf", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] }];
const DEAD = "0x000000000000000000000000000000000000dead";
const xferT = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const mintT = keccak256(toHex("Mint(address,address,int24,int24,uint128,uint256,uint256)"));
async function stats(ca) {
  const rp = await resolvePool(ca); if (!rp) return null;
  const t0 = (await pub.readContract({ address: rp.pool, abi: POOLABI, functionName: "token0" })).toLowerCase();
  const wethIsT0 = t0 === WETH;
  const [sq] = await pub.readContract({ address: rp.pool, abi: SLOT0, functionName: "slot0" });
  const P = (Number(sq) / 2 ** 96) ** 2; const priceEth = wethIsT0 ? 1 / P : P;
  let sym = "$TOKEN", ts = 0n;
  try { sym = ticker(await pub.readContract({ address: ca, abi: ERC20, functionName: "symbol" })); } catch {}
  try { ts = await pub.readContract({ address: ca, abi: ERC20, functionName: "totalSupply" }); } catch {}
  const weth = await pub.readContract({ address: WETH, abi: BAL, functionName: "balanceOf", args: [rp.pool] });
  return { ca, sym, pool: rp.pool, fee: rp.fee, wethIsT0, priceUsd: priceEth * ETHUSD, mc: priceEth * ETHUSD * (Number(ts) / 1e18), liqUsd: Number(weth) / 1e18 * ETHUSD };
}
async function lpStatus(pool) {
  try {
    const mints = await scan.request({ method: "eth_getLogs", params: [{ address: pool, topics: [mintT], fromBlock: "0x0", toBlock: "latest" }] });
    if (!mints.length) return { locked: null };
    const rcpt = await scan.request({ method: "eth_getTransactionReceipt", params: [mints[0].transactionHash] });
    let tid = null;
    for (const l of rcpt.logs) if (l.address.toLowerCase() === NPM && l.topics[0] === xferT && l.topics.length === 4 && /^0x0+$/.test("0x" + l.topics[1].slice(26))) tid = BigInt(l.topics[3]);
    if (tid === null) return { locked: null };
    const owner = (await pub.readContract({ address: NPM, abi: OWNEROF, functionName: "ownerOf", args: [tid] })).toLowerCase();
    if (owner === DEAD) return { locked: true, how: "burned" };
    const code = await pub.getBytecode({ address: owner }).catch(() => null);
    return { locked: !!(code && code !== "0x"), how: code && code !== "0x" ? "locker contract" : "held by a wallet" };
  } catch { return { locked: null }; }
}
async function activity(s) {
  const latest = Number(await pub.getBlockNumber());
  const logs = await scan.request({ method: "eth_getLogs", params: [{ address: s.pool, topics: [swapTopic], fromBlock: "0x" + Math.max(0, latest - 40000).toString(16), toBlock: "latest" }] });
  let buys = 0, sells = 0;
  for (const l of logs) { const d = l.data.slice(2); const wd = s.wethIsT0 ? s256(d.slice(0, 64)) : s256(d.slice(64, 128)); if (wd > 0n) buys++; else if (wd < 0n) sells++; }
  return { buys, sells };
}
// DexScreener: paid-profile status, boosts, and socials (also powers auto-setup)
async function dexInfo(ca) {
  try {
    const [ord, srch] = await Promise.all([
      fetch(`https://api.dexscreener.com/orders/v1/robinhood/${ca}`).then(r => r.json()).catch(() => null),
      fetch(`https://api.dexscreener.com/latest/dex/search?q=${ca}`).then(r => r.json()).catch(() => null),
    ]);
    const paid = ((ord && ord.orders) || []).filter(o => o.status === "approved");
    const pair = ((srch && srch.pairs) || [])[0];
    const info = (pair && pair.info) || {};
    const socials = {};
    for (const s of (info.socials || [])) { if (s.type === "twitter") socials.x = s.url; if (s.type === "telegram") socials.tg = s.url; }
    return {
      paid: paid.length > 0,
      paidTypes: [...new Set(paid.map(o => o.type))],
      enhanced: !!(info.imageUrl || info.header),
      boosts: (pair && pair.boosts && pair.boosts.active) || 0,
      website: ((info.websites || [])[0] || {}).url,
      x: socials.x, tg: socials.tg,
      dexUrl: pair ? `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}` : null,
    };
  } catch { return null; }
}

// ---- trending channel ----
const TREND_CH = env.TRENDING_CHANNEL || "-1004414481505";
const BOOSTF = new URL("./boosts.json", import.meta.url);
const TRENDF = new URL("./trend.json", import.meta.url);
// boosts: key -> { until, tier, chain, sym, group } (key = evm ca lowercase, or solana mint). tier 1<3<10 (lower = higher slot)
let boosts = loadJSON(BOOSTF, {});
// migrate legacy numeric-until entries → object form
for (const k of Object.keys(boosts)) if (typeof boosts[k] === "number") boosts[k] = { until: boosts[k], tier: 3, chain: "rhc" };
let trendMsg = loadJSON(TRENDF, {}); // { rhc: msgId, sol: msgId }
if (typeof trendMsg.id === "number") trendMsg = { rhc: trendMsg.id };   // migrate old single-id shape
const saveBoosts = () => saveJSON(BOOSTF, boosts);
const saveTrend = () => saveJSON(TRENDF, trendMsg);
const boostedNow = k => boosts[k] && boosts[k].until > Date.now();

// ---- paid trending: treasury wallets + tier sheet (prices configurable via env) ----
const TREND_EVM = (env.TREND_EVM_WALLET || "").toLowerCase();
const TREND_SOL = env.TREND_SOL_WALLET || "";
const SOL_RPC = env.SOL_RPC || "https://api.mainnet-beta.solana.com";
const ADMIN_IDS = new Set((env.ADMIN_IDS || "6820752140").split(",").map(s => s.trim()).filter(Boolean)); // /boost + operator commands
const TREND_HOURS = Number(env.TREND_HOURS || 24);                       // boost duration per purchase
const TIERS = {                                                          // tier -> price in the chain's native coin
  rhc: { 1: Number(env.RHC_T1 || 0.05), 3: Number(env.RHC_T3 || 0.03), 10: Number(env.RHC_T10 || 0.015) },
  sol: { 1: Number(env.SOL_T1 || 1.0), 3: Number(env.SOL_T3 || 0.6), 10: Number(env.SOL_T10 || 0.3) },
};
const TIER_LABEL = { 1: "🥇 #1 Spot", 3: "🔥 Top 3", 10: "📈 Top 10" };
const ORDERF = new URL("./trend_orders.json", import.meta.url);
let orders = loadJSON(ORDERF, { seq: 0, pending: {} }); // id -> order
const saveOrders = () => saveJSON(ORDERF, orders);
// persisted payment cursors: treasury balances (cumulative → a payment during downtime shows as a delta on next poll)
const PAYF = new URL("./pay_cursor.json", import.meta.url);
let payState = loadJSON(PAYF, {}); // { evmBal: wei-string, solBal: lamports-number }
const savePay = () => saveJSON(PAYF, payState);

// ---- 🛡️ HoodX Verified: paid live rug-watch (monthly sub, auto-verified on-chain) ----
const VERIFYF = new URL("./verified.json", import.meta.url);
let verified = loadJSON(VERIFYF, {}); // key -> { until, chain, sym, group, chatId, pool, baseLiq, alerted, lpLocked, lastAlertAt }
const saveVerified = () => saveJSON(VERIFYF, verified);
const verifiedNow = k => verified[k] && verified[k].until > Date.now();
const VERIFY_DAYS = Number(env.VERIFY_DAYS || 30);
const VERIFY_PRICE = { rhc: Number(env.VERIFY_RHC || 0.1), sol: Number(env.VERIFY_SOL || 2) }; // per 30d
const VOTEF = new URL("./votes.json", import.meta.url);
let userVotes = loadJSON(VOTEF, {}); // userId -> {ca, ts}
const saveVotes = () => saveJSON(VOTEF, userVotes);
function voteCounts() { const cut = Date.now() - 24 * 3600e3, c = {}; for (const v of Object.values(userVotes)) if (v.ts > cut) c[v.ca] = (c[v.ca] || 0) + 1; return c; }
async function pairStats(ca) {
  try {
    const j = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${ca}`).then(r => r.json());
    const p = (j.pairs || []).filter(x => x.chainId === "robinhood").sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    if (!p) return null;
    const info = p.info || {}; const soc = {};
    for (const s of (info.socials || [])) { if (s.type === "twitter") soc.x = s.url; if (s.type === "telegram") soc.tg = s.url; }
    return { ca: ca.toLowerCase(), sym: ticker(p.baseToken?.symbol || "?"), mc: p.marketCap || p.fdv || 0, vol1h: p.volume?.h1 || 0, change1h: p.priceChange?.h1 ?? 0, dexUrl: `https://dexscreener.com/${p.chainId}/${p.pairAddress}`, web: ((info.websites || [])[0] || {}).url, x: soc.x, tg: soc.tg };
  } catch { return null; }
}
const MEDAL = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
function mapPair(p) {
  const info = p.info || {}; const soc = {};
  for (const s of (info.socials || [])) { if (s.type === "twitter") soc.x = s.url; if (s.type === "telegram") soc.tg = s.url; }
  return { ca: p.baseToken.address.toLowerCase(), sym: ticker(p.baseToken.symbol || "?"), mc: p.marketCap || p.fdv || 0, vol: p.volume?.h24 || 0, change: p.priceChange?.h24 ?? 0, dexUrl: `https://dexscreener.com/${p.chainId}/${p.pairAddress}`, web: ((info.websites || [])[0] || {}).url, x: soc.x, tg: soc.tg };
}
async function topRhcPairs() {
  const j = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${WETH}`).then(r => r.json()).catch(() => null);
  const ps = (j?.pairs || []).filter(p => p.chainId === "robinhood" && p.baseToken?.address);
  const byTok = {}; // dedupe per token, keep deepest-liquidity pair
  for (const p of ps) { const a = p.baseToken.address.toLowerCase(); if (!byTok[a] || (p.liquidity?.usd || 0) > (byTok[a].liquidity?.usd || 0)) byTok[a] = p; }
  return Object.values(byTok).map(mapPair);
}
async function pairRow(ca) { // fetch a single token's row (for a voted token not in the volume top list)
  const j = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${ca}`).then(r => r.json()).catch(() => null);
  const p = (j?.pairs || []).filter(x => x.chainId === "robinhood" && x.baseToken?.address).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  return p ? mapPair(p) : null;
}
async function buildTrending() {
  const now = Date.now();
  let rows = await topRhcPairs();
  const vc = voteCounts();
  const topVoted = Object.entries(vc).sort((a, b) => b[1] - a[1])[0]; // [ca, count]
  if (topVoted && topVoted[1] > 0 && !rows.find(r => r.ca === topVoted[0])) { const x = await pairRow(topVoted[0]); if (x) rows.push(x); } // vote earns a slot
  for (const [k, b] of Object.entries(boosts)) if (b.until > now && b.chain === "rhc" && !rows.find(r => r.ca === k)) { const x = await pairRow(k); if (x) rows.push(x); } // paid boost always shows even if thin/unlisted
  rows.forEach(r => { r.votes = vc[r.ca] || 0; r.boosted = boostedNow(r.ca); r.tier = r.boosted ? boosts[r.ca].tier : 99; });
  const maxV = Math.max(0, ...rows.map(r => r.votes));
  rows.forEach(r => r.topVoted = maxV > 0 && r.votes === maxV);
  rows.sort((a, b) => a.tier - b.tier || (b.topVoted ? 1 : 0) - (a.topVoted ? 1 : 0) || b.vol - a.vol);   // paid tier first (1<3<10), then votes, then volume
  return rows.slice(0, 10);
}
function mapSolPool(p) {
  const a = p.attributes || {};
  const mint = (p.relationships?.base_token?.data?.id || "").replace("solana_", "");
  return { ca: mint, sym: ticker((a.name || "?").split(" / ")[0]), mc: Number(a.market_cap_usd || a.fdv_usd || 0), vol: Number(a.volume_usd?.h24 || 0), change: Number(a.price_change_percentage?.h24 || 0), dexUrl: `https://dexscreener.com/solana/${a.address}` };
}
async function solRow(mint) { // single Solana token's row (for a paid boost not in the trending list)
  try { const j = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?page=1`, { headers: { accept: "application/json" } }).then(r => r.json()); const p = (j.data || [])[0]; return p ? mapSolPool(p) : null; } catch { return null; }
}
// Solana board via GeckoTerminal trending pools (RHC isn't indexed there; SOL memecoins are)
async function topSolPairs() {
  try {
    const j = await fetch("https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1", { headers: { accept: "application/json" } }).then(r => r.json());
    const byMint = {}; // dedupe: one row per mint, keep highest volume
    for (const p of (j.data || [])) { const r = mapSolPool(p); if (r.ca && (!byMint[r.ca] || r.vol > byMint[r.ca].vol)) byMint[r.ca] = r; }
    let rows = Object.values(byMint);
    const now = Date.now();
    for (const [k, b] of Object.entries(boosts)) if (b.until > now && b.chain === "sol" && !rows.find(r => r.ca === k)) { const x = await solRow(k); if (x) rows.push(x); } // paid boost always shows
    rows.forEach(r => { r.votes = 0; r.boosted = boostedNow(r.ca); r.tier = r.boosted ? boosts[r.ca].tier : 99; });
    rows.sort((a, b) => a.tier - b.tier || b.vol - a.vol);
    return rows.slice(0, 10);
  } catch { return []; }
}
function fmtTrending(rows, chain = "rhc") {
  const title = chain === "sol" ? "◎ <b>HoodX Trending — Solana</b>" : "🏹 <b>HoodX Trending — Robinhood Chain</b>";
  const ts = new Date().toISOString().slice(11, 16);
  const foot = `\n\n${ce("flame", "🔥")} <i>= paid boost · ${ce("vote", "🗳️")} = top voted</i>\n🕐 <i>Refreshed ${ts} UTC</i>`;
  const rowStr = (r, i) => {
    const a = r.change >= 0 ? ce("up", "🟢") : ce("down", "🔴");
    const links = [];
    if (safeUrl(r.dexUrl)) links.push(`<a href="${esc(r.dexUrl)}">${ce("chart", "📊")}</a>`);
    if (safeUrl(r.web)) links.push(`<a href="${esc(r.web)}">${ce("globe", "🌐")}</a>`);
    if (safeUrl(r.x)) links.push(`<a href="${esc(r.x)}">${ce("x", "✖️")}</a>`);
    if (safeUrl(r.tg)) links.push(`<a href="${esc(r.tg)}">${ce("tg", "💬")}</a>`);
    const name = safeUrl(r.dexUrl) ? `<a href="${esc(r.dexUrl)}">${esc(r.sym)}</a>` : `<b>${esc(r.sym)}</b>`;
    const badge = (r.boosted ? " " + ce("flame", "🔥") : r.topVoted ? " " + ce("vote", "🗳️") : "") + (verifiedNow(r.ca) ? " " + ce("shield", "🛡️") : "");
    const votes = r.votes > 0 ? ` · ${ce("vote", "🗳️")}${r.votes}` : "";
    return `${MEDAL[i] || (i + 1) + "."} ${name}${badge} | ${a} ${r.change >= 0 ? "+" : ""}${r.change.toFixed(1)}%  ${links.join(" ")}\nMC $${Math.round(r.mc).toLocaleString()} | Vol24 $${Math.round(r.vol).toLocaleString()}${votes}`;
  };
  if (!rows.length) { const empty = chain === "sol" ? "Loading Solana trending…" : "No tokens yet — register with @hoodxchangebot"; return `${title}\n\n${empty}${foot}`; }
  // enforce Telegram's 1024-char caption limit — measured on VISIBLE text (tags/emoji don't count)
  const budget = 1000 - vlen(title) - vlen(foot); let body = "", used = 0;
  for (let i = 0; i < rows.length; i++) { const s = rowStr(rows[i], i); const add = vlen(s) + 2; if (used + add > budget && i > 0) break; body += (body ? "\n\n" : "") + s; used += add; }
  return `${title}\n\n${body}${foot}`;
}
const trendKb = () => ({ inline_keyboard: [
  [{ text: "🗳️ Vote", url: "https://t.me/hoodxchangebot?start=vote" }, { text: "🔥 Get Trending", url: "https://t.me/hoodxchangebot?start=boost" }],
  [{ text: "➕ Add Buy Bot", url: "https://t.me/hoodxchangebot?startgroup=true" }],
] });
const TREND_MEDIA = new URL("./trending_header.mp4", import.meta.url);   // animated branded header (Veo)
const TRENDMCACHE = new URL("./trending_media_id.txt", import.meta.url);
let trendFileId = fs.existsSync(TRENDMCACHE) ? fs.readFileSync(TRENDMCACHE, "utf8").trim() : null;
async function sendTrendingMedia(chat_id, caption) {
  if (trendFileId) return api("sendVideo", { chat_id, video: trendFileId, caption, parse_mode: "HTML", reply_markup: trendKb() });
  if (!fs.existsSync(TREND_MEDIA)) return send(chat_id, caption, { reply_markup: trendKb() });
  const form = new FormData();
  form.append("chat_id", String(chat_id)); form.append("caption", caption); form.append("parse_mode", "HTML"); form.append("reply_markup", JSON.stringify(trendKb()));
  form.append("supports_streaming", "true");
  form.append("video", new Blob([fs.readFileSync(TREND_MEDIA)], { type: "video/mp4" }), "trend.mp4");
  const r = await fetch(`https://api.telegram.org/bot${BOT}/sendVideo`, { method: "POST", body: form }).then(x => x.json()).catch(e => ({ ok: false, e: e.message }));
  const v = r.result && (r.result.video || r.result.animation || r.result.document);
  if (r.ok && v?.file_id) { trendFileId = v.file_id; try { fs.writeFileSync(TRENDMCACHE, trendFileId); } catch {} }
  return r;
}
async function postChainBoard(chain) {
  try {
    const rows = chain === "sol" ? await topSolPairs() : await buildTrending();
    if (!rows.length && trendMsg[chain]) return;         // data hiccup — keep the good board, don't wipe it to a placeholder
    const text = fmtTrending(rows, chain);
    if (trendMsg[chain]) {
      const r = await api("editMessageCaption", { chat_id: TREND_CH, message_id: trendMsg[chain], caption: text, parse_mode: "HTML", reply_markup: trendKb() });
      if (r.ok || /not modified/i.test(r.description || "")) return;
      // only re-post a fresh board if the old one is truly gone; on 429/network keep it and retry next cycle
      if (!/not found|can't be edited|MESSAGE_ID_INVALID|to edit/i.test(r.description || "")) return;
    }
    const r = await sendTrendingMedia(TREND_CH, text);   // animated header + list caption + buttons
    if (r.ok && r.result) { trendMsg[chain] = r.result.message_id; saveTrend(); }
  } catch {}
}
async function postTrending() { await postChainBoard("rhc"); await postChainBoard("sol"); }

// ---- 🏆 hourly Top-Voted card: community picks, ranked by 24h votes cast from projects' own groups ----
async function voteRows() {
  const vc = voteCounts();
  const top = Object.entries(vc).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const rows = [];
  for (const [ca, n] of top) {
    const r = Object.values(reg).find(x => x.ca === ca);   // registered project (voting happens in its group)
    let sym = r?.sym; const group = r?.links?.tg;
    if (!sym) { try { sym = await trendSym(isSol(ca) ? "sol" : "rhc", ca); } catch { sym = ca.slice(0, 6); } }
    const dexUrl = isSol(ca) ? `https://dexscreener.com/solana/${ca}` : `https://dexscreener.com/robinhood/${ca}`;
    rows.push({ ca, sym, votes: n, group, dexUrl });
  }
  return rows;
}
function fmtVoteCard(rows) {
  const title = `🏆 <b>HoodX Top Voted — Community Picks</b>`;
  const foot = `\n\n${ce("vote", "🗳️")} <i>Vote for your project from its own Telegram — just send</i> <code>/vote</code> <i>in the group, or tap</i> ${ce("vote", "🗳️")} <i>on any buy alert. 1 vote / person / 24h.</i>`;
  if (!rows.length) return `${title}\n\nNo votes yet — send <code>/vote</code> in your project's group to get on the board.${foot}`;
  const body = rows.map((r, i) => {
    const name = safeUrl(r.dexUrl) ? `<a href="${esc(r.dexUrl)}">${esc(r.sym)}</a>` : `<b>${esc(r.sym)}</b>`;
    const tg = r.group && safeUrl(r.group) ? ` · <a href="${esc(r.group)}">${ce("tg", "💬")}</a>` : "";
    return `${MEDAL[i] || (i + 1) + "."} ${name} — ${ce("vote", "🗳️")} <b>${r.votes}</b> vote${r.votes > 1 ? "s" : ""}${tg}`;
  }).join("\n");
  return `${title}\n\n${body}${foot}`;
}
// re-surface a single fresh card each hour (delete the previous one so the channel stays clean)
async function postVoteCard() {
  try {
    const rows = await voteRows();
    if (!rows.length) return;
    const text = fmtVoteCard(rows);
    if (trendMsg.votes) await api("deleteMessage", { chat_id: TREND_CH, message_id: trendMsg.votes }).catch(() => {});
    const r = await sendTrendingMedia(TREND_CH, text);
    if (r.ok && r.result) { trendMsg.votes = r.result.message_id; saveTrend(); }
  } catch {}
}

// ================= PAID TRENDING (auto-verified on-chain) =================
const isEvm = a => /^0x[0-9a-fA-F]{40}$/.test(a);
const isSol = a => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
async function trendSym(chain, ca) {
  try {
    if (chain === "sol") { const j = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${ca}`, { headers: { accept: "application/json" } }).then(r => r.json()); return ticker(j.data?.attributes?.symbol || ca.slice(0, 5)); }
    const j = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${ca}`).then(r => r.json());
    const p = (j.pairs || []).find(x => x.chainId === "robinhood"); return ticker(p?.baseToken?.symbol || ca.slice(0, 6));
  } catch { return ticker(ca.slice(0, 6)); }
}
const AMT = { rhc: { step: 1e-5, tol: 4e-6, dp: 8 }, sol: { step: 1e-4, tol: 4e-5, dp: 6 } }; // grid spacing > 2*tol so live amounts never collide
// create a pending order with a MINIMAL unique payable surcharge (a few cents), guaranteed distinct from every live order
function newOrder(kind, chain, ca, price, sym, chatId, group, tier = 0) {
  const { step, tol, dp } = AMT[chain]; const now = Date.now();
  const collides = a => Object.values(orders.pending).some(o => o.chain === chain && o.expires > now && Math.abs(o.amount - a) <= 2 * tol);
  let n = 0, amount; do { amount = +(price + (++n) * step).toFixed(dp); } while (n < 5000 && collides(amount)); // smallest free offset
  const id = `${chain}_${++orders.seq}`;
  orders.pending[id] = { id, kind, chain, ca: chain === "sol" ? ca : ca.toLowerCase(), tier, sym, amount, coin: chain === "sol" ? "SOL" : "ETH", wallet: chain === "sol" ? TREND_SOL : TREND_EVM, chatId, group, createdAt: now, expires: now + 60 * 60e3 };
  saveOrders();
  return orders.pending[id];
}
async function fulfillOrder(o) { return o.kind === "verify" ? activateVerify(o) : activateBoost(o); }
function matchOrder(chain, value) { // value in native coin; find the unique unexpired pending order within tolerance
  const tol = AMT[chain].tol, now = Date.now();
  let best = null, bd = tol;
  for (const o of Object.values(orders.pending)) { if (o.chain !== chain || o.expires < now) continue; const d = Math.abs(value - o.amount); if (d <= bd) { bd = d; best = o; } }
  return best;
}
// periodic sweep: drop long-expired orders so pending stays small and match odds stay clean
function sweepOrders() {
  const cut = Date.now() - 30 * 60e3; let changed = false;
  for (const [id, o] of Object.entries(orders.pending)) if (o.expires < cut) { delete orders.pending[id]; changed = true; }
  if (changed) saveOrders();
}
async function activateBoost(o) {
  boosts[o.ca] = { until: Date.now() + TREND_HOURS * 3600e3, tier: o.tier, chain: o.chain, sym: o.sym, group: o.group };
  saveBoosts(); delete orders.pending[o.id]; saveOrders();
  const chainName = o.chain === "sol" ? "Solana" : "Robinhood Chain";
  const dexUrl = o.chain === "sol" ? `https://dexscreener.com/solana/${o.ca}` : `https://dexscreener.com/robinhood/${o.ca}`;
  // 1) entry alert in the trending channel
  await send(TREND_CH, `💎 <b>${esc(o.sym)}</b> is now <b>${TIER_LABEL[o.tier]}</b> on <b>HoodX Trending — ${chainName}</b>\n${o.group && safeUrl(o.group) ? `Group: ${esc(o.group)}\n` : ""}<a href="${esc(dexUrl)}">📊 Chart</a> · <code>${esc(o.ca)}</code>`, { reply_markup: trendKb() }).catch(() => {});
  // 2) badge in the project's own group (if we know it)
  if (o.chatId && String(o.chatId) !== String(TREND_CH)) await send(o.chatId, `🔥🔥 <b>${esc(o.sym)} is now TRENDING</b> — ${TIER_LABEL[o.tier]} on HoodX for ${TREND_HOURS}h! 🚀`).catch(() => {});
  // 3) refresh the board so they appear pinned immediately
  postChainBoard(o.chain);
}
// current on-chain liquidity in USD (low-RPC: DexScreener for RHC, GeckoTerminal for SOL)
async function liqOf(chain, ca) {
  try {
    if (chain === "sol") { const j = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${ca}/pools?page=1`, { headers: { accept: "application/json" } }).then(r => r.json()); const p = (j.data || [])[0]; if (!p) return -1; return Number(p.attributes?.reserve_in_usd || 0); }
    const j = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${ca}`).then(r => r.json());
    const p = (j.pairs || []).filter(x => x.chainId === "robinhood").sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    if (!p) return -1;                       // pair not indexed this cycle → unknown, NOT a drain
    return Number(p.liquidity?.usd || 0);
  } catch { return -1; } // -1 = fetch failed / no pair → skip this cycle (never false-alarm)
}
async function activateVerify(o) {
  let pool = null, lpLocked = null;
  if (o.chain === "rhc") { const c = Object.values(reg).find(x => x.ca === o.ca); pool = c?.pool || (await resolvePool(o.ca).catch(() => null))?.pool || null; if (pool) lpLocked = (await lpStatus(pool).catch(() => ({ locked: null }))).locked; }
  const liq = await liqOf(o.chain, o.ca);
  verified[o.ca] = { until: Date.now() + VERIFY_DAYS * 86400e3, chain: o.chain, sym: o.sym, group: o.group, chatId: o.chatId, pool, lpLocked, baseLiq: Math.max(0, liq), lastAlertAt: 0 };
  saveVerified(); delete orders.pending[o.id]; saveOrders();
  await send(TREND_CH, `🛡️ <b>${esc(o.sym)}</b> is now <b>HoodX Verified</b> — watched 24/7 for LP pulls & rug patterns. Holders get an instant alert if anything moves.`, { reply_markup: trendKb() }).catch(() => {});
  if (o.chatId && String(o.chatId) !== String(TREND_CH)) await send(o.chatId, `🛡️ <b>${esc(o.sym)} is now HoodX Verified</b> — your token is watched 24/7. Holders will be alerted the instant LP unlocks or liquidity drains. Trust badge is live on the board.`).catch(() => {});
}
// live rug-watch: every 5 min re-check each Verified token; alert group + channel on a bad transition
async function watchVerified() {
  try {
    for (const [ca, v] of Object.entries(verified)) {
      if (v.until < Date.now()) { delete verified[ca]; saveVerified(); continue; }  // reap expired subs
      const cur = await liqOf(v.chain, ca);
      if (v.chain === "rhc" && !v.pool) { const p = (await resolvePool(ca).catch(() => null))?.pool; if (p) { v.pool = p; saveVerified(); } } // lazily resolve pool
      if (cur < 0) continue;                                  // unknown/fetch-fail — never false-alarm
      const base = Math.max(cur, (v.baseLiq || 0) * 0.97);    // decaying high-water: a legit settle-down drifts the baseline, only an ABRUPT drop trips
      if (base !== v.baseLiq) { v.baseLiq = base; saveVerified(); }
      let breach = null;
      if (v.baseLiq >= 100 && cur < v.baseLiq * 0.5) breach = `liquidity dropped ${Math.round((1 - cur / v.baseLiq) * 100)}% ($${Math.round(v.baseLiq).toLocaleString()} → $${Math.round(cur).toLocaleString()})`;
      // LP-unlock only counts as a genuine true→false transition (never alarm a token that was never locked)
      if (!breach && v.chain === "rhc" && v.pool && v.lpLocked === true) { const lp = await lpStatus(v.pool).catch(() => ({ locked: null })); if (lp.locked === false) breach = "LP is no longer locked"; }
      if (breach && Date.now() - (v.lastAlertAt || 0) > 6 * 3600e3) {   // 6h cooldown kills flip-flop spam
        v.lastAlertAt = Date.now(); saveVerified();
        // alert HOLDERS in the token's own group only — never post an unproven "rug" accusation to the public board
        if (v.chatId) await send(v.chatId, `🚨🛡️ <b>HoodX Verified ALERT — ${esc(v.sym)}</b>\n${breach}.\n<b>Be careful — this can signal a rug in progress.</b>`).catch(() => {});
      }
    }
  } catch {}
  setTimeout(watchVerified, 5 * 60 * 1000);
}
// Payment detection = persisted treasury BALANCE DELTA. The balance is cumulative, so a payment that lands
// during downtime shows up as a positive delta on the next poll after restart — no lost payments, no block/sig
// cursor gaps, and it also catches transfers routed through contracts/multisigs/exchanges. (Trade-off: two
// payments inside one poll window sum into one delta and won't match — logged as an unmatched inflow.)
async function watchEvmPayments() {
  try {
    if (TREND_EVM) {
      const bal = BigInt(await scan.request({ method: "eth_getBalance", params: [TREND_EVM, "latest"] }));
      if (payState.evmBal == null) { payState.evmBal = bal.toString(); savePay(); }
      else {
        const prev = BigInt(payState.evmBal);
        if (bal > prev) {
          const eth = Number(bal - prev) / 1e18;
          const o = matchOrder("rhc", eth);
          if (o) { console.log(`[trend] EVM credit ${eth} ETH → ${o.id} (${o.kind} ${o.sym})`); await fulfillOrder(o); }
          else console.log(`[trend] EVM inflow ${eth} ETH matched no live order`);
        }
        if (bal !== prev) { payState.evmBal = bal.toString(); savePay(); } // advance on any change (incl. withdrawals)
      }
    }
  } catch {}
  setTimeout(watchEvmPayments, 12000);
}
async function watchSolPayments() {
  try {
    if (TREND_SOL) {
      const bal = await fetch(SOL_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [TREND_SOL] }) }).then(r => r.json()).then(j => j.result?.value).catch(() => null);
      if (typeof bal === "number") {
        if (payState.solBal == null) { payState.solBal = bal; savePay(); }
        else {
          if (bal > payState.solBal) {
            const sol = (bal - payState.solBal) / 1e9;
            const o = matchOrder("sol", sol);
            if (o) { console.log(`[trend] SOL credit ${sol} → ${o.id} (${o.kind} ${o.sym})`); await fulfillOrder(o); }
            else console.log(`[trend] SOL inflow ${sol} matched no live order`);
          }
          if (bal !== payState.solBal) { payState.solBal = bal; savePay(); }
        }
      }
    }
  } catch {}
  setTimeout(watchSolPayments, 12000);
}

// ---- alert formatting ----
function bar(usd, e, step) { const custom = e && typeof e === "object" && e.ceid; const n = Math.max(1, Math.min(custom ? 12 : 60, Math.floor(usd / step))); return emojiUnit(e).repeat(n); } // custom emoji are heavier → capped repeat
function fmtAlert(c, ev) {
  const links = [];
  if (c.links?.chart) links.push(`<a href="${esc(c.links.chart)}">Chart</a>`);
  if (c.links?.buy) links.push(`<a href="${esc(c.links.buy)}">Buy</a>`);
  if (c.links?.x) links.push(`<a href="${esc(c.links.x)}">X</a>`);
  if (c.links?.tg) links.push(`<a href="${esc(c.links.tg)}">TG</a>`);
  return [
    `<b>${esc(ticker(c.sym))} Buy!</b>`,
    verifiedNow(c.ca) ? `${ce("shield", "🛡️")} <b>HoodX Verified</b> — LP watched 24/7` : "",
    c.dexPaid ? `${ce("paid", "🔵")} <b>DEX PAID</b> — ${ce("rocket", "🚀")}${ce("rocket", "🚀")} <b>BULLISH</b> ${ce("rocket", "🚀")}${ce("rocket", "🚀")}` : "",
    bar(ev.usd, c.emoji || BUY_DEFAULT, c.step || 10),
    `${ce("money", "💰")} <b>$${ev.usd.toFixed(0)}</b> (${ev.eth.toFixed(4)} ETH)`,
    `${ce("coin", "🪙")} ${ev.tokens.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${esc(ticker(c.sym))}`,
    `${ce("chart", "📊")} MC $${ev.mc.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
    `${ce("buyer", "👤")} <code>${ev.buyer.slice(0, 6)}…${ev.buyer.slice(-4)}</code>`,
    `\n${sponsorLine()}`,            // rotating sponsor/ads slot (network ad inventory)
    links.length ? links.join("  •  ") : ""
  ].filter(Boolean).join("\n");
}
// default buy video (shipped) — uploaded once, Telegram file_id cached + reused
const DEFAULT_MEDIA = new URL("./default_buy.mp4", import.meta.url);
const DEFCACHE = new URL("./default_media_id.txt", import.meta.url);
let defaultFileId = fs.existsSync(DEFCACHE) ? fs.readFileSync(DEFCACHE, "utf8").trim() : null;
async function sendDefaultMedia(chat_id, caption, extra) {
  if (defaultFileId) return sendMedia(chat_id, { id: defaultFileId, kind: "animation" }, caption, extra);
  if (!fs.existsSync(DEFAULT_MEDIA)) return { ok: false };
  const form = new FormData();
  form.append("chat_id", String(chat_id)); form.append("caption", caption); form.append("parse_mode", "HTML");
  if (extra.reply_markup) form.append("reply_markup", JSON.stringify(extra.reply_markup));
  form.append("animation", new Blob([fs.readFileSync(DEFAULT_MEDIA)], { type: "video/mp4" }), "buy.mp4");
  const r = await fetch(`https://api.telegram.org/bot${BOT}/sendAnimation`, { method: "POST", body: form }).then(x => x.json()).catch(e => ({ ok: false, e: e.message }));
  const a = r.result && (r.result.animation || r.result.video || r.result.document);
  if (r.ok && a?.file_id) { defaultFileId = a.file_id; try { fs.writeFileSync(DEFCACHE, defaultFileId); } catch {} }
  return r;
}
async function postAlert(c, ev) {
  // refresh DEX-paid status in the background (≤ once / 5 min) so the bullish banner stays current
  if (Date.now() - (c.dexCheckedAt || 0) > 5 * 60e3) {
    c.dexCheckedAt = Date.now();
    dexInfo(c.ca).then(dx => { if (dx && dx.paid !== c.dexPaid) { c.dexPaid = dx.paid; saveReg(); } }).catch(() => {});
  }
  const text = fmtAlert(c, ev);
  const extra = { reply_markup: kb(c) };   // Chart/Buy + HoodBridge/Pad/Get-Trending buttons
  if (c.media) { const r = await sendMedia(c.chatId, c.media, text, extra); if (r.ok) return; } // project's own art
  else { const r = await sendDefaultMedia(c.chatId, text, extra); if (r.ok) return; }              // shipped default video
  await send(c.chatId, text, extra);
}

// ---- chain watch: real-time via Alchemy WSS (eth_subscribe, no getLogs range limit) ----
const seenTx = new Set(); // dedupe guard (one alert per swap log)
async function handleSwapLog(log) {
  const c = Object.values(reg).find(x => x.pool.toLowerCase() === (log.address || "").toLowerCase());
  if (!c) return;
  const key = log.transactionHash + ":" + log.logIndex;
  if (seenTx.has(key)) return; seenTx.add(key); if (seenTx.size > 5000) seenTx.clear();
  const d = log.data.slice(2);
  const a0 = s256(d.slice(0, 64)), a1 = s256(d.slice(64, 128)), sq = BigInt("0x" + d.slice(128, 192));
  const wethDelta = c.wethIsT0 ? a0 : a1, tokDelta = c.wethIsT0 ? a1 : a0;
  if (wethDelta <= 0n) return;                             // WETH into pool = buy
  const eth = Number(abs(wethDelta)) / 1e18, usd = eth * ETHUSD;
  if (usd < (c.minBuy || 0)) return;
  const P = (Number(sq) / 2 ** 96) ** 2;
  const mc = (c.wethIsT0 ? 1 / P : P) * ETHUSD * c.supplyFactor;
  const tokens = Number(abs(tokDelta)) / 10 ** c.dec;
  let buyer = "0x" + log.topics[2].slice(26);
  try { const tx = await pub.request({ method: "eth_getTransactionByHash", params: [log.transactionHash] }); if (tx?.from) buyer = tx.from; } catch {}
  await postAlert(c, { eth, usd, tokens, mc, buyer });
}
// real-time buy watch via public-RPC polling (Alchemy WSS unusable — account hit its monthly capacity cap)
let lastWatch = 0;
async function watchSwaps() {
  try {
    const latest = Number(await scan.getBlockNumber());
    if (!lastWatch) lastWatch = latest;                    // first run: start from "now", don't replay history
    let from = lastWatch + 1;
    if (latest - from > 3000) from = latest - 3000;        // cap catch-up after downtime
    const pools = [...new Set(Object.values(reg).map(x => x.pool))];
    if (pools.length && latest >= from) {
      const logs = await scan.request({ method: "eth_getLogs", params: [{ address: pools, topics: [swapTopic], fromBlock: "0x" + from.toString(16), toBlock: "0x" + latest.toString(16) }] });
      for (const log of logs) await handleSwapLog(log).catch(() => {});
    }
    lastWatch = latest;
  } catch { /* transient RPC hiccup — retry next tick */ }
  setTimeout(watchSwaps, 4000);
}

// ---- telegram command loop ----
// one-tap vote button on buy alerts → no typing, no re-pasting CA
async function handleCallback(cq) {
  const data = cq.data || "";
  if (data.startsWith("vote:")) {
    const ca = data.slice(5).toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(ca)) { await api("answerCallbackQuery", { callback_query_id: cq.id, text: "Invalid token." }); return; }
    const uid = String(cq.from?.id);
    const prev = userVotes[uid];
    if (prev && prev.ca === ca && Date.now() - prev.ts < 24 * 3600e3) {
      const n = voteCounts()[ca] || 1;
      await api("answerCallbackQuery", { callback_query_id: cq.id, text: `Already voted 🗳️ (${n} in 24h)` });
      return;
    }
    userVotes[uid] = { ca, ts: Date.now() }; saveVotes();
    const n = voteCounts()[ca] || 1;
    await api("answerCallbackQuery", { callback_query_id: cq.id, text: `🗳️ Voted! ${n} vote${n > 1 ? "s" : ""} in 24h — most votes gets pinned Trending.`, show_alert: false });
    return;
  }
  if (data.startsWith("trend:")) {                              // trend:<chain>:<tier>:<ca>
    const [, chain, tierS, ca] = data.split(":");
    const tier = Number(tierS);
    if (!TIERS[chain] || !TIERS[chain][tier] || !ca || (chain === "sol" ? !isSol(ca) : !isEvm(ca))) { await api("answerCallbackQuery", { callback_query_id: cq.id, text: "Invalid option." }); return; }
    const chatId = cq.message?.chat?.id;
    if (!chatId) { await api("answerCallbackQuery", { callback_query_id: cq.id, text: "Open @hoodxchangebot in DM and tap again." }); return; }
    const sym = await trendSym(chain, ca);
    const group = Object.values(reg).find(x => x.ca === ca.toLowerCase())?.links?.tg;
    const o = newOrder("boost", chain, ca, TIERS[chain][tier], sym, chatId, group, tier);
    await api("answerCallbackQuery", { callback_query_id: cq.id, text: "Payment address sent below 👇" });
    await send(chatId, `🔥 <b>Trend ${esc(sym)} — ${TIER_LABEL[tier]}</b> (${TREND_HOURS}h)\n\nSend <b>exactly</b> this amount:\n💸 <code>${o.amount}</code> ${o.coin}\n📥 to: <code>${esc(o.wallet)}</code>\n\n⏱️ Auto-detected on-chain in ~1 min after it lands — you'll be pinned + announced automatically. Order expires in 60 min.\n<i>Send the exact amount so we can match your payment.</i>`);
    return;
  }
  if (data.startsWith("verify:")) {                            // verify:<chain>:<ca>
    const [, chain, ca] = data.split(":");
    if (!VERIFY_PRICE[chain] || !ca || (chain === "sol" ? !isSol(ca) : !isEvm(ca))) { await api("answerCallbackQuery", { callback_query_id: cq.id, text: "Invalid option." }); return; }
    const chatId = cq.message?.chat?.id;
    if (!chatId) { await api("answerCallbackQuery", { callback_query_id: cq.id, text: "Open @hoodxchangebot in DM and tap again." }); return; }
    const sym = await trendSym(chain, ca);
    const group = Object.values(reg).find(x => x.ca === ca.toLowerCase())?.links?.tg;
    const o = newOrder("verify", chain, ca, VERIFY_PRICE[chain], sym, chatId, group);
    await api("answerCallbackQuery", { callback_query_id: cq.id, text: "Payment address sent below 👇" });
    await send(chatId, `🛡️ <b>HoodX Verified — ${esc(sym)}</b> (${VERIFY_DAYS} days)\n\nSend <b>exactly</b>:\n💸 <code>${o.amount}</code> ${o.coin}\n📥 to: <code>${esc(o.wallet)}</code>\n\n⏱️ Auto-activates ~1 min after it lands. You get the 🛡️ badge + live 24/7 rug-watch with instant holder alerts. Expires in 60 min.`);
    return;
  }
  await api("answerCallbackQuery", { callback_query_id: cq.id });
}

let offset = 0;
async function tgTick() {
  const r = await api("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] });
  if (!r.ok) { await sleep(3000); return; } // backoff on error
  for (const u of r.result) {
    offset = u.update_id + 1;
    if (u.callback_query) { await handleCallback(u.callback_query).catch(() => {}); continue; }
    const msg = u.message; if (!msg) continue;
    const chatId = msg.chat.id;
    // uploaded media → save as this token's buy art (works in DM always; in groups when replying to the bot or with privacy off)
    const up = extractMedia(msg);
    if (up) {
      const c = Object.values(reg).find(x => x.chatId === chatId);
      if (c && (awaiting.has(chatId) || (msg.caption || "").toLowerCase().includes("/setmedia"))) {
        c.media = up; saveReg(); awaiting.delete(chatId);
        await send(chatId, "🖼️ Buy media saved — it'll show on every buy alert.");
      }
      continue;
    }
    if (!msg.text) continue;
    const parts = msg.text.trim().split(/\s+/);
    const ci = parts.findIndex(p => p.startsWith("/"));      // command can be anywhere (handles "@bot /cmd")
    if (ci < 0) continue;
    const base = parts[ci].split("@")[0].toLowerCase();
    const after = parts.slice(ci + 1);
    const arg = after[0]; const rest = after.join(" ");
    console.log(`[cmd] ${base} from chat ${chatId} (${msg.chat.type})`);
    try {
    if (base === "/start") {
      await send(chatId, "👋 <b>HoodXChange Buy Bot</b>\nAdd me as admin, then:\n<code>/register &lt;CA&gt;</code> — watch your token\n<code>/setmedia</code> — then upload your buy image/gif/video\n<code>/setemoji 🔥</code> — custom buy emoji\n<code>/setlinks chart=.. buy=.. x=.. tg=..</code>\n<code>/scan &lt;CA&gt;</code> — 🛡️ safety check (LP lock, honeypot, liq)\n<code>/chart &lt;CA&gt;</code> — price / MC / liquidity\n<code>/test</code> — preview an alert");
    } else if (base === "/register") {
      if (!/^0x[0-9a-fA-F]{40}$/.test(arg || "")) { await send(chatId, "Usage: <code>/register 0xYourTokenCA</code>"); continue; }
      const ca = arg.toLowerCase();
      const rp = await resolvePool(ca); if (!rp) { await send(chatId, "❌ No WETH pool found for that CA on Robinhood Chain."); continue; }
      let wethIsT0, sym = "$TOKEN", dec = 18, supplyFactor = 0;
      try {
        wethIsT0 = (await pub.readContract({ address: rp.pool, abi: POOLABI, functionName: "token0" })).toLowerCase() === WETH;
        try { sym = ticker(await pub.readContract({ address: ca, abi: ERC20, functionName: "symbol" })); } catch {}
        try { dec = Number(await pub.readContract({ address: ca, abi: ERC20, functionName: "decimals" })); } catch {}
        const ts = await pub.readContract({ address: ca, abi: ERC20, functionName: "totalSupply" });
        supplyFactor = Number(ts) / 1e18; // MC = price_in_eth * ETHUSD * (totalSupply_raw/1e18), decimal-independent
      } catch { await send(chatId, "❌ Couldn't read token/pool. Is the CA correct?"); continue; }
      reg[ca] = { emoji: null, step: 10, minBuy: 0, links: {}, ...(reg[ca] || {}), chatId, ca, pool: rp.pool, fee: rp.fee, wethIsT0, sym, dec, supplyFactor }; // emoji null → branded HoodX default; keep user settings, recompute token fields
      const dx = await dexInfo(ca);
      if (dx) {
        const c2 = reg[ca]; c2.links = c2.links || {};
        if (!c2.links.chart && dx.dexUrl) c2.links.chart = dx.dexUrl;   // auto-setup: pull chart + socials
        if (!c2.links.x && dx.x) c2.links.x = dx.x;
        if (!c2.links.tg && dx.tg) c2.links.tg = dx.tg;
        c2.dexPaid = dx.paid;
      }
      saveReg();
      const dexStatus = dx ? (dx.paid ? `🔵 DexScreener: <b>Paid ✅</b>${dx.boosts ? ` · ⚡${dx.boosts} boosts` : ""}` : dx.enhanced ? "🔵 DexScreener: enhanced profile" : "🔵 DexScreener: not paid yet") : "";
      const pulled = dx && (dx.x || dx.tg || dx.dexUrl) ? "\n🔗 Auto-pulled chart + socials from DexScreener." : "";
      await send(chatId, `✅ Watching <b>${esc(sym)}</b>\nPool <code>${rp.pool}</code>\n${dexStatus}${pulled}\nAdd art with <code>/setmedia</code>, custom emoji <code>/setemoji</code>, preview <code>/test</code>.`);
    } else if (base === "/setmedia") {
      const c = Object.values(reg).find(x => x.chatId === chatId); if (!c) { await send(chatId, "Register first: <code>/register &lt;CA&gt;</code>"); continue; }
      if (/^https?:\/\//i.test(arg || "")) { c.media = arg; saveReg(); await send(chatId, "🖼️ Buy media set."); }
      else { awaiting.add(chatId); await send(chatId, "📎 Send me the image / GIF / video now (just upload it here) and I'll use it on every buy alert."); }
    } else if (base === "/setlinks") {
      const c = Object.values(reg).find(x => x.chatId === chatId); if (!c) { await send(chatId, "Register first."); continue; }
      c.links = c.links || {};
      for (const kv of rest.split(/\s+/)) { const [k, v] = kv.split("="); if (["chart", "buy", "x", "tg"].includes(k) && /^https?:\/\//i.test(v || "")) c.links[k] = v; }
      saveReg(); await send(chatId, "🔗 Links updated.");
    } else if (base === "/setemoji") {
      const c = Object.values(reg).find(x => x.chatId === chatId); if (!c) { await send(chatId, "Register first: <code>/register &lt;CA&gt;</code>"); continue; }
      const stepArg = after.find(p => /^\d+$/.test(p)); if (stepArg) c.step = Math.max(1, Number(stepArg));
      const cent = (msg.entities || []).find(e => e.type === "custom_emoji");   // project sent their own custom emoji?
      if (cent) {
        const cand = { ceid: cent.custom_emoji_id, fb: msg.text.substring(cent.offset, cent.offset + cent.length) };
        const test = await api("sendMessage", { chat_id: chatId, text: `Custom buy emoji → ${emojiUnit(cand)}`, parse_mode: "HTML" });  // validate the bot may re-send it
        if (test.ok) { c.emoji = cand; saveReg(); await send(chatId, `✅ Your custom buy emoji is set (1 per $${c.step}). Preview: <code>/test</code>`); }
        else { await send(chatId, "⚠️ Telegram won't let me re-send that particular custom emoji (bots can only reuse some). Try another, use a standard emoji, or <code>/setemoji default</code> for the HoodX one."); }
        continue;
      }
      if (/^(default|reset|hoodx)$/i.test(arg || "")) { c.emoji = null; saveReg(); await send(chatId, `✅ Reset to the HoodX buy emoji ${emojiUnit(BUY_DEFAULT)} (1 per $${c.step}).`); continue; }
      if (!arg || /^\d+$/.test(arg)) { await send(chatId, `Usage: <code>/setemoji 🔥</code> — send a standard OR custom emoji (right in the command).\n<code>/setemoji default</code> — HoodX default ${emojiUnit(BUY_DEFAULT)}\nOptional $ per emoji: <code>/setemoji 🔥 20</code>`); continue; }
      c.emoji = arg; saveReg();
      await send(chatId, `✅ Buy emoji set: ${esc(arg)} (1 per $${c.step}). Preview: <code>/test</code>`);
    } else if (base === "/chart") {
      const ca = (arg && /^0x[0-9a-fA-F]{40}$/.test(arg)) ? arg.toLowerCase() : Object.values(reg).find(x => x.chatId === chatId)?.ca;
      if (!ca) { await send(chatId, "Usage: <code>/chart &lt;CA&gt;</code>"); continue; }
      const s = await stats(ca); if (!s) { await send(chatId, "❌ No WETH pool found for that CA."); continue; }
      await send(chatId, `<b>${esc(s.sym)}</b>\n💵 Price $${s.priceUsd.toPrecision(3)}\n📊 MC $${s.mc.toLocaleString(undefined, { maximumFractionDigits: 0 })}\n💧 Liquidity $${s.liqUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}\n<code>${ca}</code>`);
    } else if (base === "/scan") {
      const ca = (arg && /^0x[0-9a-fA-F]{40}$/.test(arg)) ? arg.toLowerCase() : Object.values(reg).find(x => x.chatId === chatId)?.ca;
      if (!ca) { await send(chatId, "Usage: <code>/scan &lt;CA&gt;</code>"); continue; }
      await send(chatId, "🔍 Scanning…");
      const s = await stats(ca); if (!s) { await send(chatId, "❌ No WETH pool found for that CA."); continue; }
      const [lp, act, dx] = await Promise.all([lpStatus(s.pool), activity(s), dexInfo(ca)]);
      const lpLine = lp.locked === true ? `✅ LP locked (${esc(lp.how)})` : lp.locked === false ? "🚨 LP <b>NOT locked</b> — dev can pull it" : "❓ LP status unknown";
      const sellLine = act.sells > 0 ? `✅ Sells work (${act.sells} sells / ${act.buys} buys)` : act.buys > 0 ? "🚨 Buys but <b>ZERO sells</b> — possible honeypot" : "❓ No recent trades";
      const liqLine = s.liqUsd >= 3000 ? `✅ Liquidity $${s.liqUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : `⚠️ Thin liquidity $${s.liqUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
      const dexLine = !dx ? "❓ DexScreener: n/a" : dx.paid ? `🔵 DexScreener <b>Paid ✅</b>${dx.paidTypes.length ? ` (${dx.paidTypes.map(esc).join(", ")})` : ""}${dx.boosts ? ` · ⚡${dx.boosts} boosts` : ""}` : dx.enhanced ? "🔵 DexScreener: enhanced profile (unpaid)" : "⚪ DexScreener: not paid";
      const socialLine = dx && (dx.x || dx.tg || dx.website) ? `🔗 Socials: ${[dx.website && "web", dx.x && "X", dx.tg && "TG"].filter(Boolean).join(" · ")}` : "⚠️ No socials on DexScreener";
      const flags = [lp.locked === false, act.sells === 0 && act.buys > 0, s.liqUsd < 3000].filter(Boolean).length;
      const verdict = flags === 0 ? "🟢 Looks clean" : flags === 1 ? "🟡 Caution" : "🔴 High risk";
      await send(chatId, `<b>🛡️ HoodX Scan — ${esc(s.sym)}</b>\n${lpLine}\n${sellLine}\n${liqLine}\n${dexLine}\n${socialLine}\n📊 MC $${s.mc.toLocaleString(undefined, { maximumFractionDigits: 0 })}\n\n<b>${verdict}</b>\n<i>Heuristic — always DYOR.</i>`);
    } else if (base === "/trend") {
      // paid trending: figure out chain + token, then show tier buttons (payment is auto-verified on-chain)
      let tca = after.find(p => isEvm(p) || isSol(p));
      let tchain = tca ? (isSol(tca) ? "sol" : "rhc") : null;
      if (!tca) { const c = Object.values(reg).find(x => x.chatId === chatId); if (c) { tca = c.ca; tchain = "rhc"; } }
      if (!tca) { await send(chatId, "🔥 <b>Get on HoodX Trending</b>\nIn your token's group: <code>/trend</code>\nAnywhere: <code>/trend &lt;CA or SOL mint&gt;</code>\n\nYou pay in the chain's coin, we pin you automatically once it lands."); continue; }
      const tsym = await trendSym(tchain, tca);
      const P = TIERS[tchain], coin = tchain === "sol" ? "SOL" : "ETH";
      const btn = t => ({ text: `${TIER_LABEL[t]} · ${P[t]} ${coin}`, callback_data: `trend:${tchain}:${t}:${tca}` });
      await send(chatId, `🔥 <b>Trend ${esc(tsym)}</b> on <b>HoodX — ${tchain === "sol" ? "Solana" : "Robinhood Chain"}</b>\nPick a slot (pinned ${TREND_HOURS}h + 💎 announced + 🔥 badge in your group):`, { reply_markup: { inline_keyboard: [[btn(1)], [btn(3)], [btn(10)]] } });
    } else if (base === "/verify") {
      // 🛡️ HoodX Verified — paid live rug-watch badge
      let vca = after.find(p => isEvm(p) || isSol(p));
      let vchain = vca ? (isSol(vca) ? "sol" : "rhc") : null;
      if (!vca) { const c = Object.values(reg).find(x => x.chatId === chatId); if (c) { vca = c.ca; vchain = "rhc"; } }
      if (!vca) { await send(chatId, "🛡️ <b>HoodX Verified — 24/7 rug-watch</b>\nIn your token's group: <code>/verify</code>\nAnywhere: <code>/verify &lt;CA or SOL mint&gt;</code>\n\nEarn the 🛡️ badge + we watch your LP live and alert holders instantly if it ever moves."); continue; }
      if (verifiedNow(isSol(vca) ? vca : vca.toLowerCase())) { await send(chatId, "🛡️ Already HoodX Verified & being watched."); continue; }
      const vsym = await trendSym(vchain, vca);
      const coin = vchain === "sol" ? "SOL" : "ETH";
      await send(chatId, `🛡️ <b>Get HoodX Verified — ${esc(vsym)}</b>\nLive 24/7 rug-watch + trust badge on the board & every buy alert. Holders alerted the instant LP unlocks or liquidity drains.\n\n<b>${VERIFY_PRICE[vchain]} ${coin}</b> / ${VERIFY_DAYS} days:`, { reply_markup: { inline_keyboard: [[{ text: `🛡️ Verify — ${VERIFY_PRICE[vchain]} ${coin}`, callback_data: `verify:${vchain}:${vca}` }]] } });
    } else if (base === "/boost") {   // admin manual override (free pin) — paid flow is /trend
      if (!ADMIN_IDS.has(String(msg.from?.id))) { await send(chatId, "⛔ Admins only. Projects: use <code>/trend</code> for the paid boost."); continue; }
      const bca = after.find(p => isEvm(p) || isSol(p));
      const hrs = Number(after.find(p => /^\d+$/.test(p)));
      const tier = Number(after.find(p => p === "1" || p === "3" || p === "10")) || 1;
      if (bca && hrs) {
        const key = isSol(bca) ? bca : bca.toLowerCase();
        boosts[key] = { until: Date.now() + hrs * 3600e3, tier, chain: isSol(bca) ? "sol" : "rhc", sym: await trendSym(isSol(bca) ? "sol" : "rhc", bca) }; saveBoosts();
        await send(chatId, `🔥 Boosted <code>${esc(bca)}</code> ${TIER_LABEL[tier]} for ${hrs}h.`);
        postTrending();
      } else {
        await send(chatId, "⚡ <b>Boost (admin manual)</b>\n<code>/boost &lt;CA&gt; &lt;hours&gt; [1|3|10]</code>\n\nProjects: use <code>/trend</code> for the paid auto-verified boost.");
      }
    } else if (base === "/vote") {
      const c = Object.values(reg).find(x => x.chatId === chatId);      // in a project's group → the bot already knows the token
      const argCa = after.find(p => isEvm(p) || isSol(p));
      const vca = c?.ca || (argCa ? (isSol(argCa) ? argCa : argCa.toLowerCase()) : null);
      if (!vca) { await send(chatId, `🗳️ <b>Vote your project onto HoodX Trending</b>\nAdd @hoodxchangebot to your project's group, then anyone just sends <code>/vote</code> there — the bot knows your token, no CA needed.\n🏆 Top-voted projects get their own card in Trending every hour. 1 vote / person / 24h.`); continue; }
      const uid = String(msg.from?.id || chatId);
      const prev = userVotes[uid];
      let sym = c?.sym; if (!sym) { try { sym = await trendSym(isSol(vca) ? "sol" : "rhc", vca); } catch { sym = vca.slice(0, 8); } }
      if (prev && prev.ca === vca && Date.now() - prev.ts < 24 * 3600e3) { await send(chatId, `🗳️ You already voted for <b>${esc(sym)}</b> — <b>${voteCounts()[vca] || 1}</b> votes in 24h.`); continue; }
      userVotes[uid] = { ca: vca, ts: Date.now() }; saveVotes();
      const n = voteCounts()[vca] || 1;
      await send(chatId, `🗳️ Vote counted for <b>${esc(sym)}</b> — <b>${n}</b> vote${n > 1 ? "s" : ""} in 24h.\n🏆 Top-voted projects get their own card in HoodX Trending every hour.`);
    } else if (base === "/votes") {
      const top = Object.entries(voteCounts()).sort((a, b) => b[1] - a[1]).slice(0, 10);
      if (!top.length) { await send(chatId, "No votes yet — <code>/vote &lt;CA&gt;</code> to start."); continue; }
      const lines = [];
      for (const [ca, n] of top) { let sym = ca.slice(0, 8); try { sym = ticker(await pub.readContract({ address: ca, abi: ERC20, functionName: "symbol" })); } catch {} lines.push(`🗳️ ${esc(sym)} — <b>${n}</b>`); }
      await send(chatId, `<b>🗳️ Vote Leaderboard (24h)</b>\n\n${lines.join("\n")}`);
    } else if (base === "/trending") {
      if (!ADMIN_IDS.has(String(msg.from?.id))) continue;   // operator-only manual refresh
      await postTrending(); await send(chatId, "📈 Trending refreshed.");
    } else if (base === "/test") {
      const c = Object.values(reg).find(x => x.chatId === chatId); if (!c) { await send(chatId, "Register first: <code>/register &lt;CA&gt;</code>"); continue; }
      await postAlert(c, { eth: 0.45, usd: 842, tokens: 480000, mc: 46955, buyer: "0x3484f2b7b8c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4" });
    }
    } catch (e) { console.error(`[cmd err] ${base}:`, e?.message); }   // one bad command never drops the rest of the update batch
  }
}

console.log("HoodXChange Buy Bot running (audited). Public-RPC reads + swap polling + @hoodxchangebot.");
api("setMyCommands", { commands: [
  { command: "register", description: "Watch your token — add your CA" },
  { command: "scan", description: "🛡️ Safety check: LP lock, honeypot, liquidity" },
  { command: "chart", description: "Price / market cap / liquidity" },
  { command: "setmedia", description: "Upload your buy image / gif / video" },
  { command: "setemoji", description: "Set a custom buy emoji" },
  { command: "setlinks", description: "Set chart / buy / X / TG links" },
  { command: "trend", description: "🔥 Get on HoodX Trending (paid, auto-verified)" },
  { command: "verify", description: "🛡️ HoodX Verified — live 24/7 rug-watch badge" },
  { command: "test", description: "Preview a buy alert" },
  { command: "start", description: "Setup instructions" },
] });
(async () => { while (true) { await tgTick().catch(() => sleep(2000)); } })();
watchSwaps();
watchEvmPayments();   // auto-verify RHC trend/verify payments (persisted balance-delta)
watchSolPayments();   // auto-verify Solana trend/verify payments (persisted balance-delta)
watchVerified();      // 🛡️ live rug-watch on Verified tokens
setInterval(sweepOrders, 15 * 60 * 1000);   // reap long-expired pending orders
if ((env.TRENDING_ON ?? "1") !== "0") {
  postTrending(); setInterval(postTrending, 10 * 60 * 1000);      // volume/paid boards refresh every 10 min
  setTimeout(postVoteCard, 30 * 1000); setInterval(postVoteCard, 60 * 60 * 1000);  // 🏆 top-voted card once an hour
}
