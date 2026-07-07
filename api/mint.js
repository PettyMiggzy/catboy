// CATBOY NFT mint — our own code, non-launchpad, custodial mint-on-demand.
//
// Flow (mirrors the PFP generator's trust model):
//   1) GET  /api/mint                       -> { payTo, packs, minted, total, tiers }
//   2) client pays pack.priceSol to `payTo` (one tx), gets txSig
//   3) POST /api/mint { pack, txSig, buyer } -> verifies the on-chain payment,
//      rolls a rarity by the pack's odds, atomically claims an unminted NFT of
//      that tier, and mints a Metaplex **Core** NFT straight to the buyer.
//
// Why this shape:
//   - Payment is verified on-chain (no free-mint bypass like a client-only flow).
//   - Tiered packs get REAL different odds (the server picks the tier) — a plain
//     Candy Machine can't do that.
//   - Metaplex Core = ~0.0029 SOL rent per NFT, minted only when sold, recovered
//     from the price. Cheap. Uses the existing Vercel + Neon stack.
//   - Idempotent by txSig: a retry (or double-click) never double-mints or
//     double-charges — it resumes/returns the same NFT.
//
// Required Vercel env (NEVER in client code):
//   DATABASE_URL / POSTGRES_URL  Neon connection (inventory + orders)
//   SOLANA_RPC                   full RPC url (also used by /api/solrpc)
//   NFT_MINT_WALLET              PUBLIC key buyers pay to (the mint/treasury wallet)
//   NFT_COLLECTION               Nine Lives Core collection address (create-collection.mjs)
//   NFT_COLLECTION_GENESIS       Genesis Core collection address (optional, when live)
//   NFT_COLLECTION_PRIDE         Pride Core collection address (optional, when live)
//   NFT_MINT_SECRET              JSON array secret key (id.json) of the mint authority
//                                — a DEDICATED low-value wallet, funded with ~1 SOL
//   SITE_URL                     e.g. https://www.catboyonsol.fun
//
// Setup once (see MINT.md): fund the mint wallet, run scripts/create-collection.mjs
// and scripts/seed-inventory.mjs, then set the env vars. TEST ON DEVNET FIRST.

import { neon } from "@neondatabase/serverless";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { keypairIdentity, generateSigner, publicKey } from "@metaplex-foundation/umi";
import { create, fetchCollection, mplCore } from "@metaplex-foundation/mpl-core";
import { tgAnnounce, esc } from "./_tg.js";

const SITE = (process.env.SITE_URL || "https://www.catboyonsol.fun").trim();
const TIER_EMOJI = { Common: "🐾", Rare: "💫", Epic: "🔥", Legendary: "👑", Pride: "🏳️‍🌈" };
const COLL_LABEL = { nine: "Nine Lives", genesis: "Genesis", pride: "Pride", resurrection: "OG Resurrection" };

export const config = { maxDuration: 60 };

const CONN = (process.env.DATABASE_URL || process.env.POSTGRES_URL || "").trim();
const RPC = (process.env.SOLANA_RPC || "").trim();
const MINT_WALLET = (process.env.NFT_MINT_WALLET || "").trim();
const MINT_SECRET = (process.env.NFT_MINT_SECRET || "").trim();
const MAX_TX_AGE_S = 20 * 60;
const PRICE_TOLERANCE = 0.97; // accept >=97% of quoted price (absorbs SOL drift)

// On-chain Core collection address per collection key (from env).
const COLL = {
  nine:    (process.env.NFT_COLLECTION || "").trim(),
  genesis: (process.env.NFT_COLLECTION_GENESIS || "").trim(),
  pride:   (process.env.NFT_COLLECTION_PRIDE || "").trim(),
  resurrection: (process.env.NFT_COLLECTION_RESURRECTION || "").trim(),
};

// Price + odds live server-side so the client can't tamper. Each pack maps to a
// collection (coll) + its own inventory subset + on-chain collection address.
const PACKS = {
  standard: { coll: "nine", name: "Standard Pack", priceSol: 1,    odds: { Common: 65, Rare: 24, Epic: 9,  Legendary: 2 } },
  rare:     { coll: "nine", name: "Rare Pack",     priceSol: 1.5,  odds: { Common: 45, Rare: 35, Epic: 16, Legendary: 4 } },
  elite:    { coll: "nine", name: "Elite Pack",    priceSol: 2,    odds: { Common: 25, Rare: 40, Epic: 27, Legendary: 8 } },
  genesis:  { coll: "genesis", name: "Genesis Pack", priceSol: 2,   odds: { Common: 60, Rare: 25, Epic: 12, Legendary: 3 } },
  pride:    { coll: "pride",   name: "Pride Pack",   priceSol: 1.5, odds: { Pride: 100 } },
  // OG Resurrection — 50 animated one-of-ones. Standard can pull commons; Elite never does.
  resstd:   { coll: "resurrection", name: "Resurrection Pack",      priceSol: 0.25, odds: { Common: 60, Rare: 24, Epic: 10, Legendary: 6 } },
  reselite: { coll: "resurrection", name: "Resurrection Elite Pack", priceSol: 0.5,  odds: { Rare: 60, Epic: 25, Legendary: 15 } },
  // legacy aliases (= nine Standard) so old links / the casino don't 400
  random:    { coll: "nine", name: "Standard Pack", priceSol: 1, odds: { Common: 65, Rare: 24, Epic: 9, Legendary: 2 } },
  alley:     { coll: "nine", name: "Standard Pack", priceSol: 1, odds: { Common: 65, Rare: 24, Epic: 9, Legendary: 2 } },
  ninelives: { coll: "nine", name: "Standard Pack", priceSol: 1, odds: { Common: 65, Rare: 24, Epic: 9, Legendary: 2 } },
  alpha:     { coll: "nine", name: "Standard Pack", priceSol: 1, odds: { Common: 65, Rare: 24, Epic: 9, Legendary: 2 } },
};

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function sql() { if (!CONN) throw new Error("db_not_configured"); return neon(CONN); }

async function rpc(method, params = []) {
  if (!RPC) throw new Error("rpc_not_configured");
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc_error");
  return j.result;
}

async function ensureTables() {
  const s = sql();
  await s`CREATE TABLE IF NOT EXISTS nft_inventory (
    id INT PRIMARY KEY, tier TEXT NOT NULL, name TEXT NOT NULL, uri TEXT NOT NULL,
    image TEXT, minted BOOLEAN DEFAULT false, asset TEXT,
    collection TEXT NOT NULL DEFAULT 'nine' )`;
  await s`CREATE TABLE IF NOT EXISTS nft_orders (
    sig TEXT PRIMARY KEY, pack TEXT, buyer TEXT, item_id INT, tier TEXT,
    status TEXT DEFAULT 'pending', asset TEXT, collection TEXT DEFAULT 'nine',
    created_at TIMESTAMPTZ DEFAULT now() )`;
}

// Verify the buyer paid at least the pack price to MINT_WALLET, recently, confirmed.
async function verifyPayment(txSig, priceSol) {
  if (!txSig || typeof txSig !== "string" || txSig.length < 32) return { ok: false, err: "bad_sig" };
  let tx = null;
  for (let i = 0; i < 8; i++) {
    tx = await rpc("getTransaction", [txSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]);
    if (tx) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!tx) return { ok: false, err: "tx_not_found" };
  if (tx.meta && tx.meta.err) return { ok: false, err: "tx_failed" };
  if (tx.blockTime && (Date.now() / 1000 - tx.blockTime) > MAX_TX_AGE_S) return { ok: false, err: "tx_too_old" };
  const keys = (tx.transaction.message.accountKeys || []).map((k) => (typeof k === "string" ? k : k.pubkey));
  const pre = tx.meta.preBalances || [], post = tx.meta.postBalances || [];
  const i = keys.indexOf(MINT_WALLET);
  const recv = i < 0 ? 0 : Math.max(0, post[i] - pre[i]);
  if (recv < Math.round(priceSol * PRICE_TOLERANCE * 1e9)) return { ok: false, err: "underpaid" };
  return { ok: true };
}

function rollTier(odds, availableTiers) {
  const entries = Object.entries(odds).filter(([t, w]) => availableTiers.includes(t) && w > 0);
  if (!entries.length) return null;
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let r = Math.random() * total;
  for (const [t, w] of entries) if ((r -= w) <= 0) return t;
  return entries[entries.length - 1][0];
}

let _umi = null;
function getUmi() {
  if (_umi) return _umi;
  const secret = new Uint8Array(JSON.parse(MINT_SECRET));
  const umi = createUmi(RPC).use(mplCore());
  umi.use(keypairIdentity(umi.eddsa.createKeypairFromSecretKey(secret)));
  _umi = umi;
  return umi;
}

async function mintTo(buyer, item, collAddr) {
  const umi = getUmi();
  const asset = generateSigner(umi);
  const collection = await fetchCollection(umi, publicKey(collAddr));
  await create(umi, { asset, collection, name: item.name, uri: item.uri, owner: publicKey(buyer) }).sendAndConfirm(umi);
  return asset.publicKey.toString();
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      await ensureTables();
      const s = sql();
      const tiers = await s`SELECT collection, tier, COUNT(*) FILTER (WHERE NOT minted)::int AS remaining, COUNT(*)::int AS total FROM nft_inventory GROUP BY collection, tier`;
      const byColl = await s`SELECT collection, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE minted)::int AS minted FROM nft_inventory GROUP BY collection`;
      const minted = (await s`SELECT COUNT(*)::int AS n FROM nft_inventory WHERE minted`)[0].n;
      const total = (await s`SELECT COUNT(*)::int AS n FROM nft_inventory`)[0].n;
      // Which specific pieces are sold, as manifest display numbers (strip the
      // per-collection id offset), so the marketplace can stamp them SOLD.
      const OFFSET = { nine: 0, genesis: 1000, pride: 2000 };
      const mintedRows = await s`SELECT collection, id, asset FROM nft_inventory WHERE minted`;
      const mintedIds = { nine: [], genesis: [], pride: [] };
      const mintedAssets = { nine: {}, genesis: {}, pride: {} }; // display# -> on-chain asset (for secondary-market links)
      for (const r of mintedRows) {
        const off = OFFSET[r.collection] || 0; const num = r.id - off;
        (mintedIds[r.collection] || (mintedIds[r.collection] = [])).push(num);
        if (r.asset) (mintedAssets[r.collection] || (mintedAssets[r.collection] = {}))[num] = r.asset;
      }
      // Only advertise packs whose collection is deployed on-chain AND stocked.
      const stocked = new Set(byColl.filter((c) => c.total > c.minted).map((c) => c.collection));
      const packs = Object.entries(PACKS)
        .filter(([, p]) => COLL[p.coll] && stocked.has(p.coll))
        .map(([id, p]) => ({ id, name: p.name, priceSol: p.priceSol, odds: p.odds, coll: p.coll }));
      return res.status(200).json({ payTo: MINT_WALLET, packs, minted, total, tiers, collections: byColl, mintedIds, mintedAssets });
    }
    if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "method_not_allowed" }); }
    if (!CONN || !RPC || !MINT_WALLET || !MINT_SECRET) return res.status(500).json({ error: "mint_not_configured" });

    const { pack, txSig, buyer } = req.body || {};
    const P = PACKS[pack];
    if (!P) return res.status(400).json({ error: "bad_pack" });
    const collAddr = COLL[P.coll];
    if (!collAddr) return res.status(503).json({ error: "collection_not_live" });
    if (!B58.test(buyer || "")) return res.status(400).json({ error: "bad_buyer" });
    if (!txSig || typeof txSig !== "string" || txSig.length < 32) return res.status(400).json({ error: "bad_sig" });
    await ensureTables();
    const s = sql();

    // Idempotent by txSig: already fully minted -> return that same NFT.
    let order = (await s`SELECT * FROM nft_orders WHERE sig=${txSig}`)[0];
    if (order && order.status === "minted") {
      const it = (await s`SELECT * FROM nft_inventory WHERE id=${order.item_id}`)[0];
      return res.status(200).json({ ok: true, asset: order.asset, name: it.name, image: it.image, tier: order.tier, reused: true });
    }

    // First time for this sig: verify payment, then claim the sig (unique row).
    if (!order) {
      const v = await verifyPayment(txSig, P.priceSol);
      if (!v.ok) return res.status(402).json({ error: "payment_" + v.err });
      await s`INSERT INTO nft_orders (sig, pack, buyer, collection) VALUES (${txSig},${pack},${buyer},${P.coll}) ON CONFLICT (sig) DO NOTHING`;
      order = (await s`SELECT * FROM nft_orders WHERE sig=${txSig}`)[0];
    }

    // Assign an NFT to this order (once). Race-safe: only the request that wins
    // the `item_id IS NULL` update keeps its claimed item; a loser releases it.
    let item;
    if (order.item_id) {
      item = (await s`SELECT * FROM nft_inventory WHERE id=${order.item_id}`)[0];
    } else {
      const avail = await s`SELECT tier, COUNT(*)::int AS n FROM nft_inventory WHERE NOT minted AND collection=${P.coll} GROUP BY tier`;
      const availableTiers = avail.filter((r) => r.n > 0).map((r) => r.tier);
      if (!availableTiers.length) return res.status(409).json({ error: "sold_out" });
      const tier = rollTier(P.odds, availableTiers) || availableTiers[0];
      let claimed = await s`UPDATE nft_inventory SET minted=true WHERE id=(SELECT id FROM nft_inventory WHERE NOT minted AND collection=${P.coll} AND tier=${tier} ORDER BY random() LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`;
      if (!claimed.length) claimed = await s`UPDATE nft_inventory SET minted=true WHERE id=(SELECT id FROM nft_inventory WHERE NOT minted AND collection=${P.coll} ORDER BY random() LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`;
      if (!claimed.length) return res.status(409).json({ error: "sold_out" });
      item = claimed[0];
      const won = await s`UPDATE nft_orders SET item_id=${item.id}, tier=${item.tier} WHERE sig=${txSig} AND item_id IS NULL RETURNING item_id`;
      if (!won.length) { // another request already assigned an item to this sig — release ours
        await s`UPDATE nft_inventory SET minted=false WHERE id=${item.id}`;
        order = (await s`SELECT * FROM nft_orders WHERE sig=${txSig}`)[0];
        item = (await s`SELECT * FROM nft_inventory WHERE id=${order.item_id}`)[0];
      }
    }

    // Mint on-chain to the buyer. On failure, leave the order pending + item
    // claimed so a retry with the same txSig resumes (no re-charge, no dup).
    let asset;
    try { asset = await mintTo(buyer, item, collAddr); }
    catch (e) { return res.status(502).json({ error: "mint_failed", detail: String(e.message || e) }); }
    await s`UPDATE nft_orders SET status='minted', asset=${asset} WHERE sig=${txSig}`;
    await s`UPDATE nft_inventory SET asset=${asset} WHERE id=${item.id}`;
    // Announce the sale to the channel (never let this break the mint response).
    const em = TIER_EMOJI[item.tier] || "🐾";
    const legend = /legend/i.test(item.tier || "") ? " — a LEGENDARY pull! 🎉" : "";
    await tgAnnounce(
      `${em} <b>NEW CATBOY MINTED!</b>${legend}\n` +
      `<b>${esc(item.name)}</b> · ${em} <b>${esc(item.tier)}</b>\n` +
      `From the <b>${esc(COLL_LABEL[P.coll] || P.coll)}</b> collection · ${P.priceSol} SOL\n\n` +
      `🛒 <a href="${SITE}/market.html">View the collection</a> · <a href="${SITE}/mint.html">Mint yours 🐾</a>`
    );
    return res.status(200).json({ ok: true, asset, name: item.name, image: item.image, tier: item.tier });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
