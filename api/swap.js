// 1-tap swap of ANY token (BUILD SPEC Part 2).
// Jupiter quote + swap. Flat 1% fee via Jupiter NATIVE platformFee to REFERRAL_ACCOUNT
// (never a raw SOL transfer — that's the drainer pattern). Holders of YOUR_TOKEN_MINT
// get a discounted fee. Returns a serialized swap tx; the client signs single-signer
// via signAndSendTransaction. Falls back to a plain (no-fee) swap if the fee account
// isn't usable, so trading never hard-fails.

import web3 from "@solana/web3.js";
const { PublicKey } = web3;

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
function ata(mint, owner) {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), TOKEN_PROGRAM.toBuffer(), new PublicKey(mint).toBuffer()],
    ATA_PROGRAM
  )[0];
}

async function rpc(method, params = []) {
  const url = process.env.SOLANA_RPC;
  if (!url) throw new Error("rpc_not_configured");
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc_error");
  return j.result;
}

const JUP = "https://lite-api.jup.ag/swap/v1";
const BASE_FEE_BPS = 100; // 1%

// Holder discount: 1M+ => free, 100k+ => half, else full 1%.
async function feeBpsFor(wallet) {
  const tokenMint = process.env.YOUR_TOKEN_MINT;
  if (!tokenMint || !wallet) return BASE_FEE_BPS;
  try {
    const r = await rpc("getTokenAccountsByOwner", [wallet, { mint: tokenMint }, { encoding: "jsonParsed" }]);
    let bal = 0;
    (r.value || []).forEach((a) => { bal += Number(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount) || 0; });
    if (bal >= 1_000_000) return 0;
    if (bal >= 100_000) return Math.round(BASE_FEE_BPS / 2);
    return BASE_FEE_BPS;
  } catch { return BASE_FEE_BPS; }
}

async function getQuote({ inputMint, outputMint, amount, slippageBps, platformFeeBps }) {
  const u = new URL(JUP + "/quote");
  u.searchParams.set("inputMint", inputMint);
  u.searchParams.set("outputMint", outputMint);
  u.searchParams.set("amount", String(amount));
  u.searchParams.set("slippageBps", String(slippageBps || 100));
  if (platformFeeBps > 0) u.searchParams.set("platformFeeBps", String(platformFeeBps));
  const r = await fetch(u);
  if (!r.ok) throw new Error("quote_failed_" + r.status);
  return r.json();
}

async function getSwapTx({ quoteResponse, userPublicKey, feeAccount }) {
  const body = {
    quoteResponse,
    userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    dynamicSlippage: true,
  };
  if (feeAccount) body.feeAccount = feeAccount;
  const r = await fetch(JUP + "/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("swap_failed_" + r.status);
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "method_not_allowed" }); }
  if (!process.env.SOLANA_RPC) return res.status(503).json({ error: "rpc_not_configured" });

  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {}; }
  catch { return res.status(400).json({ error: "bad_json" }); }
  const { userPublicKey, inputMint, outputMint, amount, slippageBps } = body;
  if (!userPublicKey || !inputMint || !outputMint || !amount) return res.status(400).json({ error: "missing_fields" });

  try {
    const feeBps = await feeBpsFor(userPublicKey);
    const referral = process.env.REFERRAL_ACCOUNT;

    // Derive the platform fee account: ATA of the referral wallet for the OUTPUT mint.
    let feeAccount = null;
    if (referral && feeBps > 0) {
      try {
        feeAccount = ata(outputMint, referral).toBase58();
      } catch { feeAccount = null; }
    }

    // Try with fee; on failure (e.g. fee ATA missing), fall back to a plain swap.
    let swapTx, usedFeeBps = feeAccount ? feeBps : 0;
    try {
      const quote = await getQuote({ inputMint, outputMint, amount, slippageBps, platformFeeBps: feeAccount ? feeBps : 0 });
      const swap = await getSwapTx({ quoteResponse: quote, userPublicKey, feeAccount: feeAccount || undefined });
      swapTx = swap.swapTransaction;
    } catch (e) {
      const quote = await getQuote({ inputMint, outputMint, amount, slippageBps, platformFeeBps: 0 });
      const swap = await getSwapTx({ quoteResponse: quote, userPublicKey });
      swapTx = swap.swapTransaction;
      usedFeeBps = 0;
    }

    return res.status(200).json({ tx: swapTx, feeBps: usedFeeBps });
  } catch (e) {
    return res.status(502).json({ error: "swap_unavailable", detail: String(e.message || e) });
  }
}
