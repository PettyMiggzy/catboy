// $STAG video delivery poller (Vercel Cron, every minute).
// Retrieves queued kling/veo renders; delivers the mp4 to the chat that asked, or
// refunds the credits (unless owner) if the render failed or timed out. Idempotent.
import { neon } from "@neondatabase/serverless";

const CONN = (process.env.DATABASE_URL || process.env.POSTGRES_URL || "").trim();
const TOKEN = (process.env.STAG_BOT_TOKEN || "").trim();
const VIDEO_MODEL = (process.env.STAG_VIDEO_MODEL || "kling-v3-pro-image-to-video").trim();
const CRON_SECRET = (process.env.CRON_SECRET || "").trim();
const MAX_AGE_MS = 20 * 60 * 1000;   // give up (and refund) after 20 min
const BATCH = 3;                     // jobs per run (keeps us under maxDuration)
const TG = (m) => `https://api.telegram.org/bot${TOKEN}/${m}`;
export const config = { maxDuration: 60 };

const VK_PREFIX = "VENICE_INFERENCE_KEY_";
function veniceKey() {
  const direct = process.env.STAG_VENICE_KEY || process.env.VENICE_KEY || process.env.VENICE_API_KEY || process.env.VENICE_INFERENCE_KEY;
  if (direct && direct.startsWith(VK_PREFIX)) return direct;
  const venice = Object.entries(process.env).filter(([n, v]) => /^VENICE/i.test(n) && v);
  for (const [, v] of venice) if (v.startsWith(VK_PREFIX)) return v;
  return direct || (venice[0] && venice[0][1]) || "";
}
async function sendVideo(chatId, buf, caption, replyTo) {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  if (caption) fd.append("caption", caption);
  if (replyTo) { fd.append("reply_to_message_id", String(replyTo)); fd.append("allow_sending_without_reply", "true"); }
  fd.append("video", new Blob([buf], { type: "video/mp4" }), "stag.mp4");
  try { const r = await fetch(TG("sendVideo"), { method: "POST", body: fd }); return await r.json().catch(() => ({})); } catch { return {}; }
}
async function sendMessage(chatId, text, replyTo) {
  try { await fetch(TG("sendMessage"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, reply_to_message_id: replyTo, allow_sending_without_reply: true, text }) }); } catch {}
}

export default async function handler(req, res) {
  // Only Vercel Cron (or a caller who knows CRON_SECRET) may run this if a secret is set.
  if (CRON_SECRET) {
    const auth = req.headers["authorization"] || "";
    if (auth !== `Bearer ${CRON_SECRET}`) return res.status(401).end();
  }
  if (!CONN || !TOKEN) return res.status(200).json({ ok: false, reason: "not_configured" });
  const s = neon(CONN);
  await s`CREATE TABLE IF NOT EXISTS stag_video_jobs (queue_id TEXT PRIMARY KEY, tid TEXT, chat_id TEXT, reply_to TEXT, uname TEXT, credits INT NOT NULL DEFAULT 0, funded TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT now())`;
  const refund = async (j) => { if (j.funded === "balance" && j.credits > 0) await s`INSERT INTO stag_bal (tid, credits) VALUES (${j.tid}, ${j.credits}) ON CONFLICT (tid) DO UPDATE SET credits = stag_bal.credits + ${j.credits}, updated_at = now()`; };
  const key = veniceKey();
  const jobs = await s`SELECT * FROM stag_video_jobs WHERE status='pending' ORDER BY created_at ASC LIMIT ${BATCH}`;
  let delivered = 0, failed = 0, pending = 0;
  for (const j of jobs) {
    if (Date.now() - new Date(j.created_at).getTime() > MAX_AGE_MS) {
      await refund(j);
      await s`UPDATE stag_video_jobs SET status='failed' WHERE queue_id=${j.queue_id} AND status='pending'`;
      await sendMessage(j.chat_id, "⚠️ That video took too long and was cancelled - your credits are refunded. Try again. 🦌", j.reply_to);
      failed++; continue;
    }
    let r;
    try {
      r = await fetch("https://api.venice.ai/api/v1/video/retrieve", {
        method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({ queue_id: j.queue_id, model: VIDEO_MODEL }),
      });
    } catch { pending++; continue; } // transient — try again next tick
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("json") || ct.includes("text")) {
      const jj = await r.json().catch(() => ({}));
      const st = String(jj.status || "").toUpperCase();
      if (["PROCESSING", "PENDING", "QUEUED", "RUNNING", "IN_PROGRESS"].includes(st)) { pending++; continue; }
      // anything else on the JSON path = a real failure
      await refund(j);
      await s`UPDATE stag_video_jobs SET status='failed' WHERE queue_id=${j.queue_id} AND status='pending'`;
      await sendMessage(j.chat_id, "⚠️ The video render failed - your credits are refunded. Try again. 🦌", j.reply_to);
      failed++; continue;
    }
    // binary body = finished mp4
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 2000) { pending++; continue; } // not really ready
    // Claim atomically (mark done) so two overlapping cron runs can't double-send.
    const claim = await s`UPDATE stag_video_jobs SET status='done' WHERE queue_id=${j.queue_id} AND status='pending' RETURNING queue_id`;
    if (!claim.length) continue;
    const sent = await sendVideo(j.chat_id, buf, `🎥 ${j.uname || "ranger"}, your $STAG video is ready. 🏹🦌`, j.reply_to);
    if (sent && sent.ok) { delivered++; }
    else { await s`UPDATE stag_video_jobs SET status='pending' WHERE queue_id=${j.queue_id}`; pending++; } // Telegram rejected it -> back to pending, retry next tick (20-min cap still refunds)
  }
  return res.status(200).json({ ok: true, scanned: jobs.length, delivered, failed, pending });
}
