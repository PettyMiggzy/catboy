// Lightweight holder-concentration check (BUILD SPEC Part 2).
// Top-10/20 concentration + largest single wallet, excluding the pump bonding curve.
// Best-effort: returns partial data, never hard-fails.

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

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "method_not_allowed" }); }
  if (!process.env.SOLANA_RPC) return res.status(503).json({ error: "rpc_not_configured" });

  let mint;
  try { const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {}; mint = b.mint; }
  catch { return res.status(400).json({ error: "bad_json" }); }
  if (!mint) return res.status(400).json({ error: "missing_mint" });

  try {
    const [supplyRes, largest] = await Promise.all([
      rpc("getTokenSupply", [mint]),
      rpc("getTokenLargestAccounts", [mint]),
    ]);
    const supply = Number(supplyRes.value.uiAmount) || 0;
    const accts = (largest.value || []).slice(0, 20);
    if (!accts.length) return res.status(200).json({ supply, top10: 0, top20: 0, largest: 0, holders: [] });

    const infos = await rpc("getMultipleAccounts", [accts.map((a) => a.address), { encoding: "jsonParsed" }]);

    let curvePda = "";
    try {
      curvePda = PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()],
        new PublicKey(PUMP_PROGRAM)
      )[0].toBase58();
    } catch {}

    const holders = [];
    (infos.value || []).forEach((info, i) => {
      const owner = info?.data?.parsed?.info?.owner;
      const amt = Number(accts[i].uiAmount) || 0;
      if (!owner || owner === curvePda) return; // drop the bonding curve
      holders.push({ owner, amount: amt, pct: supply ? (amt / supply) * 100 : 0 });
    });
    holders.sort((a, b) => b.amount - a.amount);

    const sum = (arr) => arr.reduce((s, h) => s + h.pct, 0);
    return res.status(200).json({
      supply,
      top10: +sum(holders.slice(0, 10)).toFixed(2),
      top20: +sum(holders.slice(0, 20)).toFixed(2),
      largest: +(holders[0]?.pct || 0).toFixed(2),
      holders: holders.slice(0, 20),
    });
  } catch (e) {
    return res.status(200).json({ error: "partial", detail: String(e.message || e) });
  }
}
