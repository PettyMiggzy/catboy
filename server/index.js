// Catboy backend — Venice AI proxy + Spaces uploads + leaderboards.
// Deploys on DigitalOcean App Platform (auto-deploy from GitHub) or any Node host.
// Secrets come from env vars (never committed): see .env.example / DEPLOY.md.
import express from "express";
import cors from "cors";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const app = express();
app.use(express.json({ limit: "12mb" }));

const {
  VENICE_KEY, ADMIN_TOKEN,
  ALLOWED_ORIGIN = "https://catboy-ecru.vercel.app",
  SPACES_KEY, SPACES_SECRET, SPACES_REGION = "nyc3",
  SPACES_BUCKET, SPACES_ENDPOINT, SPACES_CDN,
  PORT = 8080,
} = process.env;

// CORS — allow the live site (comma-separated origins supported)
const origins = ALLOWED_ORIGIN.split(",").map((s) => s.trim());
app.use(cors({ origin: (o, cb) => cb(null, !o || origins.includes(o)) }));

// --- tiny per-IP rate limit to protect credits ---
const hits = new Map();
function limit(max, windowMs) {
  return (req, res, next) => {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: "rate_limited", retryAfterMs: windowMs });
    arr.push(now); hits.set(ip, arr); next();
  };
}

app.get("/health", (_req, res) => res.json({ ok: true, venice: !!VENICE_KEY, spaces: !!SPACES_BUCKET }));

// --- Venice image generation (key stays server-side) ---
app.post("/api/venice/image", limit(20, 3600_000), async (req, res) => {
  if (!VENICE_KEY) return res.status(503).json({ error: "venice_not_configured" });
  const { prompt, width = 1024, height = 1024, model = "nano-banana-pro", negative_prompt } = req.body || {};
  if (!prompt || prompt.length > 1200) return res.status(400).json({ error: "bad_prompt" });
  try {
    const r = await fetch("https://api.venice.ai/api/v1/image/generate", {
      method: "POST",
      headers: { Authorization: `Bearer ${VENICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, width, height, format: "png", return_binary: false, negative_prompt }),
    });
    const j = await r.json();
    if (!j.images?.length) return res.status(502).json({ error: "gen_failed", detail: j.error || "no image" });
    res.json({ image: j.images[0] }); // base64 png
  } catch (e) { res.status(500).json({ error: "server_error", detail: String(e.message || e) }); }
});

// --- Admin upload to Spaces (for Claude/you to add assets) ---
const s3 = (SPACES_KEY && SPACES_BUCKET) ? new S3Client({
  region: SPACES_REGION, endpoint: SPACES_ENDPOINT || `https://${SPACES_REGION}.digitaloceanspaces.com`,
  credentials: { accessKeyId: SPACES_KEY, secretAccessKey: SPACES_SECRET }, forcePathStyle: false,
}) : null;

app.post("/api/upload", async (req, res) => {
  if (!ADMIN_TOKEN || req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) return res.status(401).json({ error: "unauthorized" });
  if (!s3) return res.status(503).json({ error: "spaces_not_configured" });
  const { key, dataBase64, contentType = "application/octet-stream" } = req.body || {};
  if (!key || !dataBase64) return res.status(400).json({ error: "missing_key_or_data" });
  try {
    await s3.send(new PutObjectCommand({ Bucket: SPACES_BUCKET, Key: key, Body: Buffer.from(dataBase64, "base64"), ContentType: contentType, ACL: "public-read" }));
    const url = (SPACES_CDN || `https://${SPACES_BUCKET}.${SPACES_REGION}.cdn.digitaloceanspaces.com`) + "/" + key;
    res.json({ url });
  } catch (e) { res.status(500).json({ error: "upload_failed", detail: String(e.message || e) }); }
});

// --- Leaderboard (in-memory for now; swap for a DB/Spaces JSON later) ---
const boards = {};
app.get("/api/leaderboard/:game", (req, res) => {
  const g = req.params.game; res.json({ game: g, scores: (boards[g] || []).slice(0, 25) });
});
app.post("/api/leaderboard/:game", limit(60, 3600_000), (req, res) => {
  const g = req.params.game; const { name = "anon", score = 0 } = req.body || {};
  if (typeof score !== "number") return res.status(400).json({ error: "bad_score" });
  boards[g] = [...(boards[g] || []), { name: String(name).slice(0, 16), score, t: Date.now() }]
    .sort((a, b) => b.score - a.score).slice(0, 100);
  res.json({ ok: true, rank: boards[g].findIndex((s) => s.score === score) + 1 });
});

app.listen(PORT, () => console.log(`Catboy backend on :${PORT}`));
