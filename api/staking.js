// $CATBOY NFT staking — "Nap to Earn" (proof-of-hold, non-custodial).
//
// Rewards come from a pool fed by 10% of NFT sales (bought back into $CATBOY)
// + optional seed/royalties, deposited by the staking bot. Distribution uses
// the standard accRewardPerShare accumulator (MasterChef-style): each pool
// deposit bumps accPerShare by deposit/totalShares, and a staker's pending is
// shares*accPerShare - rewardDebt. NFTs never leave the owner's wallet — we
// verify ownership on-chain and settle if they move it.
//
//   GET  /api/staking?wallet=<addr>   -> pool stats + your stakeable/staked cats + accrued
//   POST /api/staking {action, wallet, sig, ts, assets?}  action: stake | unstake | claim
//
// Env: DATABASE_URL, SOLANA_RPC, TOKEN_MINT(=$CATBOY), STAKE_SECRET,
//      NFT_COLLECTION[_GENESIS|_PRIDE], CLAIM_INTERVAL_DAYS(=30)
import { neon } from "@neondatabase/serverless";
import { PublicKey } from "@solana/web3.js";
import crypto from "crypto";
import { tgAnnounce, esc } from "./_tg.js";

const SITE = (process.env.SITE_URL || "https://www.catboyonsol.fun").trim();

const CONN = (process.env.DATABASE_URL || process.env.POSTGRES_URL || "").trim();
const RPC = (process.env.SOLANA_RPC || "").trim();
const MINT = (process.env.TOKEN_MINT || "3UCdpV5mTb4TmJSCyPkaAsuUFvaF4ofc2uXCEj3Jpump").trim();
const POOL_WALLET = (process.env.STAKE_POOL_WALLET || "BhXrZtDMbntmisGqQf15QRAmNadRALyx52sqaSxQup7b").trim();
const SECRET = (process.env.STAKE_SECRET || "").trim();
const CLAIM_DAYS = Math.max(1, parseInt(process.env.CLAIM_INTERVAL_DAYS || "30", 10));
const DEFAULT_COLLECTIONS = ["33kxQv4Jo7u9edC4RipZckwkpRRdxg863b6cw2UGfh6S", "HuLA9RRuG6s994eAiiY4cFhrhghCkCQWcNdm3e3wVD3x", "4N1d9umoscMYiwiqxXnkTbJD9pXLMZiPCw4H7fAUK93x"];
const _envColls = [process.env.NFT_COLLECTION, process.env.NFT_COLLECTION_GENESIS, process.env.NFT_COLLECTION_PRIDE].map((x) => (x || "").trim()).filter(Boolean);
const COLLECTIONS = _envColls.length ? _envColls : DEFAULT_COLLECTIONS;
// "nap shares" per tier — higher tier earns proportionally more of the pool
const NAP = { Common: 1, Rare: 3, Epic: 6, Legendary: 12, Legend: 12, Founder: 12, Pride: 8 };
const SCALE = 1_000_000_000_000n; // 1e12 fixed-point for accPerShare

const sql = () => { if (!CONN) throw new Error("db_not_configured"); return neon(CONN); };
const hmac = (d) => crypto.createHmac("sha256", SECRET).update(d).digest("hex");
const messageFor = (wallet, ts) => `Catboy Staking\nWallet: ${wallet}\nNonce: ${ts}\nSign to manage your naps on catboyonsol.fun — free, no transaction.`;

async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
function verifySig(message, wallet, sigB64) {
  try {
    const pub = new PublicKey(wallet).toBytes();
    const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pub)]);
    const key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(message, "utf8"), key, Buffer.from(sigB64, "base64"));
  } catch { return false; }
}

async function ensure(s) {
  await s`CREATE TABLE IF NOT EXISTS stake_pool (id INT PRIMARY KEY DEFAULT 1, acc_per_share NUMERIC NOT NULL DEFAULT 0, total_shares BIGINT NOT NULL DEFAULT 0, undistributed NUMERIC NOT NULL DEFAULT 0, deposited NUMERIC NOT NULL DEFAULT 0)`;
  await s`INSERT INTO stake_pool (id) VALUES (1) ON CONFLICT DO NOTHING`;
  await s`CREATE TABLE IF NOT EXISTS stakers (wallet TEXT PRIMARY KEY, shares BIGINT NOT NULL DEFAULT 0, reward_debt NUMERIC NOT NULL DEFAULT 0, pending NUMERIC NOT NULL DEFAULT 0, last_claim_at TIMESTAMPTZ)`;
  await s`CREATE TABLE IF NOT EXISTS staked_assets (asset TEXT PRIMARY KEY, wallet TEXT NOT NULL, tier TEXT, shares INT, staked_at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE INDEX IF NOT EXISTS staked_assets_wallet ON staked_assets (wallet)`;
  await s`CREATE TABLE IF NOT EXISTS stake_claims (id SERIAL PRIMARY KEY, wallet TEXT, amount NUMERIC, status TEXT DEFAULT 'pending', sig TEXT, created_at TIMESTAMPTZ DEFAULT now())`;
}
async function pool(s) { return (await s`SELECT * FROM stake_pool WHERE id=1`)[0]; }
// Parse Postgres NUMERIC (returned as a string) straight to BigInt — going via
// Number() would silently corrupt the accRewardPerShare accumulator once it
// exceeds 2^53, throwing off every reward calc.
const bi = (x) => BigInt(String(x ?? 0).trim().split(".")[0] || "0");
// pending for a staker given current accPerShare (all fixed-point over SCALE)
function pendingOf(st, accPerShare) { return bi(st.pending) + (bi(st.shares) * bi(accPerShare)) / SCALE - bi(st.reward_debt); }

// list the wallet's Catboy NFTs on-chain (DAS), tagged with our tier from inventory
async function ownedCatboys(s, wallet) {
  let items = [];
  try { const r = await rpc("getAssetsByOwner", { ownerAddress: wallet, page: 1, limit: 1000 }); items = r?.items || []; } catch { return []; }
  const mine = items.filter((a) => (a.grouping || []).some((g) => g.group_key === "collection" && COLLECTIONS.includes(g.group_value)));
  const out = [];
  for (const a of mine) {
    // tier: prefer our inventory record, else read the Rarity attribute
    let tier = null;
    try { const row = (await s`SELECT tier FROM nft_inventory WHERE asset=${a.id}`)[0]; if (row) tier = row.tier; } catch {}
    if (!tier) { const at = (a.content?.metadata?.attributes || []).find((x) => (x.trait_type || "").toLowerCase() === "rarity"); tier = at ? at.value : "Common"; }
    out.push({ asset: a.id, name: a.content?.metadata?.name || "Catboy", tier, shares: NAP[tier] || 1, image: a.content?.links?.image || "" });
  }
  return out;
}

async function estApy(s, p) {
  // rough: annualize the last-30d deposits vs. staked value proxy (shares). Display-only.
  try {
    const dep30 = Number((await s`SELECT COALESCE(SUM(amount),0) AS n FROM stake_claims WHERE false`)[0].n); // placeholder; real inflow tracked by deposited delta
  } catch {}
  return null; // the UI shows a live estimate from pool inflow once the bot records it
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  try {
    const s = sql(); await ensure(s);
    const p = await pool(s);
    if (req.method === "GET") {
      const wallet = String((req.query || {}).wallet || "").trim();
      const totalShares = Number(p.total_shares);
      // show the LIVE pool wallet $CATBOY balance (what stakers watch grow)
      let live = null;
      try { const rr = await rpc("getTokenAccountsByOwner", [POOL_WALLET, { mint: MINT }, { encoding: "jsonParsed" }]); live = 0; for (const v of (rr.value || [])) live += Number(v.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0); } catch {}
      const base = { pool: { deposited: (live != null ? live : Number(p.deposited)), totalShares }, napShares: NAP, claimDays: CLAIM_DAYS };
      if (!wallet) return res.status(200).json(base);
      const owned = await ownedCatboys(s, wallet);
      const stakedRows = await s`SELECT asset FROM staked_assets WHERE wallet=${wallet}`;
      const stakedSet = new Set(stakedRows.map((r) => r.asset));
      const st = (await s`SELECT * FROM stakers WHERE wallet=${wallet}`)[0] || { shares: 0, reward_debt: 0, pending: 0, last_claim_at: null };
      const accrued = Number(pendingOf(st, p.acc_per_share)) / 1e9; // pool amounts stored in base units (9dp display scale)
      const nextClaim = st.last_claim_at ? new Date(new Date(st.last_claim_at).getTime() + CLAIM_DAYS * 86400000).toISOString() : null;
      return res.status(200).json({
        ...base,
        message: SECRET ? messageFor(wallet, "GET") : null,
        wallet,
        stakeable: owned.filter((o) => !stakedSet.has(o.asset)),
        staked: owned.filter((o) => stakedSet.has(o.asset)),
        yourShares: Number(st.shares),
        accrued,
        canClaim: !st.last_claim_at || (Date.now() - new Date(st.last_claim_at).getTime()) >= CLAIM_DAYS * 86400000,
        nextClaimAt: nextClaim,
      });
    }
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method" });
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { action, wallet, sig, ts, assets } = b;
    if (!wallet || !sig || !ts) return res.status(400).json({ ok: false, error: "missing_fields" });
    if (!SECRET) return res.status(503).json({ ok: false, error: "staking_not_configured" });
    // reject stale signatures (replay hardening); the page signs a fresh Date.now() each action
    if (Math.abs(Date.now() - Number(ts)) > 15 * 60000) return res.status(401).json({ ok: false, error: "signature_expired" });
    if (!verifySig(messageFor(wallet, ts), wallet, sig)) return res.status(401).json({ ok: false, error: "signature_invalid" });

    // settle helper: roll a staker's pending forward at current accPerShare, set new shares
    async function settleAndSet(newShares) {
      const st = (await s`SELECT * FROM stakers WHERE wallet=${wallet}`)[0];
      const cur = st || { shares: 0, reward_debt: 0, pending: 0 };
      const pend = pendingOf(cur, p.acc_per_share);
      const debt = (bi(newShares) * bi(p.acc_per_share)) / SCALE;
      await s`INSERT INTO stakers (wallet, shares, reward_debt, pending, last_claim_at)
              VALUES (${wallet}, ${String(newShares)}, ${debt.toString()}, ${pend.toString()}, ${st ? st.last_claim_at : null})
              ON CONFLICT (wallet) DO UPDATE SET shares=${String(newShares)}, reward_debt=${debt.toString()}, pending=${pend.toString()}`;
    }

    if (action === "stake" || action === "unstake") {
      const owned = await ownedCatboys(s, wallet);
      const ownedMap = new Map(owned.map((o) => [o.asset, o]));
      const list = Array.isArray(assets) ? assets.filter((a) => ownedMap.has(a)) : [];
      if (!list.length) return res.status(400).json({ ok: false, error: "no_valid_assets" });
      let delta = 0;
      if (action === "stake") {
        for (const a of list) { const o = ownedMap.get(a); await s`INSERT INTO staked_assets (asset, wallet, tier, shares) VALUES (${a}, ${wallet}, ${o.tier}, ${o.shares}) ON CONFLICT (asset) DO UPDATE SET wallet=${wallet}, tier=${o.tier}, shares=${o.shares}`; delta += o.shares; }
      } else {
        const rows = await s`SELECT asset, shares FROM staked_assets WHERE wallet=${wallet} AND asset = ANY(${list})`;
        for (const r of rows) { delta -= Number(r.shares); }
        await s`DELETE FROM staked_assets WHERE wallet=${wallet} AND asset = ANY(${list})`;
      }
      const cur = (await s`SELECT shares FROM stakers WHERE wallet=${wallet}`)[0];
      const newShares = Math.max(0, Number(cur ? cur.shares : 0) + delta);
      await settleAndSet(newShares);
      await s`UPDATE stake_pool SET total_shares = GREATEST(0, total_shares + ${delta}) WHERE id=1`;
      // Announce to the channel (fire-and-forget; never blocks the action).
      const names = list.map((a) => ownedMap.get(a)?.name).filter(Boolean).map(esc).join(", ");
      const total = (await s`SELECT total_shares FROM stake_pool WHERE id=1`)[0]?.total_shares || 0;
      if (action === "stake") {
        await tgAnnounce(
          `😴 <b>NEW STAKE!</b>\nA holder just put <b>${names}</b> down for a nap (+${Math.abs(delta)}× share).\n` +
          `Now <b>${total}</b> nap-share${Number(total) === 1 ? "" : "s"} earning from the pool.\n\n💤 <a href="${SITE}/stake.html">Nap yours to earn $CATBOY</a>`
        );
      } else {
        await tgAnnounce(`🙀 <b>Woke up!</b>\nA holder pulled <b>${names}</b> out of the nap pool.\n💤 <a href="${SITE}/stake.html">Stake to earn</a>`);
      }
      return res.status(200).json({ ok: true, action, shares: newShares });
    }
    if (action === "claim") {
      const st = (await s`SELECT * FROM stakers WHERE wallet=${wallet}`)[0];
      if (!st) return res.status(400).json({ ok: false, error: "nothing_staked" });
      if (st.last_claim_at && (Date.now() - new Date(st.last_claim_at).getTime()) < CLAIM_DAYS * 86400000)
        return res.status(429).json({ ok: false, error: "claim_too_soon", nextClaimAt: new Date(new Date(st.last_claim_at).getTime() + CLAIM_DAYS * 86400000).toISOString() });
      const pend = pendingOf(st, p.acc_per_share);
      if (pend <= 0n) return res.status(400).json({ ok: false, error: "nothing_to_claim" });
      const amount = (Number(pend) / 1e9).toFixed(0);
      // record a payout for the staking bot to fulfill; reset pending + start the monthly timer
      await s`INSERT INTO stake_claims (wallet, amount, status) VALUES (${wallet}, ${amount}, 'pending')`;
      const debt = (bi(st.shares) * bi(p.acc_per_share)) / SCALE;
      await s`UPDATE stakers SET pending=0, reward_debt=${debt.toString()}, last_claim_at=now() WHERE wallet=${wallet}`;
      return res.status(200).json({ ok: true, action: "claim", amount: Number(amount), note: "Payout queued — $CATBOY hits your wallet shortly." });
    }
    return res.status(400).json({ ok: false, error: "bad_action" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
