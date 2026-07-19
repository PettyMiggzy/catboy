// autocopy/trigger.mjs — our OWN money engine (no copying). Runs the play the winning wallets use,
// reverse-engineered on-chain: buy a FRESH launch (~30-90s old) once it has pulled a burst of
// REAL unique buyers, ride it, exit on our own target BEFORE the crowd. Real-time (droplet/pm2).
// Reuses the executor proven by autocopy/swaptest.mjs (verified Uniswap V3 SwapRouter02).
// DRY_RUN=1 => paper (detect + DM, no trades). Flip to 0 only after the audit + a watched test.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createWalletClient, createPublicClient, http, webSocket, parseEther, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ---------- config ----------
// HYBRID: scan on the FREE public RPC, trade on Alchemy. Alchemy is only hit when we buy/sell.
const SCAN_RPC = process.env.SCAN_RPC || "https://rpc.mainnet.chain.robinhood.com"; // free public — all scanning/reads
const TRADE_RPC = (process.env.RPC_URL || SCAN_RPC).trim();                          // Alchemy (RPC_URL) — trades only
const TRADE_WSS = (process.env.RPC_WSS || "").trim();                                // Alchemy WSS — used for trade-side reads if set
const ROUTER = "0xcaf681a66d020601342297493863e78c959e5cb2";              // verified SwapRouter02
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73".toLowerCase();
const V3 = (process.env.V3_FACTORY || "0x1f7d7550b1b028f7571e69a784071f0205fd2efa").toLowerCase();
const PC_TOPIC = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118"; // PoolCreated
const SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

const COPY_ETH = process.env.COPY_ETH || "0.004";                        // YOUR size per entry (~$10)
const MAX_POS = Number(process.env.MAX_POS || "3");
const MAX_TOTAL_ETH = Number(process.env.MAX_TOTAL_ETH || "0.012");      // hard cap on total deployed
const SLIP = Number(process.env.SLIP || "12") / 100;                     // slippage cap (fresh pools = thin)

// entry trigger (the reverse-engineered play)
const MAX_AGE_MIN = Number(process.env.MAX_AGE_MIN || "3");              // only brand-new launches
const MIN_UNIQ = Number(process.env.MIN_UNIQ || "15");                   // >=15 distinct real buyers
const MIN_BUYS = Number(process.env.MIN_BUYS || "20");
const BUY_RATIO = Number(process.env.BUY_RATIO || "2.5");                // buys >= 2.5x sells
const UNIQ_RATIO = Number(process.env.UNIQ_RATIO || "0.55");             // >=55% of sampled buys distinct (anti-bot)
const MIN_LP_ETH = Number(process.env.MIN_LP_ETH || "0.3");
const TOP_HOLDER_MAX = Number(process.env.TOP_HOLDER_MAX || "20");

// exits (bank before the crowd)
const TAKE_PROFIT = Number(process.env.TAKE_PROFIT || "50") / 100;
const TRAIL_PCT = Number(process.env.TRAIL_PCT || "25") / 100;
const HARD_STOP = Number(process.env.HARD_STOP || "35") / 100;
const MAX_HOLD_MIN = Number(process.env.MAX_HOLD_MIN || "30");
const MAX_COST_PCT = Number(process.env.MAX_COST_PCT || "4");            // reject if est round-trip cost too high

const POLL_MS = Number(process.env.POLL_MS || "2500");
const MIN_TICK_MS = Number(process.env.MIN_TICK_MS || "2500"); // coalesce block pushes — one scan per this window (protects your RPC quota)
const WINDOW_BLOCKS = Number(process.env.WINDOW_BLOCKS || "3000");       // how far back to seed pools on start
const DRY_RUN = (process.env.DRY_RUN ?? "1") !== "0";
const BOT = (process.env.BOT_TOKEN || "").trim(), CHAT = (process.env.CHAT_ID || "6820752140").trim();
const STATE = process.env.STATE_FILE || "autocopy/.trigger.json";
const PK = (process.env.PRIVATE_KEY || "").trim();
const FEE_BPS = 100, GAS_ETH = 0.000015;                                 // 1% pools + measured gas, for the cost guard
if (!DRY_RUN && !PK) { console.error("PRIVATE_KEY required for live"); process.exit(1); }

// ---------- clients ----------
const chain = { id: 4663, name: "robinhood", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [SCAN_RPC] } } };
const account = PK ? privateKeyToAccount(PK.startsWith("0x") ? PK : "0x" + PK) : null;
const pub = createPublicClient({ chain, transport: http(SCAN_RPC) });                                   // scanning — free public
const pubT = createPublicClient({ chain, transport: TRADE_WSS ? webSocket(TRADE_WSS) : http(TRADE_RPC) }); // trade-side reads — Alchemy
const wallet = account ? createWalletClient({ account, chain, transport: http(TRADE_RPC) }) : null;      // tx submission — Alchemy

const ERC20 = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }, { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }, { name: "allowance", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] }];
const WETH_ABI = [{ name: "withdraw", type: "function", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] }, { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];
const ROUTER_ABI = [{ name: "exactInputSingle", type: "function", stateMutability: "payable", inputs: [{ type: "tuple", components: [{ name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "fee", type: "uint24" }, { name: "recipient", type: "address" }, { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }], outputs: [{ name: "amountOut", type: "uint256" }] }];
const POOL_ABI = [{ name: "slot0", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }] }, { name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }, { name: "fee", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] }];

// ---------- helpers ----------
const tg = (t) => BOT ? fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: CHAT, text: t, parse_mode: "Markdown", disable_web_page_preview: true }) }).catch(() => {}) : null;
const rawGet = async (m, p) => { try { const r = await fetch(SCAN_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) }); return (await r.json()).result; } catch { return null; } }; // scanning stays on the free public RPC
const s256 = (h) => { const v = BigInt("0x" + h); return v >= (1n << 255n) ? v - (1n << 256n) : v; };
const metaCache = {};
async function meta(pool) { if (metaCache[pool] !== undefined) return metaCache[pool]; try { const t0 = (await pub.readContract({ address: pool, abi: POOL_ABI, functionName: "token0" })).toLowerCase(); const fee = await pub.readContract({ address: pool, abi: POOL_ABI, functionName: "fee" }); const wethIsT0 = t0 === WETH; const other = wethIsT0 ? null : t0; return metaCache[pool] = other ? { token: other, wethIsT0, fee } : null; } catch { return metaCache[pool] = null; } }
async function priceEth(pool, wethIsT0) { const [sq] = await pub.readContract({ address: pool, abi: POOL_ABI, functionName: "slot0" }); const P = (Number(sq) / 2 ** 96) ** 2; return wethIsT0 ? 1 / P : P; }
async function lpEth(pool) { try { const b = await pub.readContract({ address: WETH, abi: ERC20, functionName: "balanceOf", args: [pool] }); return Number(b) / 1e18; } catch { return 0; } }
async function holderTopPct(token) { try { const r = await fetch(`https://robinhoodchain.blockscout.com/api/v2/tokens/${token}/holders`, { headers: { "User-Agent": "Mozilla/5.0" } }); const m = await fetch(`https://robinhoodchain.blockscout.com/api/v2/tokens/${token}`, { headers: { "User-Agent": "Mozilla/5.0" } }); const h = await r.json(), meta = await m.json(); const dec = Number(meta.decimals || 18), supply = Number(meta.total_supply || "0") / 10 ** dec; if (!supply || !h.items) return 100; let top = 0; for (const it of h.items) { const a = it.address || {}; if (a.is_contract || /pool|pair|lp|dead|0x0000/i.test((a.name || "") + (a.hash || ""))) continue; const v = Number(it.value || "0") / 10 ** dec; if (v > top) top = v; } return top / supply * 100; } catch { return 100; } }
const costPct = (sizeEth, lp) => (FEE_BPS / 10000) * 100 * 2 + Math.min(5, (sizeEth / Math.max(lp, 1e-9)) * 100) * 2 + (GAS_ETH / Math.max(sizeEth, 1e-9)) * 100 * 2;

// ---------- executor (proven in swaptest.mjs) ----------
async function buy(token, pool, fee, wethIsT0) {
  const amtIn = parseEther(COPY_ETH);
  const pEth = await priceEth(pool, wethIsT0);
  const expOut = BigInt(Math.floor(Number(COPY_ETH) * (1 / pEth) * 1e18));   // raw token units (decimal-agnostic)
  const minOut = expOut * BigInt(Math.floor((1 - SLIP) * 1000)) / 1000n;
  const params = { tokenIn: WETH, tokenOut: token, fee, recipient: account.address, amountIn: amtIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n };
  await pubT.simulateContract({ address: ROUTER, abi: ROUTER_ABI, functionName: "exactInputSingle", args: [params], value: amtIn, account }); // trade-side → Alchemy
  const h = await wallet.writeContract({ address: ROUTER, abi: ROUTER_ABI, functionName: "exactInputSingle", args: [params], value: amtIn });
  await pubT.waitForTransactionReceipt({ hash: h });
  // F2: only thing that must succeed is the confirmed buy. Get balance and return so the caller
  // records the position IMMEDIATELY — approve + sellability are handled by sell()/manage() later,
  // so a hiccup there can never orphan a bag we already paid for.
  const bal = await pubT.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [account.address] });
  if (bal === 0n) throw new Error("no tokens received");
  return { hash: h, bal: bal.toString(), entry: pEth };
}
// F4: reclaim native ETH from WETH (sells return WETH) so the burner never runs dry on gas
async function unwrapWeth() {
  try { const wb = await pubT.readContract({ address: WETH, abi: WETH_ABI, functionName: "balanceOf", args: [account.address] }); if (wb > 0n) { const h = await wallet.writeContract({ address: WETH, abi: WETH_ABI, functionName: "withdraw", args: [wb] }); await pubT.waitForTransactionReceipt({ hash: h }); } } catch {}
}
async function sell(token, fee, balStr) {
  const bal = BigInt(balStr);
  const allow = await pubT.readContract({ address: token, abi: ERC20, functionName: "allowance", args: [account.address, ROUTER] });
  if (allow < bal) { const ah = await wallet.writeContract({ address: token, abi: ERC20, functionName: "approve", args: [ROUTER, bal] }); await pubT.waitForTransactionReceipt({ hash: ah }); }
  const params = { tokenIn: token, tokenOut: WETH, fee, recipient: account.address, amountIn: bal, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n };
  await pubT.simulateContract({ address: ROUTER, abi: ROUTER_ABI, functionName: "exactInputSingle", args: [params], account });
  const h = await wallet.writeContract({ address: ROUTER, abi: ROUTER_ABI, functionName: "exactInputSingle", args: [params] });
  await pubT.waitForTransactionReceipt({ hash: h });
  return h;
}

// ---------- state ----------
let S; // F5: never crash-loop on a corrupt/truncated state file
try { S = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null; } catch { console.error("state file unreadable — starting fresh"); S = null; }
if (!S || typeof S !== "object") S = { lastBlock: 0, watch: {}, positions: {}, done: {} };
S.watch = S.watch || {}; S.positions = S.positions || {}; S.done = S.done || {};
const save = () => writeFileSync(STATE, JSON.stringify(S));

// ---------- detection ----------
async function scanNewPools(fromBlk, toBlk) {
  const logs = await rawGet("eth_getLogs", [{ address: V3, topics: [PC_TOPIC], fromBlock: "0x" + fromBlk.toString(16), toBlock: "0x" + toBlk.toString(16) }]) || [];
  for (const l of logs) {
    const t0 = "0x" + l.topics[1].slice(-40), t1 = "0x" + l.topics[2].slice(-40);
    const pool = ("0x" + l.data.slice(-40)).toLowerCase();
    const token = (t0.toLowerCase() === WETH ? t1 : t0).toLowerCase();
    if (token === WETH) continue;
    if (S.done[pool] || S.positions[token] || S.watch[pool]) continue;
    S.watch[pool] = { token, blk: parseInt(l.blockNumber, 16), t: Date.now() };
  }
}
async function evaluate(pool, tip) {
  const w = S.watch[pool];
  const ageMin = (Date.now() - w.t) / 60000;
  if (ageMin > MAX_AGE_MIN) { delete S.watch[pool]; S.done[pool] = Date.now(); return; }   // missed the window
  const lp = await lpEth(pool);
  if (lp < MIN_LP_ETH) return;                                                              // not enough liquidity yet
  const sw = await rawGet("eth_getLogs", [{ address: pool, topics: [SWAP_TOPIC], fromBlock: "0x" + w.blk.toString(16), toBlock: "0x" + tip.toString(16) }]) || [];
  const m = await meta(pool); if (!m) { delete S.watch[pool]; return; }
  let buys = 0, sells = 0; const buyTxs = [];
  for (const s of sw) { const d = s.data.slice(2); const a0 = s256(d.slice(0, 64)), a1 = s256(d.slice(64, 128)); const tokDelta = m.wethIsT0 ? a1 : a0; if (tokDelta < 0n) { buys++; buyTxs.push(s.transactionHash); } else if (tokDelta > 0n) sells++; }
  if (buys < MIN_BUYS || buys < sells * BUY_RATIO) return;
  // anti-bot: sample distinct real senders
  const sample = buyTxs.slice(0, 30);
  const froms = await Promise.all(sample.map(async (h) => { const tx = await rawGet("eth_getTransactionByHash", [h]); return (tx && tx.from || "").toLowerCase(); }));
  const valid = froms.filter(Boolean); const uniq = new Set(valid).size;
  if (uniq < MIN_UNIQ || uniq < valid.length * UNIQ_RATIO) return;                          // bot-inflated, skip
  // exposure + cost + holder gates
  const activePos = Object.values(S.positions).filter((p) => !p.stuck); // F3: stuck honeypots don't block new trades
  const openN = activePos.length, deployed = activePos.reduce((a, p) => a + Number(p.cost || 0), 0);
  if (openN >= MAX_POS || deployed + Number(COPY_ETH) > MAX_TOTAL_ETH) return;
  if (costPct(Number(COPY_ETH), lp) > MAX_COST_PCT) { delete S.watch[pool]; S.done[pool] = Date.now(); return; }
  const top = await holderTopPct(m.token);
  if (top > TOP_HOLDER_MAX) { delete S.watch[pool]; S.done[pool] = Date.now(); return; }

  delete S.watch[pool]; S.done[pool] = Date.now();
  await tg(`⚡ *TRIGGER* $${m.token.slice(0, 8)} — fresh (${ageMin.toFixed(1)}m) · *${uniq} real buyers* · ${buys}b/${sells}s · LP ${lp.toFixed(2)}Ξ\n${DRY_RUN ? "📝 would buy" : "🟢 buying"} ${COPY_ETH} ETH`);
  if (DRY_RUN) { S.positions[m.token] = { pool, fee: m.fee, cost: COPY_ETH, entry: await priceEth(pool, m.wethIsT0), high: 0, paper: true, t: Date.now() }; return; }
  try { const r = await buy(m.token, pool, m.fee, m.wethIsT0); S.positions[m.token] = { pool, fee: m.fee, cost: COPY_ETH, bal: r.bal, entry: r.entry, high: r.entry, t: Date.now() }; await tg(`✅ *BOUGHT* $${m.token.slice(0, 8)}\n[tx](https://robinhoodchain.blockscout.com/tx/${r.hash})`); }
  catch (e) { await tg(`❌ buy failed $${m.token.slice(0, 8)}: ${(e.shortMessage || e.message || "").slice(0, 80)}`); }
}
async function manage() {
  for (const token of Object.keys(S.positions)) {
    const pos = S.positions[token]; if (!pos.entry || pos.stuck) continue;   // F3: skip written-off bags
    let cur; try { cur = await priceEth(pos.pool, metaCache[pos.pool]?.wethIsT0 ?? true); } catch { continue; }
    pos.high = Math.max(pos.high || pos.entry, cur);
    const gain = cur / pos.entry - 1, dd = (pos.high - cur) / pos.high, ageMin = (Date.now() - pos.t) / 60000;
    let reason = null;
    if (gain >= TAKE_PROFIT) reason = `✅ TP +${(gain * 100).toFixed(0)}%`;
    else if (gain <= -HARD_STOP) reason = `🛑 stop ${(gain * 100).toFixed(0)}%`;
    else if (dd >= TRAIL_PCT) reason = `🔒 trail +${(gain * 100).toFixed(0)}%`;
    else if (ageMin >= MAX_HOLD_MIN) reason = `⌛ time ${(gain * 100).toFixed(0)}%`;
    if (!reason) continue;
    if (pos.paper || DRY_RUN) { delete S.positions[token]; save(); await tg(`📝 ${reason} $${token.slice(0, 8)} — would exit`); continue; }
    try {
      const h = await sell(token, pos.fee, pos.bal);   // F1: only forget the position AFTER the sell confirms
      delete S.positions[token]; save();
      await tg(`${reason.startsWith("✅") ? "💰" : "🛑"} *EXIT* $${token.slice(0, 8)} ${reason}\n[tx](https://robinhoodchain.blockscout.com/tx/${h})`);
      await unwrapWeth();
    } catch (e) {
      pos.sellFails = (pos.sellFails || 0) + 1; save();   // keep the position, retry next loop
      if (pos.sellFails >= 3) { pos.stuck = true; save(); await tg(`⚠️ $${token.slice(0, 8)} won't sell after 3 tries (likely honeypot) — marked stuck, ${pos.cost} ETH written off, exposure freed.`); }
    }
  }
}

// ---------- loop ----------
let busy = false, lastTick = 0;   // busy = no overlap; lastTick = rate-limit even under WSS block-push
async function tick() {
  if (busy || Date.now() - lastTick < MIN_TICK_MS) return;   // coalesce ~10 blocks/sec into 1 scan / MIN_TICK_MS
  lastTick = Date.now(); busy = true;
  try {
    const tip = Number(await pub.getBlockNumber());
    if (!S.lastBlock) S.lastBlock = tip - WINDOW_BLOCKS;
    await scanNewPools(S.lastBlock + 1, tip); S.lastBlock = tip;
    for (const pool of Object.keys(S.watch)) await evaluate(pool, tip);
    await manage();
    for (const k in S.done) if (Date.now() - S.done[k] > 3600000) delete S.done[k];
    save();
  } catch (e) { console.error("tick err:", e.shortMessage || e.message); }
  busy = false;
}

// SAFETY: verify BOTH endpoints are Robinhood Chain. The trade client (Alchemy) sends money — if it's
// on the wrong chain (an Alchemy app pointed at ETH/Base/Solana), refuse to run.
const scanCid = await pub.getChainId().catch(() => 0);
const tradeCid = !DRY_RUN ? await pubT.getChainId().catch(() => 0) : chain.id;
if (scanCid !== chain.id) { const msg = `❌ scan RPC is chain *${scanCid || "unreachable"}*, need *${chain.id}*. Not trading.`; console.error(msg); await tg(msg); process.exit(1); }
if (tradeCid !== chain.id) { const msg = `❌ *trade RPC (Alchemy) is chain ${tradeCid || "unreachable"}*, need ${chain.id} (Robinhood Chain). Fix RPC_URL — NOT trading.`; console.error(msg); await tg(msg); process.exit(1); }

console.log(`trigger bot | ${DRY_RUN ? "PAPER" : "LIVE 💸"} | hybrid: scan=public(${scanCid}) trade=alchemy(${tradeCid}) | copy ${COPY_ETH} ETH | scan ${MIN_TICK_MS}ms`);
if (account) console.log("burner:", account.address);
if (account && !DRY_RUN) await unwrapWeth();   // F4: reclaim any WETH left from a prior run
await tg(`🚀 trigger ${DRY_RUN ? "*PAPER*" : "*LIVE*"} started · hybrid (scan=public, trade=alchemy) · ${COPY_ETH} ETH/entry`);

// block detection on the free public RPC (scanning never touches Alchemy)
(async function poll() { await tick(); setTimeout(poll, POLL_MS); })();
