// One-time: create the Metaplex Core collection for the Catboy NFT mint.
// Run on any machine with the mint wallet's keypair file.
//
//   npm install
//   RPC="https://api.devnet.solana.com" \
//   KEYPAIR=./mint-wallet.json \
//   CREATOR_WALLET=<your royalty payout wallet> \
//   ROYALTY_PCT=5 \
//   node scripts/create-collection.mjs
//
// It prints:  NFT_COLLECTION=<address>   -> put that in Vercel env.
// TEST ON DEVNET FIRST (default RPC is devnet). Switch RPC to mainnet when ready.

import fs from "node:fs";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { keypairIdentity, generateSigner, publicKey } from "@metaplex-foundation/umi";
import { createCollection, mplCore, ruleSet } from "@metaplex-foundation/mpl-core";

const RPC = process.env.RPC || "https://api.devnet.solana.com";
const KEYPAIR = process.env.KEYPAIR || "./mint-wallet.json";
const NAME = process.env.COLLECTION_NAME || "Catboy — Nine Lives Collection";
const URI = process.env.COLLECTION_URI || "https://www.catboyonsol.fun/assets/nft/collection/metadata/collection.json";
const ROYALTY_PCT = parseFloat(process.env.ROYALTY_PCT || "5");
const CREATOR = process.env.CREATOR_WALLET || "";

const secret = new Uint8Array(JSON.parse(fs.readFileSync(KEYPAIR, "utf8")));
const umi = createUmi(RPC).use(mplCore());
umi.use(keypairIdentity(umi.eddsa.createKeypairFromSecretKey(secret)));

const creator = CREATOR ? publicKey(CREATOR) : umi.identity.publicKey;
const collection = generateSigner(umi);
console.log("network:", RPC);
console.log("authority:", umi.identity.publicKey.toString());
console.log("creating collection…");
await createCollection(umi, {
  collection,
  name: NAME,
  uri: URI,
  plugins: [
    { type: "Royalties", basisPoints: Math.round(ROYALTY_PCT * 100), creators: [{ address: creator, percentage: 100 }], ruleSet: ruleSet("None") },
  ],
}).sendAndConfirm(umi);
console.log("\nDONE. Set this in Vercel env:");
console.log("NFT_COLLECTION=" + collection.publicKey.toString());
