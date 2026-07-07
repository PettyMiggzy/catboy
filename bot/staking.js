// CATBOY NFT staking bot — pool + payouts.
//
// Funding model: you buy back $CATBOY as NFTs sell and send it to the POOL
// WALLET. This bot:
//   1) detects new $CATBOY arriving in the pool wallet -> distributes it to
//      current stakers (accRewardPerShare, weighted by tier nap-shares),
//   2) fulfils monthly claim payouts (sends $CATBOY from the pool wallet),
//   3) sweeps stakers: if a staked NFT left the wallet, that stake is removed
//      and its accrued rewards are forfeited back into the pool.
//
// Env (droplet .env ONLY — never chat):
//   DATABASE_URL          Neon (shared with the site)
//   RPC_URL               your RPC
//   TOKEN_MINT            $CATBOY mint (Token-2022)
//   STAKE_WALLET_SECRET   pool wallet private key (base58 or JSON array) — HOT wallet, fund only what you'll pay out
//   STAKE_CHECK_MIN       loop interval minutes (default 3)
//   CLAIM_INTERVAL_DAYS   default 30
//   NFT_COLLECTION[_GENESIS|_PRIDE]  optional (defaults to known Catboy collections)
import { neon } from "@neondatabase/serverless";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadEnv() {
  try {
    const txt = await fs.readFile(path.join(__dirname, ".env"), "utf8");
    for (const line of txt.split("\n")) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (process.env[m[1]] === undefined) process.env[m[1]] = v; }
  } catch {}
}
await loadEnv();

const CONN_STR = (process.env.DATABASE_URL || process.env.POSTGRES_URL || "").trim();
const RPC = (process.env.RPC_URL || "").trim();
const MINT = (process.env.TOKEN_MINT || "3UCdpV5mTb4TmJSCyPkaAsuUFvaF4ofc2uXCEj3Jpump").trim();
const CHECK_MS = Math.max(1, parseInt(process.env.STAKE_CHECK_MIN || "3", 10)) * 60000;
const CLAIM_DAYS = Math.max(1, parseInt(process.env.CLAIM_INTERVAL_DAYS || "30", 10));
const DEFAULT_COLLS = ["33kxQv4Jo7u9edC4RipZckwkpRRdxg863b6cw2UGfh6S", "HuLA9RRuG6s994eAiiY4cFhrhghCkCQWcNdm3e3wVD3x", "4N1d9umoscMYiwiqxXnkTbJD9pXLMZiPCw4H7fAUK93x"];
const _ec = [process.env.NFT_COLLECTION, process.env.NFT_COLLECTION_GENESIS, process.env.NFT_COLLECTION_PRIDE].map((x) => (x || "").trim()).filter(Boolean);
let COLLECTIONS = _ec.length ? _ec : DEFAULT_COLLS;
const _res = (process.env.NFT_COLLECTION_RESURRECTION || "").trim();
if (_res && !COLLECTIONS.includes(_res)) COLLECTIONS = [...COLLECTIONS, _res];
const NAP = { Common: 1, Rare: 3, Epic: 6, Legendary: 12, Legend: 12, Founder: 12, Pride: 8 };
const SCALE = 1_000_000_000_000n; // fixed-point for accPerShare (matches api/staking.js)
const REWARD_UNIT = 1_000_000_000n; // internal reward unit = 1e-9 CATBOY (matches api)

const log = (...a) => console.log(new Date().toISOString(), ...a);
process.on("unhandledRejection", (e) => log("unhandledRejection", (e && e.message) || e));
process.on("uncaughtException", (e) => log("uncaughtException", (e && e.message) || e));

if (!CONN_STR || !RPC) { console.error("Set DATABASE_URL and RPC_URL"); process.exit(1); }
if (!process.env.STAKE_WALLET_SECRET) { console.error("Set STAKE_WALLET_SECRET (pool wallet key)"); process.exit(1); }

function loadKeypair(s) {
  s = s.trim();
  if (s.startsWith("[")) return Keypair.fromSecretKey(new Uint8Array(JSON.parse(s)));
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let b = [0]; for (const c of s) { let carry = A.indexOf(c); if (carry < 0) throw new Error("bad base58"); for (let j = 0; j < b.length; j++) { carry += b[j] * 58; b[j] = carry & 255; carry >>= 8; } while (carry) { b.push(carry & 255); carry >>= 8; } } for (let k = 0; k < s.length && s[k] === "1"; k++) b.push(0);
  return Keypair.fromSecretKey(new Uint8Array(b.reverse()));
}
const kp = loadKeypair(process.env.STAKE_WALLET_SECRET);
const POOL = kp.publicKey;
const sql = neon(CONN_STR);
const conn = new Connection(RPC, "confirmed");
const MINT_PK = new PublicKey(MINT);
// Parse NUMERIC strings straight to BigInt — Number() would lose precision on
// the large accRewardPerShare accumulator and corrupt every reward calc.
const bi = (x) => BigInt(String(x ?? 0).trim().split(".")[0] || "0");

async function ensure() {
  await sql`CREATE TABLE IF NOT EXISTS stake_pool (id INT PRIMARY KEY DEFAULT 1, acc_per_share NUMERIC NOT NULL DEFAULT 0, total_shares BIGINT NOT NULL DEFAULT 0, undistributed NUMERIC NOT NULL DEFAULT 0, deposited NUMERIC NOT NULL DEFAULT 0)`;
  await sql`INSERT INTO stake_pool (id) VALUES (1) ON CONFLICT DO NOTHING`;
  await sql`ALTER TABLE stake_pool ADD COLUMN IF NOT EXISTS last_balance NUMERIC NOT NULL DEFAULT 0`;
  await sql`CREATE TABLE IF NOT EXISTS stakers (wallet TEXT PRIMARY KEY, shares BIGINT NOT NULL DEFAULT 0, reward_debt NUMERIC NOT NULL DEFAULT 0, pending NUMERIC NOT NULL DEFAULT 0, last_claim_at TIMESTAMPTZ)`;
  await sql`CREATE TABLE IF NOT EXISTS staked_assets (asset TEXT PRIMARY KEY, wallet TEXT NOT NULL, tier TEXT, shares INT, staked_at TIMESTAMPTZ DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS stake_claims (id SERIAL PRIMARY KEY, wallet TEXT, amount NUMERIC, status TEXT DEFAULT 'pending', sig TEXT, created_at TIMESTAMPTZ DEFAULT now())`;
}

// pool wallet's $CATBOY holding {rawBigInt, dec, ata, prog}
async function poolHolding() {
  try {
    const res = await conn.getParsedTokenAccountsByOwner(POOL, { mint: MINT_PK });
    for (const v of res.value) { const ta = v.account.data.parsed.info.tokenAmount; return { raw: BigInt(ta.amount), dec: ta.decimals, ui: Number(ta.uiAmount || 0), ata: v.pubkey, prog: v.account.owner }; }
  } catch (e) { log("poolHolding err", e.message); }
  return { raw: 0n, dec: 6, ui: 0, ata: null, prog: null };
}
async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
async function owns(wallet, asset) {
  try { const r = await rpc("getAssetsByOwner", { ownerAddress: wallet, page: 1, limit: 1000 }); return (r?.items || []).some((a) => a.id === asset); }
  catch { return true; } // on RPC failure, don't wrongly forfeit
}
// send `whole` $CATBOY from the pool wallet to `toOwner`; returns sig
async function payout(toOwner, whole, dec, prog) {
  const to = new PublicKey(toOwner);
  const p = prog || TOKEN_2022_PROGRAM_ID;
  const fromAta = getAssociatedTokenAddressSync(MINT_PK, POOL, false, p);
  const toAta = getAssociatedTokenAddressSync(MINT_PK, to, false, p);
  const amountRaw = BigInt(Math.round(whole)) * (10n ** BigInt(dec));
  const tx = new Transaction();
  tx.add(createAssociatedTokenAccountIdempotentInstruction(POOL, toAta, to, MINT_PK, p));
  tx.add(createTransferCheckedInstruction(fromAta, MINT_PK, toAta, POOL, amountRaw, dec, [], p));
  tx.feePayer = POOL;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(kp);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const conf = await conn.confirmTransaction(sig, "confirmed");
  if (conf?.value?.err) throw new Error("payout failed " + JSON.stringify(conf.value.err));
  return sig;
}

async function pool() { return (await sql`SELECT * FROM stake_pool WHERE id=1`)[0]; }
function pendingOf(st, acc) { return bi(st.pending) + (bi(st.shares) * bi(acc)) / SCALE - bi(st.reward_debt); }

// distribute `internalUnits` across the pool (adds to undistributed, rolls in when shares exist)
async function distribute(internalUnits) {
  let p = await pool();
  let undist = bi(p.undistributed) + internalUnits;
  let acc = bi(p.acc_per_share);
  const ts = bi(p.total_shares);
  if (ts > 0n && undist > 0n) { acc += (undist * SCALE) / ts; undist = 0n; }
  await sql`UPDATE stake_pool SET acc_per_share=${acc.toString()}, undistributed=${undist.toString()} WHERE id=1`;
}

async function processClaims(dec, prog) {
  const pend = await sql`SELECT * FROM stake_claims WHERE status='pending' ORDER BY id LIMIT 25`;
  let paidWhole = 0;
  for (const c of pend) {
    const whole = Math.round(Number(c.amount));
    if (whole <= 0) { await sql`UPDATE stake_claims SET status='skipped' WHERE id=${c.id}`; continue; }
    try {
      const sig = await payout(c.wallet, whole, dec, prog);
      await sql`UPDATE stake_claims SET status='paid', sig=${sig} WHERE id=${c.id}`;
      paidWhole += whole;
      log("claim paid:", whole, "CATBOY ->", c.wallet.slice(0, 6), sig.slice(0, 12));
    } catch (e) { log("claim payout failed id", c.id, e.message); /* leave pending; retry next cycle */ }
  }
  return paidWhole;
}

async function detectDeposits(currentUi, paidWhole) {
  const p = await pool();
  const last = Number(p.last_balance);
  // new = current - (last - paid).  positive => someone funded the pool.
  const deposit = currentUi - (last - paidWhole);
  if (deposit > 0.000001) {
    await distribute(bi(deposit) * REWARD_UNIT);
    await sql`UPDATE stake_pool SET deposited = deposited + ${deposit} WHERE id=1`;
    log("pool deposit detected:", deposit.toFixed(3), "CATBOY -> distributed");
  }
  await sql`UPDATE stake_pool SET last_balance=${currentUi} WHERE id=1`;
}

async function sweep() {
  const stakerRows = await sql`SELECT wallet FROM stakers`;
  for (const { wallet } of stakerRows) {
    const assets = await sql`SELECT asset, shares FROM staked_assets WHERE wallet=${wallet}`;
    let lostShares = 0, anyLost = false;
    for (const a of assets) { if (!(await owns(wallet, a.asset))) { anyLost = true; lostShares += Number(a.shares); await sql`DELETE FROM staked_assets WHERE asset=${a.asset}`; } }
    if (!anyLost) continue;
    // forfeit this staker's accrued rewards back into the pool, drop the lost shares
    const st = (await sql`SELECT * FROM stakers WHERE wallet=${wallet}`)[0];
    const forfeit = pendingOf(st, (await pool()).acc_per_share);
    const newShares = Math.max(0, Number(st.shares) - lostShares);
    await sql`UPDATE stake_pool SET total_shares = GREATEST(0, total_shares - ${lostShares}) WHERE id=1`;
    if (forfeit > 0n) { await distribute(forfeit); } // stays in pool -> redistributed to the rest
    if (newShares <= 0) { await sql`DELETE FROM stakers WHERE wallet=${wallet}`; }
    else { const debt = (bi(newShares) * bi((await pool()).acc_per_share)) / SCALE; await sql`UPDATE stakers SET shares=${String(newShares)}, pending=0, reward_debt=${debt.toString()} WHERE wallet=${wallet}`; }
    log("forfeit:", wallet.slice(0, 6), "lost", lostShares, "shares, forfeited", (Number(forfeit) / 1e9).toFixed(0), "CATBOY to pool");
  }
}

let busy = false;
async function cycle() {
  if (busy) return; busy = true;
  try {
    await ensure();
    const h = await poolHolding();
    const paid = await processClaims(h.dec, h.prog);
    const h2 = await poolHolding(); // re-read after payouts
    await detectDeposits(h2.ui, paid);
    await distribute(0n); // roll any held (undistributed) rewards in once stakers exist (e.g. the seed deposited before anyone staked)
    await sweep();
  } catch (e) { log("cycle error", e.message); }
  finally { busy = false; }
}

log(`CATBOY staking bot — pool ${POOL.toBase58()} · check every ${CHECK_MS / 60000}m · claim every ${CLAIM_DAYS}d`);
log(`config: DB=${CONN_STR ? "set" : "MISSING"} · collections=${COLLECTIONS.length}`);
cycle();
setInterval(cycle, CHECK_MS);
