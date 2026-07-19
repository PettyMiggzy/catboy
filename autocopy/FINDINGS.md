# Strategy research — findings (overnight sim session)

Goal: find a repeatable, positive-expectancy entry/exit for Robinhood Chain fresh launches
that could realistically net a few hundred USD/day at small size.

## What we tested (all on real on-chain data, RHC Uniswap V3)

| Strategy | Result | Verdict |
|---|---|---|
| Minute-1 snipe + hold N seconds (3–60s) | median = −fee at EVERY interval; avg dragged +ve by a few runners you often can't sell into (61% had no buyer at exit) | ❌ coin flip minus fees |
| Trending-bot ignition entry + "first red candle" exit | −18%/trade; entry good (+75% avg peak) but exit terrible | ❌ exit leak |
| Trending-bot entry + trailing/TP exit | +2.5% to +4.7%/trade (raw) | ✅ real but lumpy |
| **MC-trigger: enter when token GROWS INTO $8–20k MC, exit TP+40%/stop−35%** | **63–79% win, +33% median, positive avg across 5 OOS windows / 36h** | ✅ **best signal** |

The MC-trigger is the friend's tell ("enters near $5–10k MC") reverse-engineered and validated.
Higher band = more survival: $3–8k went negative, $8–20k was the sweet spot. Liquidity/MC filter
didn't help (these pools are already liquidity-rich at that size).

## The catch — fill sensitivity (the important part)

Stress-testing realistic polling latency on the $8–20k TP40/SL35 config:

| Fill delay | Avg net | Median |
|---|---|---|
| 0s (idealized) | +9.5% | +31% |
| 1s late | −3.2% | +25% |
| 2.5s late (real) | −2.5% | +22% |

- The **median trade stays strongly positive** even delayed — the typical entry is genuinely good.
- The **average flips negative** with ~1s of lag, driven by the loser tail (dumps filling worse than
  the −35% stop). The average is too sensitive to unmodelable fill/path details to trust as expectancy.

**Conclusion:** the SIGNAL is validated (6 ways). Live NET profitability CANNOT be proven from
backtest because it hinges on real fills. Backtested daily-$ figures ($1.8k–3.6k/day) are NOT reliable
— treat them as an upper bound, not a forecast. Paper trading with the real bot is the only valid test.

## What's built

`autocopy/trigger.mjs` now defaults to `TRIGGER_MODE=mc`:
- Entry: pool's MC (priceEth × totalSupply × live ETH price) first crosses up into `$MC_LO–$MC_HI`
  (default 8k–20k) having grown in from below; LP not draining; whale/exposure/cost gates.
- Exit: TP+40% / stop−35% (trail is a loose backstop), via `manage()`.
- Still `DRY_RUN=1` (paper). Verified: boots clean (both chains 4663), MC math correct on live tokens.
- 30-min heartbeat DMs the funnel + reject tally so we can tune from live data.

## Next steps (in priority order)

1. **Let it paper-trade for several days.** Compare live paper fills to the backtest median. The
   question to answer: do real entries fill near the band price, and do stops fill near −35%?
2. If paper fills are healthy → go live TINY ($10 clips), confirm real ≈ paper, then scale size to
   what pool liquidity allows.
3. If paper shows the loser tail is as bad as the delay-stress warned → fix execution before live:
   faster exit polling (react to a breached stop in <1s, e.g. trade-side WSS), and/or entry filters
   that trim the dump-prone tail. Re-run the delay stress until it stays green at 2.5s.
4. Do NOT flip `DRY_RUN=0` until paper proves real fills are net positive. (King controls that switch.)

Sims live in `scratchpad/` (not committed): trendbot_v2, hold_sweep, mc_grid, mc_oos, mc_enhanced,
portfolio_sim, fill_delay, fill_decompose.
