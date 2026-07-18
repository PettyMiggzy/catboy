# launch-radar — new Robinhood Chain launches trending up (alerts-only)

Every 15 min: finds pairs younger than MAX_AGE_H (default 48h) that are **trending up
with real buyers** (price up on 1h AND 6h, net buying, live volume, tradeable liquidity),
then runs a holder-health gate before DMing. Highest risk/reward table — the radar catches
early movers + filters obvious rugs, but **small size + taking profits are on you.**
Tune via env (MAX_AGE_H, LAUNCH_LIQ_MIN, VOL1H_MIN, MIN_BUYS, BUY_RATIO, TOP_HOLDER_MAX).
