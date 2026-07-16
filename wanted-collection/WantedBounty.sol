// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title WANTED: Outlaws of Sherwood — bounty claim
/// @notice Each NFT tokenId has a fixed $STAG bounty. The current holder of the NFT
///         claims it ONCE. Funded up-front by the owner depositing $STAG into this
///         contract. Non-custodial for holders; owner can only fund + set bounties
///         before locking, then withdraw leftover after an expiry.
interface IERC20 { function transfer(address,uint256) external returns (bool);
                   function transferFrom(address,address,uint256) external returns (bool);
                   function balanceOf(address) external view returns (uint256); }
interface IERC721 { function ownerOf(uint256) external view returns (address); }

contract WantedBounty {
    address public owner;
    IERC20  public immutable STAG;   // 0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49
    IERC721 public immutable WANTED;  // the WANTED collection NFT
    bool    public locked;           // once locked, bounties can't change
    uint256 public expiry;           // after this, owner may reclaim unclaimed $STAG

    mapping(uint256 => uint256) public bounty;   // tokenId => $STAG amount (18 decimals)
    mapping(uint256 => bool)    public claimed;  // tokenId => claimed?

    event BountySet(uint256 indexed id, uint256 amount);
    event Claimed(uint256 indexed id, address indexed to, uint256 amount);

    modifier onlyOwner(){ require(msg.sender==owner,"not owner"); _; }

    constructor(address stag, address wanted, uint256 expiry_) {
        owner=msg.sender; STAG=IERC20(stag); WANTED=IERC721(wanted); expiry=expiry_;
    }

    /// Owner sets each token's bounty (before locking). Batched.
    function setBounties(uint256[] calldata ids, uint256[] calldata amounts) external onlyOwner {
        require(!locked,"locked"); require(ids.length==amounts.length,"len");
        for (uint256 i; i<ids.length; ++i){ bounty[ids[i]]=amounts[i]; emit BountySet(ids[i],amounts[i]); }
    }

    /// Freeze bounties so holders can trust them. Irreversible.
    function lock() external onlyOwner { locked=true; }

    /// Current holder of tokenId claims its bounty, once.
    function claim(uint256 id) external {
        require(locked,"not live");
        require(!claimed[id],"already claimed");
        require(WANTED.ownerOf(id)==msg.sender,"not holder");
        uint256 amt=bounty[id]; require(amt>0,"no bounty");
        claimed[id]=true;
        require(STAG.transfer(msg.sender,amt),"transfer failed");
        emit Claimed(id,msg.sender,amt);
    }

    /// Batch claim for a holder owning several.
    function claimMany(uint256[] calldata ids) external {
        require(locked,"not live");
        for (uint256 i; i<ids.length; ++i){
            uint256 id=ids[i];
            if (claimed[id]) continue;
            if (WANTED.ownerOf(id)!=msg.sender) continue;
            uint256 amt=bounty[id]; if (amt==0) continue;
            claimed[id]=true; require(STAG.transfer(msg.sender,amt),"transfer failed");
            emit Claimed(id,msg.sender,amt);
        }
    }

    /// After expiry, owner reclaims whatever $STAG is left (unclaimed bounties).
    function sweep() external onlyOwner {
        require(block.timestamp>=expiry,"not expired");
        STAG.transfer(owner, STAG.balanceOf(address(this)));
    }
}
