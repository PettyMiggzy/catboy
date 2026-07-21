// HoodXChange Buy Bot — MVP
// Projects add @hoodxchangebot to their group (admin), /register <CA>, /setmedia, /test.
// Watches registered token pools on Robinhood Chain via Alchemy and posts buy alerts.
import { createPublicClient, http, keccak256, toHex, formatEther } from "viem";
import fs from "fs";

// ---- env (gitignored buybot.env) ----
const env = Object.fromEntries(
  fs.readFileSync(new URL("./buybot.env", import.meta.url), "utf8").trim().split("\n")
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const BOT = env.TG_BOT_TOKEN;
const HTTP = env.ALCHEMY_HTTP;
const ETHUSD = Number(env.ETHUSD || 1872), SUPPLY = 1e9;

const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73".toLowerCase();
const V3 = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const NOXA = "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb"; // extra factory fallback not needed for MVP
const chain = { id: 4663, name: "rh", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [HTTP] } } };
const pub = createPublicClient({ chain, transport: http(HTTP, { timeout: 15000, retryCount: 2 }) });

const FAC = [{ name: "getPool", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }], outputs: [{ type: "address" }] }];
const POOLABI = [{ name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }];
const ERC20 = [{ name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }];
const swapTopic = keccak256(toHex("Swap(address,address,int256,int256,uint160,uint128,int24)"));
const ZERO = "0x0000000000000000000000000000000000000000";
const s256 = h => { let n = BigInt("0x" + h); if (n >= 2n ** 255n) n -= 2n ** 256n; return n; };

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
async function meta(pool) {
  const t0 = (await pub.readContract({ address: pool, abi: POOLABI, functionName: "token0" })).toLowerCase();
  return { wethIsT0: t0 === WETH };
}

// ---- alert formatting ----
function bar(usd, emoji, step) { const n = Math.max(1, Math.min(60, Math.floor(usd / step))); return emoji.repeat(n); }
function fmtAlert(c, ev) {
  const links = [];
  if (c.links?.chart) links.push(`<a href="${c.links.chart}">Chart</a>`);
  if (c.links?.buy) links.push(`<a href="${c.links.buy}">Buy</a>`);
  if (c.links?.x) links.push(`<a href="${c.links.x}">X</a>`);
  if (c.links?.tg) links.push(`<a href="${c.links.tg}">TG</a>`);
  return [
    `<b>${c.sym} Buy!</b>`,
    bar(ev.usd, c.emoji || "🟢", c.step || 10),
    `💰 <b>$${ev.usd.toFixed(0)}</b> (${ev.eth.toFixed(4)} ETH)`,
    `🪙 ${ev.tokens.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${c.sym}`,
    `📊 MC $${ev.mc.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
    `👤 <code>${ev.buyer.slice(0, 6)}…${ev.buyer.slice(-4)}</code>`,
    links.length ? "\n" + links.join("  •  ") : ""
  ].filter(Boolean).join("\n");
}
async function postAlert(c, ev) {
  const text = fmtAlert(c, ev);
  if (c.media) { const r = await sendMedia(c.chatId, c.media, text); if (r.ok) return; }
  await send(c.chatId, text);
}

// ---- chain watch (poll registered pools) ----
let lastBlock = 0;
async function watchTick() {
  try {
    const latest = Number(await pub.getBlockNumber());
    if (!lastBlock) { lastBlock = latest; return; }
    if (latest <= lastBlock) return;
    const pools = Object.values(reg).map(c => c.pool);
    if (!pools.length) { lastBlock = latest; return; }
    const logs = await pub.request({ method: "eth_getLogs", params: [{ address: pools, topics: [swapTopic], fromBlock: "0x" + (lastBlock + 1).toString(16), toBlock: "0x" + latest.toString(16) }] });
    for (const l of logs) {
      const c = Object.values(reg).find(x => x.pool.toLowerCase() === l.address.toLowerCase());
      if (!c) continue;
      const d = l.data.slice(2);
      const a0 = s256(d.slice(0, 64)), a1 = s256(d.slice(64, 128)), sq = BigInt("0x" + d.slice(128, 192));
      const wethDelta = c.wethIsT0 ? a0 : a1, tokDelta = c.wethIsT0 ? a1 : a0;
      if (wethDelta <= 0) continue; // not a buy
      const eth = Number(formatEther(wethDelta < 0n ? -wethDelta : wethDelta));
      const usd = eth * ETHUSD;
      if (usd < (c.minBuy || 0)) continue;
      const P = (Number(sq) / 2 ** 96) ** 2; const mc = (c.wethIsT0 ? 1 / P : P) * ETHUSD * SUPPLY;
      const tokens = Number(formatEther(tokDelta < 0n ? -tokDelta : tokDelta));
      await postAlert(c, { eth, usd, tokens, mc, buyer: "0x" + l.topics[2].slice(26) });
    }
    lastBlock = latest;
  } catch (e) { /* keep going */ }
}

// ---- telegram command loop ----
let offset = 0;
async function tgTick() {
  const r = await api("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
  if (!r.ok) return;
  for (const u of r.result) {
    offset = u.update_id + 1;
    const msg = u.message; if (!msg?.text) continue;
    const chatId = msg.chat.id; const [cmd, arg] = msg.text.trim().split(/\s+/);
    const base = cmd.split("@")[0].toLowerCase();
    if (base === "/start") { await send(chatId, "👋 <b>HoodXChange Buy Bot</b>\nAdd me as admin, then:\n<code>/register &lt;CA&gt;</code> — watch your token\n<code>/setmedia &lt;url&gt;</code> — buy image/gif\n<code>/test</code> — preview an alert"); }
    else if (base === "/register") {
      if (!/^0x[0-9a-fA-F]{40}$/.test(arg || "")) { await send(chatId, "Usage: <code>/register 0xYourTokenCA</code>"); continue; }
      const ca = arg.toLowerCase();
      const rp = await resolvePool(ca); if (!rp) { await send(chatId, "❌ No WETH pool found for that CA on Robinhood Chain."); continue; }
      const { wethIsT0 } = await meta(rp.pool);
      let sym = "TOKEN"; try { sym = "$" + await pub.readContract({ address: ca, abi: ERC20, functionName: "symbol" }); } catch {}
      reg[ca] = { chatId, ca, pool: rp.pool, fee: rp.fee, wethIsT0, sym, emoji: "🟢", step: 10, minBuy: 0, links: {}, ...(reg[ca] || {}) };
      saveReg();
      await send(chatId, `✅ Watching <b>${sym}</b>\nPool <code>${rp.pool}</code>\nBuys in this group will now post here. Set art with <code>/setmedia &lt;url&gt;</code>, preview with <code>/test</code>.`);
    }
    else if (base === "/setmedia") { const c = Object.values(reg).find(x => x.chatId === chatId); if (!c) { await send(chatId, "Register first: <code>/register &lt;CA&gt;</code>"); continue; } c.media = arg; saveReg(); await send(chatId, "🖼️ Buy media set."); }
    else if (base === "/test") { const c = Object.values(reg).find(x => x.chatId === chatId); if (!c) { await send(chatId, "Register first: <code>/register &lt;CA&gt;</code>"); continue; } await postAlert(c, { eth: 0.45, usd: 842, tokens: 480000, mc: 46955, buyer: "0x3484f2b7b8c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4" }); }
  }
}

console.log("HoodXChange Buy Bot running. Alchemy + @hoodxchangebot.");
(async () => { while (true) { await tgTick().catch(() => {}); } })();
setInterval(watchTick, 4000);
