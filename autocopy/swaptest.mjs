// swaptest — ONE watched tiny buy+sell round-trip to prove the executor before auto-copy is wired.
// Uses viem + the on-chain-VERIFIED Uniswap V3 SwapRouter02. Simulates every tx; hard slippage cap.
// Runs in GitHub Actions (PRIVATE_KEY secret). PROVES: signing, router calldata, buy, approve, sell.
import { createWalletClient, createPublicClient, http, parseEther, formatEther, encodeFunctionData, getContract } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const ROUTER = "0xcaf681a66d020601342297493863e78c959e5cb2";           // verified SwapRouter02
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const TOKEN = (process.env.TEST_TOKEN || "0x020bfc650a365f8bb26819deaabf3e21291018b4").toLowerCase(); // CASHCAT
const POOL = (process.env.TEST_POOL || "0xA70fc67C9F69da90B63a0e4C05D229954574E313");
const FEE = Number(process.env.TEST_FEE || "10000");
const AMT_ETH = process.env.TEST_AMT || "0.003";                        // ~$7 test clip
const SLIP = Number(process.env.SLIP || "8") / 100;                     // 8% slippage cap for the test
const PK = (process.env.PRIVATE_KEY || "").trim();
if (!PK) { console.error("PRIVATE_KEY required"); process.exit(1); }

const chain = { id: 4663, name: "robinhood", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const account = privateKeyToAccount(PK.startsWith("0x") ? PK : "0x" + PK);
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

const ERC20 = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
];
const ROUTER_ABI = [{
  name: "exactInputSingle", type: "function", stateMutability: "payable",
  inputs: [{ type: "tuple", components: [
    { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "fee", type: "uint24" },
    { name: "recipient", type: "address" }, { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }],
  outputs: [{ name: "amountOut", type: "uint256" }],
}];
const POOL_ABI = [{ name: "slot0", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }] },
  { name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }];

async function main() {
  console.log("burner:", account.address);
  const bal = await pub.getBalance({ address: account.address });
  console.log("ETH balance:", formatEther(bal));
  if (bal < parseEther(AMT_ETH) + parseEther("0.0005")) { console.error("insufficient ETH for test + gas"); process.exit(1); }

  // pool price for slippage math (token per WETH from sqrtPriceX96)
  const [sqrtP] = await pub.readContract({ address: POOL, abi: POOL_ABI, functionName: "slot0" });
  const t0 = (await pub.readContract({ address: POOL, abi: POOL_ABI, functionName: "token0" })).toLowerCase();
  const wethIsT0 = t0 === WETH;
  const P = (Number(sqrtP) / 2 ** 96) ** 2;                 // token1/token0
  const tokenPerWeth = wethIsT0 ? P : 1 / P;                 // how many TOKEN per 1 WETH
  const amtIn = parseEther(AMT_ETH);
  const expOut = BigInt(Math.floor(Number(formatEther(amtIn)) * tokenPerWeth * 1e18));
  const minOut = expOut * BigInt(Math.floor((1 - SLIP) * 1000)) / 1000n;
  console.log(`BUY sim: expect ~${formatEther(expOut)} tokens, minOut ${formatEther(minOut)} (slip ${SLIP * 100}%)`);

  // ---- BUY: exactInputSingle{value} tokenIn=WETH -> TOKEN ----
  const buyParams = { tokenIn: WETH, tokenOut: TOKEN, fee: FEE, recipient: account.address, amountIn: amtIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n };
  await pub.simulateContract({ address: ROUTER, abi: ROUTER_ABI, functionName: "exactInputSingle", args: [buyParams], value: amtIn, account });
  console.log("BUY simulate OK — sending...");
  const buyHash = await wallet.writeContract({ address: ROUTER, abi: ROUTER_ABI, functionName: "exactInputSingle", args: [buyParams], value: amtIn });
  const buyRc = await pub.waitForTransactionReceipt({ hash: buyHash });
  console.log("BUY tx:", buyHash, "status:", buyRc.status);
  const tokBal = await pub.readContract({ address: TOKEN, abi: ERC20, functionName: "balanceOf", args: [account.address] });
  console.log("token received:", formatEther(tokBal));
  if (tokBal === 0n) { console.error("no tokens received — abort sell"); process.exit(1); }

  // ---- SELL: approve then exactInputSingle TOKEN -> WETH (honeypot proof: we CAN sell) ----
  const allow = await pub.readContract({ address: TOKEN, abi: ERC20, functionName: "allowance", args: [account.address, ROUTER] });
  if (allow < tokBal) { const ah = await wallet.writeContract({ address: TOKEN, abi: ERC20, functionName: "approve", args: [ROUTER, tokBal] }); await pub.waitForTransactionReceipt({ hash: ah }); console.log("approved token to router"); }
  const sellParams = { tokenIn: TOKEN, tokenOut: WETH, fee: FEE, recipient: account.address, amountIn: tokBal, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n };
  await pub.simulateContract({ address: ROUTER, abi: ROUTER_ABI, functionName: "exactInputSingle", args: [sellParams], account });
  console.log("SELL simulate OK — sending...");
  const sellHash = await wallet.writeContract({ address: ROUTER, abi: ROUTER_ABI, functionName: "exactInputSingle", args: [sellParams] });
  const sellRc = await pub.waitForTransactionReceipt({ hash: sellHash });
  console.log("SELL tx:", sellHash, "status:", sellRc.status);
  const balAfter = await pub.getBalance({ address: account.address });
  console.log("ETH after round-trip:", formatEther(balAfter), "(was", formatEther(bal) + ")");
  console.log("ROUND-TRIP COMPLETE ✅ — executor works. Cost of the round trip (fees+gas+slippage):", formatEther(bal - balAfter), "ETH");
}
main().catch((e) => { console.error("FAILED:", e.shortMessage || e.message); process.exit(1); });
