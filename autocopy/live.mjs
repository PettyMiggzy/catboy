// autocopy/live.mjs — REAL-TIME copy-trade bot for a DigitalOcean droplet (pm2).
// Watches alpha wallets block-by-block; the instant one BUYS a token, it honeypot-checks and
// copies at YOUR fixed size (never theirs); exits when they sell or a trailing stop hits.
// Uses the on-chain-VERIFIED Uniswap V3 SwapRouter02, proven by autocopy/swaptest.mjs.
// DRY_RUN=1 => paper (detects + logs + DMs, no real trades). Flip to 0 for live.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createWalletClient, createPublicClient, http, parseEther, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const ROUTER = "0xcaf681a66d020601342297493863e78c959e5cb2";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const WALLETS = (process.env.WALLETS || "0xad388f2e16355518cbc42aa6dce5f509cd729664").split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
const COPY_ETH = process.env.COPY_ETH || "0.004";              // YOUR size per copy (~$10)
const MAX_POS = Number(process.env.MAX_POS || "3");
const MAX_TOTAL_ETH = Number(process.env.MAX_TOTAL_ETH || "0.012"); // hard cap on total deployed
const SLIP = Number(process.env.SLIP || "10") / 100;
const TRAIL_PCT = Number(process.env.TRAIL_PCT || "25") / 100;      // backup exit if they go quiet
const HARD_STOP = Number(process.env.HARD_STOP || "35") / 100;
const POLL_MS = Number(process.env.POLL_MS || "2500");
const DRY_RUN = (process.env.DRY_RUN ?? "1") !== "0";
const BOT = (process.env.BOT_TOKEN || "").trim(), CHAT = (process.env.CHAT_ID || "6820752140").trim();
const STATE = process.env.STATE_FILE || "autocopy/.live.json";
const PK = (process.env.PRIVATE_KEY || "").trim();
if (!DRY_RUN && !PK) { console.error("PRIVATE_KEY required for live"); process.exit(1); }

const chain = { id: 4663, name: "robinhood", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const account = PK ? privateKeyToAccount(PK.startsWith("0x") ? PK : "0x" + PK) : null;
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = account ? createWalletClient({ account, chain, transport: http(RPC) }) : null;

const ERC20 = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }, { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }, { name: "allowance", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] }];
const ROUTER_ABI = [{ name: "exactInputSingle", type: "function", stateMutability: "payable", inputs: [{ type: "tuple", components: [{ name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "fee", type: "uint24" }, { name: "recipient", type: "address" }, { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }], outputs: [{ name: "amountOut", type: "uint256" }] }];
const POOL_ABI = [{ name: "slot0", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }] }, { name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }, { name: "fee", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] }];

const tg = (t) => BOT ? fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: CHAT, text: t, parse_mode: "Markdown", disable_web_page_preview: true }) }).catch(() => {}) : null;
const s256 = (h) => { const v = BigInt("0x" + h); return v >= (1n << 255n) ? v - (1n << 256n) : v; };
const poolMeta = {};
async function meta(pool) { if (poolMeta[pool]) return poolMeta[pool]; try { const t0 = (await pub.readContract({ address: pool, abi: POOL_ABI, functionName: "token0" })).toLowerCase(); const fee = await pub.readContract({ address: pool, abi: POOL_ABI, functionName: "fee" }); const wethIsT0 = t0 === WETH; return poolMeta[pool] = { token: wethIsT0 ? WETH : t0, wethIsT0, fee, other: wethIsT0 ? null : t0 }; } catch { return null; } }
async function priceEth(pool, wethIsT0) { const [sq] = await pub.readContract({ address: pool, abi: POOL_ABI, functionName: "slot0" }); const P = (Number(sq) / 2 ** 96) ** 2; return wethIsT0 ? 1 / P : P; }
const tokPerWeth = (pEth) => 1 / pEth;

const S = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { lastBlock: 0, positions: {} };
const save = () => writeFileSync(STATE, JSON.stringify(S));

async function buy(token, pool, fee, wethIsT0) {
  const amtIn = parseEther(COPY_ETH);
  const pEth = await priceEth(pool, wethIsT0), expOut = BigInt(Math.floor(Number(COPY_ETH) * tokPerWeth(pEth) * 1e18));
  const minOut = expOut * BigInt(Math.floor((1 - SLIP) * 1000)) / 1000n;
  const params = { tokenIn: WETH, tokenOut: token, fee, recipient: account.address, amountIn: amtIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n };
  await pub.simulateContract({ address: ROUTER, abi: ROUTER_ABI, functionName: "exactInputSingle", args: [params], value: amtIn, account }); // reverts if honeypot/no-liq
  const h = await wallet.writeContract({ address: ROUTER, abi: ROUTER_ABI, functionName: "exactInputSingle", args: [params], value: amtIn });
  await pub.waitForTransactionReceipt({ hash: h });
  const bal = await pub.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [account.address] });
  // prove sellable NOW (honeypot check on real balance)
  const allow = await pub.readContract({ address: token, abi: ERC20, functionName: "allowance", args: [account.address, ROUTER] });
  if (allow < bal) { const ah = await wallet.writeContract({ address: token, abi: ERC20, functionName: "approve", args: [ROUTER, bal] }); await pub.waitForTransactionReceipt({ hash: ah }); }
  try { await pub.simulateContract({ address: ROUTER, abi: ROUTER_ABI, functionName: "exactInputSingle", args: [{ tokenIn: token, tokenOut: WETH, fee, recipient: account.address, amountIn: bal, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }], account }); }
  catch { await tg(`🍯 *HONEYPOT* — bought $${token.slice(0,8)} but CAN'T sell it. ${COPY_ETH} ETH stuck. (size-capped)`); }
  return { hash: h, bal: bal.toString(), entry: pEth };
}
async function sell(token, fee, balStr) {
  const bal = BigInt(balStr);
  const allow = await pub.readContract({ address: token, abi: ERC20, functionName: "allowance", args: [account.address, ROUTER] });
  if (allow < bal) { const ah = await wallet.writeContract({ address: token, abi: ERC20, functionName: "approve", args: [ROUTER, bal] }); await pub.waitForTransactionReceipt({ hash: ah }); }
  const params = { tokenIn: token, tokenOut: WETH, fee, recipient: account.address, amountIn: bal, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n };
  await pub.simulateContract({ address: ROUTER, abi: ROUTER_ABI, functionName: "exactInputSingle", args: [params], account });
  const h = await wallet.writeContract({ address: ROUTER, abi: ROUTER_ABI, functionName: "exactInputSingle", args: [params] });
  await pub.waitForTransactionReceipt({ hash: h });
  return h;
}

async function handleBlock(bn) {
  const blk = await pub.getBlock({ blockNumber: BigInt(bn), includeTransactions: true });
  for (const tx of blk.transactions) {
    if (!tx.from || !WALLETS.includes(tx.from.toLowerCase())) continue;
    const rc = await pub.getTransactionReceipt({ hash: tx.hash }).catch(() => null); if (!rc) continue;
    for (const lg of rc.logs) {
      if ((lg.topics?.[0] || "").toLowerCase() !== SWAP_TOPIC) continue;
      const pool = lg.address.toLowerCase(); const m = await meta(pool); if (!m || !m.other) continue;
      const token = m.other; const d = lg.data.slice(2);
      const a0 = s256(d.slice(0, 64)), a1 = s256(d.slice(64, 128)); const tokDelta = m.wethIsT0 ? a1 : a0;
      const who = tx.from.toLowerCase().slice(0, 8);
      if (tokDelta < 0n) {   // alpha BOUGHT token
        if (S.positions[token]) continue;
        const openN = Object.keys(S.positions).length, deployed = Object.values(S.positions).reduce((a, p) => a + Number(p.cost || 0), 0);
        if (openN >= MAX_POS || deployed + Number(COPY_ETH) > MAX_TOTAL_ETH) { await tg(`👀 ${who} bought \`${token}\` — skipped (at max exposure)`); continue; }
        await tg(`🎯 *ALPHA BUY* ${who} → \`${token}\`\n${DRY_RUN ? "📝 would copy" : "🟢 copying"} ${COPY_ETH} ETH...`);
        if (DRY_RUN) { S.positions[token] = { pool, fee: m.fee, cost: COPY_ETH, entry: await priceEth(pool, m.wethIsT0), high: 0, paper: true, t: Date.now() }; save(); continue; }
        try { const r = await buy(token, pool, m.fee, m.wethIsT0); S.positions[token] = { pool, fee: m.fee, cost: COPY_ETH, bal: r.bal, entry: r.entry, high: r.entry, t: Date.now() }; save(); await tg(`✅ *BOUGHT* $${token.slice(0,8)} ${COPY_ETH} ETH\n[tx](https://robinhoodchain.blockscout.com/tx/${r.hash})`); }
        catch (e) { await tg(`❌ buy failed $${token.slice(0,8)}: ${(e.shortMessage || e.message || "").slice(0, 80)}`); }
      } else if (tokDelta > 0n && S.positions[token]) {   // alpha SOLD -> we exit
        const pos = S.positions[token]; delete S.positions[token]; save();
        if (pos.paper || DRY_RUN) { await tg(`📝 ${who} SOLD \`${token}\` — would exit copy`); continue; }
        try { const h = await sell(token, pos.fee, pos.bal); await tg(`🔴 *SOLD* $${token.slice(0,8)} (followed ${who} out)\n[tx](https://robinhoodchain.blockscout.com/tx/${h})`); }
        catch (e) { await tg(`❌ sell failed $${token.slice(0,8)}: ${(e.shortMessage || e.message || "").slice(0, 80)}`); }
      }
    }
  }
}

async function manageStops() {   // backup exits if the alpha goes quiet
  for (const token of Object.keys(S.positions)) {
    const pos = S.positions[token]; if (!pos.entry) continue;
    let cur; try { cur = await priceEth(pos.pool, poolMeta[pos.pool]?.wethIsT0 ?? true); } catch { continue; }
    pos.high = Math.max(pos.high || pos.entry, cur);
    const gain = cur / pos.entry - 1, dd = (pos.high - cur) / pos.high;
    if (gain <= -HARD_STOP || dd >= TRAIL_PCT) {
      delete S.positions[token]; save();
      if (pos.paper || DRY_RUN) { await tg(`📝 stop hit $${token.slice(0,8)} ${(gain*100).toFixed(0)}% — would exit`); continue; }
      try { const h = await sell(token, pos.fee, pos.bal); await tg(`🛑 *STOPPED OUT* $${token.slice(0,8)} ${(gain*100).toFixed(0)}%\n[tx](https://robinhoodchain.blockscout.com/tx/${h})`); } catch {}
    }
  }
}

async function loop() {
  try {
    const tip = Number(await pub.getBlockNumber());
    if (!S.lastBlock) S.lastBlock = tip - 1;
    for (let b = S.lastBlock + 1; b <= tip; b++) { await handleBlock(b); S.lastBlock = b; }
    await manageStops(); save();
  } catch (e) { console.error("loop err:", e.shortMessage || e.message); }
  setTimeout(loop, POLL_MS);
}
console.log(`autocopy live | ${DRY_RUN ? "PAPER" : "LIVE 💸"} | wallets ${WALLETS.length} | copy ${COPY_ETH} ETH | poll ${POLL_MS}ms`);
if (account) console.log("burner:", account.address);
tg(`🚀 autocopy ${DRY_RUN ? "*PAPER*" : "*LIVE*"} started · following ${WALLETS.length} wallet(s) · ${COPY_ETH} ETH/copy`);
loop();
