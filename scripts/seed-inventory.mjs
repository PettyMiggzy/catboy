// One-time: seed the Neon `nft_inventory` table from a collection manifest.
// Each row = one NFT the mint API can hand out (id, tier, name, metadata uri, image).
//
//   # Nine Lives (default)
//   DATABASE_URL="postgres://…" BASE_URL="https://www.catboyonsol.fun" \
//   node scripts/seed-inventory.mjs
//
//   # Genesis / Pride
//   DATABASE_URL="postgres://…" COLLECTION=genesis node scripts/seed-inventory.mjs
//   DATABASE_URL="postgres://…" COLLECTION=pride   node scripts/seed-inventory.mjs
//
// Safe to re-run: it upserts (won't wipe `minted`/`asset` on already-sold rows).
// Each collection lives in a separate id range so the INT primary key never
// collides: nine = id, genesis = 1000+id, pride = 2000+id.

import fs from "node:fs";
import { neon } from "@neondatabase/serverless";

const CONN = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const BASE = (process.env.BASE_URL || "https://www.catboyonsol.fun").replace(/\/$/, "");
const COLLECTION = (process.env.COLLECTION || "nine").trim();
if (!CONN) { console.error("Set DATABASE_URL"); process.exit(1); }

// dir = folder under assets/nft; offset = id range so PKs never collide.
const COLLS = {
  nine:    { dir: "collection", offset: 0 },
  genesis: { dir: "genesis",    offset: 1000 },
  pride:   { dir: "pride",      offset: 2000 },
};
const cfg = COLLS[COLLECTION];
if (!cfg) { console.error("Unknown COLLECTION:", COLLECTION, "— use nine|genesis|pride"); process.exit(1); }

const s = neon(CONN);
const man = JSON.parse(fs.readFileSync(`assets/nft/${cfg.dir}/manifest.json`, "utf8"));

await s`CREATE TABLE IF NOT EXISTS nft_inventory (
  id INT PRIMARY KEY, tier TEXT NOT NULL, name TEXT NOT NULL, uri TEXT NOT NULL,
  image TEXT, minted BOOLEAN DEFAULT false, asset TEXT,
  collection TEXT NOT NULL DEFAULT 'nine' )`;
await s`ALTER TABLE nft_inventory ADD COLUMN IF NOT EXISTS collection TEXT NOT NULL DEFAULT 'nine'`;

let n = 0;
for (const it of man) {
  const id = cfg.offset + it.id;
  const num = String(it.id).padStart(3, "0");
  const uri = `${BASE}/assets/nft/${cfg.dir}/metadata/${num}.json`;
  const image = `${BASE}/assets/nft/${cfg.dir}/${it.file}`;
  await s`INSERT INTO nft_inventory (id, tier, name, uri, image, collection)
          VALUES (${id}, ${it.tier}, ${it.name}, ${uri}, ${image}, ${COLLECTION})
          ON CONFLICT (id) DO UPDATE SET tier=EXCLUDED.tier, name=EXCLUDED.name,
            uri=EXCLUDED.uri, image=EXCLUDED.image, collection=EXCLUDED.collection`;
  n++;
}
const tiers = await s`SELECT tier, COUNT(*)::int AS n FROM nft_inventory WHERE collection=${COLLECTION} GROUP BY tier ORDER BY n`;
console.log(`seeded ${n} items into collection '${COLLECTION}' (id range ${cfg.offset + 1}–${cfg.offset + n})`);
console.log("tiers:", tiers.map((t) => `${t.tier}:${t.n}`).join("  "));
