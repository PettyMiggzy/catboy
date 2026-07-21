// HoodXChange Buy Bot — MVP (audited)
// Projects add @hoodxchangebot to their group (admin), /register <CA>, /setmedia, /setlinks, /test.
// Watches registered token pools on Robinhood Chain via Alchemy and posts buy alerts.
import { createPublicClient, http, keccak256, toHex } from "viem";
import fs from "fs";

// ---- env (gitignored buybot.env) ----
const env = Object.fromEntries(
  fs.readFileSync(new URL("./buybot.env", import.meta.url), "utf8").trim().split("\n")
    .filter(l => l.includes("="))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
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
    [{ text: "🔥 Get Trending", url: HOODX.trendingBuy }],
  ] };
}

const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73".toLowerCase();
const V3 = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const chain = { id: 4663, name: "rh", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [HTTP] } } };
const pub = createPublicClient({ chain, transport: http(HTTP, { timeout: 15000, retryCount: 2 }) });               // Alchemy: reads (fine on free tier)
const scan = createPublicClient({ chain, transport: http("https://rpc.mainnet.chain.robinhood.com", { timeout: 20000, retryCount: 1 }) }); // public RPC: getLogs history (Alchemy free tier caps getLogs at 10 blocks)

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
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); // HTML-safe

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
let reg = fs.existsSync(REGF) ? JSON.parse(fs.readFileSync(REGF, "utf8")) : {};
const saveReg = () => fs.writeFileSync(REGF, JSON.stringify(reg, null, 2));
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
  try { sym = "$" + await pub.readContract({ address: ca, abi: ERC20, functionName: "symbol" }); } catch {}
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

// ---- alert formatting ----
function bar(usd, emoji, step) { const n = Math.max(1, Math.min(60, Math.floor(usd / step))); return emoji.repeat(n); }
function fmtAlert(c, ev) {
  const links = [];
  if (c.links?.chart) links.push(`<a href="${esc(c.links.chart)}">Chart</a>`);
  if (c.links?.buy) links.push(`<a href="${esc(c.links.buy)}">Buy</a>`);
  if (c.links?.x) links.push(`<a href="${esc(c.links.x)}">X</a>`);
  if (c.links?.tg) links.push(`<a href="${esc(c.links.tg)}">TG</a>`);
  return [
    `<b>${esc(c.sym)} Buy!</b>`,
    bar(ev.usd, c.emoji || "🟢", c.step || 10),
    `💰 <b>$${ev.usd.toFixed(0)}</b> (${ev.eth.toFixed(4)} ETH)`,
    `🪙 ${ev.tokens.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${esc(c.sym)}`,
    `📊 MC $${ev.mc.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
    `👤 <code>${ev.buyer.slice(0, 6)}…${ev.buyer.slice(-4)}</code>`,
    `\n${sponsorLine()}`,            // rotating sponsor/ads slot (network ad inventory)
    links.length ? links.join("  •  ") : ""
  ].filter(Boolean).join("\n");
}
async function postAlert(c, ev) {
  const text = fmtAlert(c, ev);
  const extra = { reply_markup: kb(c) };   // Chart/Buy + HoodBridge/Pad/Get-Trending buttons
  if (c.media) { const r = await sendMedia(c.chatId, c.media, text, extra); if (r.ok) return; }
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
function connectWss() {
  let ws;
  try { ws = new WebSocket(env.ALCHEMY_WSS); } catch (e) { console.log("WSS init failed, retry 3s"); return void setTimeout(connectWss, 3000); }
  ws.onopen = () => { ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["logs", { topics: [swapTopic] }] })); console.log("WSS subscribed to Swap logs (real-time)"); };
  ws.onmessage = (ev) => { try { const m = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()); if (m.method === "eth_subscription" && m.params?.result) handleSwapLog(m.params.result); } catch {} };
  ws.onclose = () => { console.log("WSS closed — reconnecting in 3s"); setTimeout(connectWss, 3000); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

// ---- telegram command loop ----
let offset = 0;
async function tgTick() {
  const r = await api("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
  if (!r.ok) { await sleep(3000); return; } // backoff on error
  for (const u of r.result) {
    offset = u.update_id + 1;
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
    if (base === "/start") {
      await send(chatId, "👋 <b>HoodXChange Buy Bot</b>\nAdd me as admin, then:\n<code>/register &lt;CA&gt;</code> — watch your token\n<code>/setmedia &lt;url&gt;</code> — buy image/gif\n<code>/setlinks chart=.. buy=.. x=.. tg=..</code>\n<code>/scan &lt;CA&gt;</code> — 🛡️ safety check (LP lock, honeypot, liq)\n<code>/chart &lt;CA&gt;</code> — price / MC / liquidity\n<code>/test</code> — preview an alert");
    } else if (base === "/register") {
      if (!/^0x[0-9a-fA-F]{40}$/.test(arg || "")) { await send(chatId, "Usage: <code>/register 0xYourTokenCA</code>"); continue; }
      const ca = arg.toLowerCase();
      const rp = await resolvePool(ca); if (!rp) { await send(chatId, "❌ No WETH pool found for that CA on Robinhood Chain."); continue; }
      let wethIsT0, sym = "$TOKEN", dec = 18, supplyFactor = 0;
      try {
        wethIsT0 = (await pub.readContract({ address: rp.pool, abi: POOLABI, functionName: "token0" })).toLowerCase() === WETH;
        try { sym = "$" + await pub.readContract({ address: ca, abi: ERC20, functionName: "symbol" }); } catch {}
        try { dec = Number(await pub.readContract({ address: ca, abi: ERC20, functionName: "decimals" })); } catch {}
        const ts = await pub.readContract({ address: ca, abi: ERC20, functionName: "totalSupply" });
        supplyFactor = Number(ts) / 1e18; // MC = price_in_eth * ETHUSD * (totalSupply_raw/1e18), decimal-independent
      } catch { await send(chatId, "❌ Couldn't read token/pool. Is the CA correct?"); continue; }
      reg[ca] = { chatId, ca, pool: rp.pool, fee: rp.fee, wethIsT0, sym, dec, supplyFactor, emoji: "🟢", step: 10, minBuy: 0, links: {}, ...(reg[ca] || {}), chatId };
      saveReg();
      await send(chatId, `✅ Watching <b>${esc(sym)}</b>\nPool <code>${rp.pool}</code>\nBuys will post here. Add art with <code>/setmedia</code>, links with <code>/setlinks</code>, preview with <code>/test</code>.`);
    } else if (base === "/setmedia") {
      const c = Object.values(reg).find(x => x.chatId === chatId); if (!c) { await send(chatId, "Register first: <code>/register &lt;CA&gt;</code>"); continue; }
      if (/^https?:\/\//i.test(arg || "")) { c.media = arg; saveReg(); await send(chatId, "🖼️ Buy media set."); }
      else { awaiting.add(chatId); await send(chatId, "📎 Send me the image / GIF / video now (just upload it here) and I'll use it on every buy alert."); }
    } else if (base === "/setlinks") {
      const c = Object.values(reg).find(x => x.chatId === chatId); if (!c) { await send(chatId, "Register first."); continue; }
      c.links = c.links || {};
      for (const kv of rest.split(/\s+/)) { const [k, v] = kv.split("="); if (["chart", "buy", "x", "tg"].includes(k) && /^https?:\/\//i.test(v || "")) c.links[k] = v; }
      saveReg(); await send(chatId, "🔗 Links updated.");
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
      const lp = await lpStatus(s.pool); const act = await activity(s);
      const lpLine = lp.locked === true ? `✅ LP locked (${esc(lp.how)})` : lp.locked === false ? "🚨 LP <b>NOT locked</b> — dev can pull it" : "❓ LP status unknown";
      const sellLine = act.sells > 0 ? `✅ Sells work (${act.sells} sells / ${act.buys} buys)` : act.buys > 0 ? "🚨 Buys but <b>ZERO sells</b> — possible honeypot" : "❓ No recent trades";
      const liqLine = s.liqUsd >= 3000 ? `✅ Liquidity $${s.liqUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : `⚠️ Thin liquidity $${s.liqUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
      const flags = [lp.locked === false, act.sells === 0 && act.buys > 0, s.liqUsd < 3000].filter(Boolean).length;
      const verdict = flags === 0 ? "🟢 Looks clean" : flags === 1 ? "🟡 Caution" : "🔴 High risk";
      await send(chatId, `<b>🛡️ HoodX Scan — ${esc(s.sym)}</b>\n${lpLine}\n${sellLine}\n${liqLine}\n📊 MC $${s.mc.toLocaleString(undefined, { maximumFractionDigits: 0 })}\n\n<b>${verdict}</b>\n<i>Heuristic — always DYOR.</i>`);
    } else if (base === "/test") {
      const c = Object.values(reg).find(x => x.chatId === chatId); if (!c) { await send(chatId, "Register first: <code>/register &lt;CA&gt;</code>"); continue; }
      await postAlert(c, { eth: 0.45, usd: 842, tokens: 480000, mc: 46955, buyer: "0x3484f2b7b8c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4" });
    }
  }
}

console.log("HoodXChange Buy Bot running (audited). Alchemy WSS + @hoodxchangebot.");
api("setMyCommands", { commands: [
  { command: "register", description: "Watch your token — add your CA" },
  { command: "scan", description: "🛡️ Safety check: LP lock, honeypot, liquidity" },
  { command: "chart", description: "Price / market cap / liquidity" },
  { command: "setmedia", description: "Set your buy image or gif" },
  { command: "setlinks", description: "Set chart / buy / X / TG links" },
  { command: "test", description: "Preview a buy alert" },
  { command: "start", description: "Setup instructions" },
] });
(async () => { while (true) { await tgTick().catch(() => sleep(2000)); } })();
connectWss();
