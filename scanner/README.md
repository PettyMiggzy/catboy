# scanner — Robinhood Chain opportunity scanner (alerts-only)

Every 30 min: pulls active RHC pairs (dexscreener), screens each for
- **deep liquidity** (LIQ_MIN, default $10k) — can enter AND exit
- **real, two-sided volume** (VOL_MIN $25k, ≥50 txns, ≥10 buys AND ≥10 sells — not one wash-churner)
- **oversold bounce setup** — down ≥DIP_MIN% on 24h but turning up on 1h
then runs an on-chain **holder-health gate** (blockscout): rejects tokens whose top
non-pool wallet holds > TOP_HOLDER_MAX% (default 5%) — the dump-cluster/whale filter.

Survivors get DM'd as candidates. No trading — you decide. Tune everything via env.
Needs only a BOT_TOKEN secret. Dedups via scanner/.seen.json (cached), re-alerts after
REALERT_HOURS (default 12).
