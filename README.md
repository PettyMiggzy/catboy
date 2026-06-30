# CATBOY — The Legend Crosses to Solana

Landing site for **$CATBOY**, the original anime meme legend reborn on Solana.

> BNB was the origin story. Solana is where the legend grows.

## Tech

Pure static site — no build step, no dependencies. Just HTML, CSS, and vanilla JS.

```
index.html    — page structure & copy
styles.css    — neon-purple/cyan cyberpunk theme
script.js     — config (contract + socials), copy button, scroll reveal
assets/
  catboy.png  — logo / hero image (PLACEHOLDER — replace with your art)
```

## Before launch — what to update

Everything you need to change lives at the top of `script.js`:

```js
const CONFIG = {
  contractAddress: "",          // Solana mint address at launch
  socials: {
    x: "https://x.com/...",     // your X / Twitter
    telegram: "https://t.me/...", // your Telegram
  },
  mintUrl: "",                  // NFT mint page (Crossmint / LaunchMyNFT)
  merchUrl: "",                 // merch store (Fourthwall / Shopify)
  supabase: { url: "", anonKey: "", table: "allowlist" }, // allowlist storage
  waitlistEndpoint: "",         // optional fallback (Formspree/Getform)
};
```

Everything degrades gracefully when empty:
- `contractAddress` empty → shows "Coming soon", copy button disabled.
- `socials` empty → buttons show "Coming Soon" instead of linking.
- `mintUrl` / `merchUrl` empty → buttons show "Minting Soon" / "Store Opening Soon".
- `supabase` / `waitlistEndpoint` both empty → the allowlist form shows a
  friendly "opens soon" message.

Fill these in and the site lights up — no other code changes needed.

### Allowlist via Supabase (recommended)

The allowlist stores signups in your own Supabase table. The browser-side
`anonKey` is safe to expose **as long as Row Level Security (RLS) is on with an
insert-only policy** — visitors can add their email but can't read anyone's.

1. Create a free project at [supabase.com](https://supabase.com).
2. In the **SQL Editor**, run:

   ```sql
   create table if not exists allowlist (
     id uuid primary key default gen_random_uuid(),
     email text not null,
     wallet text,
     created_at timestamptz default now(),
     unique (email)
   );

   alter table allowlist enable row level security;

   -- Allow anonymous visitors to INSERT only (no read access).
   create policy "anon can join allowlist"
     on allowlist for insert
     to anon
     with check (true);
   ```

3. **Settings → API**: copy the **Project URL** and the **anon public** key
   into `CONFIG.supabase` in `script.js`.
4. View/export signups any time in **Table Editor → allowlist** (Export CSV)
   for your mint/airdrop allowlist.

Duplicate emails are handled gracefully ("already on the list"). To also send
yourself an email per signup, add a Supabase Database Webhook or Edge Function
later — optional.

### Pages

- `index.html` — home: hero, lore, journey, NFT teaser, tokenomics, roadmap,
  how to buy, merch teaser, FAQ, allowlist, socials. Intro splash video plays
  once per session.
- `nft.html` — full Genesis NFT collection: gallery, mint details, holder
  utility, how-to-mint.
- `merch.html` — full store: product grid, store button, shipping/payment info.

All pages share `styles.css` + `script.js` and the same scroll-animation
engine (staggered reveals, parallax, progress bar, count-up stats).

### Replace the artwork

Drop your real logo/character image in at `assets/catboy.png` (square works
best — it's shown as a circle). The current file is a generated placeholder.

## Run locally

Just open `index.html` in a browser, or serve it:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploy

Any static host works — drag the folder into Netlify, Vercel, Cloudflare
Pages, or GitHub Pages.

---

*$CATBOY is a meme coin for entertainment and community. Not financial advice.*
