// copytrade — watches proven ALPHA wallets (found on-chain: wallets that repeatedly bought
// fresh DexScreener-paid tokens right before they ran +500%..+5000%) and DMs you the instant
// one of them BUYS a new token. Copy the winners instead of guessing. Alerts only — you buy.
// State: per-wallet last-seen tx (cache). Refine WALLETS as we verify who stays profitable.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const UA = "Mozilla/5.0";
const BOT = (process.env.BOT_TOKEN || "").trim();
const CHAT = (process.env.CHAT_ID || "6820752140").trim();
const STATE = process.env.STATE_FILE || "copytrade/.seen.json";
const BS = "https://robinhoodchain.blockscout.com/api/v2";
const WETH = (process.env.WETH || "0x0bd7d308f8e1639fab988df18a8011f41eacad73").toLowerCase();
// alpha wallets = recurring early buyers of fresh-paid winners (reverse-engineered on-chain)
const WALLETS = (process.env.WALLETS ||
  "0xad388f2e16355518cbc42aa6dce5f509cd729664,0x99d3d142d5be15362a7bd9e127c7d754ed71a7b3,0x738c30d83dc28c79d9b742b37628afeafb71d797,0x547127ce40ac91195f5f6df499877ccc47919fe7,0x713378acc7aab5536646c41afbe6718577998a83,0x777777252e12eb5c0794d2cb7b7d241ae9894bd6"
).split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
const MIN_LIQ = Number(process.env.MIN_LIQ || "3000");
if (!BOT) { console.error("BOT_TOKEN required"); process.exit(1); }

const jget = async (u) => { try { const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) }); return r.ok ? r.json() : null; } catch { return null; } };
const tg = (t) => fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: CHAT, text: t, parse_mode: "Markdown", disable_web_page_preview: true }) }).catch(() => {});
const usd = (n) => "$" + Math.round(n).toLocaleString();
const short = (w) => w.slice(0, 6) + "…" + w.slice(-4);

async function main() {
  const cold = !existsSync(STATE);
  const st = cold ? {} : JSON.parse(readFileSync(STATE, "utf8"));
  st.seen = st.seen || {};                      // key `${wallet}:${token}` -> ts (dedupe buys)
  const nowS = Math.floor(Date.now() / 1000);
  for (const k in st.seen) if (nowS - st.seen[k] > 86400) delete st.seen[k]; // prune >24h
  let alerts = 0;

  for (const wallet of WALLETS) {
    // recent ERC-20 transfers for this wallet; INCOMING (to == wallet) = an acquisition/buy
    const tr = await jget(`${BS}/addresses/${wallet}/token-transfers?type=ERC-20&filter=to`);
    const items = tr?.items || [];
    for (const it of items.slice(0, 15)) {
      const to = (it.to?.hash || "").toLowerCase();
      if (to !== wallet) continue;
      const token = (it.token?.address || it.token?.address_hash || "").toLowerCase();
      if (!token || token === WETH) continue;
      const key = `${wallet}:${token}`;
      if (st.seen[key]) continue;               // already alerted this wallet+token
      st.seen[key] = nowS;
      if (cold) continue;                        // cold start: seed only, don't blast history

      // enrich: is it a tradeable token that's moving?
      const pairs = await jget(`https://api.dexscreener.com/tokens/v1/robinhood/${token}`);
      const p = Array.isArray(pairs) ? pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] : null;
      if (!p) continue;
      const liq = p.liquidity?.usd || 0; if (liq < MIN_LIQ) continue;
      const sym = p.baseToken?.symbol || it.token?.symbol || "?";
      const ageH = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3.6e6 : 999;
      const c1 = p.priceChange?.h1 ?? 0, mc = p.marketCap || p.fdv || 0, v1 = p.volume?.h1 || 0;
      alerts++;
      await tg(
        `🎯 *ALPHA BUY* — copy wallet\n` +
        `\`${short(wallet)}\` just bought *$${sym}*\n` +
        `🐣 ${ageH < 99 ? ageH.toFixed(0) + "h old" : "?"} · 💧 ${usd(liq)} liq · 📊 ${usd(v1)} vol/1h${mc ? ` · 🏷 ${usd(mc)} MC` : ""} · 1h ${c1 >= 0 ? "+" : ""}${c1.toFixed(0)}%\n` +
        `\`${token}\`\n[💱 Buy on DEX](${p.url}?trade=1) · [📊 Chart](${p.url}) · [👛 Wallet](https://robinhoodchain.blockscout.com/address/${wallet})\n` +
        `⚡ _A proven early-buyer just aped in. Move fast, small size, take profits._`
      );
      console.log(`ALPHA ${short(wallet)} bought ${sym} age ${ageH.toFixed(0)}h liq ${Math.round(liq)}`);
    }
  }
  writeFileSync(STATE, JSON.stringify(st));
  console.log(`${cold ? "cold start seeded" : "checked"} ${WALLETS.length} alpha wallets, ${alerts} alerts`);
}
main().catch((e) => { console.error(e); process.exit(1); });
