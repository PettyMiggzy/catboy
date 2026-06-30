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
  contractAddress: "",          // paste the Solana mint address at launch
  socials: {
    x: "https://x.com/...",     // your X / Twitter
    telegram: "https://t.me/...", // your Telegram
  },
};
```

When `contractAddress` is empty the page shows "Coming soon" and the copy
button is disabled. When socials are empty the buttons show "Coming Soon"
instead of linking out. Fill them in and the site lights up — no code changes
needed elsewhere.

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
