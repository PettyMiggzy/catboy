// Opportunity scanner for Robinhood Chain (alerts-only). Three signal types, all gated
// on deep liquidity + real two-sided volume + clean holders (no whale/dump-cluster):
//   🎯 bounce   — dipped >=DIP% on 24h but turning up on 1h (oversold reversal)
//   📈 pump     — up >=PUMP_ALERT% on 24h (or fast on 1h) — momentum
//   🚀 new high — price broke above its prior tracked high (breakout)
// DMs candidates. No trading. State (per-token high + last-alert-per-kind) via cache.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const UA = "Mozilla/5.0";
const BOT = (process.env.BOT_TOKEN || "").trim();
const CHAT = (process.env.CHAT_ID || "6820752140").trim();
const STATE = process.env.STATE_FILE || "scanner/.seen.json";
const BS = "https://robinhoodchain.blockscout.com/api/v2";
const POOLISH = /pool|pair|lp/i;
const LIQ_MIN = Number(process.env.LIQ_MIN || "10000");
const VOL_MIN = Number(process.env.VOL_MIN || "25000");
const DIP_MIN = Number(process.env.DIP_MIN || "8");
const PUMP_ALERT = Number(process.env.PUMP_ALERT || "20");   // >=20% / 24h => pump alert
const PUMP_FAST = Number(process.env.PUMP_FAST || "15");     // ...or >=15% / 1h
const ATH_BUF = Number(process.env.ATH_BUFFER || "1") / 100; // must beat prior high by 1%
const MIN_TXNS = Number(process.env.MIN_TXNS || "50");
const MIN_SIDE = Number(process.env.MIN_SIDE || "10");
const TOP_HOLDER_MAX = Number(process.env.TOP_HOLDER_MAX || "5");
const REALERT_H = Number(process.env.REALERT_HOURS || "12");
if (!BOT) { console.error("BOT_TOKEN required"); process.exit(1); }

const jget = async (u) => { try { const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25000) }); return r.ok ? r.json() : null; } catch { return null; } };
const tg = (t) => fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: CHAT, text: t, parse_mode: "Markdown", disable_web_page_preview: true }) }).catch(() => {});
const usd = (n) => "$" + Math.round(n).toLocaleString();

async function holderHealth(addr) {
  const meta = await jget(`${BS}/tokens/${addr}`), holders = await jget(`${BS}/tokens/${addr}/holders`);
  if (!meta || !holders?.items) return { ok: false };
  const dec = Number(meta.decimals || 18), supply = Number(meta.total_supply || "0") / 10 ** dec;
  if (!supply) return { ok: false };
  let top = 0;
  for (const h of holders.items) {
    const a = h.address || {}, name = (a.name || "").toLowerCase();
    if (a.is_contract || POOLISH.test(name) || /dead|0x0000/.test((a.hash || "").toLowerCase())) continue;
    const v = Number(h.value || "0") / 10 ** dec; if (v > top) top = v;
  }
  const pct = (top / supply) * 100;
  return { ok: pct <= TOP_HOLDER_MAX, pct };
}

async function main() {
  const data = await jget("https://api.dexscreener.com/latest/dex/search?q=robinhood");
  const pairs = (data?.pairs || []).filter((p) => String(p.chainId).toLowerCase() === "robinhood");
  const st = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  const nowH = Date.now() / 3.6e6;
  const fresh = (rec, kind) => !(rec.a?.[kind]) || nowH - rec.a[kind] >= REALERT_H;
  let hits = 0;
  for (const p of pairs) {
    const addr = p.baseToken?.address; if (!addr) continue;
    const liq = p.liquidity?.usd || 0, vol = p.volume?.h24 || 0;
    const price = Number(p.priceUsd || 0);
    const ch24 = p.priceChange?.h24 ?? 0, ch1 = p.priceChange?.h1 ?? 0;
    const tx = p.txns?.h24 || {}, buys = tx.buys || 0, sells = tx.sells || 0;
    const sym = p.baseToken?.symbol || "?";
    const rec = st[addr] || (st[addr] = { high: 0, a: {} });
    const realVol = liq >= LIQ_MIN && vol >= VOL_MIN && buys + sells >= MIN_TXNS && buys >= MIN_SIDE && sells >= MIN_SIDE;

    // track high; first sighting just records it (no ATH spam)
    const firstSeen = !rec.high;
    let newHigh = false;
    if (price > 0) { if (price > rec.high * (1 + ATH_BUF) && !firstSeen) newHigh = true; if (price > rec.high) rec.high = price; }

    const link = `[Chart](${p.url})`, tag = `\`${addr}\``;
    let kind = null, msg = null;
    if (realVol && ch24 <= -DIP_MIN && ch1 > 0 && fresh(rec, "bounce")) {
      kind = "bounce";
      msg = `🎯 *Bounce setup: $${sym}*\ndipped *${ch24.toFixed(1)}%* /24h, turning *+${ch1.toFixed(1)}%* /1h\n💧 ${usd(liq)} liq · 📊 ${usd(vol)} vol · 🔁 ${buys}/${sells}`;
    } else if (realVol && (ch24 >= PUMP_ALERT || ch1 >= PUMP_FAST) && fresh(rec, "pump")) {
      kind = "pump";
      msg = `📈 *Pumping: $${sym}*  *+${Math.max(ch24, ch1).toFixed(1)}%*\n24h *${ch24.toFixed(1)}%* · 1h *${ch1.toFixed(1)}%*\n💧 ${usd(liq)} liq · 📊 ${usd(vol)} vol`;
    } else if (newHigh && liq >= LIQ_MIN && vol >= VOL_MIN && fresh(rec, "ath")) {
      kind = "ath";
      msg = `🚀 *New high: $${sym}*  now $${price.toPrecision(3)}\n+${ch24.toFixed(1)}% /24h · 💧 ${usd(liq)} liq · 📊 ${usd(vol)} vol`;
    }
    if (kind) {
      const hh = kind === "ath" ? { ok: true, pct: 0 } : await holderHealth(addr);
      if (!hh.ok) { console.log(`reject ${sym} (${kind}): whale`); continue; }
      rec.a[kind] = nowH; hits++;
      await tg(`${msg}${hh.pct ? `\n👥 top wallet *${hh.pct.toFixed(1)}%*` : ""}\n${tag}\n${link}`);
      console.log(`HIT ${sym} ${kind} ch24 ${ch24} ch1 ${ch1}`);
    }
  }
  writeFileSync(STATE, JSON.stringify(st));
  console.log(`scanned ${pairs.length} pairs, ${hits} alerts`);
}
main().catch((e) => { console.error(e); process.exit(1); });
