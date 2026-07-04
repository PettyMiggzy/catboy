// Bundle / rug forensics (BUILD SPEC Part 2 — the differentiator).
// Read-only on-chain analysis via your RPC. Best-effort: every section is wrapped so
// the endpoint returns partial data instead of hard-failing under rate limits.
//
// Returns: supply, holder concentration (real wallets only), launch snipers,
// funding clusters (shared-funder bundle detection), and a 0-100 risk score.

import * as web3ns from "@solana/web3.js";
const web3 = web3ns.default || web3ns;
const { PublicKey } = web3;

const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
async function rpc(method, params = []) {
  const url = process.env.SOLANA_RPC;
  if (!url) throw new Error("rpc_not_configured");
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc_error");
  return j.result;
}

const settle = async (p, fallback) => { try { return await p; } catch { return fallback; } };

function curvePdaFor(mint) {
  try {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()],
      new PublicKey(PUMP_PROGRAM)
    )[0].toBase58();
  } catch { return ""; }
}

// Page getSignaturesForAddress to the oldest, bounded.
async function oldestSignatures(address, maxPages = 4, pageSize = 1000) {
  let before = undefined;
  let all = [];
  for (let i = 0; i < maxPages; i++) {
    const opts = { limit: pageSize };
    if (before) opts.before = before;
    const page = await settle(rpc("getSignaturesForAddress", [address, opts]), []);
    if (!page.length) break;
    all = all.concat(page);
    before = page[page.length - 1].signature;
    if (page.length < pageSize) break;
  }
  return all.reverse(); // oldest first
}

// From a parsed tx, who bought `mint` most (token balance increase)?
function buyerOf(tx, mint) {
  const pre = tx?.meta?.preTokenBalances || [];
  const post = tx?.meta?.postTokenBalances || [];
  const map = new Map();
  pre.forEach((b) => { if (b.mint === mint) map.set(b.owner, (map.get(b.owner) || 0) - (b.uiTokenAmount?.uiAmount || 0)); });
  post.forEach((b) => { if (b.mint === mint) map.set(b.owner, (map.get(b.owner) || 0) + (b.uiTokenAmount?.uiAmount || 0)); });
  let best = null, bestAmt = 0;
  for (const [owner, delta] of map) if (delta > bestAmt) { best = owner; bestAmt = delta; }
  return best ? { owner: best, amount: bestAmt } : null;
}

// Who funded this wallet first? (oldest tx, system transfer to it)
async function funderOf(wallet) {
  const sigs = await oldestSignatures(wallet, 2);
  if (!sigs.length) return null;
  for (const s of sigs.slice(0, 3)) {
    const tx = await settle(rpc("getTransaction", [s.signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]), null);
    const ix = tx?.transaction?.message?.instructions || [];
    for (const i of ix) {
      const info = i?.parsed?.info;
      if (i?.program === "system" && i?.parsed?.type === "transfer" && info?.destination === wallet) {
        return info.source;
      }
    }
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "method_not_allowed" }); }
  if (!process.env.SOLANA_RPC) return res.status(503).json({ error: "rpc_not_configured" });

  let mint;
  try { const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {}; mint = b.mint; }
  catch { return res.status(400).json({ error: "bad_json" }); }
  if (!mint) return res.status(400).json({ error: "missing_mint" });

  const out = { mint, supply: 0, top10: 0, top20: 0, largest: 0, holders: [], snipers: [], snipedPct: 0, clusters: [], mintAuthority: null, freezeAuthority: null, risk: { score: 0, level: "low", flags: [] } };
  const curve = curvePdaFor(mint);

  // 0) MINT / FREEZE AUTHORITY (rug signals — null is safest)
  try {
    const acc = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
    const info = acc?.value?.data?.parsed?.info;
    out.mintAuthority = info?.mintAuthority || null;
    out.freezeAuthority = info?.freezeAuthority || null;
  } catch {}

  // 1) SUPPLY + CONCENTRATION
  try {
    const [supplyRes, largest] = await Promise.all([
      rpc("getTokenSupply", [mint]),
      rpc("getTokenLargestAccounts", [mint]),
    ]);
    out.supply = Number(supplyRes.value.uiAmount) || 0;
    const accts = (largest.value || []).slice(0, 20);
    const infos = await settle(rpc("getMultipleAccounts", [accts.map((a) => a.address), { encoding: "jsonParsed" }]), { value: [] });
    const holders = [];
    (infos.value || []).forEach((info, i) => {
      const owner = info?.data?.parsed?.info?.owner;
      const amt = Number(accts[i].uiAmount) || 0;
      if (!owner || owner === curve) return;
      holders.push({ owner, amount: amt, pct: out.supply ? (amt / out.supply) * 100 : 0 });
    });
    holders.sort((a, b) => b.amount - a.amount);
    const sum = (a) => a.reduce((s, h) => s + h.pct, 0);
    out.top10 = +sum(holders.slice(0, 10)).toFixed(2);
    out.top20 = +sum(holders.slice(0, 20)).toFixed(2);
    out.largest = +(holders[0]?.pct || 0).toFixed(2);
    out.holders = holders.slice(0, 20);
  } catch (e) { out.risk.flags.push("concentration unavailable"); }

  // 2) LAUNCH SNIPERS (earliest buyers)
  try {
    const sigs = await oldestSignatures(mint, 4);
    const earliest = sigs.slice(0, 12);
    const txs = await Promise.all(earliest.map((s) =>
      settle(rpc("getTransaction", [s.signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]), null)
    ));
    const seen = new Set();
    let snipedAmt = 0;
    for (const tx of txs) {
      if (!tx) continue;
      const buyer = buyerOf(tx, mint);
      if (buyer && buyer.owner !== curve && !seen.has(buyer.owner)) {
        seen.add(buyer.owner);
        snipedAmt += buyer.amount;
        out.snipers.push({ owner: buyer.owner, amount: +buyer.amount.toFixed(2) });
      }
    }
    out.snipers = out.snipers.slice(0, 10);
    out.snipedPct = out.supply ? +((snipedAmt / out.supply) * 100).toFixed(2) : 0;
  } catch (e) { out.risk.flags.push("sniper scan unavailable"); }

  // 3) FUNDING CLUSTERS (shared-funder bundle detection)
  try {
    const candidates = [
      ...out.holders.slice(0, 8).map((h) => h.owner),
      ...out.snipers.slice(0, 6).map((s) => s.owner),
    ].filter((v, i, a) => v && a.indexOf(v) === i).slice(0, 12);

    const funders = await Promise.all(candidates.map(async (w) => ({ wallet: w, funder: await settle(funderOf(w), null) })));
    const byFunder = new Map();
    funders.forEach(({ wallet, funder }) => {
      if (!funder) return;
      if (!byFunder.has(funder)) byFunder.set(funder, []);
      byFunder.get(funder).push(wallet);
    });
    for (const [funder, wallets] of byFunder) {
      if (wallets.length >= 2) out.clusters.push({ funder, wallets, size: wallets.length });
    }
    out.clusters.sort((a, b) => b.size - a.size);
  } catch (e) { out.risk.flags.push("cluster trace unavailable"); }

  // 4) RISK SCORE 0-100
  try {
    const biggestCluster = out.clusters[0]?.size || 0;
    let score = 0;
    score += Math.min(35, out.top10 * 0.5);          // concentration
    score += Math.min(20, out.largest * 0.8);         // whale
    score += Math.min(25, out.snipedPct * 1.2);       // launch snipe
    score += Math.min(20, biggestCluster * 6);        // bundle
    if (out.mintAuthority) score += 12;               // can mint more
    if (out.freezeAuthority) score += 8;              // can freeze wallets
    score = Math.round(Math.min(100, score));
    const flags = out.risk.flags.slice();
    if (out.mintAuthority) flags.push("mint authority active (supply can grow)");
    if (out.freezeAuthority) flags.push("freeze authority active (wallets can be frozen)");
    if (out.top10 > 40) flags.push(`top 10 hold ${out.top10}%`);
    if (out.largest > 15) flags.push(`largest wallet ${out.largest}%`);
    if (out.snipedPct > 15) flags.push(`${out.snipedPct}% sniped at launch`);
    if (biggestCluster >= 2) flags.push(`bundle: ${biggestCluster} wallets share a funder`);
    out.risk = { score, level: score >= 66 ? "high" : score >= 33 ? "med" : "low", flags };
  } catch (e) {}

  // Edge-cache identical lookups so repeated requests don't re-hit the paid RPC.
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
  return res.status(200).json(out);
}
