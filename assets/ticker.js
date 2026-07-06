/* $CATBOY live ticker bar — sticky strip above the nav on every page.
   Shows price · 24h% · market cap · CA (with copy) · Buy link, live from
   DexScreener, refreshing every 30s. Self-contained: just add
   <script src="assets/ticker.js"></script> before </body>. */
(function () {
  var T = window.CATBOY_TOKEN || {
    ca: "3UCdpV5mTb4TmJSCyPkaAsuUFvaF4ofc2uXCEj3Jpump",
    chain: "solana",
    dexApi: "https://api.dexscreener.com/latest/dex/tokens/",
    pumpUrl: "https://pump.fun/coin/3UCdpV5mTb4TmJSCyPkaAsuUFvaF4ofc2uXCEj3Jpump",
  };
  if (document.getElementById("catboy-ticker")) return;

  var css = document.createElement("style");
  css.textContent =
    "#catboy-ticker{position:sticky;top:0;z-index:60;display:flex;align-items:center;gap:.9rem;justify-content:center;flex-wrap:nowrap;overflow-x:auto;" +
    "background:linear-gradient(90deg,#0a0a14,#141428);border-bottom:1px solid rgba(120,225,255,.25);color:#e8e8f0;" +
    "font-family:'Rajdhani',system-ui,sans-serif;font-weight:600;font-size:.86rem;padding:.4rem .8rem;white-space:nowrap;scrollbar-width:none;}" +
    "#catboy-ticker::-webkit-scrollbar{display:none;}" +
    "#catboy-ticker .tk{color:#3fe0ff;font-weight:800;letter-spacing:.03em;}" +
    "#catboy-ticker .up{color:#14f195;}#catboy-ticker .down{color:#ff5a6a;}" +
    "#catboy-ticker .muted{color:#8a8aa0;}" +
    "#catboy-ticker .ca{font-family:ui-monospace,monospace;color:#c9c9e0;}" +
    "#catboy-ticker button,#catboy-ticker a.tkbtn{background:rgba(120,225,255,.12);border:1px solid rgba(120,225,255,.35);color:#3fe0ff;" +
    "border-radius:6px;padding:.12rem .5rem;font:inherit;font-size:.78rem;cursor:pointer;text-decoration:none;white-space:nowrap;}" +
    "#catboy-ticker a.buy{background:#14f195;border-color:#14f195;color:#012;font-weight:800;}" +
    "@media(max-width:640px){#catboy-ticker{justify-content:flex-start;font-size:.8rem;gap:.6rem;}#catboy-ticker .hideM{display:none;}}";
  document.head.appendChild(css);

  var bar = document.createElement("div");
  bar.id = "catboy-ticker";
  var caShort = T.ca.slice(0, 4) + "…" + T.ca.slice(-4);
  bar.innerHTML =
    '<span class="tk">$CATBOY</span>' +
    '<span id="tkbPrice" class="muted">$—</span>' +
    '<span id="tkbChange" class="muted">—</span>' +
    '<span class="muted hideM">MC <b id="tkbMcap" style="color:#e8e8f0">—</b></span>' +
    '<span class="muted hideM">Vol <b id="tkbVol" style="color:#e8e8f0">—</b></span>' +
    '<span class="ca hideM" title="' + T.ca + '">' + caShort + '</span>' +
    '<button id="tkbCopy" type="button">Copy CA</button>' +
    '<a class="tkbtn buy" href="' + (T.pumpUrl || "#") + '" target="_blank" rel="noopener">Buy</a>';

  var nav = document.querySelector(".nav") || document.body.firstElementChild;
  if (nav && nav.parentNode) nav.parentNode.insertBefore(bar, nav);
  else document.body.insertBefore(bar, document.body.firstChild);

  // keep the sticky nav sitting right below the ticker
  function offset() { var n = document.querySelector(".nav"); if (n) n.style.top = bar.offsetHeight + "px"; }
  offset(); window.addEventListener("resize", offset);

  document.getElementById("tkbCopy").addEventListener("click", function () {
    var b = this, o = b.dataset.o || b.textContent; b.dataset.o = o;
    var done = function () { b.textContent = "Copied ✓"; setTimeout(function () { b.textContent = o; }, 1400); };
    if (navigator.clipboard) navigator.clipboard.writeText(T.ca).then(done).catch(done);
    else { var t = document.createElement("textarea"); t.value = T.ca; document.body.appendChild(t); t.select(); try { document.execCommand("copy"); } catch (e) {} t.remove(); done(); }
  });

  var $ = function (id) { return document.getElementById(id); };
  var usd = function (n) { return n ? "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }) : "—"; };
  var price = function (n) { if (!n) return "$—"; var d = n < 0.00001 ? 9 : n < 0.01 ? 7 : n < 1 ? 5 : 3; return "$" + Number(n).toFixed(d); };
  async function refresh() {
    try {
      var r = await fetch(T.dexApi + T.ca, { headers: { accept: "application/json" } });
      if (!r.ok) return;
      var j = await r.json();
      var pairs = (j.pairs || []).filter(function (p) { return p.chainId === (T.chain || "solana"); });
      if (!pairs.length) return;
      pairs.sort(function (a, b) { return (b.liquidity && b.liquidity.usd || 0) - (a.liquidity && a.liquidity.usd || 0); });
      var p = pairs[0];
      var pe = $("tkbPrice"); pe.textContent = price(Number(p.priceUsd)); pe.classList.remove("muted");
      $("tkbMcap").textContent = usd(p.marketCap || p.fdv);
      $("tkbVol").textContent = usd(p.volume && p.volume.h24);
      var ch = Number(p.priceChange && p.priceChange.h24 || 0), ce = $("tkbChange");
      ce.textContent = (ch >= 0 ? "▲ +" : "▼ ") + ch.toFixed(1) + "%";
      ce.className = ch >= 0 ? "up" : "down";
    } catch (e) { /* keep last */ }
  }
  refresh();
  setInterval(refresh, 30000);
})();
