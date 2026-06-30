// Vercel Serverless Function — stores allowlist signups in Neon Postgres.
//
// Uses Neon's own serverless driver against the DATABASE_URL that the Neon
// (Vercel) integration injects. Falls back to POSTGRES_URL if present.
//
// View/export signups: Vercel → Storage → your DB → Open in Neon Console →
//   SELECT * FROM allowlist ORDER BY created_at DESC;
// Until a database is connected this returns 503 and the site shows "opens soon".

import { neon } from "@neondatabase/serverless";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CONN = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // No database connected yet → tell the client to show "opens soon".
  if (!CONN) {
    return res.status(503).json({ error: "not_configured" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const email = String(body.email || "").trim().toLowerCase();
    const wallet = String(body.wallet || "").trim() || null;

    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: "invalid_email" });
    }
    if (email.length > 320 || (wallet && wallet.length > 120)) {
      return res.status(400).json({ error: "too_long" });
    }

    const sql = neon(CONN);

    await sql`
      CREATE TABLE IF NOT EXISTS allowlist (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        wallet TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `;

    // RETURNING id yields [] when ON CONFLICT skips the insert (already on list).
    const rows = await sql`
      INSERT INTO allowlist (email, wallet)
      VALUES (${email}, ${wallet})
      ON CONFLICT (email) DO NOTHING
      RETURNING id
    `;

    return res.status(200).json({ ok: true, duplicate: rows.length === 0 });
  } catch (err) {
    // detail is included to help debug setup; safe to remove once it works.
    return res.status(500).json({ error: "server_error", detail: String((err && err.message) || err) });
  }
}
