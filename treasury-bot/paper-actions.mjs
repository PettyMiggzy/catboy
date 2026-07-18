// Phase-1 PAPER trader for GitHub Actions (single-shot, no key, no real money).
// Runs the same buy-dip / sell-rip logic on the REAL $STAG price, tracks a simulated
// $50, and DMs every trade + running total to Telegram. State persists via a JSON file
// (the workflow caches it between runs). Flip to live (Phase 2) once execution is verified.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const RPC = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const POOL = (process.env.POOL || "0x8874bd3c8a9cb1baeee6014bd2d3598d4741e075").toLowerCase();
const TOKEN = (process.env.TOKEN || "0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49").toLowerCase();
const STAG_DEX = TOKEN; // for USD display
const BOT = (process.env.BOT_TOKEN || "").trim();
const CHAT = (process.env.CHAT_ID || "6820752140").trim();
const STATE = process.env.STATE_FILE || "treasury-bot/.paper_state.json";
const START_USD = Number(process.env.START_USD || "50");
const DIP = Number(process.env.DIP_PCT || "6") / 100;
const PUMP = Number(process.env.PUMP_PCT || "8") / 100;
const EMA_N = Number(process.env.EMA_N || "20");
const WARMUP = Number(process.env.WARMUP || "8");     // runs before it may trade
if (!BOT) { console.error("BOT_TOKEN required"); process.exit(1); }

const rpc = async (method, params) => {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()).result;
};
const tg = (text) => fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "Markdown", disable_web_page_preview: true }) }).catch(() => {});

async function priceEthPerStag() {
  // token0=WETH, token1=STAG (both 18 dec): (sqrtP/2^96)^2 = STAG per WETH -> invert for ETH per STAG
  const s = await rpc("eth_call", [{ to: POOL, data: "0x3850c7bd" }, "latest"]); // slot0()
  const sqrt = BigInt("0x" + s.slice(2, 66));
  const sp = Number(sqrt) / 2 ** 96;
  const stagPerWeth = sp * sp;
  return 1 / stagPerWeth;
}
async function ethUsd() {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${STAG_DEX}`, { headers: { "User-Agent": "Mozilla/5.0" } });
    const p = (await r.json()).pairs?.[0];
    return p ? Number(p.priceUsd) / Number(p.priceNative) : 0;
  } catch { return 0; }
}

async function main() {
  const price = await priceEthPerStag();
  const eu = await ethUsd();
  let st = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null;
  if (!st) {
    const cashEth = eu ? START_USD / eu : 0;
    st = { ema: price, cashEth, startEth: cashEth, tok: 0, entry: 0, realizedEth: 0, runs: 0, trades: 0, lastAlert: 0 };
    await tg(`📈 *Paper treasury bot LIVE* — tracking a simulated *$${START_USD}* on $STAG.\nStrategy: buy a dip *-${DIP * 100}%* vs trend, sell a rip *+${PUMP * 100}%*. I'll DM every move. 🦌`);
  }
  st.ema = st.ema + (price - st.ema) * (2 / (EMA_N + 1));
  st.runs++;
  const inCash = st.tok === 0;
  const totalEth = st.cashEth + st.tok * price;
  const totalUsd = eu ? totalEth * eu : 0;
  const pct = st.startEth ? ((totalEth / st.startEth) - 1) * 100 : 0;

  let did = null;
  if (st.runs > WARMUP) {
    if (inCash && price <= st.ema * (1 - DIP) && st.cashEth > 0) {
      st.tok = st.cashEth / price; st.entry = price; st.cashEth = 0; st.trades++; did = "BUY";
      await tg(`🟢 *BOUGHT THE DIP* (paper)\nEntry: ${price.toExponential(3)} ETH/$STAG\nNow holding *${Math.round(st.tok).toLocaleString()} $STAG*\n💼 Value: *$${totalUsd.toFixed(2)}* (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`);
    } else if (!inCash && price >= st.ema * (1 + PUMP)) {
      const gain = (price - st.entry) * st.tok;
      st.cashEth = st.tok * price; st.realizedEth += gain; st.tok = 0; st.trades++; did = "SELL";
      const v = st.cashEth * eu;
      const p2 = st.startEth ? ((st.cashEth / st.startEth) - 1) * 100 : 0;
      await tg(`🔴 *SOLD THE RIP* (paper)\nExit: ${price.toExponential(3)} ETH/$STAG\n💰 Back to cash: *$${v.toFixed(2)}* (${p2 >= 0 ? "+" : ""}${p2.toFixed(1)}% total)\nRound trips: *${Math.floor(st.trades / 2)}*`);
    }
  }
  // heartbeat every ~24 runs (~4h) so you know it's alive, without spam
  if (!did && st.runs - st.lastAlert >= 24) {
    st.lastAlert = st.runs;
    await tg(`⏳ Paper bot alive — ${inCash ? "waiting for a dip" : "holding, waiting for a rip"}. Value *$${totalUsd.toFixed(2)}* (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%).`);
  }
  writeFileSync(STATE, JSON.stringify(st));
  console.log(`run ${st.runs} price ${price.toExponential(3)} ema ${st.ema.toExponential(3)} ${inCash ? "CASH" : "HOLD"} val $${totalUsd.toFixed(2)} ${did || ""}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
