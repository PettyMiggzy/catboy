// CATBOY — DCA buy-&-burn bot.
//
// People (or you) send SOL to this bot's dedicated wallet. On a schedule it
// spends the balance in small chunks — buying $CATBOY and BURNING every buy —
// stretching whatever's deposited over a rolling window (default 0.x SOL / 7 days).
// Every burn drops supply, so your main bot's burn alert fires too.
//
// ⚠️ HOT WALLET: DCA_SECRET is a live signing key. Put it ONLY in the box's .env,
// never in chat. Fund the wallet ONLY with what you intend to DCA+burn — treat it
// as spendable, not a treasury.
//
// Env (.env in this folder):
//   DCA_SECRET            wallet key — JSON array [1,2,..] OR base58 string (REQUIRED)
//   TOKEN_MINT            $CATBOY mint (falls back to the buy bot's TOKEN_MINT)
//   RPC_URL              full RPC (your Alchemy) — REQUIRED for reliable sends
//   TELEGRAM_BOT_TOKEN   + TELEGRAM_CHAT_ID   to announce buy+burns (optional)
//   NOTIFY_CHAT_ID       your private chat — gets the deposit address on start
//   DCA_DAYS=7           spread the balance over this many days (rolling)
//   DCA_INTERVAL_HOURS=2 buy+burn this often (2 => every 2 hours)
//   DCA_RESERVE_SOL=0.02 keep this much for fees/rent (never spent)
//   DCA_MIN_BUY_SOL=0.005 skip a tick if the per-buy would be below this
//   DCA_SLIPPAGE=15      % · DCA_PRIORITY_SOL=0.00005 priority fee

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey, VersionedTransaction, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount, getMint, createBurnCheckedInstruction } from "@solana/spl-token";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadEnv() {
  try {
    const txt = await fs.readFile(path.join(__dirname, ".env"), "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch {}
}
await loadEnv();

const log = (...a) => console.log(new Date().toISOString(), ...a);
const MINT = (process.env.TOKEN_MINT || "").trim();
const RPC = (process.env.RPC_URL || process.env.SOLANA_RPC || "").trim();
const TG = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const CHAT = (process.env.TELEGRAM_CHAT_ID || "").trim();
const NOTIFY = (process.env.NOTIFY_CHAT_ID || "").trim();
const DAYS = Math.max(1, parseInt(process.env.DCA_DAYS || "7", 10));
const INTERVAL_HOURS = Math.max(0.25, parseFloat(process.env.DCA_INTERVAL_HOURS || "2")); // buy+burn every N hours
const RESERVE = Math.max(0.005, parseFloat(process.env.DCA_RESERVE_SOL || "0.02"));
const MIN_BUY = Math.max(0.001, parseFloat(process.env.DCA_MIN_BUY_SOL || "0.005"));
const SLIPPAGE = parseFloat(process.env.DCA_SLIPPAGE || "15");
const PRIORITY = parseFloat(process.env.DCA_PRIORITY_SOL || "0.00005");
const INTERVAL_MS = Math.round(INTERVAL_HOURS * 60 * 60 * 1000);
const TICKS_TOTAL = Math.max(1, Math.round((DAYS * 24) / INTERVAL_HOURS)); // ticks in the rolling window
const STATE = path.join(__dirname, ".dcastate.json");

if (!MINT || !RPC) { console.error("Set TOKEN_MINT and RPC_URL"); process.exit(1); }
if (!process.env.DCA_SECRET) { console.error("Set DCA_SECRET (hot wallet key)"); process.exit(1); }

function loadKeypair(s) {
  s = s.trim();
  if (s.startsWith("[")) return Keypair.fromSecretKey(new Uint8Array(JSON.parse(s)));
  // base58
  const bs58 = (str) => { const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; let b = [0]; for (const c of str) { let carry = A.indexOf(c); if (carry < 0) throw new Error("bad base58"); for (let j = 0; j < b.length; j++) { carry += b[j] * 58; b[j] = carry & 255; carry >>= 8; } while (carry) { b.push(carry & 255); carry >>= 8; } } for (let k = 0; k < str.length && str[k] === "1"; k++) b.push(0); return new Uint8Array(b.reverse()); };
  return Keypair.fromSecretKey(bs58(s));
}
const kp = loadKeypair(process.env.DCA_SECRET);
const conn = new Connection(RPC, "confirmed");
const OWNER = kp.publicKey;

async function tg(chatId, text) {
  if (!TG || !chatId) return;
  try { await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }) }); } catch (e) { log("tg error", e.message); }
}
const fmt = (n, d = 3) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: d });

async function loadState() { try { return JSON.parse(await fs.readFile(STATE, "utf8")); } catch { return { remaining: TICKS_TOTAL, totalSpent: 0, totalBurned: 0, funded: false, lastBuyAt: 0 }; } }
async function saveState(s) { try { await fs.writeFile(STATE, JSON.stringify(s)); } catch {} }

// Buy via PumpPortal's free local-trade API (returns a tx we sign ourselves).
async function pumpBuy(solAmount) {
  const r = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: OWNER.toBase58(), action: "buy", mint: MINT, amount: solAmount, denominatedInSol: "true", slippage: SLIPPAGE, priorityFee: PRIORITY, pool: "auto" }),
  });
  if (!r.ok) throw new Error("trade-local " + r.status + " " + (await r.text()).slice(0, 120));
  const tx = VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer()));
  tx.sign([kp]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

async function tokenBalanceRaw() {
  try { const ata = await getAssociatedTokenAddress(new PublicKey(MINT), OWNER); const acct = await getAccount(conn, ata); return acct.amount; }
  catch { return 0n; }
}
async function burnAll() {
  const ata = await getAssociatedTokenAddress(new PublicKey(MINT), OWNER);
  const amt = await tokenBalanceRaw();
  if (amt <= 0n) return { burned: 0n, dec: 6 };
  const mintInfo = await getMint(conn, new PublicKey(MINT));
  const ix = createBurnCheckedInstruction(ata, new PublicKey(MINT), OWNER, amt, mintInfo.decimals);
  const tx = new Transaction().add(ix);
  tx.feePayer = OWNER; tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(kp);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  await conn.confirmTransaction(sig, "confirmed");
  return { burned: amt, dec: mintInfo.decimals, sig };
}

const CHECK_MS = Math.max(60000, Math.round(parseFloat(process.env.DCA_CHECK_MIN || "3") * 60000)); // how often we poll (fast, so buys start right after funding)

// Burn ANY $CATBOY sitting in the wallet — catches tokens people send in directly,
// not just the DCA buys. Called every check.
async function burnAnyTokens(st, label) {
  const bal = await tokenBalanceRaw();
  if (bal <= 0n) return 0;
  const { burned, dec, sig } = await burnAll();
  const ui = Number(burned) / 10 ** dec;
  st.totalBurned += ui; await saveState(st);
  log(`${label}: burned ${fmt(ui, 0)} CATBOY (${sig})`);
  return ui;
}

let running = false;
async function check() {
  if (running) return; running = true;
  try {
    const st = await loadState();

    // 1) auto-burn anything sent directly to the wallet (donated CATBOY)
    const donated = await burnAnyTokens(st, "direct-send").catch((e) => { log("burn-send error", e.message); return 0; });
    if (donated > 0) {
      await tg(CHAT, `🔥 <b>${fmt(donated, 0)} $CATBOY sent in &amp; BURNED forever.</b>\nTotal burned: <b>${fmt(st.totalBurned, 0)}</b> 🐾\n<i>Send $CATBOY to the burn wallet to torch it too.</i>`);
    }

    // 2) DCA buy+burn on the pacing interval
    if (st.lastBuyAt && Date.now() - st.lastBuyAt < INTERVAL_MS) { running = false; return; } // not time yet
    if (st.remaining <= 0) st.remaining = TICKS_TOTAL;
    const lamports = await conn.getBalance(OWNER, "confirmed");
    const spendable = lamports / 1e9 - RESERVE;
    if (spendable < MIN_BUY) {
      if (st.funded) { st.funded = false; await saveState(st);
        const m = `⛽ <b>DCA fuel low.</b> The buy-&amp;-burn wallet is out of SOL 🔥\nSend SOL to keep the burns going:\n<code>${OWNER.toBase58()}</code>`;
        await tg(CHAT, m); await tg(NOTIFY, m);
      }
      running = false; return;
    }
    if (!st.funded) st.funded = true;
    const perBuy = Math.max(MIN_BUY, +(spendable / st.remaining).toFixed(4));
    const amount = Math.min(perBuy, +(spendable).toFixed(4));
    log(`DCA buy ${fmt(amount)} SOL (spendable ${fmt(spendable)}, ${st.remaining} ticks left)`);
    const buySig = await pumpBuy(amount);
    await new Promise((r) => setTimeout(r, 3000)); // let the ATA settle
    const { burned, dec, sig: burnSig } = await burnAll();
    const burnedUi = Number(burned) / 10 ** dec;
    st.remaining -= 1; st.totalSpent = +(st.totalSpent + amount).toFixed(4); st.totalBurned += burnedUi; st.lastBuyAt = Date.now();
    await saveState(st);
    log(`bought+burned: ${fmt(burnedUi, 0)} CATBOY for ${fmt(amount)} SOL`);
    await tg(CHAT,
      `🔥 <b>DCA Buy &amp; Burn</b>\n` +
      `Bought <b>${fmt(burnedUi, 0)} $CATBOY</b> for <b>${fmt(amount)} SOL</b> — and burned every one. 🔥\n` +
      `Total burned: <b>${fmt(st.totalBurned, 0)}</b>\n` +
      `<a href="https://solscan.io/tx/${burnSig || buySig}">tx</a> · deflationary cattitude 🐾`);
  } catch (e) {
    log("check error", e.message);
  } finally { running = false; }
}

(async () => {
  log(`CATBOY DCA burn bot — wallet ${OWNER.toBase58()} · buy+burn every ${INTERVAL_HOURS}h over ~${DAYS}d · checks every ${CHECK_MS / 60000}min · reserve ${RESERVE} SOL`);
  await tg(NOTIFY,
    `🔥 <b>CATBOY DCA burn bot online.</b>\nSend <b>SOL</b> here to auto buy-&amp;-burn $CATBOY, or send <b>$CATBOY</b> to burn it directly:\n<code>${OWNER.toBase58()}</code>\nBuy+burn every ${INTERVAL_HOURS}h · reserve ${RESERVE} SOL kept for fees.`);
  check(); // run one now
  setInterval(check, CHECK_MS);
})();
