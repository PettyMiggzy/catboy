// Launchpad backend (BUILD SPEC §2) — one endpoint, three actions.
//
//   metadata : image(base64) + name/symbol/socials -> pump.fun IPFS -> { metadataUri }
//   create   : {publicKey, mint, name, symbol, uri, devBuySol} -> PumpPortal
//              trade-local -> serialized deploy tx (base64). Records mint->dev_wallet.
//   feed     : recent launches for the public feed.
//
// Non-custodial: this never holds keys or funds. The deploy tx is signed in the
// browser (mint keypair + user wallet). See launch.html.
//
// Registry: reuses the project's existing Neon Postgres (DATABASE_URL). The spec
// names Supabase; swap the two query helpers below if you prefer it.

import { neon } from "@neondatabase/serverless";

const CONN = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const IPFS_URL = "https://pump.fun/api/ipfs";
const PUMPPORTAL_URL = "https://pumpportal.fun/api/trade-local";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    return res.status(400).json({ error: "bad_json" });
  }

  try {
    switch (body.action) {
      case "metadata": return await handleMetadata(body, res);
      case "create":   return await handleCreate(body, res);
      case "feed":     return await handleFeed(res);
      default:         return res.status(400).json({ error: "unknown_action" });
    }
  } catch (err) {
    console.error("launch endpoint failed:", err);
    return res.status(500).json({ error: "server_error" });
  }
}

// 1) metadata -> pump.fun IPFS (multipart)
async function handleMetadata(body, res) {
  const { image, name, symbol, description, twitter, telegram, website } = body;
  if (!image || !name || !symbol) return res.status(400).json({ error: "missing_fields" });

  const base64 = image.includes(",") ? image.split(",")[1] : image;
  const mime = (image.match(/^data:(.*?);base64/) || [])[1] || "image/png";
  const bytes = Buffer.from(base64, "base64");

  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type: mime }), "token.png");
  fd.append("name", name);
  fd.append("symbol", symbol);
  fd.append("description", description || "");
  fd.append("twitter", twitter || "");
  fd.append("telegram", telegram || "");
  fd.append("website", website || "");
  fd.append("showName", "true");

  const r = await fetch(IPFS_URL, { method: "POST", body: fd });
  if (!r.ok) return res.status(502).json({ error: "ipfs_failed", status: r.status });
  const data = await r.json();
  return res.status(200).json({ metadataUri: data.metadataUri, metadata: data.metadata });
}

// 2) create -> PumpPortal trade-local (returns serialized VersionedTransaction)
async function handleCreate(body, res) {
  const { publicKey, mint, name, symbol, uri, devBuySol } = body;
  if (!publicKey || !mint || !name || !symbol || !uri) {
    return res.status(400).json({ error: "missing_fields" });
  }

  const r = await fetch(PUMPPORTAL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publicKey,
      action: "create",
      tokenMetadata: { name, symbol, uri },
      mint,
      denominatedInSol: "true",
      amount: Number(devBuySol) || 0, // optional dev buy in SOL
      slippage: 10,
      priorityFee: 0.0005,
      pool: "pump",
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    return res.status(502).json({ error: "create_failed", status: r.status, detail: t.slice(0, 300) });
  }

  const txB64 = Buffer.from(await r.arrayBuffer()).toString("base64");

  // Record mint -> dev wallet for the off-chain fee-share settlement (best effort).
  if (CONN) {
    try {
      const sql = neon(CONN);
      await sql`
        CREATE TABLE IF NOT EXISTS launches (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          mint TEXT UNIQUE NOT NULL,
          dev_wallet TEXT NOT NULL,
          name TEXT,
          symbol TEXT,
          uri TEXT,
          created_at TIMESTAMPTZ DEFAULT now()
        )`;
      await sql`
        INSERT INTO launches (mint, dev_wallet, name, symbol, uri)
        VALUES (${mint}, ${publicKey}, ${name}, ${symbol}, ${uri})
        ON CONFLICT (mint) DO NOTHING`;
    } catch (e) {
      // Non-fatal: the user can still deploy even if the registry write fails.
    }
  }

  return res.status(200).json({ tx: txB64, mint });
}

// 3) feed -> recent launches
async function handleFeed(res) {
  if (!CONN) return res.status(200).json({ launches: [] });
  try {
    const sql = neon(CONN);
    const rows = await sql`
      SELECT mint, name, symbol, created_at
      FROM launches ORDER BY created_at DESC LIMIT 30`;
    return res.status(200).json({ launches: rows });
  } catch {
    return res.status(200).json({ launches: [] });
  }
}
