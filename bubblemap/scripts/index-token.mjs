#!/usr/bin/env node
// Backfill one token's bubble-map graph from the FREE RPC and write data/<sym>-graph.json.
// Usage: node scripts/index-token.mjs 0x<token> [fromBlock]
// This is the phase-1 prototype path (JSON output). Production writes to Postgres (see db/schema.sql).
import { fetchTransfers, buildGraph } from "../lib/graph.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

const token = process.argv[2];
const fromBlock = parseInt(process.argv[3] || "0", 10);
if (!token) { console.error("usage: index-token.mjs 0x<token> [fromBlock]"); process.exit(1); }

const BS = "https://robinhoodchain.blockscout.com";
async function meta(t) {
  try {
    const r = await fetch(`${BS}/api/v2/tokens/${t}`, { headers: { "user-agent": "rh-bubblemaps" } });
    const j = await r.json();
    return { name: j.name, symbol: j.symbol, decimals: j.decimals };
  } catch { return {}; }
}

console.log("fetching transfers (free RPC)…");
const { logs, latest } = await fetchTransfers(token, fromBlock);
console.log(`  ${logs.length} transfers, head block ${latest}`);
const m = await meta(token);
const g = buildGraph(logs, { token, meta: m });
mkdirSync("data", { recursive: true });
const sym = (m.symbol || "token").replace(/[^a-z0-9]/gi, "").toLowerCase();
const out = `data/${sym}-graph.json`;
writeFileSync(out, JSON.stringify(g));
console.log(`  nodes ${g.nodes.length}  edges ${g.edges.length}  clusters ${g.clusters}`);
console.log(`  wrote ${out}`);
