// Opportunity scanner for Robinhood Chain (alerts-only). Every run it pulls active RHC
// pairs from dexscreener, screens each on liquidity + REAL volume + an oversold-bounce
// setup, then runs an on-chain holder-health check (blockscout) to reject whale/dump-cluster
// tokens. Survivors get DM'd as candidates. No trading — you approve. State via cache.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const UA = "Mozilla/5.0";
const BOT = (process.env.BOT_TOKEN || "").trim();
const CHAT = (process.env.CHAT_ID || "6820752140").trim();
const STATE = process.env.STATE_FILE || "scanner/.seen.json";
const BS = "https://robinhoodchain.blockscout.com/api/v2";
const POOLISH = /pool|pair|lp/i;
// thresholds (tunable via env)
const LIQ_MIN = Number(process.env.LIQ_MIN || "10000");
const VOL_MIN = Number(process.env.VOL_MIN || "25000");
const DIP_MIN = Number(process.env.DIP_MIN || "8");     // must be down >=8% on 24h (a real dip)
const MIN_TXNS = Number(process.env.MIN_TXNS || "50");   // real activity
const MIN_SIDE = Number(process.env.MIN_SIDE || "10");   // >=10 buyers AND >=10 sellers (not one churner)
const TOP_HOLDER_MAX = Number(process.env.TOP_HOLDER_MAX || "5"); // % — reject whale-heavy
const REALERT_H = Number(process.env.REALERT_HOURS || "12");
if (!BOT) { console.error("BOT_TOKEN required"); process.exit(1); }

const jget = async (url) => { try { const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25000) }); return r.ok ? r.json() : null; } catch { return null; } };
const tg = (t) => fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: CHAT, text: t, parse_mode: "Markdown", disable_web_page_preview: true }) }).catch(() => {});
const usd = (n) => "$" + Math.round(n).toLocaleString();

async function holderHealth(addr) {
  const meta = await jget(`${BS}/tokens/${addr}`);
  const holders = await jget(`${BS}/tokens/${addr}/holders`);
  if (!meta || !holders?.items) return { ok: false, why: "no holder data" };
  const dec = Number(meta.decimals || 18);
  const supply = Number(meta.total_supply || "0") / 10 ** dec;
  if (!supply) return { ok: false, why: "no supply" };
  // biggest NON-pool / non-burn holder
  let top = 0, topName = "";
  for (const h of holders.items) {
    const a = h.address || {};
    const name = (a.name || "").toLowerCase();
    if (a.is_contract || POOLISH.test(name) || /dead|0x0000/.test((a.hash || "").toLowerCase())) continue;
    const v = Number(h.value || "0") / 10 ** dec;
    if (v > top) { top = v; topName = a.hash; }
  }
  const pct = (top / supply) * 100;
  return { ok: pct <= TOP_HOLDER_MAX, pct, holders: meta.holders || holders.items.length, why: pct > TOP_HOLDER_MAX ? `top wallet ${pct.toFixed(1)}%` : "" };
}

async function main() {
  const data = await jget("https://api.dexscreener.com/latest/dex/search?q=robinhood");
  const pairs = (data?.pairs || []).filter((p) => String(p.chainId).toLowerCase() === "robinhood");
  const seen = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  const nowH = Date.now() / 3.6e6;
  let checked = 0, hits = 0;
  for (const p of pairs) {
    const liq = p.liquidity?.usd || 0, vol = p.volume?.h24 || 0;
    const ch24 = p.priceChange?.h24 ?? 0, ch1 = p.priceChange?.h1 ?? 0;
    const tx = p.txns?.h24 || {}; const buys = tx.buys || 0, sells = tx.sells || 0;
    // --- market screen ---
    if (liq < LIQ_MIN) continue;
    if (vol < VOL_MIN) continue;
    if (buys + sells < MIN_TXNS || buys < MIN_SIDE || sells < MIN_SIDE) continue; // real, two-sided volume
    if (ch24 > -DIP_MIN) continue;          // must have actually dipped
    if (ch1 <= 0) continue;                  // ...and be turning back up (bounce starting)
    checked++;
    const addr = p.baseToken?.address; const sym = p.baseToken?.symbol || "?";
    // don't re-spam
    if (seen[addr] && nowH - seen[addr] < REALERT_H) continue;
    // --- on-chain holder health (the forensics gate) ---
    const hh = await holderHealth(addr);
    if (!hh.ok) { console.log(`reject ${sym}: ${hh.why}`); continue; }
    seen[addr] = nowH; hits++;
    await tg(
      `🎯 *Candidate: $${sym}*\n` +
      `dipped *${ch24.toFixed(1)}%* / 24h, turning *+${ch1.toFixed(1)}%* / 1h\n` +
      `💧 Liq ${usd(liq)}  ·  📊 Vol24 ${usd(vol)}\n` +
      `🔁 ${buys} buys / ${sells} sells  ·  👥 top wallet *${hh.pct.toFixed(1)}%*\n` +
      `\`${addr}\`\n[Chart](${p.url})`
    );
    console.log(`HIT ${sym} liq ${liq} vol ${vol} ch24 ${ch24} ch1 ${ch1} top ${hh.pct.toFixed(1)}%`);
  }
  writeFileSync(STATE, JSON.stringify(seen));
  console.log(`scanned ${pairs.length} pairs, ${checked} passed market screen, ${hits} candidates`);
}
main().catch((e) => { console.error(e); process.exit(1); });
