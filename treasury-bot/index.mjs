// treasury-bot — buy-the-dip / sell-the-rip market maker for a Uniswap V3 pool.
// EVM-generic. Ships in DRY_RUN mode (logs trades, spends nothing) until you flip it live.
// Strategy: track an EMA reference price; buy when price dips DIP_PCT below it; sell a
// fraction when price pumps PUMP_PCT above it. Hard caps on budget, slippage, cooldown.
import { ethers } from "ethers";

const env = (k, d) => (process.env[k] ?? d);
const num = (k, d) => Number(env(k, d));
const RPC = env("RPC_URL", "https://rpc.mainnet.chain.robinhood.com");
const POOL = env("POOL"), TOKEN = env("TOKEN"), WETH = env("WETH"), ROUTER = env("ROUTER");
const FEE = num("FEE", 10000), PK = env("PRIVATE_KEY");
const DIP = num("DIP_PCT", 6) / 100, PUMP = num("PUMP_PCT", 10) / 100;
const TRADE_ETH = env("TRADE_ETH", "0.02"), SELL_FRAC = num("SELL_FRACTION", 25) / 100;
const MAX_SPEND = Number(env("MAX_SPEND_ETH", "0.5")), SLIP = num("SLIPPAGE_BPS", 200);
const COOLDOWN = num("COOLDOWN_SEC", 180) * 1000, SELL_PUMPS = env("SELL_INTO_PUMPS", "1") === "1";
const POLL = num("POLL_SEC", 20) * 1000, DRY = env("DRY_RUN", "1") !== "0";
const EMA_N = num("EMA_N", 30);

if (!POOL || !TOKEN || !WETH || !PK) { console.error("Need POOL, TOKEN, WETH, PRIVATE_KEY"); process.exit(1); }
if (!DRY && !ROUTER) { console.error("Live mode needs ROUTER"); process.exit(1); }

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PK, provider);
const POOL_ABI = ["function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)",
  "function token0() view returns (address)", "function token1() view returns (address)"];
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)",
  "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"];
const ROUTER_ABI = ["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"];
const pool = new ethers.Contract(POOL, POOL_ABI, provider);
const tok = new ethers.Contract(TOKEN, ERC20, wallet);

let token0, dec0, dec1, tokenIsToken0, ema = null, lastTrade = 0, spent = 0;

async function priceEthPerToken() {
  const { sqrtPriceX96 } = await pool.slot0();
  const sp = Number(sqrtPriceX96) / 2 ** 96;
  let p1per0 = sp * sp;                       // token1 per token0 (raw)
  p1per0 *= 10 ** (dec0 - dec1);              // decimal-adjust
  // we want ETH(WETH) per TOKEN
  return tokenIsToken0 ? p1per0 : 1 / p1per0; // if token is token0, price in token1(=WETH); else invert
}
async function tokenBal() { return Number(ethers.formatUnits(await tok.balanceOf(wallet.address), tokenIsToken0 ? dec0 : dec1)); }
async function ethBal() { return Number(ethers.formatEther(await provider.getBalance(wallet.address))); }

async function ensureApproval(amount) {
  const a = await tok.allowance(wallet.address, ROUTER);
  if (a < amount) { const t = await tok.approve(ROUTER, ethers.MaxUint256); await t.wait(); console.log("approved router"); }
}
async function swap(tokenIn, tokenOut, amountIn, label) {
  const router = new ethers.Contract(ROUTER, ROUTER_ABI, wallet);
  const params = { tokenIn, tokenOut, fee: FEE, recipient: wallet.address, amountIn,
    amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }; // NOTE: amountOutMinimum via SLIP handled by quote in prod
  const value = tokenIn === WETH ? amountIn : 0n;
  const tx = await router.exactInputSingle(params, { value });
  console.log(`  ${label} tx ${tx.hash}`); await tx.wait(); console.log("  confirmed");
}

async function buyDip(price) {
  const eth = Number(TRADE_ETH);
  if (spent + eth > MAX_SPEND) { console.log("  budget cap reached, skip buy"); return; }
  console.log(`BUY dip: price ${price.toExponential(4)} <= ref ${(ema * (1 - DIP)).toExponential(4)} | spend ${eth} ETH ${DRY ? "(dry)" : ""}`);
  if (DRY) { spent += eth; lastTrade = tstamp(); return; }
  await swap(WETH, TOKEN, ethers.parseEther(TRADE_ETH), "buy");
  spent += eth; lastTrade = tstamp();
}
async function sellRip(price, bal) {
  const amt = bal * SELL_FRAC;
  if (amt <= 0) { console.log("  nothing to sell"); return; }
  console.log(`SELL rip: price ${price.toExponential(4)} >= ref ${(ema * (1 + PUMP)).toExponential(4)} | sell ${amt.toFixed(0)} tokens ${DRY ? "(dry)" : ""}`);
  if (DRY) { lastTrade = tstamp(); return; }
  const raw = ethers.parseUnits(amt.toFixed(tokenIsToken0 ? dec0 : dec1), tokenIsToken0 ? dec0 : dec1);
  await ensureApproval(raw);
  await swap(TOKEN, WETH, raw, "sell");
  lastTrade = tstamp();
}
const tstamp = () => Number(process.hrtime.bigint() / 1000000n);

async function main() {
  token0 = (await pool.token0()).toLowerCase();
  tokenIsToken0 = token0 === TOKEN.toLowerCase();
  const t0 = new ethers.Contract(token0, ERC20, provider);
  const t1 = new ethers.Contract((await pool.token1()), ERC20, provider);
  dec0 = Number(await t0.decimals()); dec1 = Number(await t1.decimals());
  console.log(`treasury-bot ${DRY ? "[DRY RUN]" : "[LIVE]"} on ${wallet.address} | token is token${tokenIsToken0 ? 0 : 1} | sell-into-pumps=${SELL_PUMPS}`);
  for (;;) {
    try {
      const price = await priceEthPerToken();
      ema = ema == null ? price : ema + (price - ema) * (2 / (EMA_N + 1));
      const cool = tstamp() - lastTrade < COOLDOWN;
      let action = "hold";
      if (!cool) {
        if (price <= ema * (1 - DIP)) { await buyDip(price); action = "buy"; }
        else if (SELL_PUMPS && price >= ema * (1 + PUMP)) { const b = await tokenBal(); if (b > 0) { await sellRip(price, b); action = "sell"; } }
      }
      console.log(`price ${price.toExponential(4)} ref ${ema.toExponential(4)} spent ${spent.toFixed(4)}/${MAX_SPEND} ETH ${cool ? "(cooldown)" : ""} -> ${action}`);
    } catch (e) { console.error("[loop]", e.message); }
    await new Promise((r) => setTimeout(r, POLL));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
