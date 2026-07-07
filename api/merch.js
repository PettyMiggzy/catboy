// $CATBOY merch — order endpoint.
//   GET  /api/merch                 -> { ready, payTo, decimals, holderDiscountPct }
//   POST /api/merch { productId, option, qty, txSig, buyer, ship }
//        -> verifies the buyer sent >= price in $CATBOY to the treasury, then
//           creates a Printful order and returns { ok, orderId }.
//
// Env:
//   SOLANA_RPC        RPC url (payment verification)
//   TOKEN_MINT        $CATBOY mint (Token-2022)
//   MERCH_TREASURY    wallet that receives $CATBOY payments (owner pubkey)
//   MERCH_DECIMALS    $CATBOY decimals (default 6)
//   PRINTFUL_API_KEY  Printful API token (fulfillment)
//   SITE_URL          public base for design files (default https://www.catboyonsol.fun)
//   DATABASE_URL      optional — dedupes used payment signatures
import { neon } from "@neondatabase/serverless";

const RPC = (process.env.SOLANA_RPC || "").trim();
const MINT = (process.env.TOKEN_MINT || "3UCdpV5mTb4TmJSCyPkaAsuUFvaF4ofc2uXCEj3Jpump").trim();
const TREASURY = (process.env.MERCH_TREASURY || "").trim();
const DECIMALS = parseInt(process.env.MERCH_DECIMALS || "6", 10);
const PRINTFUL = (process.env.PRINTFUL_API_KEY || "").trim();
const SITE = (process.env.SITE_URL || "https://www.catboyonsol.fun").replace(/\/$/, "");
const CONN = (process.env.DATABASE_URL || process.env.POSTGRES_URL || "").trim();
// Holder discount tiers — verified on-chain at checkout (authoritative).
const HOLDER_PCT = Math.max(0, Math.min(90, parseInt(process.env.MERCH_HOLDER_PCT || "10", 10)));  // any Catboy
const ELITE_PCT = Math.max(0, Math.min(90, parseInt(process.env.MERCH_ELITE_PCT || "20", 10)));    // Genesis / Pride
const COLLECTIONS = {
  nine: "33kxQv4Jo7u9edC4RipZckwkpRRdxg863b6cw2UGfh6S",
  genesis: "HuLA9RRuG6s994eAiiY4cFhrhghCkCQWcNdm3e3wVD3x",
  pride: "4N1d9umoscMYiwiqxXnkTbJD9pXLMZiPCw4H7fAUK93x",
};
// On-chain (DAS) holder tier for a wallet -> discount %. Elite = Genesis/Pride.
async function holderPct(wallet) {
  if (!wallet || !RPC) return { pct: 0, tier: "none" };
  try {
    const r = await rpc("getAssetsByOwner", { ownerAddress: wallet, page: 1, limit: 1000 });
    let elite = false, holder = false;
    for (const a of (r?.items || [])) {
      const g = (a.grouping || []).find((x) => x.group_key === "collection");
      if (!g) continue;
      if (g.group_value === COLLECTIONS.genesis || g.group_value === COLLECTIONS.pride) elite = true;
      else if (g.group_value === COLLECTIONS.nine) holder = true;
    }
    return elite ? { pct: ELITE_PCT, tier: "elite" } : holder ? { pct: HOLDER_PCT, tier: "holder" } : { pct: 0, tier: "none" };
  } catch { return { pct: 0, tier: "none" }; }
}

// Server-side catalog = source of truth for price + Printful variant ids.
// Fill `variants` with real Printful catalog variant ids (per option) once your
// products exist in Printful; until then the store reports not-ready for order.
const PRODUCTS = {
  "tee-classic":   { price: 5000000,  design: "assets/merch/classic.png",   variants: { S: 0, M: 0, L: 0, XL: 0, "2XL": 0 } },
  "tee-dragon":    { price: 6000000,  design: "assets/merch/dragon.png",    variants: { S: 0, M: 0, L: 0, XL: 0, "2XL": 0 } },
  "tee-nine":      { price: 5000000,  design: "assets/merch/ninelives.png", variants: { S: 0, M: 0, L: 0, XL: 0, "2XL": 0 } },
  "hoodie-dragon": { price: 12000000, design: "assets/merch/dragon.png",    variants: { S: 0, M: 0, L: 0, XL: 0, "2XL": 0 } },
  "hoodie-nine":   { price: 12000000, design: "assets/merch/ninelives.png", variants: { S: 0, M: 0, L: 0, XL: 0, "2XL": 0 } },
  "mug-classic":   { price: 3000000,  design: "assets/merch/classic.png",   variants: { "11oz": 0, "15oz": 0 } },
  "poster-nine":   { price: 4000000,  design: "assets/merch/ninelives.png", variants: { "12×18": 0, "18×24": 0 } },
  "poster-dragon": { price: 4000000,  design: "assets/merch/dragon.png",    variants: { "12×18": 0, "18×24": 0 } },
};

const sql = () => (CONN ? neon(CONN) : null);
async function rpc(method, params = []) {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc_error");
  return j.result;
}

// Confirm the tx moved >= `needTokens` of $CATBOY into the treasury's token account.
async function verifyPayment(txSig, needTokens) {
  if (!txSig || typeof txSig !== "string" || txSig.length < 32) return { ok: false, err: "bad_sig" };
  const tx = await rpc("getTransaction", [txSig, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed", commitment: "confirmed" }]);
  if (!tx || !tx.meta) return { ok: false, err: "tx_not_found" };
  if (tx.meta.err) return { ok: false, err: "tx_failed" };
  const pre = tx.meta.preTokenBalances || [];
  const post = tx.meta.postTokenBalances || [];
  const key = (b) => `${b.owner}:${b.mint}`;
  const preMap = new Map(pre.map((b) => [key(b), Number(b.uiTokenAmount.amount)]));
  let delta = 0;
  for (const b of post) {
    if (b.owner === TREASURY && b.mint === MINT) {
      const before = preMap.get(key(b)) || 0;
      delta += Number(b.uiTokenAmount.amount) - before;
    }
  }
  const needRaw = BigInt(Math.round(needTokens)) * (10n ** BigInt(DECIMALS));
  if (BigInt(Math.round(delta)) < needRaw) return { ok: false, err: "underpaid" };
  return { ok: true };
}

async function printfulOrder({ variantId, qty, designUrl, ship }) {
  const body = {
    recipient: {
      name: ship.name, address1: ship.address1, city: ship.city,
      state_code: ship.state || "", country_code: ship.country || "US",
      zip: ship.zip, email: ship.email || "",
    },
    items: [{ variant_id: variantId, quantity: qty, files: [{ url: designUrl }] }],
  };
  const r = await fetch("https://api.printful.com/orders", {
    method: "POST", headers: { "Authorization": "Bearer " + PRINTFUL, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.result) throw new Error((j && j.error && j.error.message) || ("printful_" + r.status));
  return j.result.id;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  const ready = !!(RPC && TREASURY && PRINTFUL);
  if (req.method === "GET") {
    return res.status(200).json({ ready, payTo: TREASURY, decimals: DECIMALS, holderPct: HOLDER_PCT, elitePct: ELITE_PCT });
  }
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method" });
  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { productId, option, qty = 1, txSig, buyer, ship } = b;
    const p = PRODUCTS[productId];
    if (!p) return res.status(400).json({ ok: false, error: "unknown_product" });
    if (!p.variants || !(option in p.variants)) return res.status(400).json({ ok: false, error: "bad_option" });
    const variantId = p.variants[option];
    if (!variantId) return res.status(503).json({ ok: false, error: "product_not_wired_in_printful" });
    if (!ship || !ship.name || !ship.address1 || !ship.city || !ship.zip) return res.status(400).json({ ok: false, error: "bad_shipping" });
    const q = Math.max(1, Math.min(20, parseInt(qty, 10) || 1));
    if (!ready) return res.status(503).json({ ok: false, error: "store_not_configured" });

    // one payment can't be reused for multiple orders
    const s = sql();
    if (s) {
      await s`CREATE TABLE IF NOT EXISTS merch_orders (sig TEXT PRIMARY KEY, product TEXT, buyer TEXT, printful_id TEXT, created_at TIMESTAMPTZ DEFAULT now())`;
      const dup = await s`SELECT sig FROM merch_orders WHERE sig=${txSig}`;
      if (dup.length) return res.status(409).json({ ok: false, error: "payment_already_used" });
    }

    // Holder discount — verified from the payer's on-chain NFTs (authoritative).
    const disc = await holderPct(buyer);
    const need = Math.ceil(p.price * q * (1 - disc.pct / 100));
    const pay = await verifyPayment(txSig, need);
    if (!pay.ok) return res.status(402).json({ ok: false, error: pay.err });

    const designUrl = /^https?:/.test(p.design) ? p.design : `${SITE}/${p.design}`;
    const orderId = await printfulOrder({ variantId, qty: q, designUrl, ship });
    if (s) await s`INSERT INTO merch_orders (sig, product, buyer, printful_id) VALUES (${txSig}, ${productId}, ${buyer || ""}, ${String(orderId)}) ON CONFLICT (sig) DO NOTHING`;
    return res.status(200).json({ ok: true, orderId });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
