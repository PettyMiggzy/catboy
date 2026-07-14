// STAG Telegram bot — standalone always-hot runner.
//
// Reuses the EXACT same handler as the Vercel deploy (../api/stag-bot.js) but drives it
// with Telegram long-polling (getUpdates) instead of a webhook. On a persistent process
// there are NO cold starts, and the in-memory file_id cache + Neon connection stay warm
// forever, so replies are consistently fast. No public URL / HTTPS needed.
//
//   pm2 start bot-server/ecosystem.config.cjs        (recommended)
//   # or:  node --env-file=bot-server/.env bot-server/index.mjs   (Node 20+)
//
// IMPORTANT: run from the REPO ROOT (the handler reads assets/trivia via process.cwd()).
// Telegram allows only ONE of webhook OR polling — this clears the webhook on startup.
import handler from "../api/stag-bot.js";

const TOKEN = (process.env.STAG_BOT_TOKEN || "").trim();
const SECRET = (process.env.STAG_BOT_SECRET || "").trim();
if (!TOKEN) { console.error("FATAL: STAG_BOT_TOKEN not set"); process.exit(1); }
if (!SECRET) console.warn("WARN: STAG_BOT_SECRET not set — the handler treats itself as not_configured; set it.");
const API = `https://api.telegram.org/bot${TOKEN}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal Vercel-style res stub: the handler's res.status().json()/.end() calls are just the
// webhook ack, which polling doesn't need. Real replies go out via the handler's own tg() sends.
const mkRes = () => { const res = { statusCode: 200, setHeader: () => res, status: (c) => ((res.statusCode = c), res), json: () => res, end: () => res, send: () => res }; return res; };

async function dispatch(update) {
  const req = { method: "POST", headers: { "x-telegram-bot-api-secret-token": SECRET }, body: update };
  try { await handler(req, mkRes()); }
  catch (e) { console.error("[handler]", update.update_id, (e && e.message) || e); }
}

async function tgJSON(path) {
  const r = await fetch(`${API}/${path}`, { signal: AbortSignal.timeout(65000) });
  return r.json();
}

// Optional: also run the on-chain announcer + video-render poller here (set RUN_CRONS=1).
// Leave OFF if those still run on Vercel — the DB dedup makes double-runs safe, but one
// place is cleaner. Each runs once/minute, same as the Vercel cron schedule.
async function maybeStartCrons() {
  if (process.env.RUN_CRONS !== "1") return;
  const tick = async (mod, label) => {
    try { const h = (await import(mod)).default; setInterval(() => h({ method: "GET", headers: {} }, mkRes()).catch((e) => console.error(`[${label}]`, e && e.message)), 60000); console.log(`cron on: ${label}`); }
    catch (e) { console.error(`cron load failed: ${label}`, e && e.message); }
  };
  await tick("../api/stag-onchain.js", "onchain");
  await tick("../api/stag-video-cron.js", "video");
  await tick("../api/stag-scheduled.js", "scheduled"); // promo video 4h + whale-club info 3h
}

async function main() {
  try { const w = await tgJSON("deleteWebhook"); console.log("webhook cleared -> polling mode", w && w.ok ? "" : JSON.stringify(w)); } catch (e) { console.error("deleteWebhook", e && e.message); }
  await maybeStartCrons();
  let offset = 0;
  const allowed = encodeURIComponent(JSON.stringify(["message", "edited_message", "callback_query"]));
  console.log(`STAG bot online — long-polling as @${(process.env.STAG_BOT_USERNAME || "STAGZBOT").replace(/^@/, "")}. Ctrl-C to stop.`);
  for (;;) {
    try {
      const j = await tgJSON(`getUpdates?timeout=50&offset=${offset}&allowed_updates=${allowed}`);
      if (j && j.ok && Array.isArray(j.result)) {
        for (const u of j.result) { offset = Math.max(offset, u.update_id + 1); dispatch(u); } // fire-and-forget: a slow /vid never blocks trivia
      } else if (j && !j.ok) {
        console.error("[getUpdates]", j.description || JSON.stringify(j));
        await sleep(3000);
      }
    } catch (e) {
      console.error("[poll]", (e && e.message) || e);
      await sleep(2000);
    }
  }
}

process.on("SIGINT", () => { console.log("\nSTAG bot stopped."); process.exit(0); });
process.on("SIGTERM", () => process.exit(0));
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", (e && e.message) || e));
main();
