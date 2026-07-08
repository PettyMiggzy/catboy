// CATBOY PFP Generator — paid AI PFP generation via Venice (server-side).
//
// The Venice API key NEVER ships to the browser. The flow:
//   1) GET  /api/pfp            -> { feeSol, feeUsd, payTo, model }
//   2) client pays the full feeSol to payTo (one tx)
//   3) POST /api/pfp { prompt, txSig } -> verifies the on-chain payment, then
//      calls Venice with the top model and returns { image: <base64 png> }
//
// Required Vercel env vars (NEVER in client code):
//   VENICE_API_KEY = your Venice inference key
//   SOLANA_RPC     = your private RPC (already used by /api/solrpc)
//   PFP_MODEL      = Venice model id. default nano-banana-pro (top model)
//
// Pricing (dynamic): the fee always covers our cost to generate + gas, then
// doubles it so we profit. It is computed live from the SOL/USD price so the
// markup stays constant as SOL moves:
//     fee(SOL) = (COST_USD * MARKUP + GAS_USD) / SOL_price_USD
//   PFP_COST_USD          = our Venice per-image cost in USD. default 0.18 (nano-banana-pro @1024px)
//   PFP_MARKUP            = multiple of cost to charge. default 2 (=> we keep ~1x as profit)
//   PFP_GAS_USD           = small buffer for network gas/overhead. default 0.02
//   PFP_FEE_FLOOR_SOL     = never charge below this. default 0.003
//   PFP_SOL_PRICE_FALLBACK= used only if the price feed is unreachable. default 80
//   PFP_FEE_SOL           = OPTIONAL hard override; if set, disables dynamic pricing
//
// Note: replay protection here is best-effort (recent-tx window + in-memory
// used-sig cache that resets on cold start). For a high-volume paid service,
// back it with a KV/DB store keyed on txSig.

import { neon } from "@neondatabase/serverless";

const CONN = process.env.DATABASE_URL || process.env.POSTGRES_URL || ""; // durable replay store
const TREASURY = process.env.PFP_TREASURY || "3DHwgk2T3tGxQRfD3p897eq1UV9rwvw1JNWa2rS3RdKw"; // 90% dev
const OVERHEAD = process.env.PFP_OVERHEAD || "EK8YS2haXFtKJ61phggC39m9RAG16B3NMx59uyMkP1PC"; // 10% ops
const MODEL = process.env.PFP_MODEL || "nano-banana-pro";
const MAX_TX_AGE_S = 15 * 60;

// Every PFP stays on-brand: Catboy is always the reference character, and the
// user's prompt is treated as customization (outfit / theme / background) on top.
// (Venice's image endpoint can't take a reference image, so we anchor identity
// in the prompt.) Tunable via PFP_CHARACTER.
const CHARACTER = process.env.PFP_CHARACTER ||
  "The character is CATBOY, the mascot — a young male anime hero with spiky blonde hair, black cat ears, a long black cat tail, and glowing cyan cat-like eyes, in a neon cyberpunk Solana aesthetic. Always keep these Catboy features recognizable.";

// --- Dynamic pricing: cover cost to generate + gas, then charge double so we profit.
const COST_USD = parseFloat(process.env.PFP_COST_USD || "0.18");
const MARKUP = parseFloat(process.env.PFP_MARKUP || "2");
const GAS_USD = parseFloat(process.env.PFP_GAS_USD || "0.02");
const FEE_FLOOR_SOL = parseFloat(process.env.PFP_FEE_FLOOR_SOL || "0.003");
const SOL_PRICE_FALLBACK = parseFloat(process.env.PFP_SOL_PRICE_FALLBACK || "80");
const FEE_SOL_OVERRIDE = process.env.PFP_FEE_SOL ? parseFloat(process.env.PFP_FEE_SOL) : null;

let _price = { usd: 0, at: 0 };
async function solPriceUsd() {
  if (_price.usd > 0 && Date.now() - _price.at < 5 * 60 * 1000) return _price.usd; // 5-min cache
  const sources = [
    ["https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", (j) => j && j.solana && j.solana.usd],
    ["https://price.jup.ag/v6/price?ids=SOL", (j) => j && j.data && j.data.SOL && j.data.SOL.price],
  ];
  for (const [url, pick] of sources) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      if (!r.ok) continue;
      const p = pick(await r.json());
      if (p && p > 0) { _price = { usd: p, at: Date.now() }; return p; }
    } catch (_) {}
  }
  return _price.usd || SOL_PRICE_FALLBACK;
}
async function computeFeeSol() {
  if (FEE_SOL_OVERRIDE != null) return FEE_SOL_OVERRIDE;
  const price = await solPriceUsd();
  const usd = COST_USD * MARKUP + GAS_USD;
  const sol = Math.max(usd / price, FEE_FLOOR_SOL);
  return Math.ceil(sol * 1e6) / 1e6; // round up to whole micro-SOL
}

const usedSigs = new Set(); // in-memory fallback if no DB is configured

// Atomically claim a payment signature as single-use. With a DB this is durable
// across instances/cold starts (real replay protection); without one it degrades
// to a best-effort per-instance guard.
async function claimSig(sig) {
  if (CONN) {
    const sql = neon(CONN);
    await sql`CREATE TABLE IF NOT EXISTS pfp_used_sigs (sig TEXT PRIMARY KEY, used_at TIMESTAMPTZ DEFAULT now())`;
    const rows = await sql`INSERT INTO pfp_used_sigs (sig) VALUES (${sig}) ON CONFLICT (sig) DO NOTHING RETURNING sig`;
    return rows.length > 0;
  }
  if (usedSigs.has(sig)) return false;
  usedSigs.add(sig);
  return true;
}

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

// verify txSig paid at least the fee to our wallet, recently, confirmed, and FROM `payer`
async function verifyPayment(txSig, payer) {
  if (!txSig || typeof txSig !== "string" || txSig.length < 32) return "bad_sig";
  if (usedSigs.has(txSig)) return "already_used";
  // The client waits for 'confirmed' before posting; getTransaction defaults to
  // 'finalized' (~13s later) and would miss it, so query at 'confirmed' and
  // retry briefly to absorb RPC propagation lag.
  let tx = null;
  for (let i = 0; i < 8; i++) {
    tx = await rpc("getTransaction", [txSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]);
    if (tx) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!tx) return "tx_not_found";
  if (tx.meta && tx.meta.err) return "tx_failed";
  if (tx.blockTime && (Date.now() / 1000 - tx.blockTime) > MAX_TX_AGE_S) return "tx_too_old";
  const keys = (tx.transaction.message.accountKeys || []).map((k) => (typeof k === "string" ? k : k.pubkey));
  const pre = tx.meta.preBalances || [], post = tx.meta.postBalances || [];
  const recv = (addr) => { const i = keys.indexOf(addr); return i < 0 ? 0 : Math.max(0, post[i] - pre[i]); };
  const total = recv(OVERHEAD); // full fee to the ops wallet (no split)
  const feeSol = await computeFeeSol();
  // Require at least 85% of the quoted fee. This absorbs SOL price drift between
  // the client's quote and payment, while staying above our 1x generation cost,
  // so a legit payer is never rejected and we never lose money on a sale.
  const minLamports = Math.round(feeSol * 0.85 * 1e9);
  if (total < minLamports) return "underpaid";
  // Bind to the payer: their SOL balance must have dropped by ~fee in this same tx, so an
  // attacker can't front-run a stranger's payment to get a free generation on their dime.
  const pidx = payer ? keys.indexOf(payer) : -1;
  const paid = pidx < 0 ? 0 : Math.max(0, pre[pidx] - post[pidx]);
  if (paid < minLamports) return "payer_mismatch";
  // Consume the signature exactly once (durable) before we generate anything.
  if (!(await claimSig(txSig))) return "already_used";
  return "ok";
}

// The full Venice key looks like "VENICE_INFERENCE_KEY_<rest>" — the prefix words
// are PART of the key. In the dashboard it may be stored either as the whole
// value, or split so "VENICE_INFERENCE_KEY_" is the variable NAME and the rest is
// the value. Resolve the complete key in either case.
const VK_PREFIX = "VENICE_INFERENCE_KEY_";
function veniceKey() {
  const direct = process.env.VENICE_API_KEY || process.env.VENICE_KEY || process.env.VENICE_INFERENCE_KEY || process.env.VENICE;
  const venice = Object.entries(process.env).filter(([n, v]) => /^VENICE/i.test(n) && v);
  // 1) a value that is already the complete key
  for (const [, v] of venice) if (v.startsWith(VK_PREFIX)) return v;
  if (direct && direct.startsWith(VK_PREFIX)) return direct;
  // 2) split as name (VENICE_INFERENCE_KEY_) + value (the rest)
  for (const [n, v] of venice) if (/^VENICE_INFERENCE_KEY_*$/i.test(n)) return VK_PREFIX + v;
  // 3) fall back to whatever VENICE* value exists
  if (venice.length) return venice[0][1];
  return direct || "";
}

async function venice(prompt) {
  const key = veniceKey();
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

// Payment verification (a few RPC retries) + image generation (~10-20s) can run
// well past the default 10s limit, which would kill it mid-generation.
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method === "GET") {
    const feeSol = await computeFeeSol();
    const feeUsd = Math.round((COST_USD * MARKUP + GAS_USD) * 100) / 100;
    return res.status(200).json({ feeSol, feeUsd, payTo: OVERHEAD, model: MODEL });
  }
  if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "method_not_allowed" }); }

  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    let prompt = (b.prompt || "").toString().trim().slice(0, 500);
    const txSig = (b.txSig || "").toString().trim();
    if (!prompt) return res.status(400).json({ error: "empty_prompt" });
    if (BANNED.test(prompt)) return res.status(400).json({ error: "prompt_not_allowed" });

    const payer = (b.payer || "").toString().trim();
    const v = await verifyPayment(txSig, payer);
    if (v !== "ok") return res.status(402).json({ error: "payment_" + v });

    // Anchor the Catboy identity, then apply the user's prompt as customization.
    const full = CHARACTER + " Customization: " + prompt +
      ". High quality anime profile picture, clean square PFP, centered head-and-shoulders portrait, detailed, vibrant neon lighting, safe for work, no text, no watermark.";
    const image = await venice(full);
    return res.status(200).json({ image, model: MODEL });
  } catch (e) {
    return res.status(502).json({ error: (e && e.message) || "generate_failed" });
  }
}
