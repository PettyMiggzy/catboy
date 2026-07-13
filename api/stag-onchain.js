// $STAG on-chain announcer (Vercel Cron, every minute).
// Announces to Telegram, off the standard ERC-721/ERC-20 Transfer event (no ABI needed):
//   - NFT MINT   : HoodedTwenty Transfer from 0x0
//   - NFT BUY    : HoodedTwenty Transfer wallet -> wallet
//   - NFT STAKE  : HoodedTwenty Transfer -> StagStaking  (and <- = unstake)
//   - STAKE      : $STAG token Transfer -> StagStaking   (and <- = unstake)
// Read-only. Fires nothing until mint/staking are actually live on-chain.
import { neon } from "@neondatabase/serverless";

const RPC = (process.env.RHC_RPC || "https://rpc.mainnet.chain.robinhood.com").trim();
const CONN = (process.env.DATABASE_URL || process.env.POSTGRES_URL || "").trim();
const TOKEN = (process.env.STAG_BOT_TOKEN || "").trim();
const CHAT = (process.env.STAG_ANNOUNCE_CHAT || "-1003369963744").trim();
const CRON_SECRET = (process.env.CRON_SECRET || "").trim();
const NFT = (process.env.STAG_NFT || "0x4384cB362D908d36266bDF3C31F18DB95EB127dc").toLowerCase();
const STAKING = (process.env.STAG_STAKING || "0x2faA6672546912e7cDec4E1AaCF1eeF52bA524fF").toLowerCase();
const STAG = (process.env.STAG_TOKEN || "0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49").toLowerCase();
const EXPLORER = (process.env.RHC_EXPLORER || "https://robinhoodchain.blockscout.com").replace(/\/$/, "");
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000";
const pad = (a) => "0x" + "0".repeat(24) + a.replace(/^0x/, "").toLowerCase();
const STK_TOPIC = pad(STAKING);
// Whale-buy alerts: watch the $STAG/WETH Uniswap V3 pool Swap events, alert big BUYS to the whale group.
const WETH = (process.env.RHC_WETH || "0x0bd7d308f8e1639fab988df18a8011f41eacad73").toLowerCase();
const POOL = (process.env.STAG_POOL || "0x8874bd3c8a9cb1baeee6014bd2d3598d4741e075").toLowerCase();
const WHALE_CHAT = (process.env.STAG_WHALE_CHAT || "-1004295600427").trim();
const WHALE_BUY_MIN = parseFloat(process.env.STAG_WHALE_BUY_MIN || "500000"); // min $STAG bought to alert
const SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const STAG_IS_TOKEN1 = BigInt(STAG) > BigInt(WETH); // V3 sorts tokens by address (WETH < STAG here)
const MAX_RANGE = 40000, MAX_POSTS = 10;
export const config = { maxDuration: 60 };

let _id = 0;
async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++_id, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(method + ": " + (j.error.message || "")); return j.result;
}
const big = (h) => (h && h !== "0x" ? BigInt(h) : 0n);
const addr = (t) => "0x" + t.slice(26);
const shrt = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const eth = (wei) => (Number(wei) / 1e18);
function fmt(n) { return n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : n.toLocaleString("en-US", { maximumFractionDigits: 2 }); }
async function tg(text, chat = CHAT) {
  try { const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "Markdown", disable_web_page_preview: true }) }); return (await r.json()).ok; } catch { return false; }
}
const link = (a) => `[${shrt(a)}](${EXPLORER}/address/${a})`;
// two's-complement decode of a 32-byte int256 word (hex without 0x)
const sint = (hx) => { let v = BigInt("0x" + hx); if (v >> 255n) v -= 1n << 256n; return v; };
async function stagPriceUsd() {
  try { const r = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + STAG, { headers: { "User-Agent": "Mozilla/5.0" } });
    const j = await r.json(); const p = (j.pairs || []).sort((a, b) => ((b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)))[0];
    return p ? Number(p.priceUsd) || 0 : 0; } catch { return 0; }
}

export default async function handler(req, res) {
  if (CRON_SECRET) { if ((req.headers["authorization"] || "") !== `Bearer ${CRON_SECRET}`) return res.status(401).end(); }
  if (!CONN || !TOKEN || !CHAT) return res.status(200).json({ ok: false, reason: "not_configured" });
  const s = neon(CONN);
  await s`CREATE TABLE IF NOT EXISTS stag_chain_state (k TEXT PRIMARY KEY, v BIGINT)`;
  await s`CREATE TABLE IF NOT EXISTS stag_chain_seen (id TEXT PRIMARY KEY, at TIMESTAMPTZ DEFAULT now())`;

  const tip = Number(big(await rpc("eth_blockNumber", [])));
  const row = await s`SELECT v FROM stag_chain_state WHERE k='last_block'`;
  // First run backfills recent history so freshly-activated mint/staking isn't missed;
  // the stag_chain_seen dedup guarantees nothing is announced twice.
  let from = row.length ? Number(row[0].v) + 1 : Math.max(0, tip - 60000);
  if (from > tip) return res.status(200).json({ ok: true, tip, nothing: true });
  const to = Math.min(tip, from + MAX_RANGE);
  const range = { fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) };

  // collect events
  // Only bullish signals: mints, buys, stakes. Unstakes are intentionally NOT queried/announced.
  let nftLogs = [], stakeIn = [], swapLogs = [];
  try {
    [nftLogs, stakeIn, swapLogs] = await Promise.all([
      rpc("eth_getLogs", [{ address: NFT, topics: [TRANSFER], ...range }]),
      rpc("eth_getLogs", [{ address: STAG, topics: [TRANSFER, null, STK_TOPIC], ...range }]), // $STAG -> staking
      (POOL && WHALE_CHAT) ? rpc("eth_getLogs", [{ address: POOL, topics: [SWAP], ...range }]) : Promise.resolve([]), // whale buys
    ]);
  } catch (e) { return res.status(200).json({ ok: false, error: String(e).slice(0, 150) }); }

  const events = [];
  for (const lg of nftLogs) {
    const f = addr(lg.topics[1]), t = addr(lg.topics[2]), id = String(big(lg.topics[3] || "0x0"));
    if (f.toLowerCase() === STAKING) continue;   // skip NFT unstakes (bearish)
    let kind = "nft_xfer";
    if (f.toLowerCase() === ZERO) kind = "nft_mint";
    else if (t.toLowerCase() === STAKING) kind = "nft_stake";
    events.push({ kind, f, t, id, lg });
  }
  for (const lg of stakeIn) events.push({ kind: "stake", f: addr(lg.topics[1]), amt: eth(big(lg.data)), lg });

  let posted = 0;
  for (const e of events) {
    if (posted >= MAX_POSTS) break;
    const key = `${e.lg.transactionHash}:${e.lg.logIndex}`;
    const ins = await s`INSERT INTO stag_chain_seen (id) VALUES (${key}) ON CONFLICT DO NOTHING RETURNING id`;
    if (!ins.length) continue;
    let msg = "";
    if (e.kind === "nft_mint") {
      let price = ""; try { const tx = await rpc("eth_getTransactionByHash", [e.lg.transactionHash]); const v = eth(big(tx.value)); if (v > 0) price = ` for *${v} ETH*`; } catch {}
      msg = `🦌🏹 *NEW $STAG NFT MINTED!*\nHooded Twenty *#${e.id}* minted by ${link(e.t)}${price}.\n[View](${EXPLORER}/token/${NFT}/instance/${e.id})  ·  Mint: /nft`;
    } else if (e.kind === "nft_stake") {
      msg = `🔒🦌 *NFT STAKED!*\n${link(e.f)} staked Hooded Twenty *#${e.id}* — earning $STAG. 🌿`;
    } else if (e.kind === "nft_xfer") {
      msg = `🛒🦌 *$STAG NFT moved*\nHooded Twenty *#${e.id}*: ${link(e.f)} → ${link(e.t)}.`;
    } else if (e.kind === "stake") {
      msg = `🔒💚 *$STAG STAKED!*\n${link(e.f)} staked *${fmt(e.amt)} $STAG*. Steal the pump, feed the holders. 🦌`;
    }
    // Send FIRST-effect: if the Telegram post fails, drop the "seen" row so the
    // event is retried next minute instead of being silently lost forever.
    if (msg) { if (await tg(msg)) posted++; else await s`DELETE FROM stag_chain_seen WHERE id=${key}`; }
  }

  // ---- Whale BUYS: big $STAG buys off the V3 pool Swap events -> whale group ----
  let whalePrice = null, whales = 0;
  for (const lg of swapLogs) {
    if (posted >= MAX_POSTS) break;
    const d = (lg.data || "0x").replace(/^0x/, "");
    if (d.length < 128) continue;
    const a0 = sint(d.slice(0, 64)), a1 = sint(d.slice(64, 128));
    const stagDelta = STAG_IS_TOKEN1 ? a1 : a0;    // < 0 = $STAG left the pool = a BUY
    const wethDelta = STAG_IS_TOKEN1 ? a0 : a1;
    if (stagDelta >= 0n) continue;                 // sells/adds are not buys
    const stagBought = Number(-stagDelta) / 1e18;
    if (stagBought < WHALE_BUY_MIN) continue;
    const ethSpent = Number(wethDelta < 0n ? -wethDelta : wethDelta) / 1e18;
    const buyer = addr(lg.topics[2]);              // Swap recipient
    const key = `whalebuy:${lg.transactionHash}:${lg.logIndex}`;
    const ins = await s`INSERT INTO stag_chain_seen (id) VALUES (${key}) ON CONFLICT DO NOTHING RETURNING id`;
    if (!ins.length) continue;
    if (whalePrice === null) whalePrice = await stagPriceUsd();
    const usd = whalePrice ? stagBought * whalePrice : 0;
    const bars = "🟢".repeat(Math.max(1, Math.min(48, Math.round(stagBought / WHALE_BUY_MIN))));
    const msg = `🐋💚 *$STAG WHALE BUY!*\n${bars}\n\n💰 *${fmt(stagBought)} $STAG*${usd ? ` (\\$${fmt(usd)})` : ""}\n💸 for *${ethSpent.toFixed(4)} ETH*\n🏹 Buyer: ${link(buyer)}\n[Chart](https://dexscreener.com/robinhood/${STAG})  ·  [Tx](${EXPLORER}/tx/${lg.transactionHash})`;
    if (await tg(msg, WHALE_CHAT)) { posted++; whales++; } else await s`DELETE FROM stag_chain_seen WHERE id=${key}`;
  }

  await s`INSERT INTO stag_chain_state (k, v) VALUES ('last_block', ${to}) ON CONFLICT (k) DO UPDATE SET v=${to}`;
  return res.status(200).json({ ok: true, from, to, tip, nft: nftLogs.length, stakeIn: stakeIn.length, swaps: swapLogs.length, whales, posted });
}
