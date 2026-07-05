/* CATBOY mint config — flip enabled:true at launch (see MINT.md).
   Minting runs through our own /api/mint (Metaplex Core, server-side): it
   verifies payment on-chain and enforces the odds. Price and odds are
   authoritative on the SERVER (api/mint.js); fields here are UI only. */
window.CATBOY_MINT = {
  enabled: true,             // LIVE — /api/mint configured + collection on mainnet
  rpc: "/api/solrpc",        // same-origin RPC proxy (already live)
  total: 100,                // collection size (display)
  collectionMint: "33kxQv4Jo7u9edC4RipZckwkpRRdxg863b6cw2UGfh6S", // Nine Lives Core collection — holder verify + perks
  genesisMint:    "HuLA9RRuG6s994eAiiY4cFhrhghCkCQWcNdm3e3wVD3x", // Genesis Core collection (elite perks)
  prideMint:      "4N1d9umoscMYiwiqxXnkTbJD9pXLMZiPCw4H7fAUK93x", // Pride Core collection (elite perks)

  // Tiered foil packs — pay more, better odds of a rare pull. Every pack mints a
  // random Catboy straight to your wallet. MUST match server PACKS in api/mint.js.
  // `coll` = which collection it mints from. Genesis/Pride packs only render once
  // their on-chain collection is live (the /api/mint GET gates them server-side).
  packs: [
    {
      id: "standard", name: "Standard Pack", pack: "pack-standard", priceSol: 1, coll: "nine",
      blurb: "One random Nine Lives Catboy. Solid odds, floor-friendly — rip it and see.",
      odds: { Common: 65, Rare: 24, Epic: 9, Legendary: 2 },
    },
    {
      id: "rare", name: "Rare Pack", pack: "pack-rare", priceSol: 1.5, coll: "nine",
      blurb: "Better odds — real shot at an Epic, doubled Legendary chance.",
      odds: { Common: 45, Rare: 35, Epic: 16, Legendary: 4 },
    },
    {
      id: "elite", name: "Elite Pack", pack: "pack-elite", priceSol: 2, coll: "nine",
      blurb: "Best odds in the shop. Fat Epic/Legendary chances for the chads.",
      odds: { Common: 25, Rare: 40, Epic: 27, Legendary: 8 },
    },
    {
      id: "genesis", name: "Genesis Pack", pack: "pack-genesis", priceSol: 2, coll: "genesis",
      blurb: "The launch edition — 100 originals with top-tier utility. Crimson foil.",
      odds: { Common: 60, Rare: 25, Epic: 12, Legendary: 3 },
    },
    {
      id: "pride", name: "Pride Pack", pack: "pack-pride", priceSol: 1.5, coll: "pride",
      blurb: "Limited Pride Edition 2026 — 10 rainbow Catboys. Love is love. 🏳️‍🌈",
      odds: { Pride: 100 },
    },
  ],
};
