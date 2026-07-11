// Vercel serverless endpoint: GET /api/bubblemap?token=0x...
// Serves the precomputed graph from Postgres (production) or the on-disk JSON (prototype).
// The frontend reads from THIS endpoint, never from Alchemy — so viewer traffic costs $0 CU.
import { readFileSync } from "node:fs";
import { fetchTransfers, buildGraph } from "../lib/graph.mjs";

export default async function handler(req, res) {
  const token = (req.query.token || "0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49").toLowerCase();
  const live = req.query.live === "1"; // recompute from RPC instead of cache
  try {
    if (!live) {
      // TODO(production): SELECT from Postgres graph tables (db/schema.sql).
      // Prototype: serve the committed sample if it's the seeded token.
      try {
        const g = JSON.parse(readFileSync(`${process.cwd()}/bubblemap/data/stag-graph.json`, "utf8"));
        if (g.token.address === token) { res.setHeader("cache-control", "s-maxage=300"); return res.json(g); }
      } catch {}
    }
    // Live compute off the FREE RPC (Alchemy only kicks in on failure via lib/rpc.mjs).
    const { logs } = await fetchTransfers(token);
    const g = buildGraph(logs, { token });
    res.setHeader("cache-control", "s-maxage=120");
    return res.json(g);
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
