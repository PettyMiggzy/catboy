# 🔒🦌 Stag Locker — universal token & LP locker for Robinhood Chain

A permissionless locker any project on Robinhood Chain can use to **lock LP or team tokens**
and prove they can't rug. Public, verifiable, and it earns a small fee per lock. Built to be
**handed off / white-labeled** once launch-ready — the trust layer of the chain, branded $STAG.

Status: **IN PROGRESS** — core contract written + **self-audited + full test suite passing (16/16)**.
Not third-party audited, not deployed. See "Self-audit" and "Roadmap" below.

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

## Self-audit (pass 1) — findings + status
- **[FIXED] Stranded-NFT bug in `onERC721Received`.** It previously *accepted* a V3 NFT sent
  via `safeTransferFrom` with bad/empty data (returned the receiver selector) but recorded **no
  lock** — the NFT would be stuck forever with no owner able to withdraw. Now it **reverts** unless
  the transfer comes from the configured `positionManager` and carries a valid `uint64 unlockTime`,
  so a stray/mis-encoded transfer bounces back to the sender. (Test: "REVERTS a safeTransfer with bad data".)
- **[BY DESIGN] Fee-exempt V3 path.** The `safeTransferFrom`-with-data path can't charge the flat
  fee (the callback receives no ETH). If a nonzero fee must always apply to V3 locks, route users
  through `lockV3Position` (which charges) and/or keep `flatFeeWei` at 0. Documented in the contract.
- **[KNOWN / low] Stale `ownerLockIds` after `transferLockOwnership`.** The old owner's index array
  still lists the transferred lock (append-only, no O(n) removal). `getLock(id).owner` is always
  correct, so the front-end/verify page must treat `ownerLockIds` as a candidate set and confirm the
  live owner via `getLock`. Left as-is to avoid unbounded gas; documented for integrators.
- **Verified safe:** admin has **no** asset-moving function (test asserts the ABI exposes only
  `setFee`); CEI + `ReentrancyGuard` on withdraw/lock/topUp; fee-on-transfer accounting uses
  balance-delta; overpaid fee refunded; early withdraw / non-owner / double-withdraw all revert.

## Tests (`test/StagLocker.test.js` + `contracts/mocks/Mocks.sol`)
Standalone: `npm i && npx hardhat test` (compiles paris + OZ 5.0.2, **16 passing**). Or drop
`contracts/` + `test/` into the main $STAG Hardhat repo. Covers: token lock/withdraw/extend/topUp,
fee-on-transfer accounting, fee charge + overpay refund + underpay revert, early-withdraw / wrong-owner
/ double-withdraw reverts, both V3 lock paths, the stranded-NFT revert, ownership transfer, and
"admin can't touch funds".

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
1. ✅ **Tests** (Hardhat): lock/withdraw/extend/topUp, early-withdraw reverts, admin-can't-touch-funds, fee + refund, fee-on-transfer token, V3 NFT lock via both paths — **16 passing**.
2. ✅ **Self-review pass** (findings above; stranded-NFT bug fixed). ⚠️ Still get a **third-party audit** before other people's funds go in.
3. **Front-end** (`stag-locker` site): connect wallet → lock tokens/LP → "my locks" → a **public verify page** (paste a token/LP address, see all its locks + unlock dates). Read via the view fns + events; write via the 3 lock/manage calls.
4. **Deploy** to Robinhood Chain mainnet + Blockscout verify.
5. **Branding/handoff:** logo (green-eyed stag + padlock), a one-pager, and a clean address + docs so any project — or a buyer — can use/white-label it.

## Handoff notes
- Contract is self-contained OZ-5 Solidity; drop `contracts/StagLocker.sol` into the Hardhat
  repo at `C:\Users\samah\stag\contracts` and it compiles alongside the others.
- The front-end can live in its own repo/Vercel project (like the bubble map) or a `/locker`
  route on the $STAG site. Keep any deployer key OUT of the repo (env only).
- This doc is the source of truth for a new session picking it up.
