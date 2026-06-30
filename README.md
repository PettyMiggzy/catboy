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
  waitlistEndpoint: "",         // Formspree/Getform endpoint for allowlist
};
```

Everything degrades gracefully when empty:
- `contractAddress` empty → shows "Coming soon", copy button disabled.
- `socials` empty → buttons show "Coming Soon" instead of linking.
- `mintUrl` / `merchUrl` empty → buttons show "Minting Soon" / "Store Opening Soon".
- `waitlistEndpoint` empty → the allowlist form shows a friendly "opens soon"
  message. Set it to a [Formspree](https://formspree.io) endpoint (free) and
  signups (email + optional wallet) start flowing to your inbox — no backend
  to host.

Fill these in and the site lights up — no other code changes needed.

### Sections

Hero · Lore · Journey · **NFTs** · Tokenomics · **Roadmap** · How to Buy ·
**Merch** · **FAQ** · **Allowlist** · Socials. An intro splash video
(`assets/splash.mp4`) plays once per session on load.

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
