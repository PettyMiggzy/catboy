// scalper — disciplined dip-scalp bot for Robinhood Chain. PAPER by default (DRY_RUN=1).
// Denominated in ETH (what you trade with on this chain). Sourced 100% ON-CHAIN: it reads
// every Swap on the chain in a rolling window, so "high volume" = a token actually trading a
// lot (many swaps / much ETH), not some indexer's vanity list. Built from the Monte-Carlo
// finding that the edge is keeping round-trip COST below the profit target:
//   1. trades ONLY tokens with real churn + real ETH depth       (keeps slippage tiny)
//   2. COST GUARD — refuses any trade whose est. round-trip cost eats the profit target
//   3. POSITION SIZING — risks a small % of bankroll per trade   (no single loss wipes you)
//   4. clean holders (no single wallet controls it)
//   5. real EXITS — take-profit / trailing-stop / hard-stop / time-stop
// Runs stateless from GitHub Actions; bankroll + positions + price history persist via cache.
// Flip to live later by wiring a verified ROUTER + QUOTER + burner PRIVATE_KEY (see executeTrade).
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const RPC = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const WETH = (process.env.WETH || "0x0bd7d308f8e1639fab988df18a8011f41eacad73").toLowerCase();
const SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const BS = "https://robinhoodchain.blockscout.com/api/v2";
const POOLISH = /pool|pair|lp/i;
const BOT = (process.env.BOT_TOKEN || "").trim();
const CHAT = (process.env.CHAT_ID || "6820752140").trim();
const STATE = process.env.STATE_FILE || "scalper/.state.json";
const DRY_RUN = (process.env.DRY_RUN ?? "1") !== "0";

// --- capital / sizing (ETH) ---
const START_BANK = Number(process.env.START_BANK_ETH || "0.02");  // ~$50 seed
// sizing must clear fixed gas: a $2 clip pays ~4% just in gas. Bigger clips make gas negligible.
const RISK_FRAC = Number(process.env.RISK_FRAC || "0.15");        // 15% of bankroll per trade (~$7.5 @ $50)
const MAX_POS = Number(process.env.MAX_POS || "4");
const MIN_TRADE = Number(process.env.MIN_TRADE_ETH || "0.003");   // ~$7 floor so gas stays <1%

// --- window / universe ---
const WINDOW_BLOCKS = Number(process.env.WINDOW_BLOCKS || "2500"); // ~4 min of chain-wide swaps
const MIN_SWAPS = Number(process.env.MIN_SWAPS || "15");           // churn floor in the window
const MIN_VOL_ETH = Number(process.env.MIN_VOL_ETH || "0.4");      // ETH traded in the window
const MIN_LP_ETH = Number(process.env.MIN_LP_ETH || "0.3");        // WETH depth in the pool
const MIN_BUYS_WIN = Number(process.env.MIN_BUYS_WIN || "4");      // buyers stepping in (dip turning)
const TOP_HOLDER_MAX = Number(process.env.TOP_HOLDER_MAX || "5");

// --- entry: buyable dip, not a knife ---
const ENTRY_DIP = Number(process.env.ENTRY_DIP || "4");   // need <= -4% (1h if known, else window)
const MAX_DUMP24 = Number(process.env.MAX_DUMP24 || "10"); // skip if 24h worse than -10%
const KNIFE = Number(process.env.KNIFE || "25");           // skip if window move < -25% (crashing)

// --- exits ---
const TP_PCT = Number(process.env.TP_PCT || "6");
const SL_PCT = Number(process.env.SL_PCT || "6");
const TRAIL_PCT = Number(process.env.TRAIL_PCT || "3");
const MAX_HOLD_H = Number(process.env.MAX_HOLD_H || "12");

// --- cost model (ETH) ---
const FEE_BPS = Number(process.env.FEE_BPS || "30");      // 0.30% per side
const GAS_ETH = Number(process.env.GAS_ETH || "0.000015"); // L2 gas per swap (measured ~0.000014)
const IMPACT_K = Number(process.env.IMPACT_K || "1.0");
const SLIP_CAP = Number(process.env.SLIP_CAP || "5");
const MAX_COST_FRAC = Number(process.env.MAX_COST_FRAC || "0.5"); // cost must be < 50% of TP

if (!BOT) { console.error("BOT_TOKEN required"); process.exit(1); }
const feeFrac = FEE_BPS / 10000;

const rpc = async (m, p) => { try { const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) }); return (await r.json()).result; } catch { return null; } };
const jget = async (u) => { try { const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20000) }); return r.ok ? r.json() : null; } catch { return null; } };
const tg = (t) => fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: CHAT, text: t, parse_mode: "Markdown", disable_web_page_preview: true }) }).catch(() => {});
const s256 = (h) => { const v = BigInt("0x" + h); return v >= (1n << 255n) ? v - (1n << 256n) : v; };
const strCall = async (to, sel) => { try { const r = await rpc("eth_call", [{ to, data: sel }, "latest"]); if (!r || r === "0x") return ""; const len = parseInt(r.slice(66, 130), 16); return Buffer.from(r.slice(130, 130 + len * 2), "hex").toString("utf8").replace(/\0+$/, ""); } catch { return ""; } };
const addrCall = async (to, sel) => { try { const r = await rpc("eth_call", [{ to, data: sel }, "latest"]); return r && r !== "0x" ? "0x" + r.slice(-40) : ""; } catch { return ""; } };
const lpEth = async (pool) => { const r = await rpc("eth_call", [{ to: WETH, data: "0x70a08231" + "0".repeat(24) + pool.slice(2) }, "latest"]); return r ? Number(BigInt(r)) / 1e18 : 0; };
// token price in ETH from a Swap event's sqrtPriceX96 (word index 2). Decimal-agnostic: we only
// ever use price *ratios* (% change, entry/exit), so any constant decimal scaling cancels out.
const priceFromSwap = (dataHex, wethIsT0) => { const w = dataHex.slice(2); const sq = Number(BigInt("0x" + w.slice(128, 192))) / 2 ** 96; const P = sq * sq; return P > 0 ? (wethIsT0 ? 1 / P : P) : 0; };

async function holderTop(addr) {
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
const costPctFor = (sizeEth, lp) => feeFrac * 100 * 2 + Math.min(SLIP_CAP, (sizeEth / Math.max(lp, 1e-9)) * 100 * IMPACT_K) * 2 + (GAS_ETH / Math.max(sizeEth, 1e-9)) * 100 * 2;

async function executeTrade(side, priceEth) {
  if (DRY_RUN) return priceEth; // paper fill at pool price; friction applied by caller
  throw new Error("LIVE trading not wired — supply a verified ROUTER + QUOTER + burner PRIVATE_KEY before DRY_RUN=0");
}

async function getChainWideSwaps(tip) {
  for (const span of [WINDOW_BLOCKS, 1600, 1000, 600]) {
    const from = tip - span;
    const logs = await rpc("eth_getLogs", [{ topics: [SWAP], fromBlock: "0x" + from.toString(16), toBlock: "0x" + tip.toString(16) }]);
    if (Array.isArray(logs)) return { logs, span };
  }
  return { logs: [], span: 0 };
}

async function main() {
  const tip = parseInt(await rpc("eth_blockNumber", []), 16);
  if (!tip) { console.error("no RPC"); process.exit(1); }
  const { logs, span } = await getChainWideSwaps(tip);

  const st = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null;
  const S = st || { cash: START_BANK, positions: {}, realized: 0, trades: 0, wins: 0 };
  S.pools = S.pools || {}; S.hist = S.hist || {};
  const nowH = Date.now() / 3.6e6;

  // ---------- aggregate the window per pool ----------
  const agg = new Map();
  for (const l of logs) {
    const pool = l.address.toLowerCase();
    let a = agg.get(pool);
    if (!a) { a = { n: 0, buys: 0, sells: 0, buyVol: 0, sellVol: 0, first: null, last: null }; agg.set(pool, a); }
    a.n++;
    // need pool orientation to sign the deltas; resolve+cache lazily below, so stash raw for now
    a.last = l; if (!a.first) a.first = l;
  }

  // keep only pools with enough churn, then resolve orientation/token (cache) and finish stats
  const active = [];
  for (const [pool, a] of agg) {
    if (a.n < MIN_SWAPS) continue;
    let meta = S.pools[pool];
    if (!meta) {
      const t0 = (await addrCall(pool, "0x0dfe1681")).toLowerCase(); // token0()
      const t1 = (await addrCall(pool, "0xd21220a7")).toLowerCase(); // token1()
      if (!t0 || !t1) continue;
      const wethIsT0 = t0 === WETH; const token = wethIsT0 ? t1 : t0;
      if (token === WETH || !/^0x[0-9a-f]{40}$/.test(token)) continue;
      const sym = (await strCall(token, "0x95d89b41")) || "?";
      meta = S.pools[pool] = { token, wethIsT0, sym };
    }
    // second pass over this pool's swaps to sign volume/buys (cheap: re-read from logs)
    let buys = 0, sells = 0, buyVol = 0, sellVol = 0;
    for (const l of logs) {
      if (l.address.toLowerCase() !== pool) continue;
      const d = l.data.slice(2); const a0 = s256(d.slice(0, 64)), a1 = s256(d.slice(64, 128));
      const wethDelta = meta.wethIsT0 ? a0 : a1, tokDelta = meta.wethIsT0 ? a1 : a0;
      const vol = Number(wethDelta < 0n ? -wethDelta : wethDelta) / 1e18;
      if (tokDelta < 0n) { buys++; buyVol += vol; } else if (tokDelta > 0n) { sells++; sellVol += vol; }
    }
    const firstP = priceFromSwap(a.first.data, meta.wethIsT0);
    const lastP = priceFromSwap(a.last.data, meta.wethIsT0);
    active.push({ pool, ...meta, n: a.n, buys, sells, buyVol, sellVol, vol: buyVol + sellVol, firstP, lastP });
  }

  // update rolling price history (for real 1h / 24h deltas over time)
  for (const p of active) {
    if (!p.lastP) continue;
    const h = (S.hist[p.token] = S.hist[p.token] || []);
    h.push([nowH, p.lastP]);
    while (h.length && nowH - h[0][0] > 24) h.shift();
  }
  const priceNow = new Map(active.map((p) => [p.token, p.lastP]));
  const chSince = (token, hoursAgo) => { const h = S.hist[token]; if (!h || h.length < 2) return null; const cutoff = nowH - hoursAgo; let ref = null; for (const [t, pr] of h) { if (t <= cutoff) ref = pr; } if (ref == null) ref = h[0][1]; const cur = h[h.length - 1][1]; return ref ? (cur / ref - 1) * 100 : null; };

  const fills = [];

  // ---------- 1) MANAGE OPEN POSITIONS ----------
  for (const addr of Object.keys(S.positions)) {
    const pos = S.positions[addr];
    const cur = priceNow.get(addr) ?? (S.hist[addr]?.length ? S.hist[addr][S.hist[addr].length - 1][1] : pos.entry);
    if (!cur) continue;
    pos.high = Math.max(pos.high || pos.entry, cur);
    const gainPct = (cur / pos.entry - 1) * 100;
    const ddFromHigh = (pos.high - cur) / pos.high * 100;
    const ageH = nowH - pos.openedH;
    let reason = null;
    if (gainPct <= -SL_PCT) reason = "🛑 stop";
    else if (gainPct >= TP_PCT) reason = "✅ take-profit";
    else if (gainPct > 1 && ddFromHigh >= TRAIL_PCT) reason = "🔒 trail";
    else if (ageH >= MAX_HOLD_H) reason = "⌛ time";
    if (!reason) continue;
    const lp = pos.lp || MIN_LP_ETH;
    const posValue = pos.cost * (cur / pos.entry);
    const exitCost = posValue * (feeFrac + Math.min(SLIP_CAP, (posValue / Math.max(lp, 1e-9)) * 100 * IMPACT_K) / 100) + GAS_ETH;
    await executeTrade("sell", cur);
    const proceeds = posValue - exitCost;
    S.cash += proceeds;
    const net = proceeds - (pos.cost + pos.entryCost);
    S.realized += net; S.trades++; if (net > 0) S.wins++;
    fills.push(`${net >= 0 ? "🟢" : "🔴"} SOLD *$${pos.sym}* ${reason}  ${gainPct >= 0 ? "+" : ""}${gainPct.toFixed(1)}%  → *${net >= 0 ? "+" : ""}${net.toFixed(5)} ETH*  (held ${ageH.toFixed(1)}h)`);
    delete S.positions[addr];
  }

  // ---------- 2) LOOK FOR ENTRIES ----------
  const openN = Object.keys(S.positions).length;
  if (openN < MAX_POS && S.cash >= MIN_TRADE && active.length) {
    const cands = active
      .filter((p) => !S.positions[p.token] && p.vol >= MIN_VOL_ETH && p.buys >= MIN_BUYS_WIN && p.lastP > 0)
      .map((p) => { const win = (p.lastP / p.firstP - 1) * 100; const ch1 = chSince(p.token, 1); const dip = ch1 != null ? ch1 : win; return { ...p, win, ch1, ch24: chSince(p.token, 24), dip }; })
      .filter((p) => p.dip <= -ENTRY_DIP && p.win > -KNIFE && (p.ch24 == null || p.ch24 > -MAX_DUMP24))
      .sort((a, b) => b.vol - a.vol); // most-traded (cheapest to scalp) first

    let slots = MAX_POS - openN;
    for (const c of cands) {
      if (slots <= 0 || S.cash < MIN_TRADE) break;
      const lp = await lpEth(c.pool);
      if (lp < MIN_LP_ETH) continue;
      const sizeEth = Math.min(S.cash * RISK_FRAC, S.cash);
      if (sizeEth < MIN_TRADE) break;
      const costPct = costPctFor(sizeEth, lp);
      if (costPct > TP_PCT * MAX_COST_FRAC) { console.log(`skip $${c.sym}: cost ${costPct.toFixed(2)}% > budget`); continue; }
      const top = await holderTop(c.token);
      if (top > TOP_HOLDER_MAX) { console.log(`skip $${c.sym}: whale ${top.toFixed(1)}%`); continue; }
      const price = await executeTrade("buy", c.lastP);
      const entryCost = sizeEth * (feeFrac + Math.min(SLIP_CAP, (sizeEth / Math.max(lp, 1e-9)) * 100 * IMPACT_K) / 100) + GAS_ETH;
      S.cash -= (sizeEth + entryCost);
      S.positions[c.token] = { sym: c.sym, entry: price, high: price, cost: sizeEth, entryCost, lp, pool: c.pool, openedH: nowH };
      fills.push(`🛒 BOUGHT *$${c.sym}*  ${sizeEth.toFixed(5)} ETH\n   dip *${c.dip.toFixed(1)}%* · vol ${c.vol.toFixed(2)} ETH · ${c.buys}b/${c.sells}s · cost *${costPct.toFixed(2)}%* · TP +${TP_PCT}%/SL -${SL_PCT}%`);
      slots--;
    }
  }

  // ---------- 3) MARK TO MARKET + REPORT ----------
  let posVal = 0; const lines = [];
  for (const addr of Object.keys(S.positions)) {
    const pos = S.positions[addr];
    const cur = priceNow.get(addr) ?? (S.hist[addr]?.length ? S.hist[addr][S.hist[addr].length - 1][1] : pos.entry);
    const v = pos.cost * (cur / pos.entry); posVal += v;
    lines.push(`   • $${pos.sym} ${(cur / pos.entry - 1) >= 0 ? "+" : ""}${((cur / pos.entry - 1) * 100).toFixed(1)}%  (${v.toFixed(5)} ETH)`);
  }
  const equity = S.cash + posVal;
  const wr = S.trades ? (S.wins / S.trades * 100).toFixed(0) : "0";
  // prune stale price history for tokens we no longer track/see to keep state small
  for (const k of Object.keys(S.hist)) { const h = S.hist[k]; while (h.length && nowH - h[0][0] > 24) h.shift(); if (!h.length) delete S.hist[k]; }
  writeFileSync(STATE, JSON.stringify(S));

  if (fills.length) {
    const ethUsd = Number((await jget(`https://api.dexscreener.com/tokens/v1/robinhood/${WETH}`))?.[0]?.priceUsd || 0);
    const usd = (e) => ethUsd ? ` (~$${(e * ethUsd).toFixed(2)})` : "";
    await tg(
      `${DRY_RUN ? "📝 *PAPER*" : "💸 *LIVE*"} scalper\n` +
      fills.join("\n") + "\n\n" +
      `💼 Equity *${equity.toFixed(5)} ETH*${usd(equity)}  (${equity >= START_BANK ? "+" : ""}${((equity / START_BANK - 1) * 100).toFixed(1)}%)\n` +
      `💵 cash ${S.cash.toFixed(5)} ETH · 📊 ${S.trades} trades · win *${wr}%* · realized *${S.realized >= 0 ? "+" : ""}${S.realized.toFixed(5)} ETH*\n` +
      (lines.length ? `📌 open:\n${lines.join("\n")}` : `📌 no open positions`)
    );
  }
  console.log(`span ${span} swaps ${logs.length} active ${active.length} | equity ${equity.toFixed(5)} cash ${S.cash.toFixed(5)} open ${Object.keys(S.positions).length} trades ${S.trades}/${S.wins} realized ${S.realized.toFixed(5)} fills ${fills.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
