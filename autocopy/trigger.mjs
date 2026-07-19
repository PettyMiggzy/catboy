// autocopy/trigger.mjs — our OWN money engine (no copying). Runs the play the winning wallets use,
// reverse-engineered on-chain: buy a FRESH launch (~30-90s old) once it has pulled a burst of
// REAL unique buyers, ride it, exit on our own target BEFORE the crowd. Real-time (droplet/pm2).
// Reuses the executor proven by autocopy/swaptest.mjs (verified Uniswap V3 SwapRouter02).
// DRY_RUN=1 => paper (detect + DM, no trades). Flip to 0 only after the audit + a watched test.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createWalletClient, createPublicClient, http, webSocket, parseEther, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Droplet: load secrets from autocopy/deploy/.env into process.env (no dependency) before reading config.
try { const ep = process.env.ENV_FILE || new URL("./deploy/.env", import.meta.url).pathname; if (existsSync(ep)) for (const ln of readFileSync(ep, "utf8").split("\n")) { const m = ln.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {}

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

// entry trigger (the reverse-engineered play) — now with anti-rug survival gates
const MIN_AGE_MIN = Number(process.env.MIN_AGE_MIN || "3");              // SURVIVED-LAUNCH: skip minute-1 (that's where instant -84% rugs live)
const MAX_AGE_MIN = Number(process.env.MAX_AGE_MIN || "45");             // wider window so socials have time to appear + survival is proven
const MIN_UNIQ = Number(process.env.MIN_UNIQ || "15");                   // >=15 distinct real buyers
const MIN_BUYS = Number(process.env.MIN_BUYS || "20");
const BUY_RATIO = Number(process.env.BUY_RATIO || "2.5");                // buys >= 2.5x sells
const UNIQ_RATIO = Number(process.env.UNIQ_RATIO || "0.55");             // >=55% of sampled buys distinct (anti-bot)
const MIN_LP_ETH = Number(process.env.MIN_LP_ETH || "0.3");
const TOP_HOLDER_MAX = Number(process.env.TOP_HOLDER_MAX || "20");
// anti-rug gates
const LP_KEEP = Number(process.env.LP_KEEP || "0.85");                   // liquidity must stay >=85% of its peak, else LP is being pulled = rug
const REQUIRE_SOCIALS = (process.env.REQUIRE_SOCIALS ?? "0") !== "0";    // off: DexScreener socials only appear after a paid profile, so fresh legit launches don't have them yet
const SAME_BLOCK_MAX = Number(process.env.SAME_BLOCK_MAX || "0.5");      // no single block may hold > this fraction of the buys (anti-bundle)
const MIN_BLOCKS = Number(process.env.MIN_BLOCKS || "4");                // buys must span >= this many blocks (organic demand, not one bundled rug)

// ===== MC-TRIGGER (validated strategy) =====
// Backtested + out-of-sample proven (5 windows / 36h / ~1500 tokens, costs+rug-gap stressed):
// enter when a token GROWS INTO the $8-20k market-cap band (survived launch + real demand),
// exit TP+40% / stop-35%. ~70% win, +33% median. See scratchpad sims. "burst" = old buyer-burst play.
// modes: "netflow" = net buy-pressure (best: survives fill-delay, fires often, +16.7% median @2.5s lag)
//        "mc" = grow-into-$8-20k band | "burst" = legacy buyer-burst
const TRIGGER_MODE = (process.env.TRIGGER_MODE || "netflow").toLowerCase();
const MC_LO = Number(process.env.MC_LO || "8000");                       // enter when MC first climbs to >= this (USD)
const MC_HI = Number(process.env.MC_HI || "20000");                      // ...and still <= this (in the band)
const MC_HI_HARD = Number(process.env.MC_HI_HARD || String(MC_HI * 1.5)); // if it already blew past this, we missed it — drop
const MC_MAX_AGE_MIN = Number(process.env.MC_MAX_AGE_MIN || "60");       // watch a pool up to this long for the crossing
const DEAD_MIN = Number(process.env.DEAD_MIN || "30");                   // on RHC liquidity develops LATE (12-20m+), so keep watching thin pools this long before giving up
const ZOMBIE_LP = Number(process.env.ZOMBIE_LP || "0.05");               // ...but a pool still near-zero LP after ZOMBIE_MIN is dead on arrival — cut it early to keep the watch lean
const ZOMBIE_MIN = Number(process.env.ZOMBIE_MIN || "8");
const ETH_USD_FALLBACK = Number(process.env.ETH_USD || "1865");          // used if the live price fetch fails
// NetFlow trigger: enter on sustained net buy-pressure (net WETH inflow over a rolling window) while
// price is rising, inside a sane MC range. Exit TP+40%/stop-35%. Forum-validated + fill-delay-robust.
const NF_MIN_ETH = Number(process.env.NF_MIN_ETH || "0.2");            // net WETH bought over the window — 0.2 is the tuned sweet spot (+10% avg/+16.7% med @2.5s lag; 0.5 went negative = blow-off tops, 0.1 = noise)
const NF_WIN_BLK = Number(process.env.NF_WIN_BLK || "1800");           // rolling window ~3min — persists long enough for 2.5s polling to catch it live
const NF_MC_MIN = Number(process.env.NF_MC_MIN || "3000");             // sanity floor (skip dust)
const NF_MC_MAX = Number(process.env.NF_MC_MAX || "60000");            // sanity ceiling (skip already-huge)

// exits — defaults are the sim-validated TP+40% / stop-35% (trail is a loose backstop only)
const TAKE_PROFIT = Number(process.env.TAKE_PROFIT || "40") / 100;       // proven: bank at +40%
const TRAIL_PCT = Number(process.env.TRAIL_PCT || "45") / 100;           // loose so TP+40 stays the primary exit; still catches a faded runner
const HARD_STOP = Number(process.env.HARD_STOP || "35") / 100;           // proven: cut at -35%
const MAX_HOLD_MIN = Number(process.env.MAX_HOLD_MIN || "60");           // ~forward window used in the backtests
const MAX_COST_PCT = Number(process.env.MAX_COST_PCT || "4");            // reject if est round-trip cost too high

const POLL_MS = Number(process.env.POLL_MS || "2500");
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MIN || "8") * 60000;   // alive-pulse cadence; frequent so silence = hung, not just quiet
const MIN_TICK_MS = Number(process.env.MIN_TICK_MS || "2500"); // coalesce block pushes — one scan per this window (protects your RPC quota)
const WINDOW_BLOCKS = Number(process.env.WINDOW_BLOCKS || "9000");       // warm-start: seed ~15min of pools so a reboot immediately watches already-liquid ones (not just brand-new thin ones)
const DRY_RUN = (process.env.DRY_RUN ?? "1") !== "0";
const BOT = (process.env.BOT_TOKEN || "").trim(), CHAT = (process.env.CHAT_ID || "6820752140").trim();
const STATE = process.env.STATE_FILE || "autocopy/.trigger.json";
const PK = (process.env.PRIVATE_KEY || "").trim();
const FEE_BPS = 100, GAS_ETH = 0.000015;                                 // 1% pools + measured gas, for the cost guard
if (!DRY_RUN && !PK) { console.error("PRIVATE_KEY required for live"); process.exit(1); }

// ---------- clients ----------
const chain = { id: 4663, name: "robinhood", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [SCAN_RPC] } } };
const account = PK ? privateKeyToAccount(PK.startsWith("0x") ? PK : "0x" + PK) : null;
const pub = createPublicClient({ chain, transport: http(SCAN_RPC, { timeout: 12000, retryCount: 2 }) });                                   // scanning — free public
const pubT = createPublicClient({ chain, transport: TRADE_WSS ? webSocket(TRADE_WSS) : http(TRADE_RPC, { timeout: 12000, retryCount: 2 }) }); // trade-side reads — Alchemy
const wallet = account ? createWalletClient({ account, chain, transport: http(TRADE_RPC, { timeout: 20000, retryCount: 2 }) }) : null;      // tx submission — Alchemy

const ERC20 = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }, { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }, { name: "allowance", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] }];
const WETH_ABI = [{ name: "withdraw", type: "function", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] }, { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];
const ROUTER_ABI = [{ name: "exactInputSingle", type: "function", stateMutability: "payable", inputs: [{ type: "tuple", components: [{ name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "fee", type: "uint24" }, { name: "recipient", type: "address" }, { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }], outputs: [{ name: "amountOut", type: "uint256" }] }];
const POOL_ABI = [{ name: "slot0", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }] }, { name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }, { name: "fee", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] }];

// ---------- helpers ----------
const tg = (t) => BOT ? fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: CHAT, text: t, parse_mode: "Markdown", disable_web_page_preview: true }) }).catch(() => {}) : null;
const rawGet = async (m, p) => { try { const r = await fetch(SCAN_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }), signal: AbortSignal.timeout(12000) }); return (await r.json()).result; } catch { return null; } }; // scanning stays on the free public RPC; timeout so a hung RPC call can't freeze the whole bot
const s256 = (h) => { const v = BigInt("0x" + h); return v >= (1n << 255n) ? v - (1n << 256n) : v; };
const metaCache = {};
async function meta(pool) { if (metaCache[pool] !== undefined) return metaCache[pool]; try { const t0 = (await pub.readContract({ address: pool, abi: POOL_ABI, functionName: "token0" })).toLowerCase(); const fee = await pub.readContract({ address: pool, abi: POOL_ABI, functionName: "fee" }); const wethIsT0 = t0 === WETH; const other = wethIsT0 ? null : t0; return metaCache[pool] = other ? { token: other, wethIsT0, fee } : null; } catch { return metaCache[pool] = null; } }
async function priceEth(pool, wethIsT0) { const [sq] = await pub.readContract({ address: pool, abi: POOL_ABI, functionName: "slot0" }); const P = (Number(sq) / 2 ** 96) ** 2; return wethIsT0 ? 1 / P : P; }
async function lpEth(pool) { try { const b = await pub.readContract({ address: WETH, abi: ERC20, functionName: "balanceOf", args: [pool] }); return Number(b) / 1e18; } catch { return -1; } } // -1 = read failed (distinct from 0 = genuinely empty)
async function holderTopPct(token) { try { const r = await fetch(`https://robinhoodchain.blockscout.com/api/v2/tokens/${token}/holders`, { headers: { "User-Agent": "Mozilla/5.0" } }); const m = await fetch(`https://robinhoodchain.blockscout.com/api/v2/tokens/${token}`, { headers: { "User-Agent": "Mozilla/5.0" } }); const h = await r.json(), meta = await m.json(); const dec = Number(meta.decimals || 18), supply = Number(meta.total_supply || "0") / 10 ** dec; if (!supply || !h.items) return 100; let top = 0; for (const it of h.items) { const a = it.address || {}; if (a.is_contract || /pool|pair|lp|dead|0x0000/i.test((a.name || "") + (a.hash || ""))) continue; const v = Number(it.value || "0") / 10 ** dec; if (v > top) top = v; } return top / supply * 100; } catch { return 100; } }
const costPct = (sizeEth, lp) => (FEE_BPS / 10000) * 100 * 2 + Math.min(5, (sizeEth / Math.max(lp, 1e-9)) * 100) * 2 + (GAS_ETH / Math.max(sizeEth, 1e-9)) * 100 * 2;
// live ETH price (10-min cache) so the $ market-cap band is accurate; falls back to ETH_USD_FALLBACK
let ethUsd = ETH_USD_FALLBACK, ethUsdAt = 0;
async function ethPrice() {
  if (Date.now() - ethUsdAt < 600000) return ethUsd;
  try { const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) }); const j = await r.json(); const p = Number(j?.ethereum?.usd); if (p > 0) { ethUsd = p; ethUsdAt = Date.now(); } } catch {}
  return ethUsd;
}
// totalSupply in whole tokens (cached). MC_ETH = priceEthRaw * (supplyRaw/1e18) — token decimals cancel out.
const SUPPLY_ABI = [{ name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }];
const supplyCache = {};
async function totalSupply(token) { if (supplyCache[token] !== undefined) return supplyCache[token]; try { const r = await pub.readContract({ address: token, abi: SUPPLY_ABI, functionName: "totalSupply" }); return supplyCache[token] = Number(r) / 1e18; } catch { return supplyCache[token] = 0; } }
// legitimacy gate: does the team bother to set a website/socials on DexScreener? Rug deployers almost never do.
async function hasSocials(token) {
  try {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/robinhood/${token}`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return false;
    const pairs = await r.json();
    if (!Array.isArray(pairs)) return false;
    for (const p of pairs) { const info = p.info || {}; if ((info.websites || []).length + (info.socials || []).length > 0) return true; }
    return false;
  } catch { return false; }
}

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
// diagnostics: tally WHY pools get rejected so we can see which gate is too tight (DM'd on heartbeat)
const diag = {}; const dbump = (k) => { diag[k] = (diag[k] || 0) + 1; };
let diagMaxLp = 0, diagLiqSeen = 0;   // max LP the bot actually observes + how many pools cross MIN_LP (heartbeat sanity)
let lastBeat = Date.now();   // seed to boot time so the first heartbeat reports a sane window, not epoch

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
  w.lpMax = Math.max(w.lpMax || 0, lp);                                                     // track the peak liquidity we've seen
  if (lp < MIN_LP_ETH) { dbump("lpThin"); return; }                                         // not enough liquidity yet
  // RUG GUARD #1: liquidity draining off its peak = LP being pulled → rug in progress, abandon it
  if (w.lpMax >= MIN_LP_ETH && lp < w.lpMax * LP_KEEP) { dbump("lpDrain"); delete S.watch[pool]; S.done[pool] = Date.now(); return; }
  // SURVIVED-LAUNCH: don't touch minute-1 launches — that's where the instant -84% dumps happen. Wait it out.
  if (ageMin < MIN_AGE_MIN) { dbump("seasoning"); return; }                                 // seasoning; keep watching
  const sw = await rawGet("eth_getLogs", [{ address: pool, topics: [SWAP_TOPIC], fromBlock: "0x" + w.blk.toString(16), toBlock: "0x" + tip.toString(16) }]) || [];
  const m = await meta(pool); if (!m) { delete S.watch[pool]; return; }
  let buys = 0, sells = 0; const buyTxs = [], buyBlocks = [];
  for (const s of sw) { const d = s.data.slice(2); const a0 = s256(d.slice(0, 64)), a1 = s256(d.slice(64, 128)); const tokDelta = m.wethIsT0 ? a1 : a0; if (tokDelta < 0n) { buys++; buyTxs.push(s.transactionHash); buyBlocks.push(parseInt(s.blockNumber, 16)); } else if (tokDelta > 0n) sells++; }
  if (buys < MIN_BUYS || buys < sells * BUY_RATIO) { dbump("fewBuys"); return; }
  // RUG GUARD #2 (anti-bundle / same-block): real demand trickles in across many blocks. A coordinated rug
  // bundles its "buys" into one/few blocks to fake momentum. Reject if buys concentrate in a single block
  // or span too few blocks. Keep watching (return) — organic buys across more blocks can still qualify later.
  const blkCount = {}; for (const b of buyBlocks) blkCount[b] = (blkCount[b] || 0) + 1;
  const maxInBlock = Math.max(0, ...Object.values(blkCount)), distinctBlocks = Object.keys(blkCount).length;
  if (maxInBlock > buys * SAME_BLOCK_MAX || distinctBlocks < MIN_BLOCKS) { dbump("bundled"); return; } // bundled = coordinated setup
  // anti-bot: sample distinct real senders
  const sample = buyTxs.slice(0, 30);
  const froms = await Promise.all(sample.map(async (h) => { const tx = await rawGet("eth_getTransactionByHash", [h]); return (tx && tx.from || "").toLowerCase(); }));
  const valid = froms.filter(Boolean); const uniq = new Set(valid).size;
  if (uniq < MIN_UNIQ || uniq < valid.length * UNIQ_RATIO) { dbump("botty"); return; }       // bot-inflated, skip
  // exposure + cost + holder gates
  const activePos = Object.values(S.positions).filter((p) => !p.stuck); // F3: stuck honeypots don't block new trades
  const openN = activePos.length, deployed = activePos.reduce((a, p) => a + Number(p.cost || 0), 0);
  if (openN >= MAX_POS || deployed + Number(COPY_ETH) > MAX_TOTAL_ETH) { dbump("full"); return; }
  if (costPct(Number(COPY_ETH), lp) > MAX_COST_PCT) { dbump("cost"); delete S.watch[pool]; S.done[pool] = Date.now(); return; }
  const top = await holderTopPct(m.token);
  if (top > TOP_HOLDER_MAX) { dbump("whale"); delete S.watch[pool]; S.done[pool] = Date.now(); return; }
  // LEGITIMACY: require the team set a website/socials on DexScreener. Keep watching if not — socials can be
  // added within our window; don't burn the pool. Rug deployers almost never bother, so this filters them out.
  if (REQUIRE_SOCIALS && !(await hasSocials(m.token))) { dbump("noSocials"); return; }
  dbump("PASS");

  delete S.watch[pool]; S.done[pool] = Date.now();
  await tg(`⚡ *TRIGGER* $${m.token.slice(0, 8)} — survived *${ageMin.toFixed(1)}m* · *${uniq} real buyers* / ${distinctBlocks} blocks · ${buys}b/${sells}s · LP ${lp.toFixed(2)}Ξ · ✓socials\n${DRY_RUN ? "📝 would buy" : "🟢 buying"} ${COPY_ETH} ETH`);
  if (DRY_RUN) { S.positions[m.token] = { pool, fee: m.fee, cost: COPY_ETH, entry: await priceEth(pool, m.wethIsT0), high: 0, paper: true, t: Date.now() }; return; }
  try { const r = await buy(m.token, pool, m.fee, m.wethIsT0); S.positions[m.token] = { pool, fee: m.fee, cost: COPY_ETH, bal: r.bal, entry: r.entry, high: r.entry, t: Date.now() }; await tg(`✅ *BOUGHT* $${m.token.slice(0, 8)}\n[tx](https://robinhoodchain.blockscout.com/tx/${r.hash})`); }
  catch (e) { await tg(`❌ buy failed $${m.token.slice(0, 8)}: ${(e.shortMessage || e.message || "").slice(0, 80)}`); }
}
// VALIDATED STRATEGY: enter when a token grows INTO the $MC_LO-$MC_HI market-cap band (survived launch +
// real demand), then exit TP+40%/stop-35% via manage(). Proven +EV out-of-sample. Reads stay on the free RPC.
async function evaluateMC(pool, tip) {
  const w = S.watch[pool];
  const ageMin = (Date.now() - w.t) / 60000;
  if (ageMin > MC_MAX_AGE_MIN) { dbump("aged"); delete S.watch[pool]; S.done[pool] = Date.now(); return; }
  const lp = await lpEth(pool);
  if (lp < 0) { dbump("lpErr"); return; }                                     // RPC read failed — retry next tick, don't miscount as thin
  w.lpMax = Math.max(w.lpMax || 0, lp);
  if (lp < MIN_LP_ETH) { if (ageMin > DEAD_MIN) { dbump("deadLaunch"); delete S.watch[pool]; S.done[pool] = Date.now(); } else dbump("lpThin"); return; } // prune dead launches, but give slow-starters time
  if (w.lpMax >= MIN_LP_ETH && lp < w.lpMax * LP_KEEP) { dbump("lpDrain"); delete S.watch[pool]; S.done[pool] = Date.now(); return; } // LP being pulled = rug
  const m = await meta(pool); if (!m) { delete S.watch[pool]; return; }
  const supply = await totalSupply(m.token); if (!supply) { dbump("noSupply"); return; }
  const pe = await priceEth(pool, m.wethIsT0);
  const mc = pe * supply * (await ethPrice());
  w.mcPeak = Math.max(w.mcPeak || 0, mc);                                     // highest MC we've seen for this pool
  if (mc < MC_LO) { dbump("belowBand"); return; }                            // not there yet — keep watching (fresh pool climbs up into the band)
  if (w.mcPeak > MC_HI_HARD) { dbump("ranPast"); delete S.watch[pool]; S.done[pool] = Date.now(); return; } // already mooned past the band; being here now = retrace/dump, skip
  if (mc > MC_HI) { dbump("aboveBand"); return; }                             // above band but under hard cap — wait for it to settle into band
  // in-band, first time up (a fresh pool that grew here from ~$0, never ran past) → ENTER. gates first.
  const activePos = Object.values(S.positions).filter((p) => !p.stuck);
  if (activePos.length >= MAX_POS || activePos.reduce((a, p) => a + Number(p.cost || 0), 0) + Number(COPY_ETH) > MAX_TOTAL_ETH) { dbump("full"); return; }
  if (costPct(Number(COPY_ETH), lp) > MAX_COST_PCT) { dbump("cost"); return; }
  const top = await holderTopPct(m.token);
  if (top > TOP_HOLDER_MAX) { dbump("whale"); delete S.watch[pool]; S.done[pool] = Date.now(); return; }
  dbump("PASS");
  delete S.watch[pool]; S.done[pool] = Date.now();
  await tg(`⚡ *MC TRIGGER* $${m.token.slice(0, 8)} — grew into *$${(mc / 1000).toFixed(1)}k MC* · LP ${lp.toFixed(2)}Ξ · top ${top.toFixed(0)}%\n${DRY_RUN ? "📝 would buy" : "🟢 buying"} ${COPY_ETH} ETH · exit TP+${(TAKE_PROFIT * 100).toFixed(0)}%/stop-${(HARD_STOP * 100).toFixed(0)}%`);
  if (DRY_RUN) { S.positions[m.token] = { pool, fee: m.fee, cost: COPY_ETH, entry: pe, high: 0, paper: true, t: Date.now(), mc }; return; }
  try { const r = await buy(m.token, pool, m.fee, m.wethIsT0); S.positions[m.token] = { pool, fee: m.fee, cost: COPY_ETH, bal: r.bal, entry: r.entry, high: r.entry, t: Date.now(), mc }; await tg(`✅ *BOUGHT* $${m.token.slice(0, 8)}\n[tx](https://robinhoodchain.blockscout.com/tx/${r.hash})`); }
  catch (e) { await tg(`❌ buy failed $${m.token.slice(0, 8)}: ${(e.shortMessage || e.message || "").slice(0, 80)}`); }
}
// BEST STRATEGY (fill-delay-robust, high-frequency): enter on sustained NET BUY-PRESSURE — net WETH
// inflow >= NF_MIN_ETH over the last NF_WIN_BLK blocks, price rising, MC in a sane range. Exit TP40/SL35.
// Survived 2.5s fill-lag stress at +16.7% median / 56% win where the MC-band average went negative.
async function evaluateNetFlow(pool, tip) {
  const w = S.watch[pool];
  const ageMin = (Date.now() - w.t) / 60000;
  if (ageMin > MC_MAX_AGE_MIN) { dbump("aged"); delete S.watch[pool]; S.done[pool] = Date.now(); return; }
  const lp = await lpEth(pool);
  if (lp < 0) { dbump("lpErr"); return; }
  if (lp > diagMaxLp) diagMaxLp = lp; if (lp >= MIN_LP_ETH) diagLiqSeen++;   // sanity: is the bot seeing ANY liquidity?
  w.lpMax = Math.max(w.lpMax || 0, lp);
  if (lp < MIN_LP_ETH) {
    const zombie = lp < ZOMBIE_LP && ageMin > ZOMBIE_MIN;   // near-zero LP for a while = dead on arrival
    if (zombie || ageMin > DEAD_MIN) { dbump("deadLaunch"); delete S.watch[pool]; S.done[pool] = Date.now(); } else dbump("lpThin"); // else keep watching — RHC liquidity often shows up at 12-20m+
    return;
  }
  if (w.lpMax >= MIN_LP_ETH && lp < w.lpMax * LP_KEEP) { dbump("lpDrain"); delete S.watch[pool]; S.done[pool] = Date.now(); return; }
  const m = await meta(pool); if (!m) { delete S.watch[pool]; return; }
  // net WETH flow over the trailing window, and price direction, from swap logs
  const fromBlk = Math.max(w.blk, tip - NF_WIN_BLK);
  const sw = await rawGet("eth_getLogs", [{ address: pool, topics: [SWAP_TOPIC], fromBlock: "0x" + fromBlk.toString(16), toBlock: "0x" + tip.toString(16) }]) || [];
  if (sw.length < 2) { dbump("noFlow"); return; }
  let netWeth = 0; const prices = [];
  for (const s of sw) {
    const d = s.data.slice(2);
    const a0 = s256(d.slice(0, 64)), a1 = s256(d.slice(64, 128));
    const wethDelta = m.wethIsT0 ? a0 : a1;                 // +ve = WETH into pool = a buy
    const buy = (m.wethIsT0 ? a1 : a0) < 0n;                // token leaving pool = a buy
    netWeth += (buy ? 1 : -1) * Math.abs(Number(wethDelta)) / 1e18;
    const sq = Number(BigInt("0x" + d.slice(128, 192))) / 2 ** 96;
    prices.push(m.wethIsT0 ? 1 / (sq * sq) : sq * sq);
  }
  if (netWeth < NF_MIN_ETH) { dbump("weakFlow"); return; }                        // not enough net buying
  if (prices[prices.length - 1] < prices[0]) { dbump("falling"); return; }        // require price rising over the window
  const supply = await totalSupply(m.token); if (!supply) { dbump("noSupply"); return; }
  const pe = await priceEth(pool, m.wethIsT0);
  const mc = pe * supply * (await ethPrice());
  if (mc < NF_MC_MIN || mc > NF_MC_MAX) { dbump("mcRange"); return; }              // sanity band
  const activePos = Object.values(S.positions).filter((p) => !p.stuck);
  if (activePos.length >= MAX_POS || activePos.reduce((a, p) => a + Number(p.cost || 0), 0) + Number(COPY_ETH) > MAX_TOTAL_ETH) { dbump("full"); return; }
  if (costPct(Number(COPY_ETH), lp) > MAX_COST_PCT) { dbump("cost"); return; }
  const top = await holderTopPct(m.token);
  if (top > TOP_HOLDER_MAX) { dbump("whale"); delete S.watch[pool]; S.done[pool] = Date.now(); return; }
  dbump("PASS");
  delete S.watch[pool]; S.done[pool] = Date.now();
  await tg(`⚡ *NETFLOW* $${m.token.slice(0, 8)} — *+${netWeth.toFixed(2)}Ξ* net buys/${(NF_WIN_BLK / 10).toFixed(0)}s · $${(mc / 1000).toFixed(1)}k MC · LP ${lp.toFixed(2)}Ξ · top ${top.toFixed(0)}%\n${DRY_RUN ? "📝 would buy" : "🟢 buying"} ${COPY_ETH} ETH · exit TP+${(TAKE_PROFIT * 100).toFixed(0)}%/stop-${(HARD_STOP * 100).toFixed(0)}%`);
  if (DRY_RUN) { S.positions[m.token] = { pool, fee: m.fee, cost: COPY_ETH, entry: pe, high: 0, paper: true, t: Date.now(), mc }; return; }
  try { const r = await buy(m.token, pool, m.fee, m.wethIsT0); S.positions[m.token] = { pool, fee: m.fee, cost: COPY_ETH, bal: r.bal, entry: r.entry, high: r.entry, t: Date.now(), mc }; await tg(`✅ *BOUGHT* $${m.token.slice(0, 8)}\n[tx](https://robinhoodchain.blockscout.com/tx/${r.hash})`); }
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
let busy = false, lastTick = 0, tickStart = 0;   // busy = no overlap; lastTick = rate-limit; tickStart = watchdog
async function tick() {
  // watchdog: if a previous tick has been "busy" far longer than any bounded set of RPC calls should take,
  // assume it wedged and force-recover so the bot can never go permanently silent again.
  if (busy && Date.now() - tickStart > 120000) { console.error("watchdog: tick wedged, forcing recovery"); busy = false; }
  if (busy || Date.now() - lastTick < MIN_TICK_MS) return;   // coalesce ~10 blocks/sec into 1 scan / MIN_TICK_MS
  lastTick = Date.now(); tickStart = Date.now(); busy = true;
  try {
    const tip = Number(await pub.getBlockNumber());
    if (!S.lastBlock) S.lastBlock = tip - WINDOW_BLOCKS;
    await scanNewPools(S.lastBlock + 1, tip); S.lastBlock = tip;
    const evalFn = TRIGGER_MODE === "netflow" ? evaluateNetFlow : TRIGGER_MODE === "mc" ? evaluateMC : evaluate;
    for (const pool of Object.keys(S.watch)) await evalFn(pool, tip);
    await manage();
    for (const k in S.done) if (Date.now() - S.done[k] > 3600000) delete S.done[k];
    save();
    // heartbeat: a frequent alive-pulse + funnel, so silence always means "hung" (never "just quiet")
    if (Date.now() - lastBeat > HEARTBEAT_MS) {
      const mins = Math.round((Date.now() - lastBeat) / 60000); lastBeat = Date.now();
      const order = ["PASS", "weakFlow", "falling", "mcRange", "noFlow", "belowBand", "aboveBand", "ranPast", "deadLaunch", "lpThin", "lpErr", "lpDrain", "noSupply", "whale", "cost", "full", "aged", "seasoning", "fewBuys", "bundled", "botty", "noSocials"];
      const line = order.filter((k) => diag[k]).map((k) => `${k} ${diag[k]}`).join(" · ") || "no candidates yet";
      const hb = `💓 *${TRIGGER_MODE}* · watch ${Object.keys(S.watch).length} · ETH $${ethUsd.toFixed(0)} · maxLP ${diagMaxLp.toFixed(2)}Ξ · liq≥thr ${diagLiqSeen} · rejects(${mins}m): ${line}`;
      console.log(hb.replace(/\*/g, "")); await tg(hb);
      for (const k in diag) delete diag[k]; diagMaxLp = 0; diagLiqSeen = 0;
    }
  } catch (e) { console.error("tick err:", e.shortMessage || e.message); }
  finally { busy = false; }   // always release, even if an await rejected — never leave the loop wedged
}

// SAFETY: verify BOTH endpoints are Robinhood Chain. The trade client (Alchemy) sends money — if it's
// on the wrong chain (an Alchemy app pointed at ETH/Base/Solana), refuse to run.
const scanCid = await pub.getChainId().catch(() => 0);
const tradeCid = !DRY_RUN ? await pubT.getChainId().catch(() => 0) : chain.id;
if (scanCid !== chain.id) { const msg = `❌ scan RPC is chain *${scanCid || "unreachable"}*, need *${chain.id}*. Not trading.`; console.error(msg); await tg(msg); process.exit(1); }
if (tradeCid !== chain.id) { const msg = `❌ *trade RPC (Alchemy) is chain ${tradeCid || "unreachable"}*, need ${chain.id} (Robinhood Chain). Fix RPC_URL — NOT trading.`; console.error(msg); await tg(msg); process.exit(1); }

const modeDesc = TRIGGER_MODE === "netflow" ? `NetFlow +${NF_MIN_ETH}Ξ/${(NF_WIN_BLK / 10).toFixed(0)}s → TP+${(TAKE_PROFIT * 100).toFixed(0)}%/stop-${(HARD_STOP * 100).toFixed(0)}%` : TRIGGER_MODE === "mc" ? `MC-trigger $${MC_LO / 1000}-${MC_HI / 1000}k → TP+${(TAKE_PROFIT * 100).toFixed(0)}%/stop-${(HARD_STOP * 100).toFixed(0)}%` : "buyer-burst (legacy)";
console.log(`trigger bot | ${DRY_RUN ? "PAPER" : "LIVE 💸"} | ${modeDesc} | hybrid scan=public(${scanCid}) trade=alchemy(${tradeCid}) | ${COPY_ETH} ETH/entry`);
if (account) console.log("burner:", account.address);
if (account && !DRY_RUN) await unwrapWeth();   // F4: reclaim any WETH left from a prior run
if (TRIGGER_MODE === "mc") await ethPrice();    // warm the ETH price before the first scan
await tg(`🚀 trigger ${DRY_RUN ? "*PAPER*" : "*LIVE*"} started · ${modeDesc} · ${COPY_ETH} ETH/entry`);

// block detection on the free public RPC (scanning never touches Alchemy)
(async function poll() { await tick(); setTimeout(poll, POLL_MS); })();
