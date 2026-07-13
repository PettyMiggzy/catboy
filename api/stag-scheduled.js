// $STAG scheduled broadcaster (runs every minute; DB-timestamp gated, restart-robust).
// Two recurring posts, each fired only when its interval has elapsed since the last send:
//   - promo_video : the $STAG money-printer promo video  -> announce chat, every 4h
//   - whale_info  : how to join the $STAG Whale Club      -> announce chat, every 3h
// The per-job "last_at" lives in Postgres, so restarts/redeploys never double-post and
// never drift: a slot fires at most once per interval no matter how many crons overlap.
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONN = (process.env.DATABASE_URL || process.env.POSTGRES_URL || "").trim();
const TOKEN = (process.env.STAG_BOT_TOKEN || "").trim();
const ANNOUNCE = (process.env.STAG_ANNOUNCE_CHAT || "-1003369963744").trim();
const WHALE_INFO_CHAT = (process.env.STAG_WHALE_INFO_CHAT || ANNOUNCE).trim(); // where the "join the club" post goes
const STAG = (process.env.STAG_TOKEN || "0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49").toLowerCase();
const CRON_SECRET = (process.env.CRON_SECRET || "").trim();
const VIDEO_PATH = (process.env.STAG_PROMO_VIDEO || join(process.cwd(), "assets", "stag-money-printer.mp4"));
const VIDEO_EVERY_MS = parseFloat(process.env.STAG_PROMO_HOURS || "4") * 3600 * 1000;
const WHALE_EVERY_MS = parseFloat(process.env.STAG_WHALE_INFO_HOURS || "3") * 3600 * 1000;
const TG = (m) => `https://api.telegram.org/bot${TOKEN}/${m}`;
export const config = { maxDuration: 60 };

const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 4 });

async function stagStats() {
  try {
    const r = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + STAG, { headers: { "User-Agent": "Mozilla/5.0" } });
    const j = await r.json();
    const p = (j.pairs || []).sort((a, b) => ((b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)))[0];
    if (!p) return null;
    return { price: Number(p.priceUsd) || 0, mc: Number(p.marketCap || p.fdv || 0) || 0 };
  } catch { return null; }
}

async function tgJSON(method, body) {
  try { const r = await fetch(TG(method), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return await r.json(); }
  catch { return { ok: false }; }
}

// Send the promo video. Prefer a cached Telegram file_id (instant, no re-upload); the
// first send uploads the file and caches the returned file_id for every send after.
async function sendPromoVideo(s, chat, caption) {
  const c = await s`SELECT cache FROM stag_sched WHERE job='promo_video'`;
  const fid = c.length ? c[0].cache : null;
  if (fid) {
    const j = await tgJSON("sendVideo", { chat_id: chat, video: fid, caption, parse_mode: "Markdown", supports_streaming: true });
    if (j.ok) return true;               // cached id worked
    // else fall through and re-upload (id may have expired / been wiped)
  }
  let buf; try { buf = readFileSync(VIDEO_PATH); } catch (e) { console.error("[scheduled] video read", e && e.message); return false; }
  const fd = new FormData();
  fd.append("chat_id", String(chat));
  fd.append("caption", caption);
  fd.append("parse_mode", "Markdown");
  fd.append("supports_streaming", "true");
  fd.append("video", new Blob([buf], { type: "video/mp4" }), "stag-money-printer.mp4");
  let j; try { const r = await fetch(TG("sendVideo"), { method: "POST", body: fd }); j = await r.json(); } catch { return false; }
  if (!j.ok) return false;
  const newFid = j.result?.video?.file_id;
  if (newFid) await s`UPDATE stag_sched SET cache=${newFid} WHERE job='promo_video'`;
  return true;
}

export default async function handler(req, res) {
  if (CRON_SECRET) { if ((req.headers["authorization"] || "") !== `Bearer ${CRON_SECRET}`) return res.status(401).end(); }
  if (!CONN || !TOKEN) return res.status(200).json({ ok: false, reason: "not_configured" });
  const s = neon(CONN);
  await s`CREATE TABLE IF NOT EXISTS stag_sched (job TEXT PRIMARY KEY, last_at TIMESTAMPTZ, cache TEXT)`;

  const st = await stagStats();
  const priceLine = st && st.price ? `\n\n💚 $STAG: *$${st.price < 0.01 ? st.price.toPrecision(3) : fmt(st.price)}*${st.mc ? `  ·  MC *$${fmt(st.mc)}*` : ""}` : "";

  const jobs = [
    {
      job: "promo_video", everyMs: VIDEO_EVERY_MS,
      send: () => sendPromoVideo(s, ANNOUNCE,
        `🖨️💚 *$STAG NEVER STOPS PRINTING GREEN*\n\nFixed supply: *1,000,000,000 $STAG*. Scarce by design, no dilution, ever. The Hood eats. 🦌🏹${priceLine}\n\n[Chart](https://dexscreener.com/robinhood/${STAG})`),
    },
    {
      job: "whale_info", everyMs: WHALE_EVERY_MS,
      send: () => tgJSON("sendMessage", {
        chat_id: WHALE_INFO_CHAT, parse_mode: "Markdown", disable_web_page_preview: true,
        text: `🐋💚 *$STAG WHALE CLUB*\n\nBig holders get their own room. Hold *10M+ $STAG* - across as many wallets as you want - and you are in.\n\n🔔 Live whale-buy alerts\n🤝 Whales-only chat\n🏆 First look at what is coming\n\n*How to join:* DM me \`/whale\` and follow the steps. You prove your bag with a tiny dust transaction, paste the hash, and I DM you a private one-time invite. Your wallet info is never stored.\n\nHold the bag. Steal the pump. 🦌🏹${priceLine}`,
      }).then((j) => j.ok),
    },
  ];

  const now = Date.now();
  const threshold = (ms) => new Date(now - ms).toISOString();
  const out = {};
  for (const j of jobs) {
    // Read prior send time so we can (a) decide if due and (b) roll back on a failed send.
    const prev = await s`SELECT last_at FROM stag_sched WHERE job=${j.job}`;
    const prevAt = prev.length ? prev[0].last_at : null;
    const due = !prevAt || (now - new Date(prevAt).getTime()) >= j.everyMs;
    if (!due) { out[j.job] = "waiting"; continue; }
    // Atomically claim this slot: only one overlapping run wins the UPDATE/INSERT.
    const claim = await s`
      INSERT INTO stag_sched (job, last_at) VALUES (${j.job}, now())
      ON CONFLICT (job) DO UPDATE SET last_at = now()
      WHERE stag_sched.last_at IS NULL OR stag_sched.last_at <= ${threshold(j.everyMs)}
      RETURNING job`;
    if (!claim.length) { out[j.job] = "claimed_elsewhere"; continue; }
    let ok = false; try { ok = await j.send(); } catch (e) { console.error(`[scheduled] ${j.job}`, e && e.message); }
    if (ok) { out[j.job] = "sent"; }
    else {
      // Send failed: restore the previous timestamp so it retries next minute instead of
      // silently waiting a full interval.
      if (prevAt) await s`UPDATE stag_sched SET last_at=${prevAt} WHERE job=${j.job}`;
      else await s`DELETE FROM stag_sched WHERE job=${j.job}`;
      out[j.job] = "send_failed";
    }
  }
  return res.status(200).json({ ok: true, ...out });
}
