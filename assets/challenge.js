/* CATBOY — "Beat Winslow" boss-challenge promotion.
   Rules (set by the team):
     • Promo goes LIVE on the start date below. Until then it's free PRACTICE.
     • Entry: 0.25 SOL.
     • Prize: 1 SOL to the FIRST player to beat Winslow. One winner only.
     • When someone wins, set winner + closed:true here and redeploy — the
       challenge then shows as CLOSED everywhere.
   Payout + win verification are handled by the team (a winner gets a proof
   code to DM); a client-side game can't custody or trustlessly pay 1 SOL. */
(function () {
  const W = window.CATBOY_WALLETS || {};
  const CH = {
    startISO: "2026-07-10T00:00:00Z",  // promo start (UTC)
    entrySol: 0.25,
    prizeSol: 1,
    winner: "",        // ← set to the winner's handle/wallet when beaten
    closed: false,     // ← flip true when the 1 SOL has been claimed
    pool: W.overhead || "",
    rpc: (window.CATBOY_MINT && window.CATBOY_MINT.rpc) || "/api/solrpc",

    startMs() { return Date.parse(this.startISO); },
    isClosed() { return !!this.closed; },
    isLive()   { return !this.closed && Date.now() >= this.startMs(); },
    isPractice(){ return !this.closed && Date.now() < this.startMs(); },
    msLeft()   { return Math.max(0, this.startMs() - Date.now()); },
    countdown() {
      let s = Math.floor(this.msLeft() / 1000);
      const d = Math.floor(s / 86400); s -= d * 86400;
      const h = Math.floor(s / 3600);  s -= h * 3600;
      const m = Math.floor(s / 60);    s -= m * 60;
      return { d, h, m, s };
    },
    // local record that THIS device beat him (for the claim screen)
    markBeaten(mode) { try { localStorage.setItem("catboy_beat_winslow", mode + ":" + Date.now()); } catch {} },
    hasBeaten() { try { return !!localStorage.getItem("catboy_beat_winslow"); } catch { return false; } },

    // real 0.25 SOL entry payment (native web3.js + wallet signAndSendTransaction)
    async payEntry() {
      const p = (window.solana && window.solana.isPhantom) ? window.solana
        : (window.solflare || window.backpack || (window.xnft && window.xnft.solana) || null);
      if (!p) throw new Error("No Solana wallet found — install Phantom.");
      if (!this.pool) throw new Error("Entry isn't available right now.");
      const r = await p.connect();
      const from = (r && r.publicKey) ? r.publicKey : p.publicKey;
      const web3 = await import("https://esm.sh/@solana/web3.js@1.95.3");
      const conn = new web3.Connection(location.origin + this.rpc, "confirmed");
      const tx = new web3.Transaction().add(web3.SystemProgram.transfer({
        fromPubkey: new web3.PublicKey(from),
        toPubkey: new web3.PublicKey(this.pool),
        lamports: Math.round(this.entrySol * 1e9),
      }));
      tx.feePayer = new web3.PublicKey(from);
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      const res = await p.signAndSendTransaction(tx);
      const signature = res && res.signature ? res.signature : res;
      await conn.confirmTransaction(signature, "confirmed");
      return signature;
    },
  };
  window.CATBOY_CHALLENGE = CH;
})();
