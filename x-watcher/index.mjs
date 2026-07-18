// x-watcher — polls ONE X account and posts to Telegram the instant a fresh tweet drops.
//
// Works with the official X API v2 OR any reseller that mirrors the v2 shape
// (twitterapi.io, etc.) — just point X_API_BASE + X_BEARER at your provider.
// Cost stays tiny because it polls with since_id: empty checks fetch 0 posts.
//
//   pm2 start x-watcher/index.mjs --name x-watcher
// Env (bot-server/.env style or pm2 env):
//   X_BEARER      bearer token from your X provider            (required)
//   X_API_BASE    default https://api.x.com                    (reseller? set theirs)
//   X_USERNAME    account to watch, no @        default vladtenev
//   TG_TOKEN      Telegram bot token                            (required)
//   TG_CHAT       chat/channel id to post to                    (required)
//   POLL_SECONDS  default 60
//   INCLUDE_REPLIES / INCLUDE_RTS  "1" to include (default off — original posts only)
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const BASE = (process.env.X_API_BASE || "https://api.x.com").replace(/\/$/, "");
const BEARER = (process.env.X_BEARER || "").trim();
const USER = (process.env.X_USERNAME || "vladtenev").replace(/^@/, "").trim();
const TG_TOKEN = (process.env.TG_TOKEN || "").trim();
const TG_CHAT = (process.env.TG_CHAT || "").trim();
const POLL = Math.max(15, parseInt(process.env.POLL_SECONDS || "60", 10)) * 1000;
const EXCL = ["replies", "retweets"].filter((k) =>
  k === "replies" ? process.env.INCLUDE_REPLIES !== "1" : process.env.INCLUDE_RTS !== "1");
const STATE = new URL("./.last_id", import.meta.url);

if (!BEARER || !TG_TOKEN || !TG_CHAT) { console.error("Set X_BEARER, TG_TOKEN, TG_CHAT"); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const xget = async (path) => {
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${BEARER}` } });
  if (r.status === 429) return { _rate: true };
  if (!r.ok) throw new Error(`x ${r.status} ${(await r.text()).slice(0, 140)}`);
  return r.json();
};
const tg = (text) => fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: false }),
}).catch((e) => console.error("tg", e.message));

const loadLast = () => (existsSync(STATE) ? readFileSync(STATE, "utf8").trim() : "");
const saveLast = (id) => writeFileSync(STATE, String(id));

async function resolveUserId() {
  const j = await xget(`/2/users/by/username/${USER}`);
  if (!j?.data?.id) throw new Error("could not resolve user id for @" + USER);
  return j.data.id;
}

async function main() {
  const uid = await resolveUserId();
  console.log(`x-watcher online — @${USER} (${uid}) -> TG ${TG_CHAT}, every ${POLL / 1000}s`);
  // Prime: on first run, set last_id to newest WITHOUT alerting (avoid a backlog dump).
  if (!loadLast()) {
    const j = await xget(`/2/users/${uid}/tweets?max_results=5`);
    if (j?.data?.length) { saveLast(j.data[0].id); console.log("primed at", j.data[0].id); }
  }
  for (;;) {
    try {
      const since = loadLast();
      const excl = EXCL.length ? `&exclude=${EXCL.join(",")}` : "";
      const j = await xget(`/2/users/${uid}/tweets?max_results=10&tweet.fields=created_at${excl}${since ? `&since_id=${since}` : ""}`);
      if (j._rate) { await sleep(POLL); continue; }
      const posts = (j?.data || []).slice().reverse(); // oldest -> newest
      for (const p of posts) {
        await tg(`🐦 New post from @${USER}\n\n${p.text}\n\nhttps://x.com/${USER}/status/${p.id}`);
        saveLast(p.id);
        console.log("posted", p.id);
      }
    } catch (e) { console.error("[poll]", e.message); }
    await sleep(POLL);
  }
}
process.on("SIGINT", () => process.exit(0));
main().catch((e) => { console.error(e); process.exit(1); });
