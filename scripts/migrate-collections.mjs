// One-time: add a `collection` column so nft_inventory holds multiple collections.
//   DATABASE_URL="..." node scripts/migrate-collections.mjs
import { neon } from "@neondatabase/serverless";
const s = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);
await s.query("ALTER TABLE nft_inventory ADD COLUMN IF NOT EXISTS collection TEXT NOT NULL DEFAULT 'nine'");
await s.query("ALTER TABLE nft_orders ADD COLUMN IF NOT EXISTS collection TEXT DEFAULT 'nine'");
const c = await s`SELECT collection, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE minted)::int AS minted FROM nft_inventory GROUP BY collection`;
console.log("inventory by collection:", JSON.stringify(c));
