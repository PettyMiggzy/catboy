# 🔒🦌 Stag Locker — universal token & LP locker for Robinhood Chain

A permissionless locker any project on Robinhood Chain can use to **lock LP or team tokens**
and prove they can't rug. Public, verifiable, and it earns a small fee per lock. Built to be
**handed off / white-labeled** once launch-ready — the trust layer of the chain, branded $STAG.

Status: **STARTED** — core contract written. Not audited, not deployed. See "Roadmap" below.

---

## Why it exists
- NOXA Fun already locks its *own* LP permanently. **Every other project** on Robinhood Chain
  (custom launches, team/vesting tokens, non-NOXA LPs) has no trusted locker.
- Locking builds buyer trust → more projects launch on the chain → more volume.
- Revenue: a flat ETH **creation fee** per lock (set by admin, can be 0).

## What the contract does (`contracts/StagLocker.sol`)
- **Lock ERC-20 tokens** (`lockTokens`) — fee-on-transfer safe (records amount actually received).
- **Lock Uniswap V3 LP positions** (`lockV3Position`, or `safeTransferFrom` the NFT with an
  abi-encoded `uint64 unlockTime`).
- **Owner-only management that can only STRENGTHEN a lock:** `extendLock` (later only),
  `topUp` (add more), `transferLockOwnership`. **No early exit, ever.**
- **`withdraw`** only after `unlockTime`, only by the lock owner.
- **Public verification views:** `getLock`, `ownerLockIds`, `assetLockIds`, `isUnlocked`, `totalLocks`.

### Security guarantees (the whole point)
- **Admin can NEVER touch locked assets** — the only admin power is `setFee` (fee amount +
  recipient). Locked funds are mathematically out of admin reach.
- Locks are **immutable in the owner's favour** — extend/top-up only, never shorten or pull early.
- `ReentrancyGuard` on all state-changing external calls; `SafeERC20` for transfers;
  custom errors; overpaid fee is refunded.
- ⚠️ **Holds real value → MUST be audited before mainnet** (or before anyone else's funds go in).

## Robinhood Chain facts (for deploy)
- chainId **4663** · RPC `https://rpc.mainnet.chain.robinhood.com` · gas token ETH
- Explorer (verify here): `https://robinhoodchain.blockscout.com`
- Uniswap V3 **NonfungiblePositionManager**: `0x73991a25c818bf1f1128deaab1492d45638de0d3`
- (V3 Factory `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` · SwapRouter02 `0xcaf681a66d020601342297493863e78c959e5cb2` · WETH `0x0bd7d308f8e1639fab988df18a8011f41eacad73`)

## Build / deploy (Hardhat — matches the $STAG contracts repo)
Compiler: **Solidity 0.8.24**, optimizer runs 200, viaIR, evmVersion `paris`, OpenZeppelin 5.x.

Constructor args:
```
new StagLocker(
  positionManager,  // 0x73991a25c818bf1f1128deaab1492d45638de0d3 (or 0x0 to disable V3 locks)
  flatFeeWei,       // e.g. 0 to launch free, raise later
  feeRecipient,     // where fees go (treasury)
  admin             // owner (fee control only)
)
```
Then `verify` on Blockscout and hand the address to the front-end.

## Roadmap (what's left before "launch ready")
1. **Tests** (Hardhat/Foundry): lock/withdraw/extend/topUp, early-withdraw reverts, admin-can't-touch-funds, fee + refund, fee-on-transfer token, V3 NFT lock via both paths, reentrancy.
2. **Audit / self-review pass** — it holds value; do not skip.
3. **Front-end** (`stag-locker` site): connect wallet → lock tokens/LP → "my locks" → a **public verify page** (paste a token/LP address, see all its locks + unlock dates). Read via the view fns + events; write via the 3 lock/manage calls.
4. **Deploy** to Robinhood Chain mainnet + Blockscout verify.
5. **Branding/handoff:** logo (green-eyed stag + padlock), a one-pager, and a clean address + docs so any project — or a buyer — can use/white-label it.

## Handoff notes
- Contract is self-contained OZ-5 Solidity; drop `contracts/StagLocker.sol` into the Hardhat
  repo at `C:\Users\samah\stag\contracts` and it compiles alongside the others.
- The front-end can live in its own repo/Vercel project (like the bubble map) or a `/locker`
  route on the $STAG site. Keep any deployer key OUT of the repo (env only).
- This doc is the source of truth for a new session picking it up.
