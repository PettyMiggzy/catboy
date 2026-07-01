# Catboy NFT — Launch Runbook (candy machine mint)

Everything creative is done: 100 images (`assets/nft/collection/*.jpg`) + Metaplex
metadata (`assets/nft/collection/metadata/*.json`) + a live mint UI (`mint.html`).
To go live you create the candy machine on Solana and paste 3 values into
`assets/mint-config.js`. That's it.

## 0. Prereqs (on your DigitalOcean droplet or any machine with SOL)
- Install Solana CLI + a funded keypair (mainnet SOL for rent/fees).
- Install Metaplex **sugar**: `bash <(curl -sSf https://sugar.metaplex.com/install.sh)`

## 1. Host the assets
The metadata currently points `image` at the live Vercel URLs, which works.
For production, host on **DigitalOcean Spaces** (or Arweave) and update the
`image`/`files.uri` in each `metadata/*.json` to the Spaces/CDN URL.
(We already scaffolded Spaces access — see the chat notes.)

## 2. Prepare the sugar assets folder
Sugar expects paired files `0.jpg/0.json`, `1.jpg/1.json`, …
Our files are `001.jpg`/`metadata/001.json` (1-indexed). Rename/copy into a
`sugar-assets/` folder as `0.png…99.png` + `0.json…99.json` (0-indexed), and add
`collection.png` + `collection.json`. A tiny script does this — ask and I'll add it.

## 3. Configure & deploy
```bash
sugar validate
sugar upload            # uploads assets (or point config to the Spaces URLs)
sugar deploy            # creates the candy machine
sugar guard add         # add guards: solPayment (price + treasury), startDate, etc.
sugar verify
```
`sugar` writes `cache.json` containing **candyMachine** and **collectionMint**.

## 4. Flip the switch
Edit `assets/mint-config.js`:
```js
window.CATBOY_MINT = {
  enabled: true,
  candyMachineId: "<cache.json candyMachine>",
  collectionMint: "<cache.json collectionMint>",
  treasury: "<your payout wallet>",
  rpc: "/api/solrpc",
  priceSol: 0.05,   // must equal the solPayment guard amount
  total: 100,
};
```
Commit + push. `mint.html` then reads live supply and mints for real.

## Notes
- `mint.html` uses Metaplex umi + `mplCandyMachine` `mintV2`, with a `solPayment`
  guard. If you configure different guards (allowlist/tokenGate/startDate), the
  `mintArgs` in `mint.html` must match — ping me and I'll adjust.
- Test on **devnet** first (`sugar` supports `-e devnet`, point `rpc` at a devnet
  endpoint) before mainnet.
- This flow needs live testing at launch; it's standard CM v3 but guards vary.
