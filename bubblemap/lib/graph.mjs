// Build a bubble-map graph from ERC-20 Transfer logs.
// Pulls the full transfer history of a token via eth_getLogs (works on the FREE RPC),
// then derives holder balances, wallet->wallet edges, and same-block acquisition
// clusters (the bundler/sniper signal). No Alchemy needed for this layer.

import { rpc } from "./rpc.mjs";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
const addr = (topic) => "0x" + topic.slice(-40).toLowerCase();

// Pull all Transfer logs for `token` from `fromBlock`..latest, chunked to respect
// RPC range limits. Chunk size auto-shrinks if an endpoint complains.
export async function fetchTransfers(token, fromBlock = 0, chunk = 2_000_000) {
  const latest = parseInt(await rpc("eth_blockNumber", []), 16);
  const logs = [];
  let f = fromBlock;
  while (f <= latest) {
    let t = Math.min(f + chunk - 1, latest);
    try {
      const r = await rpc("eth_getLogs", [{
        address: token.toLowerCase(), topics: [TRANSFER_TOPIC],
        fromBlock: "0x" + f.toString(16), toBlock: "0x" + t.toString(16),
      }]);
      if (Array.isArray(r)) logs.push(...r);
      f = t + 1;
    } catch (e) {
      if (chunk > 50_000) { chunk = Math.floor(chunk / 4); continue; } // shrink & retry
      throw e;
    }
  }
  return { logs, latest };
}

// Turn raw logs into { token, nodes, edges, clusters }.
export function buildGraph(logs, { token, meta = {}, pool = null } = {}) {
  const bal = new Map(), edges = new Map(), first = new Map();
  const bump = (m, k, v) => m.set(k, (m.get(k) || 0n) + v);
  const ordered = [...logs].sort((a, b) =>
    (parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16)) ||
    (parseInt(a.logIndex || "0x0", 16) - parseInt(b.logIndex || "0x0", 16)));
  for (const l of ordered) {
    const from = addr(l.topics[1]), to = addr(l.topics[2]);
    const val = BigInt(l.data), blk = parseInt(l.blockNumber, 16);
    bump(bal, from, -val); bump(bal, to, val);
    if (from !== ZERO) {
      const k = from + ">" + to, e = edges.get(k) || { from, to, val: 0n, count: 0 };
      e.val += val; e.count++; edges.set(k, e);
    }
    if (!first.has(to)) first.set(to, blk);
    if (!first.has(from)) first.set(from, blk);
  }
  const holders = [...bal].filter(([a, b]) => b > 0n && a !== ZERO);
  const supply = holders.reduce((s, [, b]) => s + b, 0n);
  // same-block acquisition clusters
  const byBlock = new Map();
  for (const [a] of holders) { const b = first.get(a); if (b != null) (byBlock.get(b) || byBlock.set(b, []).get(b)).push(a); }
  const cluster = new Map(); let cid = 0;
  for (const [, ws] of byBlock) if (ws.length > 1) { cid++; for (const w of ws) cluster.set(w, cid); }
  const pctOf = (b) => Number((b * 100000n) / supply) / 1000;
  const nodes = holders.map(([a, b]) => ({
    id: a, bal: b.toString(), pct: pctOf(b), firstBlock: first.get(a) ?? null,
    cluster: cluster.get(a) || 0,
    tag: (a === DEAD ? "burn" : (pool && a === pool.toLowerCase()) ? "LP Pool" : null),
  }));
  const held = new Set(holders.map(([a]) => a));
  const edgeList = [...edges.values()]
    .filter((e) => held.has(e.from) || held.has(e.to))
    .map((e) => ({ from: e.from, to: e.to, val: e.val.toString(), count: e.count }));
  return {
    token: { address: token.toLowerCase(), ...meta, supply: supply.toString(), holders: holders.length },
    pool, transfers: logs.length, clusters: cid, nodes, edges: edgeList, source: "free-rpc",
  };
}
