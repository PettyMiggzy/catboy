// HoodX Floor Bot — market-maker / floor support for a single token (pilot: $STAG on Robinhood Chain).
// Strategy: slow EMA = "fair" anchor. Buy the dips below it (laddered — deeper dip, bigger buy),
// scale a little out above it, recycling proceeds into the dip warchest so the floor is self-funding.
// Reuses the SwapRouter02 executor proven in trigger.mjs. DRY_RUN=1 => paper (log/DM only, no trades).
// Flip DRY_RUN=0 only with a FRESH, SMALL-funded burner key. This is real money — start tiny.
import { createWalletClient, createPublicClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { existsSync, readFileSync, writeFileSync } from "fs";

// env: prefer buybot.env, fall back to deploy/.env (droplet)
for (const f of ["./buybot.env", "./deploy/.env"]) { try { const p = new URL(f, import.meta.url); if (existsSync(p)) for (const ln of readFileSync(p, "utf8").split("\n")) { const m = ln.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} }
const E = process.env;

const RPC = E.FLOOR_RPC || "https://rpc.mainnet.chain.robinhood.com";  // public RPC handles reads + tx (Alchemy key is capped)
const ROUTER = "0xcaf681a66d020601342297493863e78c959e5cb2";           // SwapRouter02 (verified)
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73".toLowerCase();
const TOKEN = (E.FLOOR_TOKEN || "0xcddb2d9838b7edab2f04af4943a6efe42c2f9f49").toLowerCase();
const POOL = (E.FLOOR_POOL || "0x8874bd3c8a9cb1baeee6014bd2d3598d4741e075").toLowerCase();
const FEE = Number(E.FLOOR_FEE || 10000);
const DRY_RUN = (E.FLOOR_DRY ?? "1") !== "0";

// strategy params (small pilot defaults; all env-tunable)
const LOOP_S = Number(E.FLOOR_LOOP_S || 30);
const EMA_N = Number(E.FLOOR_EMA_N || 40);                              // ~20 min anchor at 30s
const PER_BUY_ETH = Number(E.FLOOR_BUY_ETH || 0.004);                  // base dip-buy size
const DIP_BANDS = [                                                     // [drop-below-anchor, size multiple]
  [Number(E.FLOOR_DIP1 || 0.04), 1.0],
  [Number(E.FLOOR_DIP2 || 0.08), 1.6],
  [Number(E.FLOOR_DIP3 || 0.14), 2.6],
];
const SELL_BAND = Number(E.FLOOR_SELL_BAND || 0.07);                   // sell when >= this above anchor
const SELL_PCT = Number(E.FLOOR_SELL_PCT || 0.12);                     // fraction of token bag to scale out
const MAX_DEPLOY_ETH = Number(E.FLOOR_MAX_ETH || 0.03);               // hard cap on total ETH spent buying
const MIN_ETH_RESERVE = Number(E.FLOOR_RESERVE || 0.002);            // never spend below this (gas)
const COOLDOWN_S = Number(E.FLOOR_COOLDOWN_S || 90);
const SLIP = Number(E.FLOOR_SLIP || 12) / 100;
const MIN_LIQ_ETH = Number(E.FLOOR_MIN_LIQ || 0.3);                   // halt if pool WETH liquidity drops below this (drain/rug guard)

const PK = (E.FLOOR_PRIVATE_KEY || E.PRIVATE_KEY || "").trim();
if (!DRY_RUN && !PK) { console.error("FLOOR_PRIVATE_KEY required for live mode"); process.exit(1); }
const chain = { id: 4663, name: "robinhood", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 20000, retryCount: 2 }) });
const account = PK ? privateKeyToAccount(PK.startsWith("0x") ? PK : "0x" + PK) : null;
const wallet = account ? createWalletClient({ account, chain, transport: http(RPC, { timeout: 20000, retryCount: 2 }) }) : null;

const ERC20 = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }, { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }, { name: "allowance", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] }];
const WETH_ABI = [{ name: "withdraw", type: "function", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] }, { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];
const POOL_ABI = [{ name: "slot0", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }] }, { name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }];
const ROUTER_ABI = [{ name: "exactInputSingle", type: "function", stateMutability: "payable", inputs: [{ type: "tuple", components: [{ name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "fee", type: "uint24" }, { name: "recipient", type: "address" }, { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }], outputs: [{ name: "amountOut", type: "uint256" }] }];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const priceEth = async wethIsT0 => { const [sq] = await pub.readContract({ address: POOL, abi: POOL_ABI, functionName: "slot0" }); const P = (Number(sq) / 2 ** 96) ** 2; return wethIsT0 ? 1 / P : P; }; // ETH per token (raw ratio)
const lpEth = async () => { try { const b = await pub.readContract({ address: WETH, abi: ERC20, functionName: "balanceOf", args: [POOL] }); return Number(b) / 1e18; } catch { return -1; } };

// telegram DM (King) — action alerts only, low frequency
const BOT = (E.TG_BOT_TOKEN || E.BOT_TOKEN || "").trim(), CHAT = (E.FLOOR_CHAT || E.CHAT_ID || "6820752140").trim();
const tg = t => BOT ? fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: CHAT, text: t, parse_mode: "HTML", disable_web_page_preview: true }) }).catch(() => {}) : null;

// live executors (variable amount)
async function buyEth(ethAmt, pEth) {
  const amtIn = parseEther(ethAmt.toFixed(18).replace(/0+$/, "").replace(/\.$/, ".0"));
  const expOut = BigInt(Math.floor(ethAmt * (1 / pEth) * 1e18));
  const minOut = expOut * BigInt(Math.floor((1 - SLIP) * 1000)) / 1000n;
  const params = { tokenIn: WETH, tokenOut: TOKEN, fee: FEE, recipient: account.address, amountIn: amtIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n };
  await pub.simulateContract({ address: ROUTER, abi: ROUTER_ABI, functionName: "exactInputSingle", args: [params], value: amtIn, account });
  const h = await wallet.writeContract({ address: ROUTER, abi: ROUTER_ABI, functionName: "exactInputSingle", args: [params], value: amtIn });
  await pub.waitForTransactionReceipt({ hash: h });
  return h;
}
async function sellTokens(bal) {
  const allow = await pub.readContract({ address: TOKEN, abi: ERC20, functionName: "allowance", args: [account.address, ROUTER] });
  if (allow < bal) { const ah = await wallet.writeContract({ address: TOKEN, abi: ERC20, functionName: "approve", args: [ROUTER, bal] }); await pub.waitForTransactionReceipt({ hash: ah }); }
  const params = { tokenIn: TOKEN, tokenOut: WETH, fee: FEE, recipient: account.address, amountIn: bal, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n };
  await pub.simulateContract({ address: ROUTER, abi: ROUTER_ABI, functionName: "exactInputSingle", args: [params], account });
  const h = await wallet.writeContract({ address: ROUTER, abi: ROUTER_ABI, functionName: "exactInputSingle", args: [params] });
  await pub.waitForTransactionReceipt({ hash: h });
  // reclaim native ETH from the WETH we received (never run dry on gas)
  try { const wb = await pub.readContract({ address: WETH, abi: WETH_ABI, functionName: "balanceOf", args: [account.address] }); if (wb > 0n) { const wh = await wallet.writeContract({ address: WETH, abi: WETH_ABI, functionName: "withdraw", args: [wb] }); await pub.waitForTransactionReceipt({ hash: wh }); } } catch {}
  return h;
}

// state
const SF = new URL("./floor_state.json", import.meta.url);
let S = existsSync(SF) ? JSON.parse(readFileSync(SF, "utf8")) : { ema: 0, deployedEth: 0, realizedEth: 0, paperTokens: 0, lastActionTs: 0, buys: 0, sells: 0, halted: false };
const save = () => { try { const t = new URL(SF.href + ".tmp"); writeFileSync(t, JSON.stringify(S)); writeFileSync(SF, JSON.stringify(S)); } catch {} };

async function tokenBalRaw() { if (DRY_RUN) return BigInt(Math.floor(S.paperTokens)); try { return await pub.readContract({ address: TOKEN, abi: ERC20, functionName: "balanceOf", args: [account.address] }); } catch { return 0n; } }
async function ethBal() { if (DRY_RUN) return 999; try { return Number(await pub.getBalance({ address: account.address })) / 1e18; } catch { return 0; } }

let wethIsT0;
async function tick() {
  try {
    if (S.halted) return;
    const pEth = await priceEth(wethIsT0);
    if (!(pEth > 0)) return;
    S.ema = S.ema > 0 ? S.ema + (pEth - S.ema) * (2 / (EMA_N + 1)) : pEth;   // seed then EMA
    const liq = await lpEth();
    if (liq >= 0 && liq < MIN_LIQ_ETH) { S.halted = true; save(); await tg(`🛑 <b>Floor bot HALTED</b> — pool WETH liquidity ${liq.toFixed(3)}Ξ &lt; ${MIN_LIQ_ETH}Ξ. Possible drain/rug. No more buys.`); return; }
    const dev = (pEth - S.ema) / S.ema;                                      // >0 above anchor, <0 below
    const cool = (Date.now() - S.lastActionTs) / 1000 >= COOLDOWN_S;
    const eth = await ethBal();
    const bag = await tokenBalRaw();
    // --- DIP BUY ---
    let band = null; for (const [d, mult] of DIP_BANDS) if (dev <= -d && (!band || d > band[0])) band = [d, mult];
    if (band && cool && S.deployedEth < MAX_DEPLOY_ETH) {
      let size = Math.min(PER_BUY_ETH * band[1], MAX_DEPLOY_ETH - S.deployedEth);
      if (!DRY_RUN) size = Math.min(size, eth - MIN_ETH_RESERVE);
      if (size >= 0.0005) {
        if (DRY_RUN) { const tok = size * (1 / pEth) * 1e18; S.paperTokens += tok; S.deployedEth += size; S.lastActionTs = Date.now(); S.buys++; save(); await tg(`🟢 <b>[DRY] Floor BUY</b> ${size.toFixed(4)}Ξ $STAG @ dip ${(dev * 100).toFixed(1)}% below anchor\nDeployed ${S.deployedEth.toFixed(4)}/${MAX_DEPLOY_ETH}Ξ · paper bag valued ${((S.paperTokens * pEth) / 1e18).toFixed(4)}Ξ`); }
        else { try { const h = await buyEth(size, pEth); S.deployedEth += size; S.lastActionTs = Date.now(); S.buys++; save(); await tg(`🟢 <b>Floor BUY</b> ${size.toFixed(4)}Ξ $STAG (dip ${(dev * 100).toFixed(1)}%)\n<code>${h}</code>`); } catch (e) { await tg(`⚠️ Floor buy failed: ${(e.shortMessage || e.message || "").slice(0, 120)}`); } }
        return;
      }
    }
    // --- SCALE-OUT SELL into strength ---
    if (dev >= SELL_BAND && cool && bag > 0n) {
      const sellRaw = bag * BigInt(Math.floor(SELL_PCT * 1000)) / 1000n;
      if (sellRaw > 0n) {
        const ethOut = Number(sellRaw) * pEth / 1e18;
        if (DRY_RUN) { S.paperTokens -= Number(sellRaw); S.realizedEth += ethOut; S.deployedEth = Math.max(0, S.deployedEth - ethOut); S.lastActionTs = Date.now(); S.sells++; save(); await tg(`🔴 <b>[DRY] Floor SELL</b> ${(SELL_PCT * 100).toFixed(0)}% of bag ≈ ${ethOut.toFixed(4)}Ξ @ +${(dev * 100).toFixed(1)}% above anchor\nRealized ${S.realizedEth.toFixed(4)}Ξ recycled into warchest`); }
        else { try { const h = await sellTokens(sellRaw); S.realizedEth += ethOut; S.deployedEth = Math.max(0, S.deployedEth - ethOut); S.lastActionTs = Date.now(); S.sells++; save(); await tg(`🔴 <b>Floor SELL</b> ~${ethOut.toFixed(4)}Ξ (+${(dev * 100).toFixed(1)}%)\n<code>${h}</code>`); } catch (e) { await tg(`⚠️ Floor sell failed (honeypot?): ${(e.shortMessage || e.message || "").slice(0, 120)}`); } }
        return;
      }
    }
    // heartbeat log (console only)
    console.log(`[floor] px ${pEth.toExponential(3)} anchor ${S.ema.toExponential(3)} dev ${(dev * 100).toFixed(1)}% deployed ${S.deployedEth.toFixed(4)}Ξ realized ${S.realizedEth.toFixed(4)}Ξ liq ${liq.toFixed(2)}Ξ`);
  } catch (e) { console.error("[floor] tick err:", e.shortMessage || e.message); }
}

(async () => {
  wethIsT0 = (await pub.readContract({ address: POOL, abi: POOL_ABI, functionName: "token0" })).toLowerCase() === WETH;
  console.log(`HoodX Floor Bot — $STAG — ${DRY_RUN ? "DRY-RUN (paper)" : "LIVE " + account.address} — anchor EMA${EMA_N}, dips ${DIP_BANDS.map(b => (b[0] * 100) + "%").join("/")}, sell +${SELL_BAND * 100}%`);
  await tg(`🏗️ <b>HoodX Floor Bot online</b> — $STAG ${DRY_RUN ? "(DRY-RUN — no real trades, proving the strategy)" : "<b>LIVE</b>"}\nBuys dips below anchor, scales out above, caps at ${MAX_DEPLOY_ETH}Ξ. I'll DM every move.`);
  while (true) { await tick(); await sleep(LOOP_S * 1000); }
})();
