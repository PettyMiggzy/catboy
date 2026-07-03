/* CATBOY secondary-market config. On Solana, trading happens on Magic Eden &
   Tensor (deepest liquidity) — no custom orderbook needed. Fill these in when
   the collection is listed (post-mint) and set enabled:true. */
window.CATBOY_MARKET = {
  enabled: false,                                   // flip true once listed
  magicEden: "https://magiceden.io/marketplace/catboy",   // real symbol at launch
  tensor: "https://www.tensor.trade/trade/catboy",        // real slug at launch
  collectionMint: (window.CATBOY_MINT && window.CATBOY_MINT.collectionMint) || "", // verified collection
  rpc: "/api/solrpc",                               // same-origin RPC (DAS) proxy
  // item deep-links (mint address appended)
  meItem: "https://magiceden.io/item-details/",
};
