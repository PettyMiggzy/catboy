// $CATBOY AI — credit top-up endpoint (Vercel side).
//   GET  /api/credits?tid&t&h            -> bundles (priced in SOL), live SOL/USD, payTo, message
//   POST /api/credits {tid,t,h,wallet,sig,usdCents,txSig}
//        -> verify the signed link + wallet signature + the SOL payment,
//           then credit the Telegram account and bind wallet<->tid (for rebates).
//
// Credits are accounted internally in USD cents; only the on-ramp is SOL.
//
// Env (Vercel): DATABASE_URL, AI_SECRET (matches the bot),
//   SOLANA_RPC, AI_TREASURY (wallet receiving the SOL top-ups).
//   No provider keys here — this is only payments.
import { neon } from "@neondatabase/serverless";
import { PublicKey } from "@solana/web3.js";
import crypto from "crypto";

const CONN = (process.env.DATABASE_URL || process.env.POSTGRES_URL || "").trim();
const SECRET = (process.env.AI_SECRET || "").trim();
const RPC = (process.env.SOLANA_RPC || "").trim();
const TREASURY = (process.env.AI_TREASURY || "").trim();
const LAMPORTS = 1e9; // lamports per SOL
const WSOL = "So11111111111111111111111111111111111111112"; // wrapped-SOL mint (for the SOL/USD quote)
const LINK_TTL = 20 * 60 * 1000; // 20 min
const MAX_TX_AGE_S = 30 * 60;    // only credit recent payments
const PRICE_TOL = 0.85; // accept >=85% of the USD value in SOL (absorbs price drift between quote and pay)
const BUNDLES = [{ usdCents: 500 }, { usdCents: 1500 }, { usdCents: 5000 }]; // $5 / $15 / $50

const sql = () => { if (!CONN) throw new Error("db_not_configured"); return neon(CONN); };
const hmac = (d) => crypto.createHmac("sha256", SECRET).update(d).digest("hex");
const messageFor = (tid, t) => `$CATBOY AI\nTelegram: ${tid}\nNonce: ${t}\nSign to link your wallet and load credits on catboyonsol.fun — free, no transaction.`;

function linkOk(tid, t, h) {
  if (!SECRET || !tid || !t || !h) return false;
  if (Math.abs(Date.now() - Number(t)) > LINK_TTL) return false;
  try { return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hmac(`${tid}.${t}`))); } catch { return false; }
}
function verifySig(message, wallet, sigB64) {
  try {
    const pub = new PublicKey(wallet).toBytes();
    const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pub)]);
    const key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(message, "utf8"), key, Buffer.from(sigB64, "base64"));
  } catch { return false; }
}
async function rpc(method, params = []) {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message || "rpc_error"); return j.result;
}
// live SOL price in USD (DexScreener) — take the deepest pair where SOL is the base token
async function solPriceUsd() {
  try {
    const r = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + WSOL);
    const j = await r.json();
    const pairs = (j.pairs || []).filter((p) => p.priceUsd && p.baseToken && p.baseToken.address === WSOL);
    if (!pairs.length) return 0;
    pairs.sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0));
    return Number(pairs[0].priceUsd) || 0;
  } catch { return 0; }
}
// confirm the tx moved >= needSol (native SOL) FROM `wallet` INTO the treasury, recently.
// Binding to `wallet` stops anyone from claiming someone else's pending payment.
async function verifyPayment(txSig, needSol, wallet) {
  if (!txSig || typeof txSig !== "string" || txSig.length < 32) return { ok: false, err: "bad_sig" };
  const tx = await rpc("getTransaction", [txSig, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed", commitment: "confirmed" }]);
  if (!tx || !tx.meta) return { ok: false, err: "tx_not_found" };
  if (tx.meta.err) return { ok: false, err: "tx_failed" };
  if (tx.blockTime && (Date.now() / 1000 - tx.blockTime) > MAX_TX_AGE_S) return { ok: false, err: "tx_too_old" };
  const keys = (tx.transaction.message.accountKeys || []).map((k) => (typeof k === "string" ? k : k.pubkey));
  const pre = tx.meta.preBalances || [], post = tx.meta.postBalances || [];
  const need = Math.round(needSol * LAMPORTS);
  const ti = keys.indexOf(TREASURY);
  const recv = ti < 0 ? 0 : Math.max(0, post[ti] - pre[ti]); // treasury's SOL balance went up
  if (recv < need) return { ok: false, err: "underpaid" };
  const bi = keys.indexOf(wallet);
  const paid = bi < 0 ? 0 : Math.max(0, pre[bi] - post[bi]); // signer's SOL balance dropped (they paid)
  if (paid < need) return { ok: false, err: "not_payer" };
  return { ok: true };
}
async function ensure(s) {
  await s`CREATE TABLE IF NOT EXISTS ai_credits (tid TEXT PRIMARY KEY, balance_cents BIGINT NOT NULL DEFAULT 0, spent_cents_month BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE TABLE IF NOT EXISTS ai_topups (sig TEXT PRIMARY KEY, tid TEXT NOT NULL, usd_cents BIGINT NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE TABLE IF NOT EXISTS ai_wallets (wallet TEXT PRIMARY KEY, tid TEXT NOT NULL, linked_at TIMESTAMPTZ DEFAULT now())`;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  try {
    const q = req.method === "GET" ? (req.query || {}) : (typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}));
    const tid = String(q.tid || "").trim(), t = String(q.t || "").trim(), h = String(q.h || "").trim();
    if (!linkOk(tid, t, h)) return res.status(403).json({ ok: false, error: "bad_or_expired_link" });

    const px = await solPriceUsd();
    if (req.method === "GET") {
      const s = sql(); await ensure(s);
      const bal = (await s`SELECT balance_cents FROM ai_credits WHERE tid=${tid}`)[0];
      // per-bundle SOL amounts at the live price (null if price unavailable). Round UP to 4 decimals
      // (0.0001 SOL) so the quoted amount never rounds below the bundle's USD value.
      const bundles = BUNDLES.map((b) => ({ usdCents: b.usdCents, usd: (b.usdCents / 100).toFixed(2), sol: px ? Math.ceil((b.usdCents / 100) / px * 1e4) / 1e4 : null }));
      return res.status(200).json({ ok: true, message: messageFor(tid, t), payTo: TREASURY, priceUsd: px, bundles, balanceCents: bal ? Number(bal.balance_cents) : 0 });
    }
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method" });
    if (!TREASURY || !RPC) return res.status(503).json({ ok: false, error: "not_configured" });

    const wallet = String(q.wallet || "").trim(), sig = String(q.sig || "").trim();
    const txSig = String(q.txSig || "").trim();
    const usdCents = Math.round(Number(q.usdCents) || 0);
    if (!wallet || !sig) return res.status(400).json({ ok: false, error: "missing_wallet_or_sig" });
    if (!BUNDLES.some((b) => b.usdCents === usdCents)) return res.status(400).json({ ok: false, error: "bad_bundle" });
    if (!verifySig(messageFor(tid, t), wallet, sig)) return res.status(401).json({ ok: false, error: "signature_invalid" });
    if (!px) return res.status(503).json({ ok: false, error: "price_unavailable" });

    const s = sql(); await ensure(s);
    // idempotent: this payment already credited?
    if ((await s`SELECT sig FROM ai_topups WHERE sig=${txSig}`).length) {
      const bal = (await s`SELECT balance_cents FROM ai_credits WHERE tid=${tid}`)[0];
      return res.status(200).json({ ok: true, credited: false, balanceCents: bal ? Number(bal.balance_cents) : 0, note: "already_credited" });
    }
    const needSol = (usdCents / 100) / px * PRICE_TOL;
    const pay = await verifyPayment(txSig, needSol, wallet);
    if (!pay.ok) return res.status(402).json({ ok: false, error: "payment_" + pay.err });

    // Atomic idempotency: only the request that actually INSERTs the topup row
    // (xmax=0) credits the account, so concurrent/replayed POSTs can't double-credit.
    const ins = await s`INSERT INTO ai_topups (sig, tid, usd_cents) VALUES (${txSig}, ${tid}, ${usdCents})
                        ON CONFLICT (sig) DO NOTHING RETURNING sig`;
    if (!ins.length) {
      const b0 = (await s`SELECT balance_cents FROM ai_credits WHERE tid=${tid}`)[0];
      return res.status(200).json({ ok: true, credited: false, balanceCents: b0 ? Number(b0.balance_cents) : 0, note: "already_credited" });
    }
    await s`INSERT INTO ai_credits (tid, balance_cents) VALUES (${tid}, ${usdCents})
            ON CONFLICT (tid) DO UPDATE SET balance_cents = ai_credits.balance_cents + ${usdCents}, updated_at=now()`;
    await s`INSERT INTO ai_wallets (wallet, tid) VALUES (${wallet}, ${tid}) ON CONFLICT (wallet) DO UPDATE SET tid=${tid}, linked_at=now()`;
    const bal = (await s`SELECT balance_cents FROM ai_credits WHERE tid=${tid}`)[0];
    return res.status(200).json({ ok: true, credited: true, addedCents: usdCents, balanceCents: Number(bal.balance_cents) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
