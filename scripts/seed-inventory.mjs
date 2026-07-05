// One-time: seed the Neon `nft_inventory` table from the collection manifest.
// Each row = one NFT the mint API can hand out (id, tier, name, metadata uri, image).
//
//   DATABASE_URL="postgres://…" \
//   BASE_URL="https://www.catboyonsol.fun" \
//   node scripts/seed-inventory.mjs
//
// Safe to re-run: it upserts (won't wipe `minted`/`asset` on already-sold rows).

import fs from "node:fs";
import { neon } from "@neondatabase/serverless";

const CONN = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const BASE = (process.env.BASE_URL || "https://www.catboyonsol.fun").replace(/\/$/, "");
if (!CONN) { console.error("Set DATABASE_URL"); process.exit(1); }

const s = neon(CONN);
const man = JSON.parse(fs.readFileSync("assets/nft/collection/manifest.json", "utf8"));

await s`CREATE TABLE IF NOT EXISTS nft_inventory (
  id INT PRIMARY KEY, tier TEXT NOT NULL, name TEXT NOT NULL, uri TEXT NOT NULL,
  image TEXT, minted BOOLEAN DEFAULT false, asset TEXT )`;

let n = 0;
for (const it of man) {
  const num = String(it.id).padStart(3, "0");
  const uri = `${BASE}/assets/nft/collection/metadata/${num}.json`;
  const image = `${BASE}/assets/nft/collection/${it.file}`;
  await s`INSERT INTO nft_inventory (id, tier, name, uri, image)
          VALUES (${it.id}, ${it.tier}, ${it.name}, ${uri}, ${image})
          ON CONFLICT (id) DO UPDATE SET tier=EXCLUDED.tier, name=EXCLUDED.name, uri=EXCLUDED.uri, image=EXCLUDED.image`;
  n++;
}
const tiers = await s`SELECT tier, COUNT(*)::int AS n FROM nft_inventory GROUP BY tier ORDER BY n`;
console.log("seeded", n, "items");
console.log("tiers:", tiers.map((t) => `${t.tier}:${t.n}`).join("  "));
