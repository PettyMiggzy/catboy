/* CATBOY — Holder engine. Single source of truth for Genesis/Nine-Lives NFT
   ownership, so holder perks (casino edge, city billboard, fighter skin,
   treasury vote) are REAL and consistent across every page.

   How it works:
   - At launch, set the two collection mints below. connect() then queries the
     wallet's assets via DAS (getAssetsByOwner) through the same-origin RPC
     proxy and counts how many Catboys it holds in each collection.
   - Before mint (mints empty) real ownership can't exist yet, so a clearly
     labelled PREVIEW mode lets holders-to-be see exactly what they'll unlock.
   - Perk math lives in CATBOY_PERKS so every page applies the SAME numbers. */
(function () {
  const CFG = {
    // Live collection mints — when set, ownership is verified on-chain automatically.
    genesisMint: (window.CATBOY_MINT && window.CATBOY_MINT.genesisMint) || "",
    prideMint:   (window.CATBOY_MINT && window.CATBOY_MINT.prideMint) || "",
    nineMint:    (window.CATBOY_MINT && window.CATBOY_MINT.collectionMint) || "",
    rpc: (window.CATBOY_MINT && window.CATBOY_MINT.rpc) || "/api/solrpc",
  };

  const LS_PREVIEW = "catboy_preview_holder";   // 'genesis' | 'pride' | 'nine' | ''
  const SS_STATE   = "catboy_holder_state";

  const empty = { connected: false, address: "", genesis: 0, pride: 0, nine: 0, total: 0,
                  tier: "none", isHolder: false, isGenesis: false, isPride: false,
                  isElite: false, source: "none" };

  let state = load();

  function load() {
    try { return Object.assign({}, empty, JSON.parse(sessionStorage.getItem(SS_STATE) || "null") || {}); }
    catch { return Object.assign({}, empty); }
  }
  function save() { try { sessionStorage.setItem(SS_STATE, JSON.stringify(state)); } catch {} }
  function emit() { save(); window.dispatchEvent(new CustomEvent("catboy:holder", { detail: get() })); }

  // Genesis and Pride are the "elite" tiers (top perks); Nine Lives is the base holder tier.
  function tierOf(genesis, pride, nine) {
    if (genesis > 0) return "genesis";
    if (pride > 0) return "pride";
    if (nine > 0) return "nine";
    return "none";
  }
  function apply(genesis, pride, nine, address, source) {
    state.genesis = genesis; state.pride = pride; state.nine = nine;
    state.total = genesis + pride + nine;
    state.address = address || state.address; state.source = source;
    state.tier = tierOf(genesis, pride, nine);
    state.isHolder = state.total > 0;
    state.isGenesis = genesis > 0;
    state.isPride = pride > 0;
    state.isElite = genesis > 0 || pride > 0;   // top-tier perks for Genesis OR Pride
    emit();
    return get();
  }
  function get() { return Object.assign({}, state); }

  const provider = () =>
    (window.solana && window.solana.isPhantom) ? window.solana :
    (window.solflare || window.backpack || (window.xnft && window.xnft.solana) || null);

  async function countHoldings(owner) {
    // no collection mints configured yet → cannot verify on-chain
    if (!CFG.genesisMint && !CFG.prideMint && !CFG.nineMint) return { genesis: 0, pride: 0, nine: 0, verifiable: false };
    const r = await fetch(location.origin + CFG.rpc, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "catboy", method: "getAssetsByOwner",
        params: { ownerAddress: owner, page: 1, limit: 1000 } }),
    });
    const d = await r.json();
    const items = (d.result && d.result.items) || [];
    const inColl = (a, mint) => mint && (a.grouping || []).some(
      (g) => g.group_key === "collection" && g.group_value === mint);
    let genesis = 0, pride = 0, nine = 0;
    for (const a of items) {
      if (inColl(a, CFG.genesisMint)) genesis++;
      else if (inColl(a, CFG.prideMint)) pride++;
      else if (inColl(a, CFG.nineMint)) nine++;
    }
    return { genesis, pride, nine, verifiable: true };
  }

  const API = {
    get,
    // preview mode: 'genesis' | 'nine' | '' (off). Persists across pages.
    getPreview() {
      // Preview is a pre-launch demo only. Once real collection mints are set,
      // ownership is verified on-chain and any client-set preview is ignored.
      if (CFG.genesisMint || CFG.prideMint || CFG.nineMint) return "";
      try { return localStorage.getItem(LS_PREVIEW) || ""; } catch { return ""; }
    },
    setPreview(kind) {
      if (CFG.genesisMint || CFG.prideMint || CFG.nineMint) return get(); // disabled once collections are live
      try { kind ? localStorage.setItem(LS_PREVIEW, kind) : localStorage.removeItem(LS_PREVIEW); } catch {}
      if (kind === "genesis") apply(3, 0, 0, state.address || "PREVIEW", "preview");
      else if (kind === "pride") apply(0, 1, 0, state.address || "PREVIEW", "preview");
      else if (kind === "nine") apply(0, 0, 1, state.address || "PREVIEW", "preview");
      else { Object.assign(state, empty, { address: state.address, connected: state.connected }); emit(); }
      return get();
    },
    async connect() {
      const p = provider();
      if (!p) throw new Error("No Solana wallet found — install Phantom.");
      const r = await p.connect();
      const owner = (r && r.publicKey ? r.publicKey : p.publicKey).toString();
      state.connected = true; state.address = owner;
      // Real on-chain ownership is always authoritative for a connected wallet —
      // a client-set preview can never override it.
      try {
        const h = await countHoldings(owner);
        if (h.verifiable) return apply(h.genesis, h.pride, h.nine, owner, "chain");
      } catch (e) { save(); throw e; }
      // Only pre-launch (no collections configured yet) fall back to the demo preview.
      const preview = API.getPreview();
      if (preview) return API.setPreview(preview);
      return apply(0, 0, 0, owner, "unverifiable");
    },
    // apply preview immediately (no wallet) for pure UI preview
    init() {
      const preview = API.getPreview();
      if (preview) API.setPreview(preview);
      else emit();
      return get();
    },
  };

  // Perk math — ONE place, used by casino / fight / dashboard.
  window.CATBOY_PERKS = {
    // coin-flip win chance (base 0.48 = 2% house edge). Genesis/Pride = elite.
    flipChance(h) { h = h || get(); return h.isElite ? 0.53 : h.isHolder ? 0.50 : 0.48; },
    // daily-bonus multiplier
    dailyMult(h)  { h = h || get(); return h.isElite ? 2.0 : h.isHolder ? 1.5 : 1.0; },
    // fighter wager payout bonus added to the base multiplier
    wagerBonus(h) { h = h || get(); return h.isElite ? 0.5 : h.isHolder ? 0.25 : 0; },
    // max wager cap (credits) — holders unlock BIGGER wagers (base stays 100)
    wagerCap(h)   { h = h || get(); return h.isElite ? 500 : h.isHolder ? 250 : 100; },
    // fighter skin id unlocked
    skin(h)       { h = h || get(); return h.isGenesis ? "genesis" : h.isPride ? "pride" : h.isHolder ? "nine" : "base"; },
    label(h) {
      h = h || get();
      if (h.tier === "genesis") return "Genesis Holder";
      if (h.tier === "pride") return "Pride Holder";
      if (h.tier === "nine") return "Nine Lives Holder";
      return "";
    },
  };

  window.CATBOY_HOLDER = API;
  // fire an initial event so listeners can render current (possibly preview) state
  try { API.init(); } catch {}
})();
