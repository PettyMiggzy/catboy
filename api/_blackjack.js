// Blackjack for the STAG bot. Bets the shared credit balance (stag_bal). Everyone gets a
// one-time 1000-credit grant to play. Inline Hit / Stand / Double buttons (callback queries).
// Rules: dealer stands on all 17, blackjack pays 3:2, double on first two cards.
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const SUITS = ["♠", "♥", "♦", "♣"]; // spade heart diamond club
const GRANT = 1000, MINBET = 10, MAXBET = 2000, DEFBET = 100;

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
  await s`CREATE TABLE IF NOT EXISTS stag_bj (tid TEXT PRIMARY KEY, chat_id TEXT, msg_id BIGINT, deck JSONB, player JSONB, dealer JSONB, bet INT, created_at TIMESTAMPTZ DEFAULT now())`;
  await s`CREATE TABLE IF NOT EXISTS stag_bj_grant (tid TEXT PRIMARY KEY, at TIMESTAMPTZ DEFAULT now())`;
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
function tableText(g, opts = {}) {
  const hide = opts.hideDealer !== false; // default true (dealer hole card hidden mid-hand)
  const pv = handValue(g.player);
  const dealer = hide ? `${cardStr(g.dealer[0])} 🂠` : handStr(g.dealer);
  let t = `🃏 *Blackjack* - bet *${g.bet}* credits\n\n`;
  t += `🎩 Dealer: ${dealer}${hide ? "" : `  (*${handValue(g.dealer)}*)`}\n`;
  t += `🦌 You: ${handStr(g.player)}  (*${pv}*)`;
  if (opts.result) t += `\n\n${opts.result}`;
  return t;
}
const grantBanner = () => `🎁 *Welcome bonus:* +${GRANT} credits to play Blackjack!\n\n`;

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
async function finish(s, tg, g, target, banner) {
  // dealer only draws if the player is still standing (not bust, not a natural)
  if (handValue(g.player) <= 21 && !isBJ(g.player)) playDealer(g);
  const o = outcome(g);
  const payout = Math.round(g.bet * o.mult);
  if (payout > 0) await addC(s, g.tid, payout);
  await s`DELETE FROM stag_bj WHERE tid=${g.tid}`;
  const bal = await balOf(s, g.tid);
  const text = (banner || "") + tableText(g, { hideDealer: false, result: resultLine(o, g.bet, payout) }) +
    `\n\n💳 Balance: *${bal}* credits  ·  /bj to play again`;
  if (target.edit) await tg("editMessageText", { chat_id: target.chat, message_id: target.msg, parse_mode: "Markdown", text, reply_markup: { inline_keyboard: [] } });
  else await tg("sendMessage", { chat_id: target.chat, reply_to_message_id: target.replyTo, allow_sending_without_reply: true, parse_mode: "Markdown", text });
}

// /bj [bet]
async function bjCommand(s, tg, { chatId, tid, replyTo, arg }) {
  await bjTables(s);
  const gotGrant = await grantIfNew(s, tid);
  const ex = await s`SELECT * FROM stag_bj WHERE tid=${tid}`;
  if (ex.length) {
    const g = ex[0];
    await tg("sendMessage", { chat_id: chatId, reply_to_message_id: replyTo, allow_sending_without_reply: true, parse_mode: "Markdown", text: tableText(g) + "\n\n_Finish this hand first (Hit / Stand above)._", reply_markup: kb(false) });
    return;
  }
  let bet = parseInt(arg, 10); if (!Number.isFinite(bet)) bet = DEFBET;
  bet = Math.max(MINBET, Math.min(MAXBET, bet));
  const bal = await balOf(s, tid);
  if (bal < bet) { await tg("sendMessage", { chat_id: chatId, reply_to_message_id: replyTo, allow_sending_without_reply: true, parse_mode: "Markdown", text: `💳 You have *${bal}* credits - not enough for a *${bet}* bet. Try a smaller bet or /buy more.` }); return; }
  await spend(s, tid, bet);
  const deck = freshDeck();
  const player = [deck.pop(), deck.pop()], dealer = [deck.pop(), deck.pop()];
  const g = { tid, chat_id: String(chatId), bet, deck, player, dealer };
  const banner = gotGrant ? grantBanner() : "";
  if (isBJ(player) || isBJ(dealer)) { await finish(s, tg, g, { chat: chatId, replyTo }, banner); return; }
  const canDouble = (bal - bet) >= bet;
  const sent = await tg("sendMessage", { chat_id: chatId, reply_to_message_id: replyTo, allow_sending_without_reply: true, parse_mode: "Markdown", text: banner + tableText(g), reply_markup: kb(canDouble) });
  const mid = sent && sent.result && sent.result.message_id;
  await s`INSERT INTO stag_bj (tid, chat_id, msg_id, deck, player, dealer, bet)
          VALUES (${tid}, ${String(chatId)}, ${mid || null}, ${JSON.stringify(deck)}::jsonb, ${JSON.stringify(player)}::jsonb, ${JSON.stringify(dealer)}::jsonb, ${bet})`;
}

async function bjCallback(s, tg, cbq) {
  const data = cbq.data || ""; if (!data.startsWith("bj:")) return;
  await bjTables(s);
  const action = data.slice(3);
  const tid = String(cbq.from.id);
  const ack = (t) => tg("answerCallbackQuery", { callback_query_id: cbq.id, text: t || "" });
  const chat = cbq.message && cbq.message.chat && cbq.message.chat.id;
  const msg = cbq.message && cbq.message.message_id;
  const ex = await s`SELECT * FROM stag_bj WHERE tid=${tid}`;
  if (!ex.length) { await ack("No active hand - tap /bj to deal."); return; }
  const g = ex[0];
  // A player can only act on their OWN hand's message (not someone else's buttons).
  if (g.msg_id != null && String(g.msg_id) !== String(msg)) { await ack("That's not your hand - /bj to play your own."); return; }
  const edit = { edit: true, chat, msg };
  if (action === "hit") {
    g.player.push(g.deck.pop());
    if (handValue(g.player) > 21) { await ack("Bust!"); await finish(s, tg, g, edit); return; }
    await s`UPDATE stag_bj SET deck=${JSON.stringify(g.deck)}::jsonb, player=${JSON.stringify(g.player)}::jsonb WHERE tid=${tid}`;
    await tg("editMessageText", { chat_id: chat, message_id: msg, parse_mode: "Markdown", text: tableText(g), reply_markup: kb(false) });
    await ack();
  } else if (action === "stand") {
    await ack(); await finish(s, tg, g, edit);
  } else if (action === "double") {
    if (g.player.length !== 2) { await ack("Can only double on your first two cards."); return; }
    const bal = await balOf(s, tid);
    if (bal < g.bet) { await ack("Not enough credits to double."); return; }
    await spend(s, tid, g.bet); g.bet = g.bet * 2;
    g.player.push(g.deck.pop());
    await ack("Doubled - one card, then stand.");
    await finish(s, tg, g, edit);
  } else { await ack(); }
}

export { bjTables, bjCommand, bjCallback, handValue, outcome, isBJ, freshDeck, cardStr, playDealer };
