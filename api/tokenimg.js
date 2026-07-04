// Token image resolver/proxy (BUILD SPEC — token images).
//   GET /api/tokenimg?ca=<mint>     -> reads on-chain Metaplex metadata -> image (needs SOLANA_RPC)
//   GET /api/tokenimg?uri=<uri>     -> resolves a metadata JSON's image (no RPC needed)
//   GET /api/tokenimg?img=<url>     -> proxies a direct image
// Redirects to wsrv.nl for resize + cache + CORS. Never hard-fails the UI.

import * as web3ns from "@solana/web3.js";
const web3 = web3ns.default || web3ns;
const { PublicKey } = web3;

async function rpc(method, params = []) {
  const url = process.env.SOLANA_RPC;
  if (!url) throw new Error("rpc_not_configured");
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc_error");
  return j.result;
}

const MPL = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"; // Metaplex Token Metadata program

function toHttp(u) {
  if (!u) return "";
  if (u.startsWith("ipfs://")) return "https://ipfs.io/ipfs/" + u.replace("ipfs://", "").replace(/^ipfs\//, "");
  return u;
}

// SSRF guard: only fetch public http(s) URLs, never internal/loopback/link-local hosts.
function isSafeHttpUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const h = url.hostname.toLowerCase();
    if (h === "localhost" || h === "0.0.0.0" || h.endsWith(".local") || h.endsWith(".internal")) return false;
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) ||
        h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return false;
    return true;
  } catch { return false; }
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
  const readStr = () => {
    if (pos + 4 > d.length) return "";
    const len = d.readUInt32LE(pos); pos += 4;
    if (len > 400 || pos + len > d.length) return "";
    const s = d.slice(pos, pos + len).toString("utf8").replace(/\0+$/, ""); pos += len; return s;
  };
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
      const metaUrl = toHttp(uri);
      if (isSafeHttpUrl(metaUrl)) {
        const r = await fetch(metaUrl, { headers: { accept: "application/json" } });
        if (r.ok) { const j = await r.json(); img = j.image || j.image_url || j.imageUrl || ""; }
      }
    }
    img = toHttp(img);
    if (!img || !isSafeHttpUrl(img)) return res.status(404).json({ error: "no_image" });

    // Always route the image through wsrv.nl (its egress, not ours) — no raw
    // server-side fetch of a user-supplied URL, which would be an SSRF vector.
    const proxied = "https://wsrv.nl/?url=" + encodeURIComponent(img) + "&w=64&h=64&fit=cover&output=webp";
    const up = await fetch(proxied);
    if (!up.ok) return res.status(404).json({ error: "img_fetch" });

    const buf = Buffer.from(await up.arrayBuffer());
    res.setHeader("Content-Type", up.headers.get("content-type") || "image/webp");
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=604800");
    return res.send(buf);
  } catch (e) {
    res.status(404).json({ error: "img_failed" });
  }
}
