// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @dev Plain ERC-20 for lock/withdraw/top-up tests.
contract MockERC20 is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @dev Fee-on-transfer ERC-20: burns `feeBps` of every transfer. Proves the locker
///      records the amount actually RECEIVED, not the amount requested.
contract MockFeeToken is ERC20 {
    uint256 public feeBps; // e.g. 500 = 5%
    constructor(uint256 _feeBps) ERC20("Fee", "FEE") { feeBps = _feeBps; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && feeBps > 0) {
            uint256 fee = (value * feeBps) / 10000;
            super._update(from, address(0xdead), fee); // burn the fee
            value -= fee;
        }
        super._update(from, to, value);
    }
}

/// @dev Stand-in for the Uniswap V3 NonfungiblePositionManager (just an ERC-721).
contract MockPositionManager is ERC721 {
    uint256 public nextId;
    constructor() ERC721("Position", "POS") {}
    function mint(address to) external returns (uint256 id) { id = nextId++; _mint(to, id); }
}

/// @dev Attempts to re-enter withdraw() during the ERC-721 receive callback.
contract ReentrantReceiver {
    address public locker;
    uint256 public targetId;
    constructor(address _locker) { locker = _locker; }
    function arm(uint256 id) external { targetId = id; }
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        // Re-enter; must be blocked by ReentrancyGuard on withdraw().
        (bool ok, ) = locker.call(abi.encodeWithSignature("withdraw(uint256)", targetId));
        require(ok, "reenter blocked"); // if guard works, this reverts and bubbles up
        return this.onERC721Received.selector;
    }
}
