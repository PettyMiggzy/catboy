/* Live $CATBOY panel — CA copy + DexScreener price/mcap/vol + embedded chart.
   Reads window.CATBOY_TOKEN. Safe to include on any page; it only fills the
   elements it finds (data-ca, .ca-copy, #tkPrice/#tkMcap/#tkVol/#tkLiq/#tkChange,
   #tkChart, #tkChartLink). Auto-refreshes every 30s. */
(function () {
  const T = window.CATBOY_TOKEN || {};
  if (!T.ca) return;
  const $ = (id) => document.getElementById(id);
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };

  // ---- contract address: fill + copy ----
  document.querySelectorAll("[data-ca]").forEach((el) => { el.textContent = T.ca; });
  document.querySelectorAll(".ca-copy").forEach((btn) => {
    btn.addEventListener("click", () => {
      const done = () => { const o = btn.dataset.o || btn.textContent; btn.dataset.o = o; btn.textContent = "Copied ✓"; setTimeout(() => (btn.textContent = o), 1400); };
      if (navigator.clipboard) navigator.clipboard.writeText(T.ca).then(done).catch(done);
      else { const t = document.createElement("textarea"); t.value = T.ca; document.body.appendChild(t); t.select(); try { document.execCommand("copy"); } catch {} t.remove(); done(); }
    });
  });

  // ---- DexScreener live data ----
  const usd = (n, d = 0) => (n ? "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: d }) : "—");
  const price = (n) => { if (!n) return "—"; const d = n < 0.00001 ? 9 : n < 0.01 ? 7 : n < 1 ? 5 : 3; return "$" + Number(n).toFixed(d); };

  async function refresh() {
    try {
      const r = await fetch(T.dexApi + T.ca, { headers: { accept: "application/json" } });
      if (!r.ok) return;
      const j = await r.json();
      let pairs = (j.pairs || []).filter((p) => p.chainId === (T.chain || "solana"));
      if (!pairs.length) return;
      pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
      const p = pairs[0];
      set("tkPrice", price(Number(p.priceUsd)));
      set("tkMcap", usd(p.marketCap || p.fdv));
      set("tkVol", usd(p.volume?.h24));
      set("tkLiq", usd(p.liquidity?.usd));
      const ch = Number(p.priceChange?.h24 || 0), chEl = $("tkChange");
      if (chEl) { chEl.textContent = (ch >= 0 ? "+" : "") + ch.toFixed(1) + "%"; chEl.style.color = ch >= 0 ? "#14f195" : "#ff5a6a"; }
      // embed the chart once we know the pair address
      const frame = $("tkChart");
      if (frame && p.pairAddress && !frame.getAttribute("src")) {
        frame.setAttribute("src", `https://dexscreener.com/${T.chain || "solana"}/${p.pairAddress}?embed=1&theme=dark&trades=0&info=0`);
      }
      const cl = $("tkChartLink"); if (cl && p.url) cl.href = p.url;
    } catch { /* keep last values */ }
  }
  refresh();
  setInterval(refresh, 30000);
})();
