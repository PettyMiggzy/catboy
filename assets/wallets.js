/* CATBOY — single source of truth for revenue routing.
   EVERY fee or sale on the site is split 90% treasury / 10% ops.
   Change an address here and it updates everywhere (mint, casino, ads, tips). */
window.CATBOY_WALLETS = {
  // 90% — main treasury / project wallet
  treasury: "3DHwgk2T3tGxQRfD3p897eq1UV9rwvw1JNWa2rS3RdKw",
  // 10% — overhead / operations ("nill money") wallet
  overhead: "EK8YS2haXFtKJ61phggC39m9RAG16B3NMx59uyMkP1PC",
  treasuryBps: 9000,   // 90.00%
  overheadBps: 1000,   // 10.00%
};

/* Split any SOL total into the 90/10 legs. Returns lamports so rounding is exact
   (treasury gets the floor, overhead gets the remainder — no lamports lost). */
window.CATBOY_PAY = {
  W: window.CATBOY_WALLETS,
  splitLamports(lamports) {
    const total = Math.max(0, Math.round(lamports));
    const treasury = Math.floor(total * this.W.treasuryBps / 10000);
    const overhead = total - treasury;
    return [
      { to: this.W.treasury, lamports: treasury },
      { to: this.W.overhead, lamports: overhead },
    ];
  },
  splitSol(sol) { return this.splitLamports(Math.round(sol * 1e9)); },
  pct() { return { treasury: this.W.treasuryBps / 100, overhead: this.W.overheadBps / 100 }; },
};

// flip to true at launch to turn real (split) payments on across the site
window.CATBOY_LAUNCHED = false;
