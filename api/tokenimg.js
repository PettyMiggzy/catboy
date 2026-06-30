// Token image resolver/proxy (BUILD SPEC Part 1 — token images via IPFS / wsrv.nl).
// GET /api/tokenimg?uri=<metadata-uri>   -> resolves the metadata JSON's image
// GET /api/tokenimg?img=<image-url>      -> proxies a direct image
// Redirects to wsrv.nl for resizing + caching + CORS. Never hard-fails the UI.

function toHttp(u) {
  if (!u) return "";
  if (u.startsWith("ipfs://")) return "https://ipfs.io/ipfs/" + u.slice(7);
  return u;
}

export default async function handler(req, res) {
  const uri = req.query?.uri;
  let img = req.query?.img;

  try {
    if (!img && uri) {
      const r = await fetch(toHttp(uri), { headers: { accept: "application/json" } });
      if (r.ok) { const j = await r.json(); img = j.image || j.image_url || j.imageUrl || ""; }
    }
    img = toHttp(img);
    if (!img) return res.status(404).json({ error: "no_image" });

    const out = "https://wsrv.nl/?url=" + encodeURIComponent(img) + "&w=64&h=64&fit=cover&output=webp";
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
    res.redirect(302, out);
  } catch (e) {
    res.status(404).json({ error: "img_failed" });
  }
}
