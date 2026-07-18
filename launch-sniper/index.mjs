// launch-sniper — catches NEW Robinhood Chain launches getting early bids, minute-1.
// Watches the V3 factory PoolCreated (every launchpad funnels here), then for each fresh
// pool reads its first minutes of on-chain swaps and DMs only the ones with real early
// buy pressure + liquidity. Filters ~11k launches/day down to the few actually running.
// State: alerted-set (cached). ⚠️ Fresh launches are a casino — small size, take profits.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const RPC = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const V3 = (process.env.V3_FACTORY || "0x1f7d7550b1b028f7571e69a784071f0205fd2efa").toLowerCase();
const WETH = (process.env.WETH || "0x0bd7d308f8e1639fab988df18a8011f41eacad73").toLowerCase();
const PC = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118"; // PoolCreated
const SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const BOT = (process.env.BOT_TOKEN || "").trim(), CHAT = (process.env.CHAT_ID || "6820752140").trim();
const STATE = process.env.STATE_FILE || "launch-sniper/.alerted.json";
const WINDOW = Number(process.env.WINDOW_BLOCKS || "12000");   // ~20 min of new pools to consider
const MIN_LP_ETH = Number(process.env.MIN_LP_ETH || "0.2");    // real liquidity floor
const MIN_BUYS = Number(process.env.MIN_BUYS || "12");
const BUY_RATIO = Number(process.env.BUY_RATIO || "2.5");
const MIN_BUYVOL_ETH = Number(process.env.MIN_BUYVOL_ETH || "0.25");
const EVAL_CAP = Number(process.env.EVAL_CAP || "160");
// --- anti-bot: fake-buy inflation guards ---
const MIN_AVG_BUY = Number(process.env.MIN_AVG_BUY || "0.004"); // reject tiny bot-spam buys
const UNIQ_SAMPLE = Number(process.env.UNIQ_SAMPLE || "30");    // # of buy txs to sample for real wallets
const UNIQ_MIN = Number(process.env.UNIQ_MIN || "10");          // need >=10 distinct real buyers
const UNIQ_RATIO = Number(process.env.UNIQ_RATIO || "0.5");     // ...and >=50% of buys from distinct wallets
if (!BOT) { console.error("BOT_TOKEN required"); process.exit(1); }

const rpc = async (m, p) => { const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) }); return (await r.json()).result; };
const tg = (t) => fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: CHAT, text: t, parse_mode: "Markdown", disable_web_page_preview: true }) }).catch(() => {});
const s256 = (h) => { const v = BigInt("0x" + h); return v >= (1n << 255n) ? v - (1n << 256n) : v; };
const strCall = async (to, sel) => { try { const r = await rpc("eth_call", [{ to, data: sel }, "latest"]); if (!r || r === "0x") return ""; const len = parseInt(r.slice(66, 130), 16); return Buffer.from(r.slice(130, 130 + len * 2), "hex").toString("utf8").replace(/\0+$/, ""); } catch { return ""; } };
const lpEth = async (pool) => { try { const r = await rpc("eth_call", [{ to: WETH, data: "0x70a08231" + "0".repeat(24) + pool.slice(2) }, "latest"]); return Number(BigInt(r)) / 1e18; } catch { return 0; } };

async function main() {
  const tip = parseInt(await rpc("eth_blockNumber", []), 16);
  const from = tip - WINDOW;
  // all pools created in the window
  const logs = await rpc("eth_getLogs", [{ address: V3, topics: [PC], fromBlock: "0x" + from.toString(16), toBlock: "0x" + tip.toString(16) }]) || [];
  const st = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  const nowS = Math.floor(Date.now() / 1000);
  for (const k in st) if (nowS - st[k] > 7200) delete st[k]; // prune >2h
  const pools = logs.slice(-EVAL_CAP).map((l) => {
    const t0 = "0x" + l.topics[1].slice(-40), t1 = "0x" + l.topics[2].slice(-40);
    const pool = "0x" + l.data.slice(-40);
    return { pool, token: t0 === WETH ? t1 : t0, wethIsT0: t0 === WETH, blk: parseInt(l.blockNumber, 16) };
  }).filter((p) => !st[p.pool]);
  let alerted = 0;
  for (const p of pools) {
    const lp = await lpEth(p.pool);
    if (lp < MIN_LP_ETH) continue;                       // cheap reject: no real liquidity yet
    const sw = await rpc("eth_getLogs", [{ address: p.pool, topics: [SWAP], fromBlock: "0x" + p.blk.toString(16), toBlock: "0x" + tip.toString(16) }]) || [];
    let buys = 0, sells = 0, buyVol = 0; const buyTxs = [];
    for (const s of sw) {
      const d = s.data.slice(2); const a0 = s256(d.slice(0, 64)), a1 = s256(d.slice(64, 128));
      const wethDelta = p.wethIsT0 ? a0 : a1, tokDelta = p.wethIsT0 ? a1 : a0;
      if (tokDelta < 0n) { buys++; buyVol += Number(wethDelta > 0n ? wethDelta : -wethDelta) / 1e18; buyTxs.push(s.transactionHash); } // token left pool = BUY
      else if (tokDelta > 0n) sells++;
    }
    if (buys < MIN_BUYS || buys < sells * BUY_RATIO || buyVol < MIN_BUYVOL_ETH) continue;
    // --- anti-bot: reject fake buy inflation ---
    // 1) tiny average buy = spam bot padding the count with dust
    const avgBuy = buyVol / buys;
    if (avgBuy < MIN_AVG_BUY) { console.log(`skip ${p.pool} avgBuy ${avgBuy.toFixed(5)} < ${MIN_AVG_BUY} (dust spam)`); continue; }
    // 2) many buys from few wallets = one bot faking demand. Sample real senders (tx.from).
    const sampleTxs = buyTxs.slice(0, UNIQ_SAMPLE);
    const froms = await Promise.all(sampleTxs.map(async (h) => { try { const tx = await rpc("eth_getTransactionByHash", [h]); return (tx && tx.from || "").toLowerCase(); } catch { return ""; } }));
    const sampled = froms.filter(Boolean).length;
    const uniqBuyers = new Set(froms.filter(Boolean)).size;
    if (sampled && (uniqBuyers < UNIQ_MIN || uniqBuyers < sampled * UNIQ_RATIO)) {
      console.log(`skip ${p.pool} uniq ${uniqBuyers}/${sampled} buyers (bot-inflated)`); continue;
    }
    st[p.pool] = nowS; alerted++;
    const sym = (await strCall(p.token, "0x95d89b41")) || "?", name = (await strCall(p.token, "0x06fdde03")) || "";
    const ageMin = Math.max(1, Math.round((tip - p.blk) * 0.1 / 60)); // ~0.1s/block
    await tg(
      `⚡ *EARLY: $${sym}*${name ? ` — ${name}` : ""}  (~${ageMin}m old)\n` +
      `🟢 *${buys} buys* / ${sells} sells · bought *${buyVol.toFixed(2)} ETH*\n` +
      `👛 *${uniqBuyers}/${sampled}* real wallets · avg *${avgBuy.toFixed(4)} ETH*/buy\n` +
      `💧 LP *${lp.toFixed(2)} ETH*\n\`${p.token}\`\n` +
      `[Explorer](https://robinhoodchain.blockscout.com/token/${p.token}) · [Chart](https://dexscreener.com/robinhood/${p.token})\n` +
      `⚠️ _Minute-1 launch. Casino — small size, take profits fast._`
    );
    console.log(`SNIPE ${sym} buys ${buys}/${sells} buyVol ${buyVol.toFixed(2)} lp ${lp.toFixed(2)}`);
  }
  writeFileSync(STATE, JSON.stringify(st));
  console.log(`window pools ${pools.length}, ${alerted} early movers`);
}
main().catch((e) => { console.error(e); process.exit(1); });
