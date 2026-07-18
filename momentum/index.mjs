// momentum — rides trends on the HIGHEST-LIQUIDITY Robinhood Chain tokens. PAPER by default.
// Built from a full day of backtesting: dip-scalping had no edge; on deep-liquidity tokens
// (CASHCAT $60M/$3M-liq) buying STRENGTH and trailing the stop captured +19% vs ~0% scalping.
// So this bot:
//   1. ranks every active pool by REAL WETH depth, trades ONLY the deepest (high liquidity)
//   2. ENTERS on momentum — price up MOM% over ~10min WITH net buying (not dips)
//   3. EXITS with a trailing stop (ride the trend) + hard stop + time stop — no fixed take-profit
//   4. clean holders + cost guard, small position sizing
// Runs from GitHub Actions; bankroll + positions + price history persist via cache.
// Flip live later with a verified ROUTER+QUOTER+burner PRIVATE_KEY (see executeTrade).
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const RPC = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const WETH = (process.env.WETH || "0x0bd7d308f8e1639fab988df18a8011f41eacad73").toLowerCase();
const SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const BS = "https://robinhoodchain.blockscout.com/api/v2";
const POOLISH = /pool|pair|lp/i;
const BOT = (process.env.BOT_TOKEN || "").trim();
const CHAT = (process.env.CHAT_ID || "6820752140").trim();
const STATE = process.env.STATE_FILE || "momentum/.state.json";
const DRY_RUN = (process.env.DRY_RUN ?? "1") !== "0";

// --- capital (ETH) ---
const START_BANK = Number(process.env.START_BANK_ETH || "0.02");
const RISK_FRAC = Number(process.env.RISK_FRAC || "0.15");
const MAX_POS = Number(process.env.MAX_POS || "4");
const MIN_TRADE = Number(process.env.MIN_TRADE_ETH || "0.003");

// --- universe: HIGH LIQUIDITY first ---
const WINDOW_BLOCKS = Number(process.env.WINDOW_BLOCKS || "2500");
const MIN_SWAPS = Number(process.env.MIN_SWAPS || "10");      // must be actively trading
const MIN_LP_ETH = Number(process.env.MIN_LP_ETH || "40");    // deep pool floor (~$250k+ liq) — the whole point
const MAX_LP_ETH = Number(process.env.MAX_LP_ETH || "5000");  // skip ultra-deep pegs/megapools that never move
const TOP_LIQ = Number(process.env.TOP_LIQ || "20");          // watch this many deep-enough pools
const TOP_HOLDER_MAX = Number(process.env.TOP_HOLDER_MAX || "8");

// --- entry: momentum (buy strength, not dips) ---
const MOM_PCT = Number(process.env.MOM_PCT || "2");           // up >=2% ...
const MOM_MIN = Number(process.env.MOM_MIN || "10");          // ...over ~10 min
const MAX_EXT = Number(process.env.MAX_EXT || "12");          // skip if already up >12% (chasing too late)

// --- exit: ride it ---
const TRAIL_PCT = Number(process.env.TRAIL_PCT || "6");       // give back 6% from the high => exit
const SL_PCT = Number(process.env.SL_PCT || "5");             // hard stop
const MAX_HOLD_H = Number(process.env.MAX_HOLD_H || "12");

// --- cost (ETH) ---
const FEE_BPS = Number(process.env.FEE_BPS || "30");
const GAS_ETH = Number(process.env.GAS_ETH || "0.000015");
const IMPACT_K = Number(process.env.IMPACT_K || "1.0");
const SLIP_CAP = Number(process.env.SLIP_CAP || "5");
const MAX_COST_PCT = Number(process.env.MAX_COST_PCT || "2");

if (!BOT) { console.error("BOT_TOKEN required"); process.exit(1); }
const feeFrac = FEE_BPS / 10000;

const rpc = async (m, p) => { try { const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) }); return (await r.json()).result; } catch { return null; } };
const jget = async (u) => { try { const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20000) }); return r.ok ? r.json() : null; } catch { return null; } };
const tg = (t) => fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: CHAT, text: t, parse_mode: "Markdown", disable_web_page_preview: true }) }).catch(() => {});
const s256 = (h) => { const v = BigInt("0x" + h); return v >= (1n << 255n) ? v - (1n << 256n) : v; };
const strCall = async (to, sel) => { try { const r = await rpc("eth_call", [{ to, data: sel }, "latest"]); if (!r || r === "0x") return ""; const len = parseInt(r.slice(66, 130), 16); return Buffer.from(r.slice(130, 130 + len * 2), "hex").toString("utf8").replace(/\0+$/, ""); } catch { return ""; } };
const addrCall = async (to, sel) => { try { const r = await rpc("eth_call", [{ to, data: sel }, "latest"]); return r && r !== "0x" ? ("0x" + r.slice(-40)).toLowerCase() : ""; } catch { return ""; } };
const lpEth = async (pool) => { const r = await rpc("eth_call", [{ to: WETH, data: "0x70a08231" + "0".repeat(24) + pool.slice(2) }, "latest"]); return r ? Number(BigInt(r)) / 1e18 : 0; };
const priceFromSwap = (dataHex, wethIsT0) => { const w = dataHex.slice(2); const sq = Number(BigInt("0x" + w.slice(128, 192))) / 2 ** 96; const P = sq * sq; return P > 0 ? (wethIsT0 ? 1 / P : P) : 0; };

async function holderTop(addr) {
  const meta = await jget(`${BS}/tokens/${addr}`), holders = await jget(`${BS}/tokens/${addr}/holders`);
  if (!meta || !holders?.items) return 100;
  const dec = Number(meta.decimals || 18), supply = Number(meta.total_supply || "0") / 10 ** dec;
  if (!supply) return 100;
  let top = 0;
  for (const h of holders.items) { const a = h.address || {}, name = (a.name || "").toLowerCase(); if (a.is_contract || POOLISH.test(name) || /dead|0x0000/.test((a.hash || "").toLowerCase())) continue; const v = Number(h.value || "0") / 10 ** dec; if (v > top) top = v; }
  return (top / supply) * 100;
}
const costPctFor = (sizeEth, lp) => feeFrac * 100 * 2 + Math.min(SLIP_CAP, (sizeEth / Math.max(lp, 1e-9)) * 100 * IMPACT_K) * 2 + (GAS_ETH / Math.max(sizeEth, 1e-9)) * 100 * 2;
async function executeTrade(side, priceEth) { if (DRY_RUN) return priceEth; throw new Error("LIVE not wired — supply verified ROUTER+QUOTER+burner PRIVATE_KEY before DRY_RUN=0"); }
async function getSwaps(tip) { for (const span of [WINDOW_BLOCKS, 1600, 1000, 600]) { const logs = await rpc("eth_getLogs", [{ topics: [SWAP], fromBlock: "0x" + (tip - span).toString(16), toBlock: "0x" + tip.toString(16) }]); if (Array.isArray(logs)) return logs; } return []; }

async function main() {
  const tip = parseInt(await rpc("eth_blockNumber", []), 16);
  if (!tip) { console.error("no RPC"); process.exit(1); }
  const logs = await getSwaps(tip);
  const st = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null;
  const S = st || { cash: START_BANK, positions: {}, realized: 0, trades: 0, wins: 0 };
  S.pools = S.pools || {}; S.hist = S.hist || {};
  const nowH = Date.now() / 3.6e6;

  // aggregate window per pool
  const agg = new Map();
  for (const l of logs) { const pool = l.address.toLowerCase(); let a = agg.get(pool); if (!a) { a = { n: 0, first: null, last: null }; agg.set(pool, a); } a.n++; a.last = l; if (!a.first) a.first = l; }

  // resolve active pools, measure liquidity, keep only the DEEPEST (high-liquidity)
  let active = [];
  for (const [pool, a] of agg) {
    if (a.n < MIN_SWAPS) continue;
    let meta = S.pools[pool];
    if (!meta) { const t0 = await addrCall(pool, "0x0dfe1681"), t1 = await addrCall(pool, "0xd21220a7"); if (!t0 || !t1) continue; const wethIsT0 = t0 === WETH, token = wethIsT0 ? t1 : t0; if (token === WETH || !/^0x[0-9a-f]{40}$/.test(token)) continue; const sym = (await strCall(token, "0x95d89b41")) || "?"; meta = S.pools[pool] = { token, wethIsT0, sym }; }
    const lp = await lpEth(pool);
    if (lp < MIN_LP_ETH || lp > MAX_LP_ETH) continue;    // deep enough to trade cheap, not a dead megapool/peg
    let buys = 0, sells = 0;
    for (const l of logs) { if (l.address.toLowerCase() !== pool) continue; const d = l.data.slice(2); const a1 = s256(d.slice(64, 128)), a0 = s256(d.slice(0, 64)); const tokDelta = meta.wethIsT0 ? a1 : a0; if (tokDelta < 0n) buys++; else if (tokDelta > 0n) sells++; }
    active.push({ pool, ...meta, n: a.n, buys, sells, lp, firstP: priceFromSwap(a.first.data, meta.wethIsT0), lastP: priceFromSwap(a.last.data, meta.wethIsT0) });
  }
  active.sort((x, y) => y.lp - x.lp);
  active = active.slice(0, TOP_LIQ);

  // update price history (per token) for the momentum lookback
  for (const p of active) { if (!p.lastP) continue; const h = (S.hist[p.token] = S.hist[p.token] || []); h.push([nowH, p.lastP]); while (h.length && nowH - h[0][0] > 24) h.shift(); }
  const priceNow = new Map(active.map((p) => [p.token, p.lastP]));
  const chMin = (token, mins) => { const h = S.hist[token]; if (!h || h.length < 2) return null; const cutoff = nowH - mins / 60; let ref = null; for (const [t, pr] of h) { if (t <= cutoff) ref = pr; } if (ref == null) ref = h[0][1]; const cur = h[h.length - 1][1]; return ref ? (cur / ref - 1) * 100 : null; };

  const fills = [];

  // ---------- manage positions (trailing / stop / time) ----------
  for (const addr of Object.keys(S.positions)) {
    const pos = S.positions[addr];
    const cur = priceNow.get(addr) ?? (S.hist[addr]?.length ? S.hist[addr][S.hist[addr].length - 1][1] : pos.entry);
    if (!cur) continue;
    pos.high = Math.max(pos.high || pos.entry, cur);
    const gainPct = (cur / pos.entry - 1) * 100, ddFromHigh = (pos.high - cur) / pos.high * 100, ageH = nowH - pos.openedH;
    let reason = null;
    if (gainPct <= -SL_PCT) reason = "🛑 stop";
    else if (ddFromHigh >= TRAIL_PCT) reason = "🔒 trail";      // rode it up, gave back TRAIL% from peak
    else if (ageH >= MAX_HOLD_H) reason = "⌛ time";
    if (!reason) continue;
    const lp = pos.lp || MIN_LP_ETH, posValue = pos.cost * (cur / pos.entry);
    const exitCost = posValue * (feeFrac + Math.min(SLIP_CAP, (posValue / Math.max(lp, 1e-9)) * 100 * IMPACT_K) / 100) + GAS_ETH;
    await executeTrade("sell", cur);
    const proceeds = posValue - exitCost, net = proceeds - (pos.cost + pos.entryCost);
    S.cash += proceeds; S.realized += net; S.trades++; if (net > 0) S.wins++;
    fills.push(`${net >= 0 ? "🟢" : "🔴"} SOLD *$${pos.sym}* ${reason}  ${gainPct >= 0 ? "+" : ""}${gainPct.toFixed(1)}%  → *${net >= 0 ? "+" : ""}${net.toFixed(5)} ETH*  (peak +${((pos.high / pos.entry - 1) * 100).toFixed(1)}%, held ${ageH.toFixed(1)}h)`);
    delete S.positions[addr];
  }

  // ---------- entries: momentum on the deepest pools ----------
  const openN = Object.keys(S.positions).length;
  if (openN < MAX_POS && S.cash >= MIN_TRADE && active.length) {
    const cands = active
      .filter((p) => !S.positions[p.token] && p.lastP > 0 && p.buys > p.sells)     // net buying
      .map((p) => { const m = chMin(p.token, MOM_MIN); const mom = m != null ? m : (p.firstP > 0 ? (p.lastP / p.firstP - 1) * 100 : 0); return { ...p, mom }; })
      .filter((p) => p.mom >= MOM_PCT && p.mom <= MAX_EXT)                          // rising, but not already blown off
      .sort((a, b) => b.mom - a.mom);                                              // strongest trend first
    let slots = MAX_POS - openN;
    for (const c of cands) {
      if (slots <= 0 || S.cash < MIN_TRADE) break;
      const sizeEth = Math.min(S.cash * RISK_FRAC, S.cash); if (sizeEth < MIN_TRADE) break;
      const costPct = costPctFor(sizeEth, c.lp);
      if (costPct > MAX_COST_PCT) { console.log(`skip $${c.sym}: cost ${costPct.toFixed(2)}%`); continue; }
      const top = await holderTop(c.token);
      if (top > TOP_HOLDER_MAX) { console.log(`skip $${c.sym}: whale ${top.toFixed(1)}%`); continue; }
      const price = await executeTrade("buy", c.lastP);
      const entryCost = sizeEth * (feeFrac + Math.min(SLIP_CAP, (sizeEth / Math.max(c.lp, 1e-9)) * 100 * IMPACT_K) / 100) + GAS_ETH;
      S.cash -= (sizeEth + entryCost);
      S.positions[c.token] = { sym: c.sym, entry: price, high: price, cost: sizeEth, entryCost, lp: c.lp, pool: c.pool, openedH: nowH };
      fills.push(`🚀 BOUGHT *$${c.sym}*  ${sizeEth.toFixed(5)} ETH\n   momentum *+${c.mom.toFixed(1)}%*/${MOM_MIN}m · liq *${c.lp.toFixed(0)} ETH* · ${c.buys}b/${c.sells}s · trail ${TRAIL_PCT}% / stop -${SL_PCT}%`);
      slots--;
    }
  }

  // ---------- mark to market + report ----------
  let posVal = 0; const lines = [];
  for (const addr of Object.keys(S.positions)) { const pos = S.positions[addr]; const cur = priceNow.get(addr) ?? (S.hist[addr]?.length ? S.hist[addr][S.hist[addr].length - 1][1] : pos.entry); const v = pos.cost * (cur / pos.entry); posVal += v; lines.push(`   • $${pos.sym} ${(cur / pos.entry - 1) >= 0 ? "+" : ""}${((cur / pos.entry - 1) * 100).toFixed(1)}%  (${v.toFixed(5)} ETH)`); }
  const equity = S.cash + posVal, wr = S.trades ? (S.wins / S.trades * 100).toFixed(0) : "0";
  for (const k of Object.keys(S.hist)) { const h = S.hist[k]; while (h.length && nowH - h[0][0] > 24) h.shift(); if (!h.length) delete S.hist[k]; }

  const HEARTBEAT_H = Number(process.env.HEARTBEAT_H || "1");
  const beatDue = nowH - (S.lastBeat || 0) >= HEARTBEAT_H;
  if (fills.length || beatDue) {
    S.lastBeat = nowH;
    const ethUsd = Number((await jget(`https://api.dexscreener.com/tokens/v1/robinhood/${WETH}`))?.[0]?.priceUsd || 0);
    const usd = (e) => ethUsd ? ` (~$${(e * ethUsd).toFixed(2)})` : "";
    const stats = `💼 Equity *${equity.toFixed(5)} ETH*${usd(equity)}  (${equity >= START_BANK ? "+" : ""}${((equity / START_BANK - 1) * 100).toFixed(1)}%)\n💵 cash ${S.cash.toFixed(5)} ETH · 📊 ${S.trades} trades · win *${wr}%* · realized *${S.realized >= 0 ? "+" : ""}${S.realized.toFixed(5)} ETH*\n` + (lines.length ? `📌 open:\n${lines.join("\n")}` : `📌 no open positions`);
    await tg(fills.length ? `${DRY_RUN ? "📝 *PAPER*" : "💸 *LIVE*"} momentum\n${fills.join("\n")}\n\n${stats}` : `${DRY_RUN ? "📝 *PAPER*" : "💸 *LIVE*"} momentum · hourly check\n${stats}`);
  }
  writeFileSync(STATE, JSON.stringify(S));
  console.log(`swaps ${logs.length} · deep pools ${active.length} · equity ${equity.toFixed(5)} cash ${S.cash.toFixed(5)} open ${Object.keys(S.positions).length} trades ${S.trades}/${S.wins} fills ${fills.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
