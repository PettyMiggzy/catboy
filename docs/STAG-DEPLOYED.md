# $STAG — Deployed Contracts (Robinhood Chain mainnet)

Reference/handoff record of the on-chain deployment. **No action pending from an AI session** —
these are King's own admin-wallet operations. Recorded here for continuity so it isn't lost.

- **Chain:** Robinhood Chain mainnet (`rhmainnet`, chainId 4663), gas token ETH
- **Contracts repo:** `C:\Users\samah\stag\contracts` (Hardhat; `npx hardhat run scripts/deploy.js --network rhmainnet`; evm target `paris`, 29 Solidity files). Deploy writes `deployed.json`.

## Wallets
| Role | Address |
|---|---|
| Deployer | `0x5db7CA9d2CE3f414B3fd94EC0FcaF9F3Ab1A575f` |
| Admin / owner (penaltyRecipient, oracle setter, splitter admin) | `0xb6A5059356332A0B222e9D21b1f72f3617d12516` |

Deployer balance at deploy: 0.016968… ETH. Granted **2 free mints** → deployer.

## Contracts (live)
| Contract | Address | Role |
|---|---|---|
| **HoodedTwenty** | `0x4384cB362D908d36266bDF3C31F18DB95EB127dc` | the NFT collection (mint) — "our NFTs" (the ones in the promo) |
| **StagStaking** | `0x2faA6672546912e7cDec4E1AaCF1eeF52bA524fF` | staking pool (stake $STAG / NFTs for rewards) |
| **RevenueSplitter** | `0x1F6D791108635ac4522b1cfaD86FD7B435aDFe2a` | **90/10 → pool / admin** split |
| **SherwoodPact** | `0xc36662D2db9432702f018963ABdab19432AA488B` | needs an **oracle** = the bubble-map indexer signer (see next steps) |

Wiring done at deploy: NFT → splitter / royalty / locker / prices; ownership + penaltyRecipient + oracle → admin.

## `/admin` → Deployed Addresses (paste)
```
mint=0x4384cB362D908d36266bDF3C31F18DB95EB127dc
staking=0x2faA6672546912e7cDec4E1AaCF1eeF52bA524fF
splitter=0x1F6D791108635ac4522b1cfaD86FD7B435aDFe2a
pact=0xc36662D2db9432702f018963ABdab19432AA488B
```

## NEXT steps (from `/admin`, connect the OWNER wallet `0xb6A5…2516`)
1. **Fund the staking pool** + call `notifyRewardAmount`
2. **`setMintActive(true)`** to open minting
3. **SherwoodPact `setOracle(<indexer signer>)`** — once the bubble-map indexer is live (ties this to the bubblemap/ build)

## Threads this connects to
- **Staking** — this is the on-chain staking (was not previously documented; now it exists).
- **NFTs** — `HoodedTwenty` is the collection the origin-story promo was made for.
- **Bubble map** — `SherwoodPact.setOracle` waits on the indexer from `bubblemap/HANDOFF.md`.
