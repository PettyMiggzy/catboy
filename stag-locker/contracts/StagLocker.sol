// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title StagLocker
 * @notice Permissionless token + LP locker for any project on Robinhood Chain.
 *         Anyone can lock ERC-20 tokens or a Uniswap V3 LP position (NFT) until a
 *         chosen unlock time to prove they can't rug. Locks are immutable in the
 *         owner's favour: they can only be EXTENDED or TOPPED UP, never shortened or
 *         pulled early. The contract admin can only set the (optional) creation fee and
 *         fee recipient - the admin can NEVER touch or move locked assets.
 *
 * @dev    Solidity 0.8.24, OpenZeppelin 5.x. Deploy with the chain's Uniswap V3
 *         NonfungiblePositionManager so LP-NFT locks can be identified/validated.
 *         Robinhood Chain V3 NPM: 0x73991a25c818bf1f1128deaab1492d45638de0d3
 */
contract StagLocker is Ownable, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    enum Kind { ERC20, V3_LP }

    struct Lock {
        Kind kind;          // token lock or Uniswap V3 LP-NFT lock
        address asset;      // ERC20 token, or the V3 position manager (NFT contract)
        uint256 amountOrId; // ERC20: locked amount (actual received) · V3: the tokenId
        address owner;      // the only account that can withdraw / manage the lock
        uint64 unlockTime;  // unix seconds; withdrawable at or after this time
        bool withdrawn;     // true once claimed
    }

    /// @notice Uniswap V3 NonfungiblePositionManager for this chain (LP-NFT locks).
    address public immutable positionManager;

    /// @notice Flat creation fee in wei (native ETH). 0 = free. Only affects NEW locks.
    uint256 public flatFeeWei;
    /// @notice Where creation fees are sent.
    address public feeRecipient;

    uint256 public nextLockId;
    mapping(uint256 => Lock) private _locks;
    mapping(address => uint256[]) private _ownerLocks; // owner => lockIds
    mapping(address => uint256[]) private _assetLocks; // asset => lockIds

    event TokenLocked(uint256 indexed id, address indexed owner, address indexed token, uint256 amount, uint64 unlockTime);
    event V3Locked(uint256 indexed id, address indexed owner, uint256 indexed tokenId, uint64 unlockTime);
    event Withdrawn(uint256 indexed id, address indexed owner);
    event LockExtended(uint256 indexed id, uint64 newUnlockTime);
    event LockToppedUp(uint256 indexed id, uint256 addedAmount, uint256 newAmount);
    event LockOwnerChanged(uint256 indexed id, address indexed from, address indexed to);
    event FeeChanged(uint256 flatFeeWei, address feeRecipient);

    error BadUnlockTime();
    error NotLockOwner();
    error StillLocked();
    error AlreadyWithdrawn();
    error WrongKind();
    error FeeTooLow();
    error ZeroAmount();
    error ZeroAddress();

    constructor(address _positionManager, uint256 _flatFeeWei, address _feeRecipient, address _admin)
        Ownable(_admin)
    {
        if (_feeRecipient == address(0) || _admin == address(0)) revert ZeroAddress();
        positionManager = _positionManager; // may be address(0) if V3 locks unused on this chain
        flatFeeWei = _flatFeeWei;
        feeRecipient = _feeRecipient;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Locking
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Lock ERC-20 `token` until `unlockTime`. Handles fee-on-transfer tokens
    ///         by recording the amount actually received. Send >= flatFeeWei as msg.value.
    function lockTokens(address token, uint256 amount, uint64 unlockTime)
        external payable nonReentrant returns (uint256 id)
    {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (unlockTime <= block.timestamp) revert BadUnlockTime();
        _takeFee();

        IERC20 t = IERC20(token);
        uint256 before = t.balanceOf(address(this));
        t.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = t.balanceOf(address(this)) - before; // fee-on-transfer safe
        if (received == 0) revert ZeroAmount();

        id = nextLockId++;
        _locks[id] = Lock(Kind.ERC20, token, received, msg.sender, unlockTime, false);
        _ownerLocks[msg.sender].push(id);
        _assetLocks[token].push(id);
        emit TokenLocked(id, msg.sender, token, received, unlockTime);
    }

    /// @notice Lock a Uniswap V3 LP position NFT (`tokenId`) until `unlockTime`.
    ///         Approve this contract for the NFT first, or use safeTransferFrom with data.
    function lockV3Position(uint256 tokenId, uint64 unlockTime)
        external payable nonReentrant returns (uint256 id)
    {
        if (positionManager == address(0)) revert WrongKind();
        if (unlockTime <= block.timestamp) revert BadUnlockTime();
        _takeFee();
        IERC721(positionManager).transferFrom(msg.sender, address(this), tokenId);
        id = _recordV3(msg.sender, tokenId, unlockTime);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Managing a lock (owner-only, never weakens the lock)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Extend a lock. `newUnlockTime` must be LATER than the current one.
    function extendLock(uint256 id, uint64 newUnlockTime) external {
        Lock storage l = _locks[id];
        if (l.owner != msg.sender) revert NotLockOwner();
        if (l.withdrawn) revert AlreadyWithdrawn();
        if (newUnlockTime <= l.unlockTime) revert BadUnlockTime();
        l.unlockTime = newUnlockTime;
        emit LockExtended(id, newUnlockTime);
    }

    /// @notice Add more of the SAME token to an existing ERC-20 lock (no fee).
    function topUp(uint256 id, uint256 amount) external nonReentrant {
        Lock storage l = _locks[id];
        if (l.owner != msg.sender) revert NotLockOwner();
        if (l.withdrawn) revert AlreadyWithdrawn();
        if (l.kind != Kind.ERC20) revert WrongKind();
        if (amount == 0) revert ZeroAmount();
        IERC20 t = IERC20(l.asset);
        uint256 before = t.balanceOf(address(this));
        t.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = t.balanceOf(address(this)) - before;
        l.amountOrId += received;
        emit LockToppedUp(id, received, l.amountOrId);
    }

    /// @notice Hand a lock to a new owner (e.g. to a multisig). Irreversible for old owner.
    function transferLockOwnership(uint256 id, address newOwner) external {
        Lock storage l = _locks[id];
        if (l.owner != msg.sender) revert NotLockOwner();
        if (l.withdrawn) revert AlreadyWithdrawn();
        if (newOwner == address(0)) revert ZeroAddress();
        l.owner = newOwner;
        _ownerLocks[newOwner].push(id);
        emit LockOwnerChanged(id, msg.sender, newOwner);
    }

    /// @notice Withdraw a lock once `unlockTime` has passed. Owner only.
    function withdraw(uint256 id) external nonReentrant {
        Lock storage l = _locks[id];
        if (l.owner != msg.sender) revert NotLockOwner();
        if (l.withdrawn) revert AlreadyWithdrawn();
        if (block.timestamp < l.unlockTime) revert StillLocked();
        l.withdrawn = true;
        if (l.kind == Kind.ERC20) {
            IERC20(l.asset).safeTransfer(msg.sender, l.amountOrId);
        } else {
            IERC721(l.asset).safeTransferFrom(address(this), msg.sender, l.amountOrId);
        }
        emit Withdrawn(id, msg.sender);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views (public verification)
    // ─────────────────────────────────────────────────────────────────────────

    function getLock(uint256 id) external view returns (Lock memory) { return _locks[id]; }
    function ownerLockIds(address owner) external view returns (uint256[] memory) { return _ownerLocks[owner]; }
    function assetLockIds(address asset) external view returns (uint256[] memory) { return _assetLocks[asset]; }
    function totalLocks() external view returns (uint256) { return nextLockId; }
    function isUnlocked(uint256 id) external view returns (bool) { return block.timestamp >= _locks[id].unlockTime; }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin: fee only. NO access to locked assets, ever.
    // ─────────────────────────────────────────────────────────────────────────

    function setFee(uint256 _flatFeeWei, address _feeRecipient) external onlyOwner {
        if (_feeRecipient == address(0)) revert ZeroAddress();
        flatFeeWei = _flatFeeWei;
        feeRecipient = _feeRecipient;
        emit FeeChanged(_flatFeeWei, _feeRecipient);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal
    // ─────────────────────────────────────────────────────────────────────────

    function _takeFee() private {
        uint256 fee = flatFeeWei;
        if (msg.value < fee) revert FeeTooLow();
        if (fee > 0) {
            (bool ok, ) = feeRecipient.call{value: fee}("");
            require(ok, "fee xfer failed");
        }
        // refund any overpayment
        uint256 extra = msg.value - fee;
        if (extra > 0) {
            (bool ok2, ) = msg.sender.call{value: extra}("");
            require(ok2, "refund failed");
        }
    }

    function _recordV3(address owner, uint256 tokenId, uint64 unlockTime) private returns (uint256 id) {
        id = nextLockId++;
        _locks[id] = Lock(Kind.V3_LP, positionManager, tokenId, owner, unlockTime, false);
        _ownerLocks[owner].push(id);
        _assetLocks[positionManager].push(id);
        emit V3Locked(id, owner, tokenId, unlockTime);
    }

    /// @dev Accept V3 position NFTs ONLY as a lock creation: must come from the
    ///      configured positionManager and carry abi.encode(uint64 unlockTime) as data,
    ///      which auto-creates the lock owned by `from`. Anything else reverts, so a
    ///      stray/mis-encoded safeTransferFrom can never strand an NFT in this contract
    ///      with no lock recorded. (Fee-exempt by nature: safeTransferFrom carries no ETH;
    ///      use lockV3Position if a creation fee must be charged.)
    function onERC721Received(address, address from, uint256 tokenId, bytes calldata data)
        external override returns (bytes4)
    {
        if (msg.sender != positionManager) revert WrongKind();
        if (data.length != 32) revert BadUnlockTime();
        uint64 unlockTime = abi.decode(data, (uint64));
        if (unlockTime <= block.timestamp) revert BadUnlockTime();
        _recordV3(from, tokenId, unlockTime);
        return this.onERC721Received.selector;
    }
}
