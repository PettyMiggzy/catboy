// OG Resurrection eligibility check.
//   POST /api/og-check { wallet, ts, sig }
//     - wallet: BNB (EVM) address the user connected
//     - sig: personal_sign of messageFor(wallet, ts) from that wallet
//     - verifies the signature proves ownership, then checks the wallet held
//       CATBOY on BSC AT THE FROZEN SNAPSHOT BLOCK (archive call). Held then ->
//       eligible for the OG at-cost price. Buying the token after the snapshot
//       does nothing (the block is in the past).
//
// Env: BSC_RPC = a BSC ARCHIVE rpc (Alchemy BNB endpoint). Set it in Vercel;
//      it is NOT committed to the repo so the key can't be scraped from GitHub.
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

const BSC_RPC = (process.env.BSC_RPC || "").trim();
// Frozen snapshot — see docs/resurrection-snapshot.md (committed pre-announcement).
const SNAPSHOT_BLOCK = 108609459;
const SNAPSHOT_HEX = "0x" + SNAPSHOT_BLOCK.toString(16);
const CONTRACTS = [
  "0x0dcee5f694e492f0dd842a7fbe5bed4c6e4665a6", // original CATBOY
  "0xcA9b8D6df0729D85DCfc8eF8Bb18af1aD1990786", // migrated CATBOY
];
const FRESH_MS = 15 * 60 * 1000;

const messageFor = (wallet, ts) => `Catboy OG — prove you held CATBOY on BNB\nWallet: ${wallet}\nNonce: ${ts}\nSigning is free and off-chain.`;

// Recover the EVM address that produced an eth personal_sign signature.
function recoverEvmAddress(message, sigHex) {
  const msg = new TextEncoder().encode(message);
  const pre = new TextEncoder().encode("\x19Ethereum Signed Message:\n" + msg.length);
  const full = new Uint8Array(pre.length + msg.length);
  full.set(pre); full.set(msg, pre.length);
  const hash = keccak_256(full);
  const clean = sigHex.replace(/^0x/, "");
  if (clean.length < 130) throw new Error("bad_sig_len");
  let v = parseInt(clean.slice(128, 130), 16);
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new Error("bad_recovery");
  const sig = secp256k1.Signature.fromCompact(clean.slice(0, 128)).addRecoveryBit(v);
  const pub = sig.recoverPublicKey(hash).toRawBytes(false); // 65 bytes, 0x04 prefix
  const addr = keccak_256(pub.slice(1)).slice(-20);
  return "0x" + Buffer.from(addr).toString("hex");
}

async function balanceAt(token, wallet) {
  const data = "0x70a08231" + wallet.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const r = await fetch(BSC_RPC, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data }, SNAPSHOT_HEX] }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc_error");
  return j.result && j.result !== "0x" ? BigInt(j.result) : 0n;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  try {
    if (req.method === "GET") return res.status(200).json({ ok: true, snapshotBlock: SNAPSHOT_BLOCK, contracts: CONTRACTS, message: messageFor("<your BNB wallet>", "<timestamp>") });
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method" });
    if (!BSC_RPC) return res.status(503).json({ ok: false, error: "bsc_rpc_not_configured" });
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const wallet = String(b.wallet || "").trim();
    const ts = String(b.ts || "").trim();
    const sig = String(b.sig || "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return res.status(400).json({ ok: false, error: "bad_wallet" });
    if (!ts || !sig) return res.status(400).json({ ok: false, error: "missing_fields" });
    if (Math.abs(Date.now() - Number(ts)) > FRESH_MS) return res.status(401).json({ ok: false, error: "signature_expired" });

    // 1) prove the caller owns `wallet`
    let signer;
    try { signer = recoverEvmAddress(messageFor(wallet, ts), sig); } catch { return res.status(401).json({ ok: false, error: "bad_signature" }); }
    if (signer.toLowerCase() !== wallet.toLowerCase()) return res.status(401).json({ ok: false, error: "signature_mismatch" });

    // 2) held CATBOY at the frozen snapshot block?
    let held = 0n;
    for (const c of CONTRACTS) { try { held += await balanceAt(c, wallet); } catch { /* skip one contract on rpc hiccup */ } }
    const eligible = held > 0n;
    return res.status(200).json({ ok: true, eligible, wallet, snapshotBlock: SNAPSHOT_BLOCK });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
