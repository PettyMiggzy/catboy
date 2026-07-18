// New-launch radar for Robinhood Chain (alerts-only). DMs FRESH launches that are
// actually trending up with real buyers — and pass a rug/health gate. This is the
// highest-risk/highest-reward table; the radar catches early movers + filters obvious
// traps, but position sizing + taking profits are on YOU. State via cache.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const UA = "Mozilla/5.0";
const BOT = (process.env.BOT_TOKEN || "").trim();
const CHAT = (process.env.CHAT_ID || "6820752140").trim();
const STATE = process.env.STATE_FILE || "launch-radar/.seen.json";
const BS = "https://robinhoodchain.blockscout.com/api/v2";
const POOLISH = /pool|pair|lp/i;
const MAX_AGE_H = Number(process.env.MAX_AGE_H || "48");     // only launches younger than this
const LIQ_MIN = Number(process.env.LAUNCH_LIQ_MIN || "5000"); // enough to actually trade/exit
const VOL1H_MIN = Number(process.env.VOL1H_MIN || "1000");    // live activity
const MIN_BUYS = Number(process.env.MIN_BUYS || "8");         // real buyers, last hour
const BUY_RATIO = Number(process.env.BUY_RATIO || "1.3");     // buys >= 1.3x sells (net buying)
const TOP_HOLDER_MAX = Number(process.env.TOP_HOLDER_MAX || "15"); // launches run concentrated; flag but allow <15%
const REALERT_H = Number(process.env.REALERT_HOURS || "8");
if (!BOT) { console.error("BOT_TOKEN required"); process.exit(1); }

const jget = async (u) => { try { const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25000) }); return r.ok ? r.json() : null; } catch { return null; } };
const tg = (t) => fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: CHAT, text: t, parse_mode: "Markdown", disable_web_page_preview: true }) }).catch(() => {});
const usd = (n) => "$" + Math.round(n).toLocaleString();

async function topHolderPct(addr) {
  const meta = await jget(`${BS}/tokens/${addr}`), holders = await jget(`${BS}/tokens/${addr}/holders`);
  if (!meta || !holders?.items) return 100;
  const dec = Number(meta.decimals || 18), supply = Number(meta.total_supply || "0") / 10 ** dec;
  if (!supply) return 100;
  let top = 0;
  for (const h of holders.items) {
    const a = h.address || {}, name = (a.name || "").toLowerCase();
    if (a.is_contract || POOLISH.test(name) || /dead|0x0000/.test((a.hash || "").toLowerCase())) continue;
    const v = Number(h.value || "0") / 10 ** dec; if (v > top) top = v;
  }
  return (top / supply) * 100;
}

async function main() {
  const data = await jget("https://api.dexscreener.com/latest/dex/search?q=robinhood");
  const pairs = (data?.pairs || []).filter((p) => String(p.chainId).toLowerCase() === "robinhood");
  const st = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  const now = Date.now(), nowH = now / 3.6e6;
  let hits = 0;
  for (const p of pairs) {
    const addr = p.baseToken?.address; if (!addr || !p.pairCreatedAt) continue;
    const ageH = (now - p.pairCreatedAt) / 3.6e6;
    if (ageH > MAX_AGE_H) continue;                    // must be a fresh launch
    const liq = p.liquidity?.usd || 0, v1 = p.volume?.h1 || 0;
    const c1 = p.priceChange?.h1 ?? 0, c6 = p.priceChange?.h6 ?? c1;
    const tx = p.txns?.h1 || {}, buys = tx.buys || 0, sells = tx.sells || 0;
    // --- fresh + trending up + real buyers ---
    if (liq < LIQ_MIN) continue;
    if (v1 < VOL1H_MIN) continue;
    if (c1 <= 0 || c6 <= 0) continue;                  // sustained up, not a dead-cat
    if (buys < MIN_BUYS || buys < sells * BUY_RATIO) continue; // net buying
    if (st[addr] && nowH - st[addr] < REALERT_H) continue;
    // --- rug/health gate ---
    const top = await topHolderPct(addr);
    if (top > TOP_HOLDER_MAX) { console.log(`reject ${p.baseToken?.symbol}: top ${top.toFixed(1)}%`); continue; }
    st[addr] = nowH; hits++;
    const sym = p.baseToken?.symbol || "?";
    await tg(
      `🌱 *New launch trending up: $${sym}*\n` +
      `⏱ ${ageH.toFixed(1)}h old  ·  *+${c1.toFixed(1)}%* /1h, *+${c6.toFixed(1)}%* /6h\n` +
      `🟢 ${buys} buys / ${sells} sells (1h)  ·  📊 ${usd(v1)} vol/1h\n` +
      `💧 ${usd(liq)} liq  ·  👥 top wallet *${top.toFixed(1)}%*\n` +
      `\`${addr}\`\n[Chart](${p.url})\n` +
      `⚠️ _Fresh launch = casino. Small size, take profits._`
    );
    console.log(`LAUNCH ${sym} age ${ageH.toFixed(1)}h c1 ${c1} buys ${buys}/${sells} top ${top.toFixed(1)}%`);
  }
  writeFileSync(STATE, JSON.stringify(st));
  console.log(`scanned ${pairs.length} pairs, ${hits} launch alerts`);
}
main().catch((e) => { console.error(e); process.exit(1); });
