// Vercel Serverless Function — stores allowlist signups in Vercel Postgres.
//
// Setup (one time):
//   1. Vercel dashboard → your project → Storage → Create Database → Postgres,
//      and connect it to this project. That injects POSTGRES_URL automatically.
//   2. Redeploy. That's it — signups land in the `allowlist` table.
//
// View/export: Vercel → Storage → your DB → Data, or run
//   SELECT * FROM allowlist ORDER BY created_at DESC;
// Until the DB is connected this returns 503 and the site shows "opens soon".

import { sql } from "@vercel/postgres";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // No database connected yet → tell the client to show "opens soon".
  if (!process.env.POSTGRES_URL) {
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

    await sql`
      CREATE TABLE IF NOT EXISTS allowlist (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        wallet TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `;

    const result = await sql`
      INSERT INTO allowlist (email, wallet)
      VALUES (${email}, ${wallet})
      ON CONFLICT (email) DO NOTHING
    `;

    // rowCount === 0 means the email was already on the list.
    return res.status(200).json({ ok: true, duplicate: result.rowCount === 0 });
  } catch (err) {
    return res.status(500).json({ error: "server_error" });
  }
}
