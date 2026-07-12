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
async function tg(text) {
  try { const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "Markdown", disable_web_page_preview: true }) }); return (await r.json()).ok; } catch { return false; }
}
const link = (a) => `[${shrt(a)}](${EXPLORER}/address/${a})`;

export default async function handler(req, res) {
  if (CRON_SECRET) { if ((req.headers["authorization"] || "") !== `Bearer ${CRON_SECRET}`) return res.status(401).end(); }
  if (!CONN || !TOKEN || !CHAT) return res.status(200).json({ ok: false, reason: "not_configured" });
  const s = neon(CONN);
  await s`CREATE TABLE IF NOT EXISTS stag_chain_state (k TEXT PRIMARY KEY, v BIGINT)`;
  await s`CREATE TABLE IF NOT EXISTS stag_chain_seen (id TEXT PRIMARY KEY, at TIMESTAMPTZ DEFAULT now())`;

  const tip = Number(big(await rpc("eth_blockNumber", [])));
  const row = await s`SELECT v FROM stag_chain_state WHERE k='last_block'`;
  let from = row.length ? Number(row[0].v) + 1 : tip - 500;
  if (from > tip) return res.status(200).json({ ok: true, tip, nothing: true });
  const to = Math.min(tip, from + MAX_RANGE);
  const range = { fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) };

  // collect events
  // Only bullish signals: mints, buys, stakes. Unstakes are intentionally NOT queried/announced.
  let nftLogs = [], stakeIn = [];
  try {
    [nftLogs, stakeIn] = await Promise.all([
      rpc("eth_getLogs", [{ address: NFT, topics: [TRANSFER], ...range }]),
      rpc("eth_getLogs", [{ address: STAG, topics: [TRANSFER, null, STK_TOPIC], ...range }]), // $STAG -> staking
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
    if (msg && (await tg(msg))) posted++;
  }
  await s`INSERT INTO stag_chain_state (k, v) VALUES ('last_block', ${to}) ON CONFLICT (k) DO UPDATE SET v=${to}`;
  return res.status(200).json({ ok: true, from, to, tip, nft: nftLogs.length, stakeIn: stakeIn.length, posted });
}
