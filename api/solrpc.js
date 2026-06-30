// Secure Solana RPC proxy (BUILD SPEC §1).
//
// The browser only ever calls /api/solrpc. This forwards the JSON-RPC body to your
// private RPC (process.env.SOLANA_RPC) server-side, so the API key never ships to
// the client. Front-end: new Connection(location.origin + '/api/solrpc').
//
// Set in Vercel env (NEVER in client code):
//   SOLANA_RPC=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY  (or Alchemy/QuickNode)

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const RPC = process.env.SOLANA_RPC;
  if (!RPC) return res.status(503).json({ error: "rpc_not_configured" });

  try {
    // web3.js sends a JSON object or a batch array — re-serialize either faithfully.
    const payload = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
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
