/* CATBOY mint config — fill these in at launch, then set enabled:true.
   Values come from the Metaplex "sugar" deploy (see MINT.md). */
window.CATBOY_MINT = {
  enabled: false,            // flip to true once the candy machine is live
  candyMachineId: "",        // sugar -> cache.json "candyMachine"
  collectionMint: "",        // sugar -> cache.json "collectionMint"
  treasury: "",              // wallet that receives mint payments (solPayment destination)
  rpc: "/api/solrpc",        // same-origin RPC proxy (already live)
  priceSol: 0.05,            // public mint price in SOL (must match the candy guard)
  total: 100,                // collection size
};
