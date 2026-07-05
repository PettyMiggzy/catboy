// Devnet proof: mint ONE NFT from the collection to a recipient, using the exact
// same mpl-core create() call the mint API uses. Proves on-chain minting works.
//
//   RPC="https://api.devnet.solana.com" KEYPAIR=./mint-wallet.json \
//   COLLECTION=<collection addr> TO=<your Phantom devnet address> \
//   node scripts/test-mint.mjs
//
// Omit TO to mint to the mint wallet itself.

import fs from "node:fs";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { keypairIdentity, generateSigner, publicKey } from "@metaplex-foundation/umi";
import { create, fetchCollection, mplCore } from "@metaplex-foundation/mpl-core";

const RPC = process.env.RPC || "https://api.devnet.solana.com";
const COLLECTION = process.env.COLLECTION;
const TO = process.env.TO || "";
const URI = process.env.URI || "https://www.catboyonsol.fun/assets/nft/collection/metadata/001.json";
const NAME = process.env.NAME || "Catboy #001";
if (!COLLECTION) { console.error("Set COLLECTION=<collection address>"); process.exit(1); }

const secret = new Uint8Array(JSON.parse(fs.readFileSync(process.env.KEYPAIR || "./mint-wallet.json", "utf8")));
const umi = createUmi(RPC).use(mplCore());
umi.use(keypairIdentity(umi.eddsa.createKeypairFromSecretKey(secret)));

const to = TO ? publicKey(TO) : umi.identity.publicKey;
const asset = generateSigner(umi);
console.log("minting", NAME, "->", to.toString(), "…");
const collection = await fetchCollection(umi, publicKey(COLLECTION));
await create(umi, { asset, collection, name: NAME, uri: URI, owner: to }).sendAndConfirm(umi);
console.log("\n✅ MINTED");
console.log("asset:", asset.publicKey.toString());
console.log("owner:", to.toString());
console.log("view:  https://core.metaplex.com/explorer/" + asset.publicKey.toString() + "?env=devnet");
