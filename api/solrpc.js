// Secure Solana RPC proxy (BUILD SPEC §1).
//
// The browser only ever calls /api/solrpc. This forwards the JSON-RPC body to your
// private RPC (process.env.SOLANA_RPC) server-side, so the API key never ships to
// the client. Front-end: new Connection(location.origin + '/api/solrpc').
//
// Set in Vercel env (NEVER in client code):
//   SOLANA_RPC=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY  (or Alchemy/QuickNode)

// Only the read methods the frontend actually needs — blocks abusive/expensive
// calls (e.g. getProgramAccounts) so the proxy can't be used to burn RPC quota.
const ALLOWED = new Set([
  "getLatestBlockhash", "isBlockhashValid", "getBlockHeight", "getSlot", "getEpochInfo",
  "getVersion", "getGenesisHash", "getHealth", "getFeeForMessage", "getRecentPrioritizationFees",
  "getMinimumBalanceForRentExemption", "getBalance", "getAccountInfo", "getMultipleAccounts",
  "getParsedAccountInfo", "getTokenAccountsByOwner", "getTokenAccountBalance", "getTokenSupply",
  "getSignatureStatuses", "getSignaturesForAddress", "getTransaction", "getParsedTransaction",
  "getAsset", "getAssetsByOwner", "getAssetsByGroup", "searchAssets", "sendTransaction",
]);
const MAX_BATCH = 25;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const RPC = process.env.SOLANA_RPC;
  if (!RPC) return res.status(503).json({ error: "rpc_not_configured" });

  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body || "{}"); } catch { return res.status(400).json({ error: "bad_json" }); } }
    const calls = Array.isArray(body) ? body : [body];
    if (calls.length > MAX_BATCH) return res.status(413).json({ error: "batch_too_large" });
    for (const c of calls) {
      if (!c || typeof c.method !== "string" || !ALLOWED.has(c.method)) {
        return res.status(403).json({ error: "method_not_allowed" });
      }
    }
    const payload = JSON.stringify(body);
    const upstream = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", "application/json");
    return res.send(text);
  } catch (err) {
    return res.status(502).json({ error: "rpc_proxy_failed" });
  }
}
