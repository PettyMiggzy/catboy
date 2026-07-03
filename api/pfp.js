// CATBOY PFP Generator — paid AI PFP generation via Venice (server-side).
//
// The Venice API key NEVER ships to the browser. The flow:
//   1) GET  /api/pfp            -> { feeSol, treasury, overhead, model }
//   2) client pays feeSol, split 90/10 to treasury/overhead (one tx)
//   3) POST /api/pfp { prompt, txSig } -> verifies the on-chain payment, then
//      calls Venice with the top model and returns { image: <base64 png> }
//
// Required Vercel env vars (NEVER in client code):
//   VENICE_API_KEY = your Venice inference key
//   SOLANA_RPC     = your private RPC (already used by /api/solrpc)
//   PFP_FEE_SOL    = price per PFP in SOL (set to ~2x your Venice per-image cost). default 0.02
//   PFP_MODEL      = Venice model id. default nano-banana-pro (top model)
//
// Note: replay protection here is best-effort (recent-tx window + in-memory
// used-sig cache that resets on cold start). For a high-volume paid service,
// back it with a KV/DB store keyed on txSig.

const TREASURY = process.env.PFP_TREASURY || "3DHwgk2T3tGxQRfD3p897eq1UV9rwvw1JNWa2rS3RdKw"; // 90% dev
const OVERHEAD = process.env.PFP_OVERHEAD || "EK8YS2haXFtKJ61phggC39m9RAG16B3NMx59uyMkP1PC"; // 10% ops
const FEE_SOL = parseFloat(process.env.PFP_FEE_SOL || "0.02");
const MODEL = process.env.PFP_MODEL || "nano-banana-pro";
const MAX_TX_AGE_S = 15 * 60;

const usedSigs = new Set(); // best-effort replay guard (per warm instance)

const BANNED = /\b(nude|naked|nsfw|sex|sexual|porn|explicit|hentai|nipple|genital|underage|child|loli|shota|rape|gore)\b/i;

async function rpc(method, params = []) {
  const url = process.env.SOLANA_RPC;
  if (!url) throw new Error("rpc_not_configured");
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc_error");
  return j.result;
}

// verify txSig paid at least FEE_SOL to treasury+overhead, recently, confirmed
async function verifyPayment(txSig) {
  if (!txSig || typeof txSig !== "string" || txSig.length < 32) return "bad_sig";
  if (usedSigs.has(txSig)) return "already_used";
  const tx = await rpc("getTransaction", [txSig, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]);
  if (!tx) return "tx_not_found";
  if (tx.meta && tx.meta.err) return "tx_failed";
  if (tx.blockTime && (Date.now() / 1000 - tx.blockTime) > MAX_TX_AGE_S) return "tx_too_old";
  const keys = (tx.transaction.message.accountKeys || []).map((k) => (typeof k === "string" ? k : k.pubkey));
  const pre = tx.meta.preBalances || [], post = tx.meta.postBalances || [];
  const recv = (addr) => { const i = keys.indexOf(addr); return i < 0 ? 0 : Math.max(0, post[i] - pre[i]); };
  const total = recv(TREASURY) + recv(OVERHEAD);
  const feeLamports = Math.round(FEE_SOL * 1e9);
  if (total < feeLamports - 5000) return "underpaid";     // small tolerance
  usedSigs.add(txSig);
  return "ok";
}

async function venice(prompt) {
  const key = process.env.VENICE_API_KEY || process.env.VENICE_KEY || process.env.VENICE_INFERENCE_KEY || process.env.VENICE;
  if (!key) throw new Error("venice_not_configured");
  const body = { model: MODEL, prompt, width: 1024, height: 1024, format: "png", return_binary: false };
  const r = await fetch("https://api.venice.ai/api/v1/image/generate", {
    method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.images || !j.images[0]) throw new Error((j && j.error) || "venice_failed_" + r.status);
  return j.images[0];
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ feeSol: FEE_SOL, treasury: TREASURY, overhead: OVERHEAD, model: MODEL });
  }
  if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "method_not_allowed" }); }

  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    let prompt = (b.prompt || "").toString().trim().slice(0, 500);
    const txSig = (b.txSig || "").toString().trim();
    if (!prompt) return res.status(400).json({ error: "empty_prompt" });
    if (BANNED.test(prompt)) return res.status(400).json({ error: "prompt_not_allowed" });

    const v = await verifyPayment(txSig);
    if (v !== "ok") return res.status(402).json({ error: "payment_" + v });

    // style guardrails: keep it a clean, high-quality PFP
    const full = prompt + ". High quality profile picture, clean square PFP, centered portrait, detailed, vibrant, safe for work, no text, no watermark.";
    const image = await venice(full);
    return res.status(200).json({ image, model: MODEL });
  } catch (e) {
    return res.status(502).json({ error: (e && e.message) || "generate_failed" });
  }
}
