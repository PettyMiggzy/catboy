// Whale-group wallet gate — verification endpoint.
//
// Flow:
//   GET  /api/whale?tid=<tg>&t=<ts>&h=<hmac>  -> validates the bot-issued link,
//        returns { ok, message, minTokens, nftGate } (the exact string to sign).
//   POST /api/whale { tid, t, h, wallet, sig } -> verifies the signature proves
//        wallet ownership, checks the wallet holds >= minTokens $CATBOY OR a
//        Catboy NFT, and if so returns a one-time Telegram invite link.
//
// Env:
//   DATABASE_URL        Neon (shared with the bot: config + members)
//   SOLANA_RPC          full RPC url (balance / NFT checks)
//   TELEGRAM_BOT_TOKEN  to mint the one-time invite link
//   WHALE_CHAT_ID       the whale group's chat id (e.g. -100...)
//   WHALE_SECRET        shared HMAC secret (must match the bot's)
//   TOKEN_MINT          $CATBOY mint
//   NFT_COLLECTION, NFT_COLLECTION_GENESIS, NFT_COLLECTION_PRIDE  collection addresses (NFT gate)
import { neon } from "@neondatabase/serverless";
import { PublicKey } from "@solana/web3.js";
import crypto from "crypto";
import { tgAnnounce } from "./_tg.js";
import { isBlocked } from "./_blocklist.js";

const SITE = (process.env.SITE_URL || "https://www.catboyonsol.fun").trim();
const CONN = (process.env.DATABASE_URL || process.env.POSTGRES_URL || "").trim();
const RPC = (process.env.SOLANA_RPC || "").trim();
const BOT = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const WHALE_CHAT = (process.env.WHALE_CHAT_ID || "").trim();
const SECRET = (process.env.WHALE_SECRET || "").trim();
const MINT = (process.env.TOKEN_MINT || "").trim();
// Public on-chain collection ids — default to the known Catboy collections.
const DEFAULT_COLLECTIONS = ["33kxQv4Jo7u9edC4RipZckwkpRRdxg863b6cw2UGfh6S", "HuLA9RRuG6s994eAiiY4cFhrhghCkCQWcNdm3e3wVD3x", "4N1d9umoscMYiwiqxXnkTbJD9pXLMZiPCw4H7fAUK93x"];
const _envColls = [process.env.NFT_COLLECTION, process.env.NFT_COLLECTION_GENESIS, process.env.NFT_COLLECTION_PRIDE]
  .map((x) => (x || "").trim()).filter(Boolean);
const COLLECTIONS = _envColls.length ? _envColls : DEFAULT_COLLECTIONS;
const LINK_TTL = 30 * 60 * 1000;       // verify link valid 30 min
const DEFAULT_MIN = 10_000_000;        // 10M $CATBOY default (changeable from the bot)

const sql = () => { if (!CONN) throw new Error("db_not_configured"); return neon(CONN); };

async function rpc(method, params = []) {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc_error");
  return j.result;
}

async function ensureTables(s) {
  await s`CREATE TABLE IF NOT EXISTS whale_config (id INT PRIMARY KEY DEFAULT 1, min_tokens NUMERIC NOT NULL DEFAULT ${DEFAULT_MIN}, nft_gate BOOLEAN NOT NULL DEFAULT true)`;
  // one row per (verified) wallet — a person can bind several; wallet is unique so it can't be shared across accounts
  await s`CREATE TABLE IF NOT EXISTS whale_wallets (wallet TEXT PRIMARY KEY, tid TEXT NOT NULL, verified_at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE INDEX IF NOT EXISTS whale_wallets_tid ON whale_wallets (tid)`;
  await s`CREATE TABLE IF NOT EXISTS whale_members (tid TEXT PRIMARY KEY, joined_at TIMESTAMPTZ DEFAULT now())`;
}
async function config() {
  try {
    const s = sql();
    await ensureTables(s);
    const rows = await s`SELECT min_tokens, nft_gate FROM whale_config WHERE id=1`;
    if (!rows.length) { await s`INSERT INTO whale_config (id) VALUES (1) ON CONFLICT DO NOTHING`; return { minTokens: DEFAULT_MIN, nftGate: true }; }
    return { minTokens: Number(rows[0].min_tokens), nftGate: !!rows[0].nft_gate };
  } catch { return { minTokens: DEFAULT_MIN, nftGate: true }; }
}

// The bot signs `${tid}.${t}` with WHALE_SECRET so nobody can verify for a tid they don't control.
const hmac = (data) => crypto.createHmac("sha256", SECRET).update(data).digest("hex");
const linkOk = (tid, t, h) => SECRET && h && h === hmac(`${tid}.${t}`) && (Date.now() - Number(t)) < LINK_TTL && Number(t) <= Date.now() + 60000;

// The exact human-readable string the wallet signs.
const messageFor = (tid, t) =>
  `Catboy Whale Verification\nTelegram: ${tid}\nNonce: ${t}\nOnly sign this on catboyonsol.fun — it proves you own this wallet.`;

function verifySig(message, wallet, sigB64) {
  try {
    const pub = new PublicKey(wallet).toBytes();
    const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pub)]);
    const key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(message, "utf8"), key, Buffer.from(sigB64, "base64"));
  } catch { return false; }
}

async function balanceOf(wallet) {
  try {
    const r = await rpc("getTokenAccountsByOwner", [wallet, { mint: MINT }, { encoding: "jsonParsed" }]);
    let sum = 0;
    for (const v of (r.value || [])) sum += Number(v.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
    return sum;
  } catch { return 0; }
}

async function ownsNft(wallet) {
  if (!COLLECTIONS.length) return false;
  try {
    // DAS getAssetsByOwner (Metaplex Core assets), match our collection groupings.
    const r = await rpc("getAssetsByOwner", { ownerAddress: wallet, page: 1, limit: 1000 });
    const items = r?.items || [];
    for (const a of items) {
      const grp = (a.grouping || []).find((g) => g.group_key === "collection");
      if (grp && COLLECTIONS.includes(grp.group_value)) return true;
      // Core assets sometimes expose the collection under `updateAuthority`/`authorities`.
      if (COLLECTIONS.includes(a.id)) return true;
    }
    return false;
  } catch { return false; }
}

async function makeInvite(tid) {
  const r = await fetch(`https://api.telegram.org/bot${BOT}/createChatInviteLink`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: WHALE_CHAT, member_limit: 1, expire_date: Math.floor(Date.now() / 1000) + 600, name: `whale-${tid}`.slice(0, 32) }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.description || "invite_failed");
  return j.result.invite_link;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  try {
    const q = req.method === "GET" ? (req.query || {}) : (typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}));
    const tid = String(q.tid || "").trim();
    const t = String(q.t || "").trim();
    const h = String(q.h || "").trim();
    if (!tid || !linkOk(tid, t, h)) return res.status(403).json({ ok: false, error: "bad_or_expired_link" });

    const cfg = await config();
    if (req.method === "GET") {
      return res.status(200).json({ ok: true, message: messageFor(tid, t), minTokens: cfg.minTokens, nftGate: cfg.nftGate });
    }
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method" });

    const wallet = String(q.wallet || "").trim();
    const sig = String(q.sig || "").trim();
    if (!wallet || !sig) return res.status(400).json({ ok: false, error: "missing_wallet_or_sig" });
    if (!verifySig(messageFor(tid, t), wallet, sig)) return res.status(401).json({ ok: false, error: "signature_invalid" });
    // Wash-trade / chart-farm wallets can't buy their way into the whale pod.
    if (isBlocked(wallet)) return res.status(403).json({ ok: false, error: "wallet_not_eligible" });

    const s = sql();
    await ensureTables(s);
    // a wallet can only be bound to one Telegram account (no sharing a whale bag)
    const owner = await s`SELECT tid FROM whale_wallets WHERE wallet=${wallet}`;
    if (owner.length && String(owner[0].tid) !== String(tid)) return res.status(200).json({ ok: false, error: "wallet_linked_to_other" });
    await s`INSERT INTO whale_wallets (wallet, tid, verified_at) VALUES (${wallet}, ${tid}, now())
            ON CONFLICT (wallet) DO UPDATE SET tid=${tid}, verified_at=now()`;

    // sum across ALL of this user's verified wallets (supply can be spread around)
    const wallets = (await s`SELECT wallet FROM whale_wallets WHERE tid=${tid}`).map((r) => r.wallet);
    let total = 0, byNft = false;
    for (const w of wallets) {
      if (isBlocked(w)) continue; // blocked wallets don't count toward the whale threshold
      total += await balanceOf(w);
      if (cfg.nftGate && !byNft && await ownsNft(w)) byNft = true;
    }
    if (total < cfg.minTokens && !byNft) {
      return res.status(200).json({ ok: false, error: "not_enough", balance: total, wallets: wallets.length, minTokens: cfg.minTokens, nftGate: cfg.nftGate, needed: Math.max(0, cfg.minTokens - total) });
    }

    if (!BOT || !WHALE_CHAT) return res.status(500).json({ ok: false, error: "whale_group_not_configured" });
    const invite = await makeInvite(tid);
    // xmax=0 means this was a fresh INSERT (a brand-new whale), not a re-verify.
    const ins = await s`INSERT INTO whale_members (tid, joined_at) VALUES (${tid}, now())
                        ON CONFLICT (tid) DO UPDATE SET joined_at=now() RETURNING (xmax = 0) AS is_new`;
    if (ins[0]?.is_new) {
      const count = (await s`SELECT COUNT(*)::int AS n FROM whale_members`)[0]?.n || 1;
      await tgAnnounce(
        `🐋 <b>NEW WHALE JOINED THE POD!</b>\nA big holder just verified and entered the whale group.\n` +
        `<b>${count}</b> whale${count === 1 ? "" : "s"} strong 🐾\n\nHold enough $CATBOY or a Catboy NFT? <a href="${SITE}/whale.html">Join the pod</a>`
      );
    }
    return res.status(200).json({ ok: true, invite, balance: total, wallets: wallets.length, byNft });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
