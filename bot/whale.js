// Whale-group gate — Telegram side.
//   /whale                 -> DMs the user a personal verify link (opens whale.html)
//   /setwhale <amount>     -> (admin) set the min $CATBOY threshold  (accepts 10m, 1b, 5000000)
//   /whalenft on|off       -> (admin) toggle the "or owns a Catboy NFT" gate
//   /whalestatus           -> (admin) show config + member count
// Plus a periodic re-check that removes members whose wallet fell below the bar.
//
// Env: DATABASE_URL, WHALE_CHAT_ID, WHALE_SECRET (must match the site's),
//      WHALE_SITE (default https://www.catboyonsol.fun), WHALE_RECHECK_MIN (default 30),
//      TOKEN_MINT, NFT_COLLECTION[_GENESIS|_PRIDE]
import { neon } from "@neondatabase/serverless";
import crypto from "node:crypto";

const CONN = (process.env.DATABASE_URL || process.env.POSTGRES_URL || "").trim();
const WHALE_CHAT = (process.env.WHALE_CHAT_ID || "").trim();
const SECRET = (process.env.WHALE_SECRET || "").trim();
const SITE = (process.env.WHALE_SITE || "https://www.catboyonsol.fun").replace(/\/$/, "");
const RECHECK_MS = Math.max(5, parseInt(process.env.WHALE_RECHECK_MIN || "30", 10)) * 60000;
const MINT = (process.env.TOKEN_MINT || "").trim();
// Collection addresses are public on-chain ids (not secrets) — default to the
// known Catboy collections so the droplet doesn't need to set them.
const DEFAULT_COLLECTIONS = ["33kxQv4Jo7u9edC4RipZckwkpRRdxg863b6cw2UGfh6S", "HuLA9RRuG6s994eAiiY4cFhrhghCkCQWcNdm3e3wVD3x", "4N1d9umoscMYiwiqxXnkTbJD9pXLMZiPCw4H7fAUK93x"];
const _envColls = [process.env.NFT_COLLECTION, process.env.NFT_COLLECTION_GENESIS, process.env.NFT_COLLECTION_PRIDE].map((x) => (x || "").trim()).filter(Boolean);
const COLLECTIONS = _envColls.length ? _envColls : DEFAULT_COLLECTIONS;
const DEFAULT_MIN = 10_000_000;

const sql = () => (CONN ? neon(CONN) : null);
const hmac = (data) => crypto.createHmac("sha256", SECRET).update(data).digest("hex");
const fmtN = (n) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
// "10m" -> 10_000_000, "1b" -> 1e9, "2.5k" -> 2500, plain numbers pass through
function parseAmount(s) {
  const m = String(s || "").trim().toLowerCase().replace(/[, _]/g, "").match(/^([\d.]+)\s*([kmb])?$/);
  if (!m) return NaN;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

export async function whaleConfig() {
  const s = sql(); if (!s) return { minTokens: DEFAULT_MIN, nftGate: true };
  await s`CREATE TABLE IF NOT EXISTS whale_config (id INT PRIMARY KEY DEFAULT 1, min_tokens NUMERIC NOT NULL DEFAULT ${DEFAULT_MIN}, nft_gate BOOLEAN NOT NULL DEFAULT true)`;
  await s`CREATE TABLE IF NOT EXISTS whale_wallets (wallet TEXT PRIMARY KEY, tid TEXT NOT NULL, verified_at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE INDEX IF NOT EXISTS whale_wallets_tid ON whale_wallets (tid)`;
  await s`CREATE TABLE IF NOT EXISTS whale_members (tid TEXT PRIMARY KEY, joined_at TIMESTAMPTZ DEFAULT now())`;
  const r = await s`SELECT min_tokens, nft_gate FROM whale_config WHERE id=1`;
  if (!r.length) { await s`INSERT INTO whale_config (id) VALUES (1) ON CONFLICT DO NOTHING`; return { minTokens: DEFAULT_MIN, nftGate: true }; }
  return { minTokens: Number(r[0].min_tokens), nftGate: !!r[0].nft_gate };
}

async function rpc(rpcUrl, method, params) {
  const r = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
async function balanceOf(rpcUrl, wallet) {
  try { const r = await rpc(rpcUrl, "getTokenAccountsByOwner", [wallet, { mint: MINT }, { encoding: "jsonParsed" }]);
    let s = 0; for (const v of (r.value || [])) s += Number(v.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0); return s;
  } catch { return 0; }
}
async function ownsNft(rpcUrl, wallet) {
  if (!COLLECTIONS.length) return false;
  try { const r = await rpc(rpcUrl, "getAssetsByOwner", { ownerAddress: wallet, page: 1, limit: 1000 });
    for (const a of (r?.items || [])) {
      const g = (a.grouping || []).find((x) => x.group_key === "collection");
      if (g && COLLECTIONS.includes(g.group_value)) return true;
    }
    return false;
  } catch { return false; }
}

// ---- command handling. ctx = { API, tgSendTo, isAdmin, CFG, log } ----
export async function whaleCommand(cmd, arg, m, ctx) {
  const { API, tgSendTo, isAdmin, log } = ctx;
  if (cmd === "/whale" || cmd === "/verify") {
    if (!SECRET || !WHALE_CHAT) return tgSendTo(m.chat.id, "🐋 Whale verification isn't configured yet.");
    const tid = m.from && m.from.id;
    if (!tid) return tgSendTo(m.chat.id, "Couldn't read your Telegram id — try again.");
    const t = Date.now();
    const link = `${SITE}/whale.html?tid=${tid}&t=${t}&h=${hmac(`${tid}.${t}`)}`;
    const dm = await fetch(`${API}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: tid, parse_mode: "HTML",
        text: "🐋 <b>Whale Verification</b>\nTap below, connect your wallet and sign (free — no transaction). If you qualify, you'll get a one-time invite to the whale group.",
        reply_markup: { inline_keyboard: [[{ text: "🔓 Verify Wallet", url: link }]] } }) }).then(r => r.json()).catch(() => ({}));
    if (dm && dm.ok) { if (m.chat.type !== "private") return tgSendTo(m.chat.id, "📩 Sent you a DM — verify there to join the whale group. 🐋"); return; }
    // couldn't DM (user hasn't started the bot) — point them to open it
    const botLink = ctx.botUsername ? `https://t.me/${ctx.botUsername}?start=whale` : link;
    return tgSendTo(m.chat.id, `Start a chat with me first, then send <b>/whale</b> again. 👉 <a href="${botLink}">Open bot</a>`);
  }
  if (!isAdmin(m)) return false;
  if (cmd === "/setwhale") {
    const n = parseAmount(arg);
    if (!isFinite(n) || n < 0) return tgSendTo(m.chat.id, "Usage: <code>/setwhale 10m</code> (or 5000000, 1b).");
    const s = sql(); if (!s) return tgSendTo(m.chat.id, "DB not configured.");
    await s`INSERT INTO whale_config (id, min_tokens) VALUES (1, ${n}) ON CONFLICT (id) DO UPDATE SET min_tokens=${n}`;
    log && log("whale threshold set:", n);
    return tgSendTo(m.chat.id, `✅ Whale threshold set to <b>${fmtN(n)} $CATBOY</b>. Applies to new verifies + the next re-check.`);
  }
  if (cmd === "/whalenft") {
    const on = /^(on|1|yes|true)$/i.test(arg);
    const off = /^(off|0|no|false)$/i.test(arg);
    if (!on && !off) return tgSendTo(m.chat.id, "Usage: <code>/whalenft on</code> or <code>/whalenft off</code>.");
    const s = sql(); if (!s) return tgSendTo(m.chat.id, "DB not configured.");
    await s`INSERT INTO whale_config (id, nft_gate) VALUES (1, ${on}) ON CONFLICT (id) DO UPDATE SET nft_gate=${on}`;
    return tgSendTo(m.chat.id, `✅ NFT gate <b>${on ? "ON" : "OFF"}</b> — holders ${on ? "can" : "cannot"} qualify by owning a Catboy NFT.`);
  }
  if (cmd === "/whalestatus") {
    const cfg = await whaleConfig();
    const s = sql();
    const cnt = s ? (await s`SELECT count(*)::int AS n FROM whale_members`)[0].n : 0;
    const wcnt = s ? (await s`SELECT count(*)::int AS n FROM whale_wallets`)[0].n : 0;
    return tgSendTo(m.chat.id,
      `🐋 <b>Whale gate</b>\nThreshold: <b>${fmtN(cfg.minTokens)} $CATBOY</b> (summed across a member's wallets)\nNFT gate: <b>${cfg.nftGate ? "on" : "off"}</b>\n` +
      `Members: <b>${cnt}</b> · linked wallets: <b>${wcnt}</b>\nGroup set: <b>${WHALE_CHAT ? "yes" : "NO — set WHALE_CHAT_ID"}</b>\n` +
      `Re-check every <b>${RECHECK_MS / 60000}m</b>\n\n<code>/setwhale 10m</code> · <code>/whalenft on|off</code>`);
  }
  return false;
}

export function startWhaleEnforcement(ctx) {
  const { API, CFG, log, tgSendTo } = ctx;
  if (!CONN || !WHALE_CHAT) { log && log("whale enforcement off (need DATABASE_URL + WHALE_CHAT_ID)"); return; }
  async function kick(tid) {
    // ban then unban = remove without a permanent ban (they can re-verify later)
    await fetch(`${API}/banChatMember`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: WHALE_CHAT, user_id: Number(tid) }) }).catch(() => {});
    await fetch(`${API}/unbanChatMember`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: WHALE_CHAT, user_id: Number(tid), only_if_banned: true }) }).catch(() => {});
  }
  async function sweep() {
    try {
      const cfg = await whaleConfig();
      const s = sql(); if (!s) return;
      const members = await s`SELECT tid FROM whale_members`;
      let removed = 0;
      for (const mem of members) {
        // sum across ALL of this member's verified wallets (supply may be spread around)
        const wallets = (await s`SELECT wallet FROM whale_wallets WHERE tid=${mem.tid}`).map((r) => r.wallet);
        let total = 0, nft = false;
        for (const w of wallets) { total += await balanceOf(CFG.rpcUrl, w); if (cfg.nftGate && !nft && await ownsNft(CFG.rpcUrl, w)) nft = true; }
        if (total >= cfg.minTokens || nft) continue;
        await kick(mem.tid);
        await s`DELETE FROM whale_members WHERE tid=${mem.tid}`;
        removed++;
        log && log("whale removed:", mem.tid, "total", total, "across", wallets.length, "wallet(s)");
      }
      if (removed) log && log(`whale sweep: removed ${removed} below-threshold member(s)`);
    } catch (e) { log && log("whale sweep error", e.message); }
  }
  setInterval(sweep, RECHECK_MS);
  setTimeout(sweep, 60000); // first sweep a minute after boot
  log && log(`whale enforcement ON — re-check every ${RECHECK_MS / 60000}m, group ${WHALE_CHAT}`);
}
