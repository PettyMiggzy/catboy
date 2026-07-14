// Blackjack for the STAG bot. Bets the shared credit balance (stag_bal). Everyone gets a
// one-time 1000-credit grant to play. Inline Hit / Stand / Double buttons (callback queries).
// Rules: dealer stands on all 17, blackjack pays 3:2, double on first two cards.
// The hand renders as a real card-table IMAGE (badass Venice felt + card sprites); if the
// renderer/assets are unavailable it falls back to text cards. ctx supplies TG send helpers.
import { renderHand, canRenderImage } from "./_bjrender.js";
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const SUITS = ["♠", "♥", "♦", "♣"];
const GRANT = 1000, MINBET = 10, MAXBET = 2000, DEFBET = 100;
const ANNOUNCE_MIN = 300;      // net win that gets bragged to the group chat
// Escape the Markdown specials Telegram cares about so usernames can't break formatting.
const mdEsc = (x) => String(x == null ? "" : x).replace(/([_*`\[\]])/g, "\\$1");

function freshDeck() {
  const d = []; for (let i = 0; i < 52; i++) d.push(i);
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = d[i]; d[i] = d[j]; d[j] = t; }
  return d;
}
const cardStr = (c) => RANKS[c % 13] + SUITS[Math.floor(c / 13)];
const handStr = (cards) => cards.map(cardStr).join(" ");
function handValue(cards) {
  let total = 0, aces = 0;
  for (const c of cards) { const r = c % 13; if (r === 12) { aces++; total += 11; } else total += Math.min(r + 2, 10); }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}
const isBJ = (cards) => cards.length === 2 && handValue(cards) === 21;

async function bjTables(s) {
  await s`CREATE TABLE IF NOT EXISTS stag_bal (tid TEXT PRIMARY KEY, credits INT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE TABLE IF NOT EXISTS stag_bj (tid TEXT PRIMARY KEY, chat_id TEXT, msg_id BIGINT, deck JSONB, player JSONB, dealer JSONB, bet INT, uname TEXT, created_at TIMESTAMPTZ DEFAULT now())`;
  await s`ALTER TABLE stag_bj ADD COLUMN IF NOT EXISTS uname TEXT`;
  await s`CREATE TABLE IF NOT EXISTS stag_bj_grant (tid TEXT PRIMARY KEY, at TIMESTAMPTZ DEFAULT now())`;
  // Blackjack leaderboard: lifetime net winnings per player (the "leaders" announced in the group).
  await s`CREATE TABLE IF NOT EXISTS stag_bj_stats (tid TEXT PRIMARY KEY, uname TEXT, net BIGINT NOT NULL DEFAULT 0, hands INT NOT NULL DEFAULT 0, wins INT NOT NULL DEFAULT 0, blackjacks INT NOT NULL DEFAULT 0, biggest INT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT now())`;
}
const balOf = async (s, tid) => { const r = await s`SELECT credits FROM stag_bal WHERE tid=${tid}`; return r.length ? Number(r[0].credits) : 0; };
const addC = (s, tid, n) => s`INSERT INTO stag_bal (tid, credits) VALUES (${tid}, ${n}) ON CONFLICT (tid) DO UPDATE SET credits = stag_bal.credits + ${n}, updated_at = now()`;
async function spend(s, tid, n) { const r = await s`UPDATE stag_bal SET credits = credits - ${n}, updated_at = now() WHERE tid=${tid} AND credits >= ${n} RETURNING credits`; return r.length ? Number(r[0].credits) : null; }
async function grantIfNew(s, tid) {
  const g = await s`INSERT INTO stag_bj_grant (tid) VALUES (${tid}) ON CONFLICT DO NOTHING RETURNING tid`;
  if (g.length) { await addC(s, tid, GRANT); return true; }
  return false;
}

const kb = (canDouble) => {
  const row = [{ text: "🃏 Hit", callback_data: "bj:hit" }, { text: "✋ Stand", callback_data: "bj:stand" }];
  if (canDouble) row.push({ text: "⏫ Double", callback_data: "bj:double" });
  return { inline_keyboard: [row] };
};
const grantBanner = () => `🎁 *Welcome bonus:* +${GRANT} credits to play Blackjack!\n\n`;
// caption for image mode (numbers only - the image shows the cards)
function caption(g, opts = {}) {
  const hide = opts.hideDealer !== false;
  const t = `🃏 *Blackjack*  ·  bet *${g.bet}* credits\n🎩 Dealer: *${hide ? "?" : handValue(g.dealer)}*    🦌 You: *${handValue(g.player)}*`;
  return t + (opts.result ? `\n\n${opts.result}` : "") + (opts.balance != null ? `\n💳 Balance: *${opts.balance}*  ·  /bj to play again` : "");
}
// full text (fallback when image rendering is unavailable)
function tableText(g, opts = {}) {
  const hide = opts.hideDealer !== false;
  const dealer = hide ? `${cardStr(g.dealer[0])} 🂠` : handStr(g.dealer);
  let t = `🃏 *Blackjack* - bet *${g.bet}* credits\n\n`;
  t += `🎩 Dealer: ${dealer}${hide ? "" : `  (*${handValue(g.dealer)}*)`}\n`;
  t += `🦌 You: ${handStr(g.player)}  (*${handValue(g.player)}*)`;
  return t + (opts.result ? `\n\n${opts.result}` : "");
}

function playDealer(g) { while (handValue(g.dealer) < 17) g.dealer.push(g.deck.pop()); }
function outcome(g) {
  const pv = handValue(g.player), dv = handValue(g.dealer);
  const pBJ = isBJ(g.player), dBJ = isBJ(g.dealer);
  if (pv > 21) return { r: "bust", mult: 0 };
  if (pBJ && dBJ) return { r: "push", mult: 1 };
  if (pBJ) return { r: "blackjack", mult: 2.5 };
  if (dBJ) return { r: "dealerbj", mult: 0 };
  if (dv > 21) return { r: "dealerbust", mult: 2 };
  if (pv > dv) return { r: "win", mult: 2 };
  if (pv < dv) return { r: "lose", mult: 0 };
  return { r: "push", mult: 1 };
}
function resultLine(o, bet, payout) {
  const net = payout - bet;
  switch (o.r) {
    case "blackjack": return `🃏 *BLACKJACK!* +${net} credits 🎉`;
    case "win": case "dealerbust": return `✅ *You win!* +${net} credits`;
    case "push": return `🤝 *Push* - your ${bet} is returned`;
    case "bust": return `💥 *Bust!* -${bet} credits`;
    case "lose": return `❌ *Dealer wins* -${bet} credits`;
    case "dealerbj": return `🎩 *Dealer blackjack* -${bet} credits`;
    default: return "";
  }
}
// send/edit the hand as an image (preferred) or text (fallback)
async function showHand(ctx, g, { chatId, replyTo, edit, msg, keyboard, banner = "", hideDealer = true, result, balance }) {
  if (canRenderImage()) {
    const img = renderHand(g.dealer, g.player, hideDealer);
    if (img && img.buf) {
      const cap = banner + caption(g, { hideDealer, result, balance });
      if (edit) return ctx.editPhoto(chatId, msg, img, cap, keyboard || { inline_keyboard: [] });
      return ctx.sendCards(chatId, img, cap, keyboard, replyTo);
    }
  }
  const text = banner + tableText(g, { hideDealer, result }) + (balance != null ? `\n\n💳 Balance: *${balance}*  ·  /bj to play again` : "");
  if (edit) return ctx.tg("editMessageText", { chat_id: chatId, message_id: msg, parse_mode: "Markdown", text, reply_markup: keyboard || { inline_keyboard: [] } });
  return ctx.tg("sendMessage", { chat_id: chatId, reply_to_message_id: replyTo, allow_sending_without_reply: true, parse_mode: "Markdown", text, reply_markup: keyboard });
}
// lifetime blackjack stats -> the leaderboard the group sees
async function recordStats(s, tid, uname, net, o) {
  const win = net > 0 ? 1 : 0, bj = o.r === "blackjack" ? 1 : 0, big = Math.max(net, 0);
  await s`INSERT INTO stag_bj_stats (tid, uname, net, hands, wins, blackjacks, biggest)
          VALUES (${tid}, ${uname || null}, ${net}, 1, ${win}, ${bj}, ${big})
          ON CONFLICT (tid) DO UPDATE SET
            uname = COALESCE(${uname || null}, stag_bj_stats.uname),
            net = stag_bj_stats.net + ${net},
            hands = stag_bj_stats.hands + 1,
            wins = stag_bj_stats.wins + ${win},
            blackjacks = stag_bj_stats.blackjacks + ${bj},
            biggest = GREATEST(stag_bj_stats.biggest, ${big}),
            updated_at = now()`;
}
// call out a winner in the group chat (only for a blackjack or a chunky win)
async function announceWin(ctx, g, net, o) {
  if (!ctx || !ctx.announceChat) return;
  if (o.r !== "blackjack" && net < ANNOUNCE_MIN) return;
  const who = mdEsc(g.uname || "A stag");
  const line = o.r === "blackjack"
    ? `🃏 *BLACKJACK!* ${who} hit 21 and took *+${net}* off the dealer! 🎉`
    : `🦌 ${who} just won *+${net}* credits at the $STAG blackjack table! 🃏`;
  try { await ctx.tg("sendMessage", { chat_id: ctx.announceChat, parse_mode: "Markdown", disable_web_page_preview: true,
    text: `${line}\n_DM me_ \`/bj\` _to play — winners get called out right here._` }); } catch {}
}
async function finish(s, ctx, g, target, banner) {
  if (handValue(g.player) <= 21 && !isBJ(g.player)) playDealer(g);
  const o = outcome(g);
  const payout = Math.round(g.bet * o.mult);
  if (payout > 0) await addC(s, g.tid, payout);
  const net = payout - g.bet;
  await recordStats(s, g.tid, g.uname, net, o);
  await s`DELETE FROM stag_bj WHERE tid=${g.tid}`;
  const bal = await balOf(s, g.tid);
  await showHand(ctx, g, { ...target, hideDealer: false, result: resultLine(o, g.bet, payout), balance: bal, keyboard: { inline_keyboard: [] }, banner });
  await announceWin(ctx, g, net, o);
}
// top blackjack players by lifetime net winnings; posts to the group when toGroup is set
async function bjLeaderboard(s, ctx, { chatId, toGroup }) {
  await bjTables(s);
  const dest = (toGroup && ctx.announceChat) ? ctx.announceChat : chatId;
  const rows = await s`SELECT uname, net, hands, blackjacks FROM stag_bj_stats WHERE hands > 0 ORDER BY net DESC, blackjacks DESC LIMIT 10`;
  if (!rows.length) {
    await ctx.tg("sendMessage", { chat_id: dest, parse_mode: "Markdown", text: "🃏 No blackjack legends yet. DM me `/bj` to get on the board. 🦌" });
    return;
  }
  const medal = ["🥇", "🥈", "🥉"];
  const list = rows.map((r, i) => {
    const tag = medal[i] || `*${i + 1}.*`;
    const who = mdEsc(r.uname || "a stag");
    const n = Number(r.net), sign = n >= 0 ? "+" : "";
    const extra = r.blackjacks ? `, ${r.blackjacks} 🃏` : "";
    return `${tag} ${who} — *${sign}${n}* credits  _(${r.hands} hand${r.hands == 1 ? "" : "s"}${extra})_`;
  }).join("\n");
  await ctx.tg("sendMessage", { chat_id: dest, parse_mode: "Markdown", disable_web_page_preview: true,
    text: `🏆 *$STAG BLACKJACK LEADERS* 🃏\n\n${list}\n\n_DM me_ \`/bj\` _to climb the board._` });
}

// /bj [bet]  — plays in DM only; wins get announced in the group
async function bjCommand(s, ctx, { chatId, tid, uname, replyTo, arg, isPrivate }) {
  await bjTables(s);
  if (!isPrivate) {
    const u = String(ctx.botUser || "STAGZBOT").replace(/^@/, "");
    await ctx.tg("sendMessage", { chat_id: chatId, reply_to_message_id: replyTo, allow_sending_without_reply: true, parse_mode: "Markdown", disable_web_page_preview: true,
      text: `🃏 *Blackjack runs in my DMs.*\n👉 [Tap here to play me](https://t.me/${u}) then send \`/bj <bet>\`.\n\n🏆 Winners and leaders get announced right here in the group. 🦌` });
    return;
  }
  const gotGrant = await grantIfNew(s, tid);
  const ex = await s`SELECT * FROM stag_bj WHERE tid=${tid}`;
  if (ex.length) {
    await showHand(ctx, ex[0], { chatId, replyTo, keyboard: kb(false), banner: "", result: "_Finish this hand first._" });
    return;
  }
  let bet = parseInt(arg, 10); if (!Number.isFinite(bet)) bet = DEFBET;
  bet = Math.max(MINBET, Math.min(MAXBET, bet));
  const bal0 = await balOf(s, tid);
  if (bal0 < bet) { await ctx.tg("sendMessage", { chat_id: chatId, reply_to_message_id: replyTo, allow_sending_without_reply: true, parse_mode: "Markdown", text: `💳 You have *${bal0}* credits - not enough for a *${bet}* bet. Try a smaller bet or /buy more.` }); return; }
  await spend(s, tid, bet);
  const deck = freshDeck();
  const player = [deck.pop(), deck.pop()], dealer = [deck.pop(), deck.pop()];
  const g = { tid, chat_id: String(chatId), bet, deck, player, dealer, uname };
  const banner = gotGrant ? grantBanner() : "";
  if (isBJ(player) || isBJ(dealer)) { await finish(s, ctx, g, { chatId, replyTo }, banner); return; }
  const sent = await showHand(ctx, g, { chatId, replyTo, keyboard: kb((bal0 - bet) >= bet), banner });
  const mid = sent && sent.result && sent.result.message_id;
  await s`INSERT INTO stag_bj (tid, chat_id, msg_id, deck, player, dealer, bet, uname)
          VALUES (${tid}, ${String(chatId)}, ${mid || null}, ${JSON.stringify(deck)}::jsonb, ${JSON.stringify(player)}::jsonb, ${JSON.stringify(dealer)}::jsonb, ${bet}, ${uname || null})`;
}

async function bjCallback(s, ctx, cbq) {
  const data = cbq.data || ""; if (!data.startsWith("bj:")) return;
  await bjTables(s);
  const action = data.slice(3);
  const tid = String(cbq.from.id);
  const ack = (t) => ctx.tg("answerCallbackQuery", { callback_query_id: cbq.id, text: t || "" });
  const chatId = cbq.message && cbq.message.chat && cbq.message.chat.id;
  const msg = cbq.message && cbq.message.message_id;
  const ex = await s`SELECT * FROM stag_bj WHERE tid=${tid}`;
  if (!ex.length) { await ack("No active hand - tap /bj to deal."); return; }
  const g = ex[0];
  if (!g.uname && cbq.from) g.uname = cbq.from.username ? "@" + cbq.from.username : cbq.from.first_name;
  if (g.msg_id != null && String(g.msg_id) !== String(msg)) { await ack("That's not your hand - /bj to play your own."); return; }
  const target = { chatId, msg, edit: true };
  if (action === "hit") {
    g.player.push(g.deck.pop());
    if (handValue(g.player) > 21) { await ack("Bust!"); await finish(s, ctx, g, target); return; }
    await s`UPDATE stag_bj SET deck=${JSON.stringify(g.deck)}::jsonb, player=${JSON.stringify(g.player)}::jsonb WHERE tid=${tid}`;
    await showHand(ctx, g, { ...target, keyboard: kb(false) });
    await ack();
  } else if (action === "stand") {
    await ack(); await finish(s, ctx, g, target);
  } else if (action === "double") {
    if (g.player.length !== 2) { await ack("Can only double on your first two cards."); return; }
    const bal = await balOf(s, tid);
    if (bal < g.bet) { await ack("Not enough credits to double."); return; }
    await spend(s, tid, g.bet); g.bet = g.bet * 2;
    g.player.push(g.deck.pop());
    await ack("Doubled - one card, then stand.");
    await finish(s, ctx, g, target);
  } else { await ack(); }
}

export { bjTables, bjCommand, bjCallback, bjLeaderboard, handValue, outcome, isBJ, freshDeck, cardStr, playDealer };
