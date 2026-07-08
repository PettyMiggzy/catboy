// Claim $CATBOY pump.fun CREATOR FEES to the creator wallet.
//
// Why this exists: the mint has no freeze authority — nobody can stop the
// wash-traders churning the chart. But pump.fun pays the CREATOR a fee on
// EVERY trade (buy and sell). At CATBOY's market cap (sub-$300k) that's the
// top tier — up to ~0.95% of every trade. So every dump and every wash cycle
// pays *us*. This sweeps those accrued fees to the creator wallet on demand.
//
// Creator wallet (must control its key): JAyu18HU91SaoG6yfRou4rbpZQC3yyaouiAAMaZ1cboy
//
//   CREATOR_WALLET_SECRET=<base58 or JSON array>  SOLANA_RPC=<rpc url> \
//   node scripts/claim-creator-fees.mjs
//
// Optional: PRIORITY_FEE (SOL, default 0.00005). Schedule it (pm2/cron) to
// sweep continuously — see the --loop flag.
//
// NEXT STEP (phase 2, ask to build): route the claimed SOL into a buyback that
// feeds the staking pool, so the farmers' volume literally funds diamond hands.
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";

const RPC = (process.env.SOLANA_RPC || "").trim();
const SECRET = (process.env.CREATOR_WALLET_SECRET || "").trim();
const PRIORITY = parseFloat(process.env.PRIORITY_FEE || "0.00005");
const EXPECTED_CREATOR = "JAyu18HU91SaoG6yfRou4rbpZQC3yyaouiAAMaZ1cboy";
const PUMPPORTAL = "https://pumpportal.fun/api/trade-local";

if (!RPC) { console.error("Set SOLANA_RPC"); process.exit(1); }
if (!SECRET) { console.error("Set CREATOR_WALLET_SECRET (the deployer wallet key — base58 or JSON array)"); process.exit(1); }

// base58 / JSON-array secret -> Keypair (same decoder the staking bot uses; no bs58 dep)
function loadKeypair(s) {
  if (s.startsWith("[")) return Keypair.fromSecretKey(new Uint8Array(JSON.parse(s)));
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let b = [0];
  for (const c of s) { let carry = A.indexOf(c); if (carry < 0) throw new Error("bad base58 in CREATOR_WALLET_SECRET"); for (let j = 0; j < b.length; j++) { carry += b[j] * 58; b[j] = carry & 255; carry >>= 8; } while (carry) { b.push(carry & 255); carry >>= 8; } }
  for (let k = 0; k < s.length && s[k] === "1"; k++) b.push(0);
  return Keypair.fromSecretKey(new Uint8Array(b.reverse()));
}

const conn = new Connection(RPC, "confirmed");
const kp = loadKeypair(SECRET);
const pub = kp.publicKey.toBase58();
if (pub !== EXPECTED_CREATOR) {
  console.warn(`⚠️  loaded wallet ${pub} is NOT the known creator wallet ${EXPECTED_CREATOR}.`);
  console.warn("   Creator fees only accrue to the deployer wallet — double-check the key. Continuing anyway.");
}

async function claimOnce() {
  const before = await conn.getBalance(kp.publicKey).catch(() => null);
  // pump.fun claims ALL accrued creator fees at once — no mint needed.
  const r = await fetch(PUMPPORTAL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: pub, action: "collectCreatorFee", priorityFee: PRIORITY }),
  });
  if (r.status !== 200) { console.error("pumpportal error", r.status, (await r.text()).slice(0, 200)); return false; }
  const buf = new Uint8Array(await r.arrayBuffer());
  const tx = VersionedTransaction.deserialize(buf);
  tx.sign([kp]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  const conf = await conn.confirmTransaction(sig, "confirmed").catch(() => null);
  if (conf?.value?.err) { console.error("claim tx failed:", JSON.stringify(conf.value.err), "sig", sig); return false; }
  const after = await conn.getBalance(kp.publicKey).catch(() => null);
  const gained = before != null && after != null ? (after - before) / 1e9 : null;
  console.log(`✅ claimed  sig=${sig}`);
  if (gained != null) console.log(`   wallet SOL: ${(before/1e9).toFixed(4)} -> ${(after/1e9).toFixed(4)}  (net ${gained >= 0 ? "+" : ""}${gained.toFixed(4)} after fee)`);
  console.log(`   https://solscan.io/tx/${sig}`);
  return true;
}

const LOOP = process.argv.includes("--loop");
const EVERY_MS = Math.max(60, parseInt(process.env.CLAIM_EVERY_MIN || "60", 10)) * 60000;

if (LOOP) {
  console.log(`creator-fee claimer running for ${pub} — sweeping every ${EVERY_MS/60000} min`);
  const tick = async () => { try { await claimOnce(); } catch (e) { console.error("claim error:", e.message); } };
  await tick();
  setInterval(tick, EVERY_MS);
} else {
  const ok = await claimOnce().catch((e) => { console.error("claim error:", e.message); return false; });
  process.exit(ok ? 0 : 1);
}
