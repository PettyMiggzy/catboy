// No-key X watcher: reads a public Nitter RSS feed for one account and posts fresh
// tweets to Telegram. Designed to run on GitHub Actions (cron) — no server, no API key.
// State (last seen tweet id) is a single file the workflow persists via actions/cache.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const USER = (process.env.X_USERNAME || "vladtenev").replace(/^@/, "").trim();
const BOT = (process.env.BOT_TOKEN || "").trim();
const CHAT = (process.env.CHAT_ID || "").trim();
const STATE = process.env.STATE_FILE || "x-watcher/.last_id";
const INSTANCES = (process.env.NITTER_INSTANCES || "nitter.net,nitter.privacyredirect.com,nitter.tiekoetter.com").split(",").map((s) => s.trim()).filter(Boolean);
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";

if (!BOT || !CHAT) { console.error("Set BOT_TOKEN and CHAT_ID"); process.exit(1); }

const decode = (s) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim();

async function fetchFeed() {
  for (const inst of INSTANCES) {
    try {
      const r = await fetch(`https://${inst}/${USER}/rss`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) { console.error(`${inst} -> ${r.status}`); continue; }
      const xml = await r.text();
      if (xml.includes("<item>")) return xml;
    } catch (e) { console.error(`${inst} ${e.message}`); }
  }
  return null;
}
const tg = (text) => fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chat_id: CHAT, text, disable_web_page_preview: false }),
}).then((r) => r.json()).catch((e) => console.error("tg", e.message));

function parse(xml) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  return items.map((it) => {
    const link = (it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "";
    const idm = link.match(/status\/(\d+)/);
    const title = (it.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
    return idm ? { id: idm[1], text: decode(title), url: `https://x.com/${USER}/status/${idm[1]}` } : null;
  }).filter(Boolean);
}

async function main() {
  const xml = await fetchFeed();
  if (!xml) { console.error("all nitter instances failed this run"); return; }
  let posts = parse(xml);
  if (!posts.length) { console.error("no items parsed"); return; }
  // newest-first in RSS; sort by id ascending so we post oldest -> newest
  posts.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  const last = existsSync(STATE) ? readFileSync(STATE, "utf8").trim() : "";
  if (!last) { // first run: prime, don't dump the backlog
    writeFileSync(STATE, posts[posts.length - 1].id);
    await tg(`👀 Watching @${USER} on X — I'll ping here the moment a fresh post drops. 🏹`);
    console.log("primed at", posts[posts.length - 1].id);
    return;
  }
  const fresh = posts.filter((p) => BigInt(p.id) > BigInt(last));
  for (const p of fresh) {
    await tg(`🐦 New post from @${USER}\n\n${p.text}\n\n${p.url}`);
    writeFileSync(STATE, p.id);
    console.log("posted", p.id);
  }
  if (!fresh.length) console.log("no new posts");
}
main().catch((e) => { console.error(e); process.exit(1); });
