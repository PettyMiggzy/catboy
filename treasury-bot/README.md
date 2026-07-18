# treasury-bot — buy-the-dip / sell-the-rip market maker

EVM-generic treasury bot for a Uniswap-V3-style pool (works on Robinhood Chain and
any EVM). Watches the pool price, **buys dips** and (optionally) **sells into pumps**,
inside hard budget + slippage + cooldown limits. Grows/holds a treasury and puts a
buy-wall under the chart to absorb dumpers.

## SAFETY FIRST
- Ships with **DRY_RUN=1** (default): it LOGS every trade it *would* make but spends
  nothing. Watch it for a while, tune the numbers, THEN set DRY_RUN=0 to go live.
- Hard caps: MAX_SPEND_ETH (lifetime), TRADE_ETH (per buy), SELL_FRACTION (per sell),
  SLIPPAGE_BPS, COOLDOWN_SEC. It cannot exceed these.
- The wallet key is read from env only — NEVER commit it. Fund a *dedicated* trading
  wallet, not your main bag.

## Run
```
cd treasury-bot && npm install
# fill env (see below), then:
pm2 start index.mjs --name treasury-bot --update-env
```

## Env
```
RPC_URL=https://rpc.mainnet.chain.robinhood.com
POOL=0x8874bd3c8a9cb1baeee6014bd2d3598d4741e075   # $STAG/WETH V3 pool
TOKEN=0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49   # the token you're MMing ($STAG)
WETH=0x0bd7d308f8e1639fab988df18a8011f41eacad73
ROUTER=0x...            # the chain's Uniswap V3 SwapRouter (Ape Store router on RHC)
FEE=10000               # pool fee tier (500 / 3000 / 10000)
PRIVATE_KEY=0x...       # dedicated trading wallet (holds ETH + some $STAG). NEVER commit.
DIP_PCT=6               # buy when price is >=6% below the moving reference
PUMP_PCT=10             # sell when price is >=10% above the reference
TRADE_ETH=0.02          # ETH spent per dip-buy
SELL_FRACTION=25        # % of held token sold per pump-sell
MAX_SPEND_ETH=0.5       # lifetime ETH the bot may spend buying
SLIPPAGE_BPS=200        # 2% max slippage
COOLDOWN_SEC=180        # min seconds between trades
SELL_INTO_PUMPS=1       # 1 = also sell into green candles; 0 = dip-buy only (floor support)
POLL_SEC=20
DRY_RUN=1               # 1 = simulate only. Set 0 to trade for real.
```
Reuse for other projects: point POOL/TOKEN/WETH/ROUTER/FEE at that project's pool.
