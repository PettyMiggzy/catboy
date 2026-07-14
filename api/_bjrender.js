// Renders a blackjack hand as an image: real card sprites composited onto the badass
// Venice table backdrop. Pure JS (pngjs), no native deps. Falls back gracefully if
// pngjs or the assets are missing (the caller then uses text rendering).
import { readFileSync } from "node:fs";
let PNG = null, jpeg = null;
try { ({ PNG } = await import("pngjs")); } catch { PNG = null; }
try { jpeg = (await import("jpeg-js")).default || (await import("jpeg-js")); } catch { jpeg = null; }

const CW = 132, CH = 184;              // card sprite size in the sheet
let A = null;                          // decoded assets, lazy-loaded once
function assets() {
  if (A || !PNG) return A;
  try {
    const dir = `${process.cwd()}/assets/blackjack`;
    A = {
      table: PNG.sync.read(readFileSync(`${dir}/table.png`)),
      cards: PNG.sync.read(readFileSync(`${dir}/cards.png`)),
      back: PNG.sync.read(readFileSync(`${dir}/back.png`)),
    };
  } catch { A = null; }
  return A;
}
export function canRenderImage() { return !!(PNG && assets()); }

// alpha-composite src region onto dst at (dx,dy)
function blit(dst, src, sx, sy, sw, sh, dx, dy) {
  for (let y = 0; y < sh; y++) {
    const oy = dy + y; if (oy < 0 || oy >= dst.height) continue;
    for (let x = 0; x < sw; x++) {
      const ox = dx + x; if (ox < 0 || ox >= dst.width) continue;
      const si = ((sy + y) * src.width + (sx + x)) * 4;
      const a = src.data[si + 3] / 255; if (a === 0) continue;
      const di = (oy * dst.width + ox) * 4;
      dst.data[di]     = src.data[si]     * a + dst.data[di]     * (1 - a);
      dst.data[di + 1] = src.data[si + 1] * a + dst.data[di + 1] * (1 - a);
      dst.data[di + 2] = src.data[si + 2] * a + dst.data[di + 2] * (1 - a);
      dst.data[di + 3] = 255;
    }
  }
}
function drawCard(out, a, c, dx, dy) {          // c = card index (0..51) or -1 for back
  if (c < 0) { blit(out, a.back, 0, 0, CW, CH, dx, dy); return; }
  const rank = c % 13, suit = Math.floor(c / 13);
  blit(out, a.cards, rank * CW, suit * CH, CW, CH, dx, dy);
}
function drawRow(out, a, cards, hideIndex, centerY) {
  const n = cards.length;
  const step = n <= 2 ? 150 : Math.max(64, Math.min(150, Math.floor(760 / n)));
  const totalW = CW + (n - 1) * step;
  let x = Math.floor((out.width - totalW) / 2);
  const y = Math.floor(centerY - CH / 2);
  for (let i = 0; i < n; i++) { drawCard(out, a, i === hideIndex ? -1 : cards[i], x, y); x += step; }
}

// dealerCards / playerCards = arrays of card indices. hideHole hides dealer's 2nd card.
export function renderHand(dealerCards, playerCards, hideHole) {
  const a = assets(); if (!a) return null;
  const t = a.table;
  const out = { width: t.width, height: t.height, data: Buffer.from(t.data) };
  drawRow(out, a, dealerCards, hideHole ? 1 : -1, Math.round(t.height * 0.30));
  drawRow(out, a, playerCards, -1, Math.round(t.height * 0.74));
  // JPEG keeps it ~150KB (snappy uploads); fall back to PNG if jpeg-js isn't present.
  if (jpeg) { try { return { buf: jpeg.encode({ data: out.data, width: out.width, height: out.height }, 86).data, mime: "image/jpeg", ext: "jpg" }; } catch {} }
  return { buf: PNG.sync.write(out), mime: "image/png", ext: "png" };
}
