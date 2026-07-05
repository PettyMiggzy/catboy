// Generate a fresh dedicated mint wallet. Writes mint-wallet.json (the secret,
// stays ONLY on this machine) and prints the PUBLIC address to fund/use.
//   node scripts/new-wallet.mjs
import fs from "node:fs";
import { Keypair } from "@solana/web3.js";

if (fs.existsSync("mint-wallet.json")) {
  console.error("mint-wallet.json already exists — refusing to overwrite. Delete it first if you really mean to.");
  process.exit(1);
}
const kp = Keypair.generate();
fs.writeFileSync("mint-wallet.json", JSON.stringify(Array.from(kp.secretKey)));
console.log("Created mint-wallet.json (keep this file secret, never commit or paste it).\n");
console.log("PUBLIC address — fund this, and use it as NFT_MINT_WALLET:");
console.log(kp.publicKey.toString());
