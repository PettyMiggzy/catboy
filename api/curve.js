// Bonding-curve progress (% toward graduation) for pump.fun tokens (BUILD SPEC Part 2).
// Best-effort: returns partial data, never hard-fails.

import web3 from "@solana/web3.js";
const { PublicKey } = web3;

const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_INIT_REAL_TOKEN = 793100000000000n;
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
    const pda = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()],
      new PublicKey(PUMP_PROGRAM)
    )[0].toBase58();

    const acc = await rpc("getAccountInfo", [pda, { encoding: "base64" }]);
    if (!acc || !acc.value) {
      // No curve account => not a pump token, or already graduated to a DEX.
      return res.status(200).json({ exists: false, graduated: true, progress: 100 });
    }

    const data = Buffer.from(acc.value.data[0], "base64");
    // layout: [8 disc][u64 virtTok][u64 virtSol][u64 realTok][u64 realSol][u64 totalSupply][bool complete]
    const realToken = data.readBigUInt64LE(24);
    const complete = data.readUInt8(48) === 1;
    let progress = Number(((PUMP_INIT_REAL_TOKEN - realToken) * 10000n) / PUMP_INIT_REAL_TOKEN) / 100;
    progress = Math.max(0, Math.min(100, progress));

    return res.status(200).json({ exists: true, complete, progress: +progress.toFixed(2) });
  } catch (e) {
    return res.status(200).json({ error: "partial", detail: String(e.message || e) });
  }
}
