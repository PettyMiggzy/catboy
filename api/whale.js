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
// No-connect verification: users send a unique tiny amount of SOL here (a normal
// wallet "send" — no dApp connect, no signature, no approval). The exact odd amount
// is their one-time secret binding the tx to their Telegram account. Defaults to the
// existing Catboy ops wallet; override with WHALE_VERIFY_WALLET.
const VERIFY_WALLET = (process.env.WHALE_VERIFY_WALLET || "EK8YS2haXFtKJ61phggC39m9RAG16B3NMx59uyMkP1PC").trim();
const DEPOSIT_BASE = parseInt(process.env.WHALE_DEPOSIT_BASE || "100000", 10); // lamports (0.0001 SOL)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  // DEFAULT must be an inline literal — Postgres forbids bind params in DDL, so ${DEFAULT_MIN}
  // sent 1 param for a 0-param statement and threw "bind message supplies 1 parameters, but
  // prepared statement requires 0", breaking whale verification. Keep literal in sync w/ DEFAULT_MIN.
  await s`CREATE TABLE IF NOT EXISTS whale_config (id INT PRIMARY KEY DEFAULT 1, min_tokens NUMERIC NOT NULL DEFAULT 10000000, nft_gate BOOLEAN NOT NULL DEFAULT true)`;
  // one row per (verified) wallet — a person can bind several; wallet is unique so it can't be shared across accounts
  await s`CREATE TABLE IF NOT EXISTS whale_wallets (wallet TEXT PRIMARY KEY, tid TEXT NOT NULL, verified_at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE INDEX IF NOT EXISTS whale_wallets_tid ON whale_wallets (tid)`;
  await s`CREATE TABLE IF NOT EXISTS whale_members (tid TEXT PRIMARY KEY, joined_at TIMESTAMPTZ DEFAULT now())`;
  // No-connect verification: the unique deposit amount issued per Telegram user, and a
  // global dedupe so one deposit tx can verify at most one account.
  await s`CREATE TABLE IF NOT EXISTS whale_verify_req (tid TEXT PRIMARY KEY, lamports BIGINT NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE TABLE IF NOT EXISTS whale_verify_used (txsig TEXT PRIMARY KEY, tid TEXT, at TIMESTAMPTZ DEFAULT now())`;
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
// Constant-time compare so the HMAC check can't be probed via timing (matches credits.js).
const hmacEq = (a, b) => {
  if (!a || !b || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
};
const linkOk = (tid, t, h) => SECRET && h && hmacEq(h, hmac(`${tid}.${t}`)) && (Date.now() - Number(t)) < LINK_TTL && Number(t) <= Date.now() + 60000;

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

// Verify a no-connect micro-deposit: a confirmed tx that sent EXACTLY `expectedLamports`
// to VERIFY_WALLET. The source of that transfer is the user's proven wallet.
async function verifyDeposit(txSig, expectedLamports) {
  if (!txSig || typeof txSig !== "string" || txSig.length < 32) return { ok: false, error: "bad_txsig" };
  let tx = null;
  for (let i = 0; i < 6; i++) {
    tx = await rpc("getTransaction", [txSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]);
    if (tx) break;
    await sleep(1500); // absorb RPC propagation lag; client posts at 'confirmed'
  }
  if (!tx) return { ok: false, error: "tx_not_found" };
  if (tx.meta && tx.meta.err) return { ok: false, error: "tx_failed" };
  if (tx.blockTime && (Date.now() / 1000 - tx.blockTime) > 3600) return { ok: false, error: "tx_too_old" };
  const instrs = (tx.transaction?.message?.instructions) || [];
  for (const ix of instrs) {
    const isSystem = ix.program === "system" || ix.programId === "11111111111111111111111111111111";
    if (isSystem && ix.parsed && ix.parsed.type === "transfer") {
      const info = ix.parsed.info || {};
      if (info.destination === VERIFY_WALLET && Number(info.lamports) === expectedLamports) {
        return { ok: true, wallet: info.source, blockTime: tx.blockTime || 0 };
      }
    }
  }
  return { ok: false, error: "no_matching_transfer" };
}

// Shared tail for both verification methods: bind the proven wallet to the tid, sum the
// user's holdings across all their verified wallets, gate, and issue the invite.
async function finishVerify(s, tid, wallet, cfg, res) {
  if (isBlocked(wallet)) return res.status(403).json({ ok: false, error: "wallet_not_eligible" });
  const owner = await s`SELECT tid FROM whale_wallets WHERE wallet=${wallet}`;
  if (owner.length && String(owner[0].tid) !== String(tid)) return res.status(200).json({ ok: false, error: "wallet_linked_to_other" });
  await s`INSERT INTO whale_wallets (wallet, tid, verified_at) VALUES (${wallet}, ${tid}, now())
          ON CONFLICT (wallet) DO UPDATE SET tid=${tid}, verified_at=now()`;

  const wallets = (await s`SELECT wallet FROM whale_wallets WHERE tid=${tid}`).map((r) => r.wallet);
  let total = 0, byNft = false;
  for (const w of wallets) {
    if (isBlocked(w)) continue;
    total += await balanceOf(w);
    if (cfg.nftGate && !byNft && await ownsNft(w)) byNft = true;
  }
  if (total < cfg.minTokens && !byNft) {
    return res.status(200).json({ ok: false, error: "not_enough", balance: total, wallets: wallets.length, minTokens: cfg.minTokens, nftGate: cfg.nftGate, needed: Math.max(0, cfg.minTokens - total) });
  }
  if (!BOT || !WHALE_CHAT) return res.status(500).json({ ok: false, error: "whale_group_not_configured" });
  const invite = await makeInvite(tid);
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
    const s = sql();
    await ensureTables(s);

    if (req.method === "GET") {
      // Issue a deposit amount (the user's secret) — no wallet connect needed. It MUST be
      // unique among active pending verifies, else an attacker could re-roll GET until their
      // amount matches a pending whale's deposit and hijack it. Reroll on any clash.
      let lamports = DEPOSIT_BASE + 1 + Math.floor(Math.random() * 99999);
      for (let tries = 0; tries < 15; tries++) {
        const clash = await s`SELECT 1 FROM whale_verify_req WHERE lamports=${lamports} AND tid<>${tid} AND created_at > now() - interval '30 minutes'`;
        if (!clash.length) break;
        lamports = DEPOSIT_BASE + 1 + Math.floor(Math.random() * 99999);
      }
      await s`INSERT INTO whale_verify_req (tid, lamports, created_at) VALUES (${tid}, ${lamports}, now())
              ON CONFLICT (tid) DO UPDATE SET lamports=${lamports}, created_at=now()`;
      return res.status(200).json({
        ok: true, minTokens: cfg.minTokens, nftGate: cfg.nftGate,
        verifyWallet: VERIFY_WALLET, depositLamports: lamports, depositSol: lamports / 1e9,
        message: messageFor(tid, t), // legacy sign-flow fallback
      });
    }
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method" });

    // --- Primary: no-connect micro-deposit (user pasted their tx signature) ---
    const txSig = String(q.txSig || "").trim();
    if (txSig) {
      if ((await s`SELECT 1 FROM whale_verify_used WHERE txsig=${txSig}`).length) return res.status(200).json({ ok: false, error: "tx_already_used" });
      const reqRow = await s`SELECT lamports, created_at FROM whale_verify_req WHERE tid=${tid}`;
      if (!reqRow.length) return res.status(200).json({ ok: false, error: "no_challenge" });
      if (Date.now() - new Date(reqRow[0].created_at).getTime() > LINK_TTL) return res.status(200).json({ ok: false, error: "challenge_expired" });
      const vr = await verifyDeposit(txSig, Number(reqRow[0].lamports));
      if (!vr.ok) return res.status(200).json({ ok: false, error: vr.error });
      // Deposit must be NEWER than the challenge — blocks hijacking an old/stale deposit.
      if (vr.blockTime && vr.blockTime * 1000 < new Date(reqRow[0].created_at).getTime() - 120000) {
        return res.status(200).json({ ok: false, error: "deposit_predates_request" });
      }
      // A deposit tx verifies at most one account (atomic claim before granting).
      const used = await s`INSERT INTO whale_verify_used (txsig, tid) VALUES (${txSig}, ${tid}) ON CONFLICT (txsig) DO NOTHING RETURNING txsig`;
      if (!used.length) return res.status(200).json({ ok: false, error: "tx_already_used" });
      await s`DELETE FROM whale_verify_req WHERE tid=${tid}`;
      return await finishVerify(s, tid, vr.wallet, cfg, res);
    }

    // --- Fallback: legacy connect-and-sign (kept so existing links still work) ---
    const wallet = String(q.wallet || "").trim();
    const sig = String(q.sig || "").trim();
    if (!wallet || !sig) return res.status(400).json({ ok: false, error: "missing_proof" });
    if (!verifySig(messageFor(tid, t), wallet, sig)) return res.status(401).json({ ok: false, error: "signature_invalid" });
    return await finishVerify(s, tid, wallet, cfg, res);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
