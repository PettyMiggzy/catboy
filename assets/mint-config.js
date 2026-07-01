/* CATBOY mint config — fill these in at launch, then set enabled:true.
   Values come from the Metaplex "sugar" deploy (see MINT.md). */
window.CATBOY_MINT = {
  enabled: false,            // flip to true once the candy machine is live
  candyMachineId: "",        // sugar -> cache.json "candyMachine"
  collectionMint: "",        // sugar -> cache.json "collectionMint"
  treasury: "",              // wallet that receives mint payments (solPayment destination)
  rpc: "/api/solrpc",        // same-origin RPC proxy (already live)
  total: 100,                // collection size

  // Tiered "loot box" packs — different price, different odds of each rarity.
  // Odds are percentages and must add up to 100 per pack. At launch each pack
  // maps to a candy-guard group label (guardGroup) with its own solPayment.
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
