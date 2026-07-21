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
const pub = createPublicClient({ chain, transport: http(HTTP, { timeout: 15000, retryCount: 2 }) });

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
  const isVid = /\.(mp4|gif)$/i.test(media) || media.startsWith("vid:");
  const m = media.replace(/^vid:/, "");
  return api(isVid ? "sendAnimation" : "sendPhoto", { chat_id, [isVid ? "animation" : "photo"]: m, caption, parse_mode: "HTML", ...extra });
};

// ---- registry ----
const REGF = new URL("./registry.json", import.meta.url);
let reg = fs.existsSync(REGF) ? JSON.parse(fs.readFileSync(REGF, "utf8")) : {};
const saveReg = () => fs.writeFileSync(REGF, JSON.stringify(reg, null, 2));

async function resolvePool(ca) {
  for (const f of [10000, 3000, 500, 100]) {
    try { const p = await pub.readContract({ address: V3, abi: FAC, functionName: "getPool", args: [ca, WETH, f] }); if (p && p.toLowerCase() !== ZERO) return { pool: p, fee: f }; } catch {}
  }
  return null;
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

// ---- chain watch (poll registered pools; guarded against overlap + dup posts) ----
let lastBlock = 0, busy = false;
async function watchTick() {
  if (busy) return; busy = true;
  try {
    const latest = Number(await pub.getBlockNumber());
    if (!lastBlock) { lastBlock = latest; return; }
    if (latest <= lastBlock) return;
    const entries = Object.values(reg);
    if (!entries.length) { lastBlock = latest; return; }
    const pools = entries.map(c => c.pool);
    const from = lastBlock + 1;
    const logs = await pub.request({ method: "eth_getLogs", params: [{ address: pools, topics: [swapTopic], fromBlock: "0x" + from.toString(16), toBlock: "0x" + latest.toString(16) }] });
    lastBlock = latest; // advance BEFORE posting so a post failure can't cause re-scan/dupes
    for (const l of logs) {
      const c = entries.find(x => x.pool.toLowerCase() === l.address.toLowerCase());
      if (!c) continue;
      const d = l.data.slice(2);
      const a0 = s256(d.slice(0, 64)), a1 = s256(d.slice(64, 128)), sq = BigInt("0x" + d.slice(128, 192));
      const wethDelta = c.wethIsT0 ? a0 : a1, tokDelta = c.wethIsT0 ? a1 : a0;
      if (wethDelta <= 0n) continue;                       // WETH into pool = buy; else skip
      const eth = Number(abs(wethDelta)) / 1e18;           // WETH always 18 dec
      const usd = eth * ETHUSD;
      if (usd < (c.minBuy || 0)) continue;
      const P = (Number(sq) / 2 ** 96) ** 2;
      const mc = (c.wethIsT0 ? 1 / P : P) * ETHUSD * c.supplyFactor; // decimal-independent MC
      const tokens = Number(abs(tokDelta)) / 10 ** c.dec;  // real token decimals
      let buyer = "0x" + l.topics[2].slice(26);
      try { const tx = await pub.request({ method: "eth_getTransactionByHash", params: [l.transactionHash] }); if (tx?.from) buyer = tx.from; } catch {} // real sender, not router
      await postAlert(c, { eth, usd, tokens, mc, buyer });
      await sleep(200); // gentle throttle to avoid Telegram 429 on bursts
    }
  } catch (e) { /* transient; retry next tick from same lastBlock+1 only if getLogs itself failed */ }
  finally { busy = false; }
}

// ---- telegram command loop ----
let offset = 0;
async function tgTick() {
  const r = await api("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
  if (!r.ok) { await sleep(3000); return; } // backoff on error
  for (const u of r.result) {
    offset = u.update_id + 1;
    const msg = u.message; if (!msg?.text) continue;
    const chatId = msg.chat.id; const parts = msg.text.trim().split(/\s+/);
    const ci = parts.findIndex(p => p.startsWith("/"));      // command can be anywhere (handles "@bot /cmd")
    if (ci < 0) continue;
    const base = parts[ci].split("@")[0].toLowerCase();
    const after = parts.slice(ci + 1);
    const arg = after[0]; const rest = after.join(" ");
    console.log(`[cmd] ${base} from chat ${chatId} (${msg.chat.type})`);
    if (base === "/start") {
      await send(chatId, "👋 <b>HoodXChange Buy Bot</b>\nAdd me as admin, then:\n<code>/register &lt;CA&gt;</code> — watch your token\n<code>/setmedia &lt;url&gt;</code> — buy image/gif\n<code>/setlinks chart=.. buy=.. x=.. tg=..</code>\n<code>/test</code> — preview an alert");
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
      if (!/^https?:\/\//i.test(arg || "")) { await send(chatId, "Usage: <code>/setmedia https://...image_or_gif</code>"); continue; }
      c.media = arg; saveReg(); await send(chatId, "🖼️ Buy media set.");
    } else if (base === "/setlinks") {
      const c = Object.values(reg).find(x => x.chatId === chatId); if (!c) { await send(chatId, "Register first."); continue; }
      c.links = c.links || {};
      for (const kv of rest.split(/\s+/)) { const [k, v] = kv.split("="); if (["chart", "buy", "x", "tg"].includes(k) && /^https?:\/\//i.test(v || "")) c.links[k] = v; }
      saveReg(); await send(chatId, "🔗 Links updated.");
    } else if (base === "/test") {
      const c = Object.values(reg).find(x => x.chatId === chatId); if (!c) { await send(chatId, "Register first: <code>/register &lt;CA&gt;</code>"); continue; }
      await postAlert(c, { eth: 0.45, usd: 842, tokens: 480000, mc: 46955, buyer: "0x3484f2b7b8c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4" });
    }
  }
}

console.log("HoodXChange Buy Bot running (audited). Alchemy + @hoodxchangebot.");
(async () => { while (true) { await tgTick().catch(() => sleep(2000)); } })();
setInterval(watchTick, 4000);
