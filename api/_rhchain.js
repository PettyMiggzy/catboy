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

// ── Hooded Twenty NFT + StagStaking on-chain stats (read-only) ─────────────────
export const HOODED_NFT = (process.env.STAG_NFT || "0x4384cB362D908d36266bDF3C31F18DB95EB127dc").toLowerCase();
export const STAG_STAKING = (process.env.STAG_STAKING || "0x2faA6672546912e7cDec4E1AaCF1eeF52bA524fF").toLowerCase();
const _call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
const _big = (h) => BigInt(h || "0x0");
const _balData = (a) => "0x70a08231" + "0".repeat(24) + a.toLowerCase().replace(/^0x/, "");
const _whole = (raw, dec = STAG_DECIMALS) => Number(raw / 10n ** BigInt(Math.max(0, dec - 6))) / 1e6;

// keccak256("StakedNFT(address,uint256)") — the staking contract records NFT stakes in
// userInfo (it does NOT escrow them via the NFT's balanceOf), so counting
// HoodedNFT.balanceOf(staking) always reads 0. Count from the contract's own records instead.
const STAKED_NFT_TOPIC = "0xa3a2f4924c244b65a4ecb0f6c615dc546a3510483f569d676ae4485f759d98d7";
async function stakedNftTotal() {
  try {
    const tip = Number(_big(await rpc("eth_blockNumber", [])));
    const from = "0x" + Math.max(0, tip - 1500000).toString(16);
    const logs = await rpc("eth_getLogs", [{ address: STAG_STAKING, topics: [STAKED_NFT_TOPIC], fromBlock: from, toBlock: "latest" }]);
    const stakers = [...new Set((logs || []).map((l) => "0x" + l.topics[1].slice(26).toLowerCase()))].slice(0, 100);
    if (!stakers.length) return 0;
    const infos = await Promise.all(stakers.map((w) => _call(STAG_STAKING, "0x1959a002" + "0".repeat(24) + w.replace(/^0x/, "")).catch(() => "0x")));
    return infos.reduce((n, hex) => n + _decodeUserInfo(hex).nfts.length, 0); // current staked-NFT count per userInfo
  } catch { return 0; }
}

// Total $STAG staked, NFTs staked, ETH reward pool + emission. (Staked = recorded by the pool.)
export async function stakingStats() {
  const [stag, poolWei, rate, finish, nftCount] = await Promise.all([
    _call(STAG_TOKEN, _balData(STAG_STAKING)),
    rpc("eth_getBalance", [STAG_STAKING, "latest"]),
    _call(STAG_STAKING, "0x7b0a47ee"), // rewardRate()
    _call(STAG_STAKING, "0xebe2b12b"), // periodFinish()
    stakedNftTotal(),
  ]);
  return {
    stagStaked: _whole(_big(stag)), nftsStaked: nftCount,
    poolEth: Number(_big(poolWei)) / 1e18, rewardEthPerSec: Number(_big(rate)) / 1e18,
    periodFinish: Number(_big(finish)),
  };
}
// Hooded Twenty mint progress.
export async function nftMintStats() {
  const [m, max, rem, active, price] = await Promise.all([
    _call(HOODED_NFT, "0x4f02c420"), // minted()
    _call(HOODED_NFT, "0x32cb6b0c"), // MAX_SUPPLY()
    _call(HOODED_NFT, "0x55234ec0"), // remaining()
    _call(HOODED_NFT, "0x25fd90f3"), // mintActive()
    _call(HOODED_NFT, "0x0a096373").catch(() => "0x0"), // randomPrice() (may revert pre-launch)
  ]);
  return {
    minted: Number(_big(m)), max: Number(_big(max)), remaining: Number(_big(rem)),
    active: _big(active) !== 0n, price: Number(_big(price)) / 1e18,
  };
}
// Decode StagStaking.userInfo(address) return tuple (has a dynamic nfts[] member).
function _decodeUserInfo(hex) {
  const d = (hex || "0x").replace(/^0x/, "");
  const word = (i) => { const s = d.slice(i * 64, i * 64 + 64); return s ? BigInt("0x" + s) : 0n; };
  // [4]stakedAt [5]lockTier [6]unlockAt [7]pendingEth [8]nftsOffset [9]locked
  const weight = Number(word(3)), unlockAt = Number(word(6)), lockTier = Number(word(5)), locked = word(9) !== 0n;
  const off = Number(word(8)) / 32;
  const len = off > 0 ? Number(word(off)) : 0;
  const nfts = [];
  for (let i = 0; i < len && i < 40; i++) nfts.push(Number(word(off + 1 + i)));
  return { weight, unlockAt, lockTier, locked, nfts };
}
// Top stakers by weight (the contract's reward-share metric). Gathers stakers from stake
// events, reads each one's live weight, ranks. Capped for a single serverless call.
export async function topStakers(limit = 10) {
  const STAKED_TOKENS = "0xe28ac993e6e9802e861a36a4c6b790999a65dfdc1df4dc3b2d16cc15dd511e3c";
  const STAKED_NFT = "0xa3a2f4924c244b65a4ecb0f6c615dc546a3510483f569d676ae4485f759d98d7";
  const tip = Number(BigInt(await rpc("eth_blockNumber", [])));
  const from = "0x" + Math.max(0, tip - 1500000).toString(16); // staking is new; this covers deploy
  let logs = [];
  try {
    const [a, b] = await Promise.all([
      rpc("eth_getLogs", [{ address: STAG_STAKING, topics: [STAKED_TOKENS], fromBlock: from, toBlock: "latest" }]),
      rpc("eth_getLogs", [{ address: STAG_STAKING, topics: [STAKED_NFT], fromBlock: from, toBlock: "latest" }]),
    ]);
    logs = [...(a || []), ...(b || [])];
  } catch { return []; }
  const stakers = [...new Set(logs.map((l) => "0x" + l.topics[1].slice(26).toLowerCase()))].slice(0, 100);
  if (!stakers.length) return [];
  const [tw, ...infos] = await Promise.all([
    _call(STAG_STAKING, "0x96c82e57"), // totalWeight()
    ...stakers.map((w) => _call(STAG_STAKING, "0x1959a002" + "0".repeat(24) + w.replace(/^0x/, "")).catch(() => "0x")),
  ]);
  const totalW = Number(_big(tw)) || 1;
  return stakers.map((w, i) => {
    const info = _decodeUserInfo(infos[i]);
    return { wallet: w, weight: info.weight, nfts: info.nfts.length, share: (info.weight / totalW) * 100 };
  }).filter((x) => x.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, limit);
}
// A specific wallet's staking position: $STAG staked, NFTs staked (+ids), pending ETH, unlock.
export async function walletStake(wallet) {
  const w = wallet.toLowerCase().replace(/^0x/, "");
  const [staked, earned, ui] = await Promise.all([
    _call(STAG_STAKING, "0x2123c6c6" + "0".repeat(24) + w + "0".repeat(24) + STAG_TOKEN.replace(/^0x/, "")), // stakedOf(w, $STAG)
    _call(STAG_STAKING, "0x008cc262" + "0".repeat(24) + w), // earned(w)
    _call(STAG_STAKING, "0x1959a002" + "0".repeat(24) + w).catch(() => "0x"), // userInfo(w)
  ]);
  const info = _decodeUserInfo(ui);
  return {
    stakedStag: _whole(_big(staked)), pendingEth: Number(_big(earned)) / 1e18,
    nftsStaked: info.nfts.length, nftIds: info.nfts, unlockAt: info.unlockAt, locked: info.locked,
  };
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
  return { ok: true, from, amountWhole, blockTime: await blockTimestamp(rec.blockNumber) };
}

// Unix seconds of a block (0 if unavailable) — used to require a payment be newer than
// the request that assigned its amount, so an old/stale tx can't be claimed by someone else.
async function blockTimestamp(blockNumber) {
  try {
    if (!blockNumber) return 0;
    const blk = await rpc("eth_getBlockByNumber", [blockNumber, false]);
    return blk && blk.timestamp ? Number(BigInt(blk.timestamp)) : 0;
  } catch { return 0; }
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
  return { ok: true, from: (tx.from || "").toLowerCase(), blockTime: await blockTimestamp(tx.blockNumber || rec.blockNumber) };
}
