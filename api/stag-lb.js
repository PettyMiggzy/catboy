// Vercel Serverless Function — global leaderboard for the STAG ARCHERY game.
//
// The game is a self-contained HTML served cross-origin (e.g. via githack), so
// this endpoint is intentionally CORS-open (public read + write) — unlike the
// same-origin site endpoints. Scores live in Neon Postgres (DATABASE_URL).
//
//   GET  /api/stag-lb        → { ok, top: [{ n, s }] }  (best score per name)
//   POST /api/stag-lb  {n,s} → { ok, rank }
//
// Inspect: Vercel → Storage → DB → Neon console →
//   SELECT name, MAX(score) FROM stag_scores GROUP BY name ORDER BY 2 DESC;

import { neon } from "@neondatabase/serverless";

const CONN = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const MAX_SCORE = 100000;          // reject obviously-garbage values, allow real high runs
const TOP_N = 25;

// Best-effort per-warm-instance rate limit (a durable one would need Vercel KV).
const HITS = new Map();
function rateLimited(ip) {
  const now = Date.now(), win = 60000, max = 20;
  const arr = (HITS.get(ip) || []).filter((t) => now - t < win);
  arr.push(now); HITS.set(ip, arr);
  return arr.length > max;
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!CONN) return res.status(503).json({ error: "not_configured" });

  const sql = neon(CONN);
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS stag_scores (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name TEXT NOT NULL,
        score INT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `;

    if (req.method === "GET") {
      const rows = await sql`
        SELECT name, MAX(score) AS score
        FROM stag_scores
        GROUP BY name
        ORDER BY score DESC, MIN(created_at) ASC
        LIMIT ${TOP_N}
      `;
      return res.status(200).json({ ok: true, top: rows.map((r) => ({ n: r.name, s: Number(r.score) })) });
    }

    if (req.method === "POST") {
      const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
      if (rateLimited(ip)) return res.status(429).json({ error: "rate_limited" });

      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const name = String(body.n || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
      const score = Math.floor(Number(body.s));
      if (!name) return res.status(400).json({ error: "bad_name" });
      if (!Number.isFinite(score) || score < 0 || score > MAX_SCORE) return res.status(400).json({ error: "bad_score" });

      await sql`INSERT INTO stag_scores (name, score) VALUES (${name}, ${score})`;

      const [{ rank }] = await sql`
        SELECT COUNT(*) + 1 AS rank
        FROM (SELECT name, MAX(score) AS score FROM stag_scores GROUP BY name) t
        WHERE t.score > ${score}
      `;
      return res.status(200).json({ ok: true, rank: Number(rank) });
    }

    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    console.error("stag-lb failed:", err);
    return res.status(500).json({ error: "server_error" });
  }
}
