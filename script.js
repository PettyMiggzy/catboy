// ===== CATBOY — site config =====
// Edit these when the token launches. Everything else updates automatically.
const CONFIG = {
  contractAddress: "", // paste the Solana mint address here at launch
  socials: {
    x: "",        // e.g. "https://x.com/catboy_sol"
    telegram: "", // e.g. "https://t.me/catboy_sol"
  },
  // NFT collection — paste your Crossmint / LaunchMyNFT / mint page URL at drop time.
  mintUrl: "",
  // Merch — paste your Fourthwall / Shopify store URL when it's live.
  merchUrl: "",
  // Casino / burn-lottery game — paste the dApp URL when it launches.
  gameUrl: "",
  // Allowlist storage — primary backend is our own Vercel serverless function
  // (api/allowlist.js) writing to Vercel Postgres. Nothing third-party.
  // Returns 503 until the database is provisioned, so the form shows
  // "opens soon" gracefully until you finish setup (see README).
  apiEndpoint: "/api/allowlist",
  // Optional alternative backends (used only if apiEndpoint is empty):
  supabase: { url: "", anonKey: "", table: "allowlist" },
  waitlistEndpoint: "", // Formspree/Getform fallback
};

// ----- Intro splash -----
(function () {
  const splash = document.getElementById("splash");
  const video = document.getElementById("splashVideo");
  const skip = document.getElementById("splashSkip");
  if (!splash) return;

  // Show only once per browser session.
  if (sessionStorage.getItem("catboy_splash_seen")) {
    splash.remove();
    return;
  }

  document.body.classList.add("splash-open");
  let done = false;
  const dismiss = () => {
    if (done) return;
    done = true;
    sessionStorage.setItem("catboy_splash_seen", "1");
    splash.classList.add("hide");
    document.body.classList.remove("splash-open");
    setTimeout(() => splash.remove(), 900);
  };

  if (video) {
    video.addEventListener("ended", dismiss);
    video.addEventListener("error", dismiss); // if the video can't load, don't block the site
    const tryPlay = video.play();
    if (tryPlay && tryPlay.catch) tryPlay.catch(() => {}); // autoplay may be blocked; user can skip
  }
  if (skip) skip.addEventListener("click", dismiss);
  // Hard safety: never let the splash trap the user.
  setTimeout(dismiss, 12000);
})();

// ----- Footer year -----
const yearEl = document.getElementById("year");
if (yearEl) yearEl.textContent = new Date().getFullYear();

// ----- Contract address (only on pages that have the box) -----
const caEl = document.getElementById("ca");
const copyBtn = document.getElementById("copyCa");
if (caEl && copyBtn) {
  if (CONFIG.contractAddress) {
    caEl.textContent = CONFIG.contractAddress;
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(CONFIG.contractAddress);
        copyBtn.textContent = "Copied!";
        setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
      } catch {
        copyBtn.textContent = "Error";
      }
    });
  } else {
    copyBtn.disabled = true;
    copyBtn.style.opacity = "0.5";
    copyBtn.style.cursor = "not-allowed";
  }
}

// ----- Social links -----
document.querySelectorAll("[data-social]").forEach((el) => {
  const key = el.getAttribute("data-social");
  const url = CONFIG.socials[key];
  if (url) {
    el.setAttribute("href", url);
    el.setAttribute("target", "_blank");
    el.setAttribute("rel", "noopener");
  } else {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      el.textContent = "Coming Soon";
      setTimeout(() => {
        el.textContent = key === "x" ? "Follow on X" : "Join Telegram";
      }, 1500);
    });
  }
});

// ----- Link-or-"coming soon" buttons (mint, merch) -----
function wireLinkButton(selector, url, comingSoonLabel) {
  document.querySelectorAll(selector).forEach((el) => {
    const original = el.textContent;
    if (url) {
      el.setAttribute("href", url);
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener");
    } else {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        el.textContent = comingSoonLabel;
        setTimeout(() => (el.textContent = original), 1600);
      });
    }
  });
}
wireLinkButton("[data-mint]", CONFIG.mintUrl, "Minting Soon");
wireLinkButton("[data-merch]", CONFIG.merchUrl, "Store Opening Soon");
wireLinkButton("[data-game]", CONFIG.gameUrl, "Game Coming Soon");

// ----- Waitlist / allowlist form -----
(function () {
  const form = document.getElementById("waitlistForm");
  if (!form) return;
  const status = form.querySelector(".form-status");
  const submitBtn = form.querySelector("button[type=submit]");
  const setStatus = (msg, ok) => {
    if (!status) return;
    status.textContent = msg;
    status.style.color = ok ? "var(--cyan)" : "var(--magenta)";
  };

  const sb = CONFIG.supabase || {};
  const supabaseReady = sb.url && sb.anonKey;
  const apiReady = !!CONFIG.apiEndpoint;

  // POST to our own Vercel serverless function (api/allowlist.js).
  async function submitToApi(email, wallet) {
    const res = await fetch(CONFIG.apiEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email, wallet: wallet || null }),
    });
    if (res.ok) return { ok: true };
    if (res.status === 503) return { ok: false, notReady: true }; // DB not provisioned yet
    if (res.status === 409) return { ok: true, dup: true };
    return { ok: false };
  }

  // POST a signup to Supabase's REST (PostgREST) API.
  async function submitToSupabase(email, wallet) {
    const res = await fetch(`${sb.url}/rest/v1/${sb.table || "allowlist"}`, {
      method: "POST",
      headers: {
        apikey: sb.anonKey,
        Authorization: `Bearer ${sb.anonKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ email, wallet: wallet || null }),
    });
    // 23505 = unique_violation (already signed up) — treat as success.
    if (res.ok) return { ok: true };
    if (res.status === 409) return { ok: true, dup: true };
    let detail = "";
    try { detail = (await res.json()).message || ""; } catch {}
    if (detail.includes("duplicate")) return { ok: true, dup: true };
    return { ok: false };
  }

  async function submitToFormspree(form) {
    const res = await fetch(CONFIG.waitlistEndpoint, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: new FormData(form),
    });
    return { ok: res.ok };
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = form.elements.email.value.trim();
    const wallet = form.elements.wallet.value.trim();
    if (!email) {
      setStatus("Please enter your email.", false);
      return;
    }
    if (!apiReady && !supabaseReady && !CONFIG.waitlistEndpoint) {
      setStatus("Allowlist opens soon — follow our socials to be first. 😺", true);
      form.reset();
      return;
    }
    submitBtn.disabled = true;
    const prev = submitBtn.textContent;
    submitBtn.textContent = "Joining…";
    try {
      const result = apiReady
        ? await submitToApi(email, wallet)
        : supabaseReady
        ? await submitToSupabase(email, wallet)
        : await submitToFormspree(form);
      if (result.notReady) {
        setStatus("Allowlist opens soon — follow our socials to be first. 😺", true);
        form.reset();
      } else if (result.ok) {
        setStatus(
          result.dup
            ? "You're already on the list! 🐾"
            : "You're on the list! Welcome to the legend. 🐾",
          true
        );
        form.reset();
      } else {
        setStatus("Something went wrong — try again in a moment.", false);
      }
    } catch {
      setStatus("Network error — please try again.", false);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = prev;
    }
  });
})();

// ----- Mobile hamburger menu (injected so every page gets it) -----
(function () {
  const nav = document.querySelector(".nav");
  const links = document.querySelector(".nav-links");
  if (!nav || !links) return;
  const btn = document.createElement("button");
  btn.className = "nav-toggle";
  btn.setAttribute("aria-label", "Menu");
  btn.setAttribute("aria-expanded", "false");
  btn.innerHTML = "<span></span><span></span><span></span>";
  // place the toggle right before the CTA button if present, else at the end
  const cta = nav.querySelector(".nav-cta");
  nav.insertBefore(btn, cta || null);
  const setOpen = (open) => {
    links.classList.toggle("open", open);
    btn.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  };
  btn.addEventListener("click", () => setOpen(!links.classList.contains("open")));
  links.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => setOpen(false)));
  addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });
})();

// ----- Art Wall lightbox -----
(function () {
  const lb = document.getElementById("lightbox");
  const lbImg = document.getElementById("lightboxImg");
  const lbClose = document.getElementById("lightboxClose");
  if (!lb || !lbImg) return;
  const open = (src, alt) => {
    lbImg.src = src;
    lbImg.alt = alt || "Catboy art";
    lb.classList.add("open");
    lb.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  };
  const close = () => {
    lb.classList.remove("open");
    lb.setAttribute("aria-hidden", "true");
    lbImg.src = "";
    document.body.style.overflow = "";
  };
  document.querySelectorAll(".art-tile").forEach((tile) => {
    tile.addEventListener("click", () => {
      const img = tile.querySelector("img");
      open(tile.dataset.full || (img && img.src), img && img.alt);
    });
  });
  lb.addEventListener("click", (e) => { if (e.target === lb) close(); });
  if (lbClose) lbClose.addEventListener("click", close);
  addEventListener("keydown", (e) => { if (e.key === "Escape" && lb.classList.contains("open")) close(); });
})();

// ----- Scroll-progress bar -----
(function () {
  const bar = document.getElementById("progress");
  if (!bar) return;
  let ticking = false;
  const update = () => {
    const h = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.width = (h > 0 ? (window.scrollY / h) * 100 : 0) + "%";
    ticking = false;
  };
  addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  update();
})();

// ----- Subtle parallax on background glow + hero art -----
(function () {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) return;
  const glow = document.querySelector(".bg-glow");
  const art = document.querySelector(".hero-img");
  let ticking = false;
  const update = () => {
    const y = window.scrollY;
    if (glow) glow.style.transform = `translateY(${y * 0.15}px)`;
    if (art) art.style.transform = `translateY(${y * -0.05}px)`;
    ticking = false;
  };
  addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
})();

// ----- Count-up for numeric stats -----
(function () {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const els = document.querySelectorAll("[data-count]");
  const run = (el) => {
    const target = parseFloat(el.dataset.count);
    const prefix = el.dataset.prefix || "";
    const suffix = el.dataset.suffix || "";
    if (reduce) { el.textContent = prefix + target + suffix; return; }
    const dur = 1400;
    let start = null;
    const step = (t) => {
      if (start === null) start = t;
      const p = Math.min((t - start) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = prefix + Math.round(target * eased) + suffix;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      if (e.isIntersecting) { run(e.target); io.unobserve(e.target); }
    }), { threshold: 0.5 });
    els.forEach((el) => io.observe(el));
  } else {
    els.forEach(run);
  }
})();

// ----- Scroll reveal engine: staggered, directional, with safety net -----
(function () {
  if (!("IntersectionObserver" in window)) return; // no JS-added .reveal => content stays visible
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });

  const mark = (el, variant, delay) => {
    el.classList.add("reveal");
    if (variant) el.classList.add(variant);
    if (delay) el.style.setProperty("--rd", delay + "ms");
    io.observe(el);
  };

  // Single elements (headings, blocks) reveal as one unit.
  document.querySelectorAll(
    ".section-head, .lore-grid, .contract, .nft-info, .nft-mint, .waitlist-form, .cta-card, .ticker, .page-hero-inner, .saga-row, .lives-layout, .burn-stats"
  ).forEach((el) => mark(el));

  // Grids reveal their children in a staggered cascade.
  const groups = ".timeline, .token-grid, .steps, .nft-gallery, .roadmap, .merch-grid, .faq, .util-grid, .product-grid";
  document.querySelectorAll(groups).forEach((container) => {
    Array.from(container.children).forEach((child, i) => mark(child, null, i * 90));
  });

  // Safety net: reveal anything still hidden after 4s no matter what.
  setTimeout(() => document.querySelectorAll(".reveal").forEach((el) => el.classList.add("in")), 4000);
})();
