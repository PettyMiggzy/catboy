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
  // Waitlist/allowlist — paste a Formspree (or Getform) endpoint to collect signups.
  // Example: "https://formspree.io/f/xxxxxxx". Leave empty to show "opening soon".
  waitlistEndpoint: "https://formspree.io/f/xrewazwa",
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
document.getElementById("year").textContent = new Date().getFullYear();

// ----- Contract address -----
const caEl = document.getElementById("ca");
const copyBtn = document.getElementById("copyCa");
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

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = form.elements.email.value.trim();
    if (!email) {
      setStatus("Please enter your email.", false);
      return;
    }
    if (!CONFIG.waitlistEndpoint) {
      setStatus("Allowlist opens soon — follow our socials to be first. 😺", true);
      form.reset();
      return;
    }
    submitBtn.disabled = true;
    const prev = submitBtn.textContent;
    submitBtn.textContent = "Joining…";
    try {
      const res = await fetch(CONFIG.waitlistEndpoint, {
        method: "POST",
        headers: { Accept: "application/json" },
        body: new FormData(form),
      });
      if (res.ok) {
        setStatus("You're on the list! Welcome to the legend. 🐾", true);
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

// ----- Scroll reveal (with safety fallbacks so content can never stay hidden) -----
const revealEls = document.querySelectorAll(".section, .cta");
if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.08, rootMargin: "0px 0px -10% 0px" }
  );
  revealEls.forEach((el) => observer.observe(el));
  // Safety net: anything still hidden after 2.5s gets revealed regardless.
  setTimeout(() => revealEls.forEach((el) => el.classList.add("in")), 2500);
} else {
  revealEls.forEach((el) => el.classList.add("in"));
}
