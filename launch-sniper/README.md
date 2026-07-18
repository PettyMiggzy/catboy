# launch-sniper — early-momentum detector (on-chain, minute-1)

Every 5 min: reads V3 `PoolCreated` (every launchpad funnels here), and for each fresh
pool with real liquidity reads its on-chain swaps so far — DMs only launches with strong
early buy pressure (buyers >> sellers, real buy volume). Catches runners in their first
minutes, before dexscreener indexes them. Filters ~11k launches/day to the few catching.
Tune via env: MIN_LP_ETH, MIN_BUYS, BUY_RATIO, MIN_BUYVOL_ETH, WINDOW_BLOCKS, EVAL_CAP.
⚠️ Fresh launches are a casino — small size, take profits fast.
