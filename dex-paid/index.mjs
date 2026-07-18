// dex-paid — watches for Robinhood Chain tokens that just PAID DexScreener (boosts or the
// "DEX Paid" profile badge). A team spending on DEX marketing = buyers about to come in, so
// this alerts early so you can ride the incoming attention. Alerts only — you buy manually.
// Gated on liquidity + holder health so it doesn't shill an obvious rug. State via cache.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const UA = "Mozilla/5.0";
const BOT = (process.env.BOT_TOKEN || "").trim();
const CHAT = (process.env.CHAT_ID || "6820752140").trim();
const STATE = process.env.STATE_FILE || "dex-paid/.seen.json";
const BS = "https://robinhoodchain.blockscout.com/api/v2";
const POOLISH = /pool|pair|lp/i;
const MIN_LIQ = Number(process.env.MIN_LIQ || "5000");        // avoid dead/rug listings
const TOP_HOLDER_MAX = Number(process.env.TOP_HOLDER_MAX || "15");
const BOOST_BUMP = Number(process.env.BOOST_BUMP || "50");    // re-alert if boosts jump this much more
// research finding: paying DEX only works on FRESH tokens; big boosts on OLD bleeding tokens = dump traps
const FRESH_H = Number(process.env.FRESH_H || "12");          // <12h old = the real signal
const MAX_AGE_H = Number(process.env.MAX_AGE_H || "48");      // >48h + dumping = exit-liquidity trap, skip
const MIN_VOL1H = Number(process.env.MIN_VOL1H || "2000");    // needs real buying, not a dead boost
if (!BOT) { console.error("BOT_TOKEN required"); process.exit(1); }

const jget = async (u) => { try { const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) }); return r.ok ? r.json() : null; } catch { return null; } };
const tg = (t) => fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: CHAT, text: t, parse_mode: "Markdown", disable_web_page_preview: true }) }).catch(() => {});
const usd = (n) => "$" + Math.round(n).toLocaleString();

async function holderTop(addr) {
  const meta = await jget(`${BS}/tokens/${addr}`), holders = await jget(`${BS}/tokens/${addr}/holders`);
  if (!meta || !holders?.items) return 100;
  const dec = Number(meta.decimals || 18), supply = Number(meta.total_supply || "0") / 10 ** dec;
  if (!supply) return 100;
  let top = 0;
  for (const h of holders.items) { const a = h.address || {}, name = (a.name || "").toLowerCase(); if (a.is_contract || POOLISH.test(name) || /dead|0x0000/.test((a.hash || "").toLowerCase())) continue; const v = Number(h.value || "0") / 10 ** dec; if (v > top) top = v; }
  return (top / supply) * 100;
}

async function main() {
  // pull both paid signals: boosts (with $ amount) + profiles ("DEX Paid" badge)
  const boosts = (await jget("https://api.dexscreener.com/token-boosts/latest/v1")) || [];
  const boostsTop = (await jget("https://api.dexscreener.com/token-boosts/top/v1")) || [];
  const profiles = (await jget("https://api.dexscreener.com/token-profiles/latest/v1")) || [];
  const isRH = (x) => String(x.chainId).toLowerCase() === "robinhood" && x.tokenAddress;

  // merge by token: track max boost amount + whether it has a paid profile
  const tokens = new Map();
  for (const x of [...boosts, ...boostsTop]) if (isRH(x)) { const a = x.tokenAddress.toLowerCase(); const amt = Number(x.totalAmount || x.amount || 0); const t = tokens.get(a) || { addr: x.tokenAddress, boost: 0, profile: false, desc: x.description || "" }; t.boost = Math.max(t.boost, amt); tokens.set(a, t); }
  for (const x of profiles) if (isRH(x)) { const a = x.tokenAddress.toLowerCase(); const t = tokens.get(a) || { addr: x.tokenAddress, boost: 0, profile: false, desc: x.description || "" }; t.profile = true; if (!t.desc) t.desc = x.description || ""; tokens.set(a, t); }

  const cold = !existsSync(STATE);   // first ever run: seed the list, don't blast every existing paid token
  const st = cold ? {} : JSON.parse(readFileSync(STATE, "utf8"));
  const nowS = Math.floor(Date.now() / 1000);
  for (const k in st) if (nowS - (st[k].t || 0) > 172800) delete st[k]; // prune >48h
  let alerts = 0;
  if (cold) { for (const [addr, t] of tokens) st[addr] = { boost: t.boost, t: nowS }; writeFileSync(STATE, JSON.stringify(st)); console.log(`cold start: seeded ${tokens.size} existing paid tokens (no alerts)`); return; }

  for (const [addr, t] of tokens) {
    const prev = st[addr];
    // alert on: first time seen paid, OR boost jumped >= BOOST_BUMP more than last alert
    const firstPaid = !prev;
    const boostJump = prev && t.boost - (prev.boost || 0) >= BOOST_BUMP;
    if (!firstPaid && !boostJump) continue;

    // enrich with market data
    const pairs = await jget(`https://api.dexscreener.com/tokens/v1/robinhood/${addr}`);
    const p = Array.isArray(pairs) ? pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] : null;
    if (!p) { st[addr] = { boost: t.boost, t: nowS }; continue; }
    const liq = p.liquidity?.usd || 0, vol = p.volume?.h24 || 0, v1 = p.volume?.h1 || 0, mc = p.marketCap || p.fdv || 0;
    const sym = p.baseToken?.symbol || "?", ch1 = p.priceChange?.h1 ?? 0, ch6 = p.priceChange?.h6 ?? 0, ch24 = p.priceChange?.h24 ?? 0;
    const ageH = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3.6e6 : 999;
    const rec = () => { st[addr] = { boost: t.boost, t: nowS }; };
    if (liq < MIN_LIQ) { rec(); continue; }                                          // too thin
    if (ageH > MAX_AGE_H && ch24 < 0) { rec(); console.log(`skip ${sym}: old(${ageH.toFixed(0)}h)+dumping = trap`); continue; } // exit-liquidity trap
    if (v1 < MIN_VOL1H) { rec(); console.log(`skip ${sym}: no real volume (dead boost)`); continue; }     // no buyers actually coming
    const top = await holderTop(addr);
    if (top > TOP_HOLDER_MAX) { rec(); console.log(`skip ${sym}: whale ${top.toFixed(1)}%`); continue; }

    rec(); alerts++;
    const fresh = ageH < FRESH_H;
    const tag = t.profile && t.boost ? `💸 DEX Paid + ⚡${t.boost} boost` : t.profile ? `💸 DEX Paid badge` : `⚡ Boosted ×${t.boost}`;
    await tg(
      `${fresh ? "🔥 *FRESH DEX PAID*" : "🅿️ *DEX PAID*"}: $${sym} ${boostJump ? "_(boost bump)_" : ""}\n` +
      `${tag}${fresh ? `  ·  🐣 *${ageH.toFixed(0)}h old*` : `  ·  ${ageH.toFixed(0)}h old`}\n` +
      `💧 ${usd(liq)} liq · 📊 ${usd(v1)} vol/1h · 🏷 ${mc ? usd(mc) : "?"} MC\n` +
      `📈 1h ${ch1 >= 0 ? "+" : ""}${ch1.toFixed(0)}% · 6h ${ch6 >= 0 ? "+" : ""}${ch6.toFixed(0)}% · 👥 top ${top.toFixed(0)}%\n` +
      `\`${addr}\`\n[💱 Buy on DEX](${p.url}?trade=1) · [📊 Chart](${p.url})\n` +
      `${fresh ? "⚡ _Fresh + paid + moving = the real setup. Small size, take profits into the pump._" : "⚠️ _Older token — paid to draw eyeballs. Riskier, could be exit liquidity. Tight._"}`
    );
    console.log(`PAID ${sym} boost ${t.boost} age ${ageH.toFixed(0)}h v1 ${Math.round(v1)} fresh ${fresh}`);
  }
  writeFileSync(STATE, JSON.stringify(st));
  console.log(`tracked ${tokens.size} paid RH tokens, ${alerts} alerts`);
}
main().catch((e) => { console.error(e); process.exit(1); });
