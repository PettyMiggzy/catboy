// Tiny static file server for the Hooded Hunt game (always-on, alongside the bot).
//   node bot-server/serve.mjs         (from repo root)  ->  http://<droplet-ip>:8090/hunt
// PORT env overrides the port (e.g. PORT=80 for a clean URL when run as root).
// Serves ONLY files under games/ — with strict path-traversal protection.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname, resolve } from "node:path";

const ROOT = resolve(process.cwd(), "games");
const PORT = parseInt(process.env.PORT || "8090", 10);
const TYPES = {
  ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8", ".png":"image/png", ".jpg":"image/jpeg",
  ".jpeg":"image/jpeg", ".webp":"image/webp", ".svg":"image/svg+xml",
  ".mp4":"video/mp4", ".webm":"video/webm", ".json":"application/json", ".ico":"image/x-icon",
};

const srv = createServer(async (req, res) => {
  try {
    let url = decodeURIComponent((req.url || "/").split("?")[0]);
    // route aliases -> the game
    if (url === "/" || url === "/hunt" || url === "/hunt/" || url === "/play") url = "/hooded-hunt/index.html";
    // resolve inside ROOT and refuse anything that escapes it (path traversal guard)
    const path = normalize(join(ROOT, url));
    if (path !== ROOT && !path.startsWith(ROOT + "/")) { res.writeHead(403).end("forbidden"); return; }
    let file = path;
    try { const s = await stat(file); if (s.isDirectory()) file = join(file, "index.html"); } catch {}
    const body = await readFile(file);
    const ct = TYPES[extname(file).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": ct,
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
  } catch (e) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  }
});
srv.listen(PORT, "0.0.0.0", () => console.log(`Hooded Hunt served on :${PORT}  ->  /hunt`));
