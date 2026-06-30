// ===== CATBOY — site config =====
// Edit these when the token launches. Everything else updates automatically.
const CONFIG = {
  contractAddress: "", // paste the Solana mint address here at launch
  socials: {
    x: "",        // e.g. "https://x.com/catboy_sol"
    telegram: "", // e.g. "https://t.me/catboy_sol"
  },
};

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
