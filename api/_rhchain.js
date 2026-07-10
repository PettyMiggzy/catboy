// Robinhood Chain (EVM L2, chainId 4663) helpers for the $STAG bot.
// Read-only JSON-RPC: verify $STAG (ERC-20) payments and native-ETH micro-deposits,
// and read on-chain $STAG balances. No keys — public reads only.

const RPC = (process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com").trim();
export const STAG_TOKEN = (process.env.STAG_TOKEN || "0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49").toLowerCase();
export const STAG_DECIMALS = parseInt(process.env.STAG_DECIMALS || "18", 10);

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export async function rpc(method, params = []) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc_error");
  return j.result;
}

const topicAddr = (topic) => "0x" + (topic || "").slice(-40).toLowerCase();

// On-chain $STAG balance (raw bigint of smallest unit).
export async function stagBalance(wallet) {
  const data = "0x70a08231" + "0".repeat(24) + wallet.toLowerCase().replace(/^0x/, "");
  const res = await rpc("eth_call", [{ to: STAG_TOKEN, data }, "latest"]);
  return BigInt(res || "0x0");
}
// Whole-token $STAG held (Number, fine for a >=1M threshold check).
export async function stagBalanceWhole(wallet) {
  const raw = await stagBalance(wallet);
  return Number(raw / 10n ** BigInt(Math.max(0, STAG_DECIMALS - 6))) / 1e6;
}

// Standard burn address + total supply, for the /burn tool.
export const DEAD = "0x000000000000000000000000000000000000dEaD";
export async function stagTotalSupplyWhole() {
  const res = await rpc("eth_call", [{ to: STAG_TOKEN, data: "0x18160ddd" }, "latest"]); // totalSupply()
  const raw = BigInt(res || "0x0");
  return Number(raw / 10n ** BigInt(Math.max(0, STAG_DECIMALS - 6))) / 1e6;
}

// Verify an ERC-20 $STAG payment: tx confirmed, transfers >= minWhole $STAG INTO `treasury`.
// Returns { ok, from, amountWhole } or { ok:false, err }.
export async function verifyStagPayment(txHash, treasury) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || "")) return { ok: false, err: "bad_hash" };
  const rec = await rpc("eth_getTransactionReceipt", [txHash]);
  if (!rec) return { ok: false, err: "tx_not_found" };
  if (rec.status && rec.status !== "0x1") return { ok: false, err: "tx_failed" };
  const t = treasury.toLowerCase();
  let raw = 0n, from = null;
  for (const log of rec.logs || []) {
    if ((log.address || "").toLowerCase() !== STAG_TOKEN) continue;
    if (!log.topics || log.topics[0] !== TRANSFER_TOPIC) continue;
    if (topicAddr(log.topics[2]) !== t) continue; // "to" == treasury
    raw += BigInt(log.data || "0x0");
    from = topicAddr(log.topics[1]);
  }
  if (raw <= 0n || !from) return { ok: false, err: "no_stag_to_treasury" };
  const amountWhole = Number(raw / 10n ** BigInt(Math.max(0, STAG_DECIMALS - 6))) / 1e6;
  return { ok: true, from, amountWhole };
}

// Verify a native-ETH micro-deposit of EXACTLY valueWei into `verifyWallet` (holder verify).
// The exact odd amount is the per-user secret binding this tx to their /verify session.
export async function verifyMicroDeposit(txHash, verifyWallet, valueWei) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || "")) return { ok: false, err: "bad_hash" };
  const tx = await rpc("eth_getTransactionByHash", [txHash]);
  if (!tx) return { ok: false, err: "tx_not_found" };
  if (!tx.to || tx.to.toLowerCase() !== verifyWallet.toLowerCase()) return { ok: false, err: "wrong_recipient" };
  if (BigInt(tx.value || "0x0") !== BigInt(valueWei)) return { ok: false, err: "wrong_amount" };
  const rec = await rpc("eth_getTransactionReceipt", [txHash]);
  if (!rec || (rec.status && rec.status !== "0x1")) return { ok: false, err: "not_confirmed" };
  return { ok: true, from: (tx.from || "").toLowerCase() };
}
