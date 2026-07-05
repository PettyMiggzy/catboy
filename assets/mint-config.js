/* CATBOY mint config — flip enabled:true at launch (see MINT.md).
   Minting runs through our own /api/mint (Metaplex Core, server-side): it
   verifies payment on-chain and enforces the odds. The mint wallet, price and
   odds are authoritative on the SERVER (api/mint.js); fields here are UI. */
window.CATBOY_MINT = {
  enabled: true,             // LIVE — /api/mint configured + collection on mainnet
  rpc: "/api/solrpc",        // same-origin RPC proxy (already live)
  total: 100,                // collection size (display)
  collectionMint: "33kxQv4Jo7u9edC4RipZckwkpRRdxg863b6cw2UGfh6S", // Core collection — holder verify + perks

  // Single flat-price random mint. MUST match the server PACKS in api/mint.js.
  packs: [
    {
      id: "random", name: "Random Catboy", emoji: "🎲", icon: "alpha", priceSol: 1,
      blurb: "One random Catboy from the 100-piece Nine Lives collection. Could be a floor cat, could be a Legendary — it mints straight to your wallet. Same odds for everyone.",
      odds: { Common: 60, Rare: 25, Epic: 12, Legendary: 3 },
    },
  ],
};
