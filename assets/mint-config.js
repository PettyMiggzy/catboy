/* CATBOY mint config — flip enabled:true at launch (see MINT.md).
   Minting runs through our own /api/mint (Metaplex Core, server-side): it
   verifies payment on-chain and enforces the pack odds. The mint wallet, price
   and odds are authoritative on the SERVER (api/mint.js); fields here are UI. */
window.CATBOY_MINT = {
  enabled: true,             // LIVE — /api/mint configured + collection on mainnet
  rpc: "/api/solrpc",        // same-origin RPC proxy (already live)
  total: 100,                // collection size (display)

  // Tiered "loot box" packs — UI copy + the price/odds shown to buyers. These
  // MUST match the server PACKS in api/mint.js (that's what actually runs).
  packs: [
    {
      id: "alley", name: "Alley Cat Pack", emoji: "🐈", priceSol: 0.05,
      blurb: "Trench starter. Cheap pull for the broke bois — you’re basically ngmi but hey, one cat, nine lives.",
      guardGroup: "alley",
      odds: { Common: 80, Rare: 16, Epic: 3.5, Legendary: 0.5 },
    },
    {
      id: "ninelives", name: "Nine Lives Pack", emoji: "😼", priceSol: 0.2,
      blurb: "The degen’s pick. Balanced odds, real shot at an Epic. Aped responsibly (lol).",
      guardGroup: "ninelives",
      odds: { Common: 50, Rare: 35, Epic: 12, Legendary: 3 },
    },
    {
      id: "alpha", name: "Alpha Whale Pack", emoji: "👑", priceSol: 0.6,
      blurb: "Whale mode. Printer goes brrr — fat Epic/Legendary odds for the size chads.",
      guardGroup: "alpha",
      odds: { Common: 18, Rare: 42, Epic: 32, Legendary: 8 },
    },
  ],
};
