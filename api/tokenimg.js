// Token image resolver/proxy (BUILD SPEC — token images).
//   GET /api/tokenimg?ca=<mint>     -> reads on-chain Metaplex metadata -> image (needs SOLANA_RPC)
//   GET /api/tokenimg?uri=<uri>     -> resolves a metadata JSON's image (no RPC needed)
//   GET /api/tokenimg?img=<url>     -> proxies a direct image
// Redirects to wsrv.nl for resize + cache + CORS. Never hard-fails the UI.

import { rpc } from "../lib/rpc.js";
import { PublicKey } from "@solana/web3.js";

const MPL = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"; // Metaplex Token Metadata program

function toHttp(u) {
  if (!u) return "";
  if (u.startsWith("ipfs://")) return "https://ipfs.io/ipfs/" + u.replace("ipfs://", "").replace(/^ipfs\//, "");
  return u;
}

async function uriFromMint(mint) {
  if (!process.env.SOLANA_RPC) return "";
  const pda = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), new PublicKey(MPL).toBuffer(), new PublicKey(mint).toBuffer()],
    new PublicKey(MPL)
  )[0].toBase58();
  const acc = await rpc("getAccountInfo", [pda, { encoding: "base64" }]);
  if (!acc || !acc.value) return "";
  const d = Buffer.from(acc.value.data[0], "base64");
  let pos = 1 + 32 + 32; // key + update_authority + mint
  const readStr = () => { const len = d.readUInt32LE(pos); pos += 4; const s = d.slice(pos, pos + len).toString("utf8").replace(/\0+$/, ""); pos += len; return s; };
  readStr(); readStr(); // name, symbol
  return readStr().trim(); // uri
}

export default async function handler(req, res) {
  const ca = req.query?.ca;
  let uri = req.query?.uri;
  let img = req.query?.img;

  try {
    if (!img && !uri && ca) { try { uri = await uriFromMint(ca); } catch {} }
    if (!img && uri) {
      const r = await fetch(toHttp(uri), { headers: { accept: "application/json" } });
      if (r.ok) { const j = await r.json(); img = j.image || j.image_url || j.imageUrl || ""; }
    }
    img = toHttp(img);
    if (!img) return res.status(404).json({ error: "no_image" });

    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=604800");
    res.redirect(302, "https://wsrv.nl/?url=" + encodeURIComponent(img) + "&w=64&h=64&fit=cover&output=webp");
  } catch (e) {
    res.status(404).json({ error: "img_failed" });
  }
}
