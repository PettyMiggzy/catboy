// Shared fire-and-forget Telegram announcer for the serverless API.
// Posts to the same public channel the buybot uses:
//   TELEGRAM_BOT_TOKEN  — the @CatboyBuyBot token (set in Vercel env)
//   TELEGRAM_CHAT_ID    — the announcement channel/group id
// If either is unset, calls silently no-op so the API never breaks.
//
// NOTE: files under api/ whose name starts with "_" are treated as helper
// modules by Vercel, not as routable endpoints.

const TG_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TG_CHAT = (process.env.TELEGRAM_CHAT_ID || "").trim();

// escape the handful of chars Telegram's HTML parse_mode cares about
export const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function tgAnnounce(text) {
  if (!TG_TOKEN || !TG_CHAT) return; // not configured — skip quietly
  try {
    // awaited on purpose: in serverless the function can freeze the instant we
    // return the HTTP response, so a non-awaited send may never actually fire.
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch (_) { /* an announcement must never break the underlying action */ }
}
