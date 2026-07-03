/* CATBOY Brawl — a 2.5D neon fighter. Catboy vs the Solana roster. */
(function () {
  "use strict";
  const cv = document.getElementById("fg");
  if (!cv) return;
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  const GROUND = H - 64;
  const FP = "assets/game/fighters/";

  // ---------- wagering (shared casino credits; free demo, real $CATBOY at launch) ----------
  const CREDIT_KEY = "catboy_credits";
  const getCredits = () => { const c = parseInt(localStorage.getItem(CREDIT_KEY) || "50", 10); return isNaN(c) ? 50 : c; };
  const setCredits = (n) => { n = Math.max(0, Math.round(n)); localStorage.setItem(CREDIT_KEY, n); const el = document.getElementById("wgCredits"); if (el) el.textContent = n; };
  const payMult = (oppIdx) => 1.8 + oppIdx * 0.2;   // tougher/later foes pay more (house edge baked in)
  let WAGER = 0;
  function wgNote(m) { const el = document.getElementById("wgNote"); if (el) el.textContent = m; }
  document.querySelectorAll(".wg-chip").forEach((c) => c.addEventListener("click", () => {
    document.querySelectorAll(".wg-chip").forEach((x) => x.classList.remove("active"));
    c.classList.add("active"); WAGER = parseInt(c.dataset.w, 10) || 0;
  }));
  setCredits(getCredits());   // init the display

  // ---------- roster ----------
  const ROSTER = [
    { id: "catboy", name: "CATBOY", poses: true, color: "#9b4dff", hp: 100, pow: 1.05, spd: 1.15, special: "Nine Lives Fury", blurb: "The legend. Fast, relentless, nine chances." },
    { id: "sol",    name: "SOLANA",   img: "char_sol.png",   char: true, color: "#9945ff", hp: 125, pow: 1.15, spd: 1.1,  special: "Proof of Stake", blurb: "The chain itself. Balanced and unstoppable." },
    { id: "jup",    name: "JUPITER",  img: "char_jup.png",   char: true, color: "#c7f94c", hp: 100, pow: 1.0,  spd: 1.22, special: "Best Route", blurb: "The aggregator. Fast — finds every opening." },
    { id: "pump",   name: "PUMP.FUN", img: "char_pump.png",  char: true, color: "#2ed573", hp: 95,  pow: 1.05, spd: 1.16, special: "Bonding Curve", blurb: "The launchpad. Unpredictable chaos." },
    { id: "bonk",   name: "BONK",     img: "char_bonk.png",  char: true, color: "#f7a600", hp: 115, pow: 1.12, spd: 0.95, special: "Bonk Hammer", blurb: "The OG dog with a bat. Hits like a truck." },
    { id: "wif",    name: "dogwifhat",img: "char_wif.png",   char: true, color: "#d49a6a", hp: 100, pow: 1.0,  spd: 1.08, special: "Hat Trick", blurb: "Just a dog with a hat. Don't sleep on it." },
    { id: "pengu",  name: "PENGU",    img: "char_pengu.png", char: true, color: "#50aaff", hp: 105, pow: 1.02, spd: 1.05, special: "Ice Slide", blurb: "Pudgy Penguins. Cool under pressure." },
    { id: "jto",    name: "JITO",     img: "char_jto.png",   char: true, color: "#00d2b4", hp: 100, pow: 1.05, spd: 1.1,  special: "MEV Strike", blurb: "Liquid staking. Strikes out of nowhere." },
    { id: "pyth",   name: "PYTH",     img: "char_pyth.png",  char: true, color: "#aa78ff", hp: 90,  pow: 1.1,  spd: 1.05, special: "Price Feed", blurb: "The oracle. Ranged data blasts." },
    { id: "trump",  name: "TRUMP",    img: "char_trump.png", char: true, color: "#d4af37", hp: 122, pow: 1.18, spd: 0.85, special: "Tariff Slam", blurb: "Official Trump. Heavyweight, huge hits." },
    { id: "popcat", name: "POPCAT",   img: "char_popcat.png",char: true, color: "#e7b9a0", hp: 90,  pow: 0.95, spd: 1.22, special: "Pop Slam", blurb: "Pop pop pop. Glass cannon." },
  ];

  // Per-fighter special moves — each its own archetype + visual.
  const SPECIALS = {
    catboy:  { type: "rush",      color: "#9b4dff", hits: 5, dmg: 7 },   // dashing claw flurry
    sol:     { type: "beam",      color: "#14f195", dmg: 28 },           // wide stake beam
    jup:     { type: "multishot", color: "#c7f94c", n: 3, dmg: 10 },     // 3 routed orbs
    pump:    { type: "grow",      color: "#2ed573", dmg: 24 },           // bonding-curve orb that swells
    bonk:    { type: "slam",      color: "#f7a600", dmg: 26 },           // bat shockwave
    wif:     { type: "multishot", color: "#d49a6a", n: 3, dmg: 9, spin: true }, // spinning hats
    pengu:   { type: "slide",     color: "#7fd4ff", dmg: 22 },           // ice belly-slide
    jto:     { type: "teleport",  color: "#00d2b4", dmg: 26 },           // blink strike
    pyth:    { type: "rain",      color: "#aa78ff", n: 5, dmg: 9 },      // candlestick rain
    trump:   { type: "slam",      color: "#d4af37", dmg: 28 },           // tariff ground pound
    popcat:  { type: "multishot", color: "#e7b9a0", n: 4, dmg: 6, fast: true }, // pop barrage
  };
  const specOf = (def) => SPECIALS[def.id] || { type: "orb", color: def.color, dmg: 22 };

  // ---------- assets ----------
  const IMG = {};
  function load(src) {
    if (IMG[src]) return IMG[src];
    const i = new Image(); i.src = src; IMG[src] = i; return i;
  }
  ROSTER.forEach((r) => {
    if (r.poses) ["idle","punch","kick","special","hit","ko","jump"].forEach((p) => load(FP + "catboy_" + p + ".png"));
    else load(FP + r.img);
  });
  const BG = load("assets/game/city-bg.png");

  function fimg(def, state) {
    if (def.poses) {
      const map = { idle:"idle", walk:"idle", jump:"jump", punch:"punch", kick:"kick", special:"special", block:"idle", hurt:"hit", ko:"ko" };
      return IMG[FP + "catboy_" + (map[state] || "idle") + ".png"];
    }
    return IMG[FP + def.img];
  }

  // ---------- input ----------
  const keys = {};
  const KMAP = { a:"left", d:"right", arrowleft:"left", arrowright:"right", w:"jump", " ":"jump", arrowup:"jump",
    s:"block", arrowdown:"block", j:"punch", k:"kick", l:"special" };
  addEventListener("keydown", (e) => { const k = KMAP[e.key.toLowerCase()]; if (k) { keys[k] = true; if (k==="jump"||k==="block") e.preventDefault(); } });
  addEventListener("keyup", (e) => { const k = KMAP[e.key.toLowerCase()]; if (k) keys[k] = false; });
  // touch pad
  document.querySelectorAll("#pad .pad-btn").forEach((b) => {
    const k = b.dataset.k;
    const on = (e) => { e.preventDefault(); keys[k] = true; b.classList.add("on"); };
    const off = (e) => { e.preventDefault(); keys[k] = false; b.classList.remove("on"); };
    b.addEventListener("touchstart", on, { passive: false });
    b.addEventListener("touchend", off); b.addEventListener("touchcancel", off);
    b.addEventListener("mousedown", on); b.addEventListener("mouseup", off); b.addEventListener("mouseleave", off);
  });

  // ---------- fighter ----------
  function Fighter(def, x, facing, isCPU) {
    this.def = def; this.x = x; this.y = GROUND; this.vx = 0; this.vy = 0;
    this.facing = facing; this.cpu = isCPU;
    this.maxhp = def.hp; this.hp = def.hp; this.meter = 0;
    this.state = "idle"; this.st = 0;       // state timer (ms)
    this.cool = 0; this.hitstun = 0; this.invuln = 0; this.flash = 0;
    this.didHit = false; this.combo = 0; this.comboT = 0;
    this.h = (def.poses || def.char) ? 252 : 150;  // draw height (full-body chars vs token)
    this.onGround = true;
    this.ai = { t: 0, want: "idle" };
    this.bob = Math.random() * 6;
  }
  Fighter.prototype.reach = function () { return (this.def.poses || this.def.char) ? 150 : 120; };
  Fighter.prototype.set = function (s, dur) { this.state = s; this.st = 0; this.dur = dur || 0; this.didHit = false; this.isFinisher = false; };
  Fighter.prototype.busy = function () { return ["punch","kick","special","hurt","ko"].includes(this.state); };

  Fighter.prototype.tryAttack = function (kind) {
    if (this.cool > 0 || this.busy() || !this.onGround) return;
    if (kind === "special") {
      if (this.meter < 100) return;
      this.meter = 0; this.set("special", 620); this.cool = 760;
      this.specHits = 0; this._lastSpecHit = 0; return;
    }
    if (kind === "punch") { this.set("punch", 300); this.cool = 340; }
    else { this.set("kick", 420); this.cool = 480; }
  };

  // ---------- game ----------
  let G = null;
  function newMatch(player, oppList) {
    return {
      player, oppQueue: oppList.slice(), oppIdx: 0, staked: 0, lastPay: 0,
      p1: null, p2: null, round: 1, w1: 0, w2: 0,
      phase: "intro", phaseT: 0, roundTime: 60, shake: 0, sparks: [], shots: [], beams: [], pops: [], blood: [], splats: [], finFlash: 0, slow: 1,
    };
  }
  function startRound(keepWins) {
    const pdef = G.player, odef = G.oppQueue[G.oppIdx];
    G.p1 = new Fighter(pdef, W * 0.3, 1, false);
    G.p2 = new Fighter(odef, W * 0.7, -1, true);
    G.p2.maxhp = Math.round(G.p2.maxhp * (1 + G.oppIdx * 0.06));
    G.p2.hp = G.p2.maxhp;
    if (!keepWins) { G.w1 = 0; G.w2 = 0; G.round = 1; }
    G.roundTime = 60; G.phase = "intro"; G.phaseT = 0; G.sparks = []; G.shots = []; G.beams = []; G.pops = []; G.blood = []; G.splats = []; G.finFlash = 0;
  }

  function spark(x, y, c, n) {
    for (let i = 0; i < (n || 10); i++) G.sparks.push({ x, y, vx: (Math.random()-0.5)*7, vy: (Math.random()-0.7)*7, life: 1, c });
  }
  function popText(x, y, t, c) { G.pops.push({ x, y, t, c, life: 1 }); }
  function bloodSpray(x, y, dir, n) {
    n = n || 10;
    for (let i = 0; i < n; i++)
      G.blood.push({ x, y, vx: dir * (0.5 + Math.random() * 4) + (Math.random() - 0.5) * 5,
        vy: -(1.5 + Math.random() * 7), r: 1.4 + Math.random() * 3.2, life: 1 });
  }
  function koFighter(def, att, kb) {
    def.set("ko", 4000); def.vx = kb * att.facing * 1.4; def.vy = -6;
    G.shake = 16; G.slow = 0.35;
    bloodSpray(def.x, def.y - def.h * 0.55, att.facing, 24);
  }
  // finisher: available when the foe is low + in range (player only)
  function finishPromptable(f, foe) {
    return f && foe && !f.cpu && foe.state !== "ko" && foe.hp > 0 &&
      foe.hp <= foe.maxhp * 0.20 && Math.abs(f.x - foe.x) <= f.reach() + 44;
  }
  function canFinish(f, foe) {
    return finishPromptable(f, foe) && !f.busy() && f.onGround;
  }
  function doFinisher(f, foe) {
    f.set("special", 720); f.cool = 900; f.isFinisher = true; f.didHit = true;
    G.slow = 0.22; G.shake = 24; G.finFlash = 1;
    foe.hp = 0; foe.set("ko", 5000); foe.vx = f.facing * 11; foe.vy = -9;
    bloodSpray(foe.x, foe.y - foe.h * 0.6, f.facing, 60);
    bloodSpray(foe.x, foe.y - foe.h * 0.32, f.facing, 44);
    spark(foe.x, foe.y - foe.h * 0.5, "#ff2d4d", 30);
    popText(W / 2, H / 2 - 44, "FINISHED!", "#ff2d4d");
    popText(f.x, f.y - f.h - 20, f.def.special.toUpperCase(), f.def.color);
  }

  function applyHit(att, def, dmg, kb, hitX, hitY) {
    if (def.invuln > 0 || def.state === "ko") return;
    // only an ACTUAL block (visible) reduces damage — no more invisible CPU blocking
    const blocked = def.state === "block" || (def === G.p1 && keys.block && def.onGround);
    let d = dmg;
    if (blocked) { d = Math.round(dmg * 0.25); spark(hitX, hitY, "#19e0ff", 7); G.shake = Math.max(G.shake, 4); }
    else {
      def.set("hurt", 260 + dmg * 6); def.hitstun = 260 + dmg * 6;
      def.vx = kb * (att.facing); def.vy = -3;
      spark(hitX, hitY, "#ff3df0", 8);
      bloodSpray(hitX, hitY, att.facing, Math.min(22, 5 + d));   // blood on a clean hit
      G.shake = Math.max(G.shake, 9);
      att.combo++; att.comboT = 900;
      if (att.combo > 1) popText(def.x, def.y - def.h - 10, att.combo + " HIT", "#ffd84d");
    }
    def.hp = Math.max(0, def.hp - d);
    att.meter = Math.min(100, att.meter + (blocked ? 4 : 9));
    def.meter = Math.min(100, def.meter + (blocked ? 3 : 6));
    def.flash = 1;
    popText(hitX, hitY - 18, "-" + d, blocked ? "#9fe8ff" : "#ff6b9d");
    if (def.hp <= 0) koFighter(def, att, kb);
  }

  // CPU brain
  function think(me, foe, dt) {
    const ai = me.ai; ai.t -= dt;
    const dist = Math.abs(me.x - foe.x);
    me.facing = foe.x >= me.x ? 1 : -1;
    if (me.busy() || me.state === "ko" || me.hitstun > 0) { ai.want = "idle"; return; }
    const lvl = 0.5 + G.oppIdx * 0.07; // harder later
    if (ai.t <= 0) {
      ai.t = 220 + Math.random() * 380 * (1.3 - lvl);
      const r = Math.random();
      if (foe.state === "punch" || foe.state === "kick") { ai.want = (r < Math.min(0.55, lvl)) ? "block" : "back"; }
      else if (dist > me.reach() + 30) ai.want = "approach";
      else if (me.meter >= 100 && r < 0.6) ai.want = "special";
      else if (r < 0.45) ai.want = "punch";
      else if (r < 0.72) ai.want = "kick";
      else if (r < 0.85) ai.want = "back";
      else ai.want = "idle";
    }
    me.vx = 0;
    if (me.state === "block" && ai.want !== "block") me.state = "idle";
    if (ai.want === "approach") me.vx = me.def.spd * 2.4 * me.facing;
    else if (ai.want === "back") me.vx = -me.def.spd * 1.8 * me.facing;
    else if (ai.want === "punch") me.tryAttack("punch");
    else if (ai.want === "kick") me.tryAttack("kick");
    else if (ai.want === "special") me.tryAttack("special");
    else if (ai.want === "block") { if (!me.busy() && me.onGround) me.state = "block"; }
  }

  function updateFighter(f, foe, dt) {
    f.st += dt; f.cool = Math.max(0, f.cool - dt); f.invuln = Math.max(0, f.invuln - dt);
    f.flash = Math.max(0, f.flash - dt / 120); f.comboT -= dt; if (f.comboT <= 0) f.combo = 0;
    f.hitstun = Math.max(0, f.hitstun - dt);

    if (f.state === "ko") { /* fall + settle */ }
    else if (f.state === "hurt") { if (f.st >= f.dur) f.set("idle"); }
    else {
      // control
      if (!f.cpu) {
        f.facing = foe.x >= f.x ? 1 : -1;
        if (!f.busy() && f.onGround) {
          let mv = 0; if (keys.left) mv -= 1; if (keys.right) mv += 1;
          f.vx = mv * f.def.spd * 3.0;
          if (keys.jump && f.onGround) { f.vy = -13; f.onGround = false; }
          if (keys.block && mv === 0) f.state = "block"; else if (f.state === "block") f.state = "idle";
          if (keys.punch) f.tryAttack("punch");
          else if (keys.kick) f.tryAttack("kick");
          else if (keys.special) { if (canFinish(f, foe)) doFinisher(f, foe); else f.tryAttack("special"); }
        }
      }
      // attack active windows -> hit check
      if ((f.state === "punch" || f.state === "kick") && !f.didHit && f.st > f.dur * 0.28 && f.st < f.dur * 0.7) {
        const dist = Math.abs(f.x - foe.x);
        const facingFoe = (foe.x - f.x) * f.facing > 0;
        if (dist <= f.reach() && facingFoe && foe.state !== "ko") {
          f.didHit = true;
          const dmg = Math.round((f.state === "punch" ? 7 : 13) * f.def.pow);
          const kb = f.state === "punch" ? 5 : 9;
          applyHit(f, foe, dmg, kb, (f.x + foe.x) / 2, f.y - f.h * 0.55);
        }
      }
      // special move — per-fighter archetype (skipped for a finisher)
      if (f.state === "special" && !f.isFinisher) {
        const cfg = specOf(f.def);
        if (cfg.type === "rush") {
          if (f.st < f.dur * 0.78) f.vx = f.facing * f.def.spd * 4.4;
          if (f.st - f._lastSpecHit > 110 && (f.specHits || 0) < (cfg.hits || 4)) {
            const dist = Math.abs(f.x - foe.x), facingFoe = (foe.x - f.x) * f.facing > 0;
            if (dist <= f.reach() + 12 && facingFoe && foe.state !== "ko") {
              applyHit(f, foe, Math.round((cfg.dmg || 7) * f.def.pow), 4, (f.x + foe.x) / 2, f.y - f.h * 0.55);
              f.specHits = (f.specHits || 0) + 1; f._lastSpecHit = f.st;
            }
          }
          if (Math.random() < 0.55) G.sparks.push({ x: f.x, y: f.y - f.h * 0.5, vx: -f.facing * 2, vy: -1, life: 0.5, c: cfg.color });
        } else if (!f.didHit && f.st > 140) {
          f.didHit = true; fireSpecial(f, foe, cfg);
        }
      }
      if (f.busy() && f.st >= f.dur && f.state !== "ko") f.set("idle");
      if (Math.abs(f.vx) > 0.2 && f.state === "idle") f.state = "walk";
      else if (f.state === "walk" && Math.abs(f.vx) <= 0.2) f.state = "idle";
    }

    // physics
    f.x += f.vx * dt / 16;
    if (!f.onGround || f.state === "ko") { f.vy += 0.6 * dt / 16; f.y += f.vy * dt / 16; }
    if (f.y >= GROUND) { f.y = GROUND; f.vy = 0; if (!f.onGround) f.onGround = true; }
    if (f.onGround && f.state !== "ko" && f.hitstun <= 0) f.vx *= 0.6;
    f.x = Math.max(60, Math.min(W - 60, f.x));
    if (f.state !== "ko") f.bob += dt / 200;
    // footstep dust while striding
    if (f.state === "walk" && f.onGround) {
      f.stepT = (f.stepT || 0) - dt;
      if (f.stepT <= 0) {
        f.stepT = 250;
        for (let k = 0; k < 3; k++) G.sparks.push({ x: f.x - f.facing * (6 + k * 5), y: GROUND - 2, vx: -f.facing * (1 + Math.random()), vy: -Math.random() * 1.5, life: 0.45, c: "#b9a6e0" });
      }
    }
  }

  function fireSpecial(f, foe, cfg) {
    const ox = f.x + f.facing * 40, oy = f.y - f.h * 0.55, P = f.def.pow;
    G.shake = Math.max(G.shake, 9); spark(ox, oy, cfg.color, 18);
    popText(f.x, f.y - f.h - 16, f.def.special.toUpperCase(), cfg.color);
    const S = (o) => G.shots.push(Object.assign({ x: ox, y: oy, vx: f.facing * 9, vy: 0, owner: f, c: cfg.color, r: 18, life: 1500, shape: "orb", kb: 10 }, o));
    switch (cfg.type) {
      case "beam":
        G.beams.push({ x: ox, y: oy, c: cfg.color, life: 440, max: 440, facing: f.facing });
        if ((foe.x - f.x) * f.facing > 0 && foe.state !== "ko") applyHit(f, foe, Math.round((cfg.dmg || 26) * P), 13, foe.x, oy);
        break;
      case "slam":
        S({ y: GROUND - 14, vx: f.facing * 6, dmg: Math.round((cfg.dmg || 24) * P), r: 32, shape: "wave", grow: 0.05, life: 1700, kb: 15 });
        break;
      case "grow":
        S({ vx: f.facing * 6, dmg: Math.round((cfg.dmg || 22) * P), r: 14, grow: 0.08, life: 1700, kb: 12 });
        break;
      case "slide":
        f.vx = f.facing * f.def.spd * 5;
        S({ y: GROUND - 22, vx: f.facing * 10, dmg: Math.round((cfg.dmg || 20) * P), r: 22, kb: 11 });
        break;
      case "multishot": {
        const n = cfg.n || 3;
        for (let i = 0; i < n; i++) S({
          y: oy - 28 + i * (56 / Math.max(1, n - 1)), vx: f.facing * (cfg.fast ? 12 : 9),
          dmg: Math.round((cfg.dmg || 8) * P), r: cfg.fast ? 12 : 16, shape: cfg.spin ? "hat" : "orb", ang: 0, kb: 6, life: 1500,
        });
        break;
      }
      case "rain": {
        const n = cfg.n || 5;
        for (let i = 0; i < n; i++) S({
          x: foe.x - 90 + i * (180 / Math.max(1, n - 1)), y: -30 - i * 36, vx: 0, vy: 6, gravity: 0.26,
          dmg: Math.round((cfg.dmg || 8) * P), r: 13, shape: "candle", kb: 6, life: 2400,
        });
        break;
      }
      case "teleport":
        spark(f.x, oy, cfg.color, 16);
        f.x = Math.max(60, Math.min(W - 60, foe.x - f.facing * 92));
        f.facing = foe.x >= f.x ? 1 : -1;
        spark(f.x, oy, cfg.color, 22); G.shake = Math.max(G.shake, 11);
        if (foe.state !== "ko") applyHit(f, foe, Math.round((cfg.dmg || 26) * P), 13, foe.x, oy);
        break;
      default:
        S({ dmg: Math.round((cfg.dmg || 22) * P), r: 20, kb: 11 });
    }
  }

  function updateBeams(dt) {
    if (!G.beams) return;
    for (let i = G.beams.length - 1; i >= 0; i--) { G.beams[i].life -= dt; if (G.beams[i].life <= 0) G.beams.splice(i, 1); }
  }

  function updateShots(dt) {
    for (let i = G.shots.length - 1; i >= 0; i--) {
      const s = G.shots[i];
      s.x += s.vx * dt / 16;
      if (s.vy) s.y += s.vy * dt / 16;
      if (s.gravity) s.vy += s.gravity * dt / 16;
      if (s.grow) s.r += s.grow * dt / 16;
      if (s.ang !== undefined) s.ang += 0.32;
      s.life -= dt;
      const foe = s.owner === G.p1 ? G.p2 : G.p1;
      const fy = foe.y - foe.h * 0.5, dx = Math.abs(s.x - foe.x);
      if (!s.dead && foe.state !== "ko" && s.life > 0) {
        const hit = s.shape === "wave" ? (dx < s.r + 28) : (dx < s.r + 40 && Math.abs(s.y - fy) < foe.h * 0.55 + s.r);
        if (hit) { applyHit(s.owner, foe, s.dmg, s.kb || 11, s.x, s.y); s.dead = true; }
      }
      if (s.shape === "candle" && s.y > GROUND) { s.dead = true; spark(s.x, GROUND, s.c, 8); }
      if (s.dead || s.life <= 0 || s.x < -60 || s.x > W + 60) G.shots.splice(i, 1);
    }
  }

  // ---------- rendering ----------
  function drawBG() {
    if (BG.complete && BG.naturalWidth) {
      const s = Math.max(W / BG.naturalWidth, H / BG.naturalHeight);
      const w = BG.naturalWidth * s, h = BG.naturalHeight * s;
      ctx.globalAlpha = 0.55; ctx.drawImage(BG, (W - w) / 2, (H - h) / 2, w, h); ctx.globalAlpha = 1;
    } else { ctx.fillStyle = "#0a0618"; ctx.fillRect(0, 0, W, H); }
    ctx.fillStyle = "rgba(8,4,20,0.55)"; ctx.fillRect(0, 0, W, H);
    // floor
    const g = ctx.createLinearGradient(0, GROUND, 0, H);
    g.addColorStop(0, "rgba(155,77,255,0.35)"); g.addColorStop(1, "rgba(5,3,12,0.9)");
    ctx.fillStyle = g; ctx.fillRect(0, GROUND, W, H - GROUND);
    ctx.strokeStyle = "rgba(25,224,255,0.6)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, GROUND); ctx.lineTo(W, GROUND); ctx.stroke();
  }

  function drawFighter(f) {
    const img = fimg(f.def, f.state);
    if (!img || !img.complete || !img.naturalWidth) return;
    const ar = img.naturalWidth / img.naturalHeight;
    let h = f.h, w = h * ar;
    let cx = f.x, cy = f.y;
    ctx.save();
    // shadow
    ctx.globalAlpha = 0.4; ctx.fillStyle = "#000";
    ctx.beginPath(); ctx.ellipse(f.x, GROUND + 6, w * 0.32, 10, 0, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
    ctx.translate(cx, cy);
    if (f.facing < 0) ctx.scale(-1, 1);
    // procedural motion
    let dy = 0, rot = 0, sc = 1, scx = 1;
    if (f.state === "ko") { rot = Math.min(1.45, f.st / 600 * 1.45); }
    else if (f.state === "hurt") { rot = -0.18; }
    else if (f.state === "punch" || f.state === "kick") {
      const p = Math.sin(Math.min(1, f.st / f.dur) * Math.PI); sc = 1 + p * 0.06;
      ctx.translate(p * (f.state === "kick" ? 34 : 26), 0);
    } else if (f.state === "special") {
      sc = 1 + Math.sin(Math.min(1, f.st / f.dur) * Math.PI) * 0.1;
    } else if (f.state === "walk") {
      // bounce-stride so movement reads as walking, not sliding
      const ph = f.bob * 3.6, hop = Math.abs(Math.sin(ph));
      dy = -hop * 13;                          // hop up on each step
      rot = Math.sin(ph) * 0.07 * f.facing;    // rock with the stride
      sc = 1 + hop * 0.03; scx = 1 - hop * 0.02;
      if (hop < 0.12) { dy = 0; scx = 1.05; sc = 0.97; } // squash on footfall
    } else if (f.state === "block") { sc = 0.96; }
    else { dy = Math.sin(f.bob * 1.4) * ((f.def.poses || f.def.char) ? 3 : 7); } // idle breathe
    ctx.translate(0, dy); ctx.rotate(rot); ctx.scale(scx * sc, sc);
    // draw centered, feet at 0
    const dw = w, dh = h;
    if (f.flash > 0) { ctx.shadowColor = "#fff"; ctx.shadowBlur = 30; }
    ctx.drawImage(img, -dw / 2, -dh, dw, dh);
    if (f.flash > 0) {
      ctx.globalCompositeOperation = "source-atop";
      ctx.globalAlpha = f.flash * 0.7; ctx.fillStyle = "#ff2d7a";
      ctx.fillRect(-dw / 2, -dh, dw, dh);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    }
    ctx.restore();
    // block shield
    if (f.state === "block") {
      ctx.save(); ctx.globalAlpha = 0.5; ctx.strokeStyle = "#19e0ff"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(f.x + f.facing * 22, f.y - h * 0.5, h * 0.42, -1, 1); ctx.stroke(); ctx.restore();
    }
  }

  function drawShots() {
    // beams (behind projectiles)
    (G.beams || []).forEach((b) => {
      const a = b.life / b.max, x1 = b.facing > 0 ? W : 0, left = Math.min(b.x, x1), w = Math.abs(x1 - b.x);
      ctx.save();
      const grad = ctx.createLinearGradient(b.x, 0, x1, 0);
      grad.addColorStop(0, b.c); grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.globalAlpha = a; ctx.fillStyle = grad; const h = 50 * a + 12; ctx.fillRect(left, b.y - h / 2, w, h);
      ctx.globalAlpha = a * 0.8; ctx.fillStyle = "#fff"; ctx.fillRect(left, b.y - 6, w, 12);
      ctx.restore();
    });
    G.shots.forEach((s) => {
      ctx.save();
      if (s.shape === "wave") {
        ctx.globalAlpha = Math.max(0, Math.min(1, s.life / 700));
        ctx.strokeStyle = s.c; ctx.lineWidth = 6;
        ctx.beginPath(); ctx.ellipse(s.x, GROUND, s.r, s.r * 0.5, 0, Math.PI, 2 * Math.PI); ctx.stroke();
        ctx.globalAlpha *= 0.3; ctx.fillStyle = s.c;
        ctx.beginPath(); ctx.ellipse(s.x, GROUND, s.r, s.r * 0.5, 0, Math.PI, 2 * Math.PI); ctx.fill();
      } else if (s.shape === "hat") {
        ctx.translate(s.x, s.y); ctx.rotate(s.ang || 0); ctx.fillStyle = s.c;
        ctx.beginPath(); ctx.ellipse(0, 0, s.r, s.r * 0.55, 0, 0, 7); ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.7)"; ctx.fillRect(-s.r * 0.6, -2, s.r * 1.2, 4);
      } else if (s.shape === "candle") {
        ctx.strokeStyle = s.c; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(s.x, s.y - 24); ctx.lineTo(s.x, s.y + 24); ctx.stroke();
        ctx.fillStyle = s.c; ctx.fillRect(s.x - 6, s.y - 16, 12, 32);
        ctx.fillStyle = "rgba(255,255,255,0.5)"; ctx.fillRect(s.x - 6, s.y - 16, 12, 4);
      } else {
        const grad = ctx.createRadialGradient(s.x, s.y, 2, s.x, s.y, s.r);
        grad.addColorStop(0, "#fff"); grad.addColorStop(0.4, s.c); grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 7); ctx.fill();
      }
      ctx.restore();
    });
  }

  function drawFX() {
    for (let i = G.sparks.length - 1; i >= 0; i--) {
      const p = G.sparks[i]; p.x += p.vx; p.y += p.vy; p.vy += 0.3; p.life -= 0.04;
      if (p.life <= 0) { G.sparks.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = p.c;
      ctx.fillRect(p.x, p.y, 4, 4);
    }
    // blood droplets — arc, then splat on the ground as a decal
    for (let i = G.blood.length - 1; i >= 0; i--) {
      const b = G.blood[i]; b.x += b.vx; b.y += b.vy; b.vy += 0.5; b.life -= 0.014;
      if (b.y >= GROUND) { G.splats.push({ x: b.x, y: GROUND, r: b.r * (1.6 + Math.random()), a: 0.55 }); G.blood.splice(i, 1); continue; }
      if (b.life <= 0) { G.blood.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, b.life); ctx.fillStyle = "#c81028";
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (let i = G.pops.length - 1; i >= 0; i--) {
      const p = G.pops[i]; p.y -= 0.6; p.life -= 0.02;
      if (p.life <= 0) { G.pops.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = p.c;
      ctx.font = "900 22px Orbitron, sans-serif"; ctx.textAlign = "center";
      ctx.fillText(p.t, p.x, p.y);
    }
    ctx.globalAlpha = 1;
  }

  function bar(x, y, w, f, mirror, name, color, meter) {
    const pct = Math.max(0, f.hp / f.maxhp);
    ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(x, y, w, 22);
    const bx = mirror ? x + w * (1 - pct) : x;
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, "#19e0ff"); g.addColorStop(1, "#ff3df0");
    ctx.fillStyle = pct > 0.3 ? g : "#ff4d4d"; ctx.fillRect(bx, y, w * pct, 22);
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, 22);
    // meter
    ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.fillRect(x, y + 24, w, 7);
    ctx.fillStyle = f.meter >= 100 ? "#ffd84d" : "#9b4dff";
    const mw = w * (f.meter / 100); ctx.fillRect(mirror ? x + w - mw : x, y + 24, mw, 7);
    ctx.fillStyle = "#fff"; ctx.font = "700 15px Orbitron, sans-serif";
    ctx.textAlign = mirror ? "right" : "left";
    ctx.fillText(name, mirror ? x + w : x, y - 8);
  }

  function drawHUD() {
    bar(28, 40, 360, G.p1, false, G.p1.def.name, G.p1.def.color, true);
    bar(W - 28 - 360, 40, 360, G.p2, true, G.p2.def.name, G.p2.def.color, true);
    // round pips
    ctx.textAlign = "center"; ctx.font = "900 18px Orbitron, sans-serif"; ctx.fillStyle = "#fff";
    ctx.fillText("ROUND " + G.round, W / 2, 36);
    for (let i = 0; i < 2; i++) {
      ctx.fillStyle = i < G.w1 ? "#19e0ff" : "rgba(255,255,255,0.2)";
      ctx.beginPath(); ctx.arc(W / 2 - 70 - i * 16, 30, 6, 0, 7); ctx.fill();
      ctx.fillStyle = i < G.w2 ? "#ff3df0" : "rgba(255,255,255,0.2)";
      ctx.beginPath(); ctx.arc(W / 2 + 70 + i * 16, 30, 6, 0, 7); ctx.fill();
    }
    // timer
    ctx.fillStyle = G.roundTime < 10 ? "#ff4d4d" : "#fff"; ctx.font = "900 30px Orbitron, sans-serif";
    ctx.fillText(Math.ceil(G.roundTime), W / 2, 70);
  }

  function center(text, sub, c) {
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(5,3,12,0.45)"; ctx.fillRect(0, H/2 - 90, W, 180);
    ctx.fillStyle = c || "#fff"; ctx.font = "900 64px Orbitron, sans-serif";
    ctx.shadowColor = c || "#19e0ff"; ctx.shadowBlur = 24;
    ctx.fillText(text, W / 2, H / 2 + 6); ctx.shadowBlur = 0;
    if (sub) { ctx.fillStyle = "#cfd0ff"; ctx.font = "600 22px Rajdhani, sans-serif"; ctx.fillText(sub, W / 2, H / 2 + 48); }
  }

  // ---------- loop ----------
  let last = 0;
  function frame(t) {
    requestAnimationFrame(frame);
    if (!last) last = t; let dt = Math.min(50, t - last); last = t;
    if (!G || G.phase === "select") { renderSelect(); return; }
    dt *= G.slow; G.slow += (1 - G.slow) * 0.04;
    G.phaseT += dt;

    drawSetup();
    if (G.phase === "intro") {
      drawWorld(0);
      center("ROUND " + G.round, G.p1.def.name + "  VS  " + G.p2.def.name, "#19e0ff");
      if (G.phaseT > 1500) { G.phase = "fight"; G.phaseT = 0; }
    } else if (G.phase === "fight") {
      think(G.p2, G.p1, dt);
      updateFighter(G.p1, G.p2, dt);
      updateFighter(G.p2, G.p1, dt);
      updateShots(dt);
      updateBeams(dt);
      G.roundTime -= dt / 1000;
      drawWorld(dt);
      if (G.p1.combo > 1 && G.p1.comboT > 0) { ctx.fillStyle = "#ffd84d"; ctx.font = "900 26px Orbitron"; ctx.textAlign = "left"; ctx.fillText(G.p1.combo + " COMBO", 30, 110); }
      if (finishPromptable(G.p1, G.p2)) {
        const a = 0.55 + 0.45 * Math.sin(G.phaseT / 110);
        ctx.globalAlpha = a; ctx.fillStyle = "#ff2d4d"; ctx.textAlign = "center";
        ctx.font = "900 32px Orbitron, sans-serif"; ctx.shadowColor = "#ff2d4d"; ctx.shadowBlur = 22;
        ctx.fillText("FINISH THEM!  ▶ L", W / 2, 128); ctx.shadowBlur = 0; ctx.globalAlpha = 1;
      }
      // round end?
      const dead = G.p1.hp <= 0 || G.p2.hp <= 0 || G.roundTime <= 0;
      if (dead) { G.phase = "roundend"; G.phaseT = 0; G.roundWinner = decideRound(); }
    } else if (G.phase === "roundend") {
      updateFighter(G.p1, G.p2, dt); updateFighter(G.p2, G.p1, dt);
      drawWorld(dt);
      const w = G.roundWinner;
      center(w === 1 ? "YOU WIN" : w === 2 ? "KO" : "DRAW", w === 1 ? "Nice." : w === 2 ? G.p2.def.name + " wins the round" : "", w === 2 ? "#ff3df0" : "#19e0ff");
      if (G.phaseT > 2200) nextRoundOrMatch();
    } else if (G.phase === "matchwin") {
      drawWorld(dt);
      const more = G.oppIdx < G.oppQueue.length - 1;
      const won = G.lastPay > 0 ? "+" + G.lastPay + " credits · " : "";
      center("VICTORY", won + (more ? "Tap to face " + G.oppQueue[G.oppIdx + 1].name : "You cleared the roster!"), "#ffd84d");
    } else if (G.phase === "matchlose") {
      drawWorld(dt);
      const lost = G.lastPay < 0 ? G.lastPay + " credits · " : "";
      center("DEFEATED", lost + "Tap to rematch", "#ff3df0");
    }
    drawShake();
  }

  function decideRound() {
    if (G.p1.hp <= 0 && G.p2.hp <= 0) return 0;
    if (G.p2.hp <= 0) return 1;
    if (G.p1.hp <= 0) return 2;
    return G.p1.hp > G.p2.hp ? 1 : G.p1.hp < G.p2.hp ? 2 : 0;
  }
  function nextRoundOrMatch() {
    const w = G.roundWinner;
    if (w === 1) G.w1++; else if (w === 2) G.w2++;
    if (G.w1 >= 2 || G.w2 >= 2) {
      if (G.w1 >= 2) {
        // bout won — pay out the wager (house edge baked into the mult)
        if (G.staked > 0) { const pay = Math.round(G.staked * payMult(G.oppIdx)); setCredits(getCredits() + pay); G.lastPay = pay; wgNote("You won " + pay + " credits! 🐾"); }
        else G.lastPay = 0;
        if (G.oppIdx >= G.oppQueue.length - 1) { G.phase = "matchwin"; G.cleared = true; }
        else { G.phase = "matchwin"; }
      } else {
        if (G.staked > 0) { G.lastPay = -G.staked; wgNote("Lost " + G.staked + " credits. Rematch to win it back."); }
        else G.lastPay = 0;
        G.phase = "matchlose";
      }
      G.phaseT = 0; return;
    }
    G.round++; startRound(true);
  }

  // tap to advance match screens
  cv.addEventListener("pointerdown", () => {
    if (!G) return;
    if (G.phase === "matchwin") {
      if (G.oppIdx < G.oppQueue.length - 1) { G.oppIdx++; startRound(false); stakeBout(); }
      else { G.phase = "select"; }
    } else if (G.phase === "matchlose") { startRound(false); stakeBout(); }
  });

  function drawSetup() { /* placeholder for camera */ }
  function drawSplats() {
    const arr = G.splats; if (arr.length > 80) arr.splice(0, arr.length - 80);
    for (const s of arr) {
      ctx.globalAlpha = s.a; ctx.fillStyle = "#6e0b18";
      ctx.beginPath(); ctx.ellipse(s.x, s.y + 3, s.r, s.r * 0.4, 0, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  function drawWorld(dt) {
    drawBG();
    drawSplats();            // blood pools on the ground, behind fighters
    // draw back-to-front by y
    const order = [G.p1, G.p2].sort((a, b) => a.y - b.y);
    drawShots();
    order.forEach(drawFighter);
    drawFX();
    if (G.finFlash > 0) { ctx.globalAlpha = G.finFlash * 0.5; ctx.fillStyle = "#c00018"; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; G.finFlash -= 0.02; }
    drawHUD();
  }
  function drawShake() {
    if (G.shake > 0.3) {
      cv.style.transform = "translate(" + (Math.random()-0.5)*G.shake + "px," + (Math.random()-0.5)*G.shake + "px)";
      G.shake *= 0.85;
    } else cv.style.transform = "";
  }

  // ---------- character select ----------
  const sel = { idx: 0, hover: 0 };
  let selBoxes = [];
  function renderSelect() {
    drawBG();
    ctx.textAlign = "center";
    ctx.fillStyle = "#fff"; ctx.font = "900 40px Orbitron, sans-serif";
    ctx.shadowColor = "#9b4dff"; ctx.shadowBlur = 20;
    ctx.fillText("CHOOSE YOUR FIGHTER", W / 2, 70); ctx.shadowBlur = 0;
    const cols = 6, cw = 142, ch = 152, gap = 12;
    const totalW = cols * cw + (cols - 1) * gap;
    const x0 = (W - totalW) / 2, y0 = 100;
    selBoxes = [];
    ROSTER.forEach((r, i) => {
      const cx = x0 + (i % cols) * (cw + gap), cy = y0 + Math.floor(i / cols) * (ch + gap);
      selBoxes.push({ x: cx, y: cy, w: cw, h: ch, i });
      const on = i === sel.hover;
      ctx.fillStyle = on ? "rgba(155,77,255,0.28)" : "rgba(10,6,24,0.7)";
      ctx.fillRect(cx, cy, cw, ch);
      ctx.strokeStyle = on ? "#19e0ff" : r.color; ctx.lineWidth = on ? 3 : 1.5;
      ctx.strokeRect(cx, cy, cw, ch);
      const img = fimg(r, "idle");
      if (img && img.complete && img.naturalWidth) {
        const ar = img.naturalWidth / img.naturalHeight; let h = 96, w = h * ar;
        if (w > cw - 30) { w = cw - 30; h = w / ar; }
        ctx.drawImage(img, cx + cw / 2 - w / 2, cy + 14, w, h);
      }
      ctx.fillStyle = "#fff"; ctx.font = "700 12px Orbitron, sans-serif";
      ctx.fillText(r.name, cx + cw / 2, cy + ch - 13);
    });
    const r = ROSTER[sel.hover];
    ctx.fillStyle = "#cfd0ff"; ctx.font = "600 18px Rajdhani, sans-serif";
    ctx.fillText(r.blurb + "   ·   Special: " + r.special, W / 2, H - 26);
  }
  function hitSelect(mx, my) {
    for (const b of selBoxes) if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) return b.i;
    return -1;
  }
  cv.addEventListener("mousemove", (e) => {
    if (!G || G.phase !== "select") return;
    const p = canvasPos(e); const i = hitSelect(p.x, p.y); if (i >= 0) sel.hover = i;
  });
  cv.addEventListener("click", (e) => {
    if (!G || G.phase !== "select") return;
    const p = canvasPos(e); const i = hitSelect(p.x, p.y);
    if (i >= 0) startGame(i);
  });
  addEventListener("keydown", (e) => {
    if (!G || G.phase !== "select") return;
    const k = e.key.toLowerCase();
    if (k === "arrowright" || k === "d") sel.hover = (sel.hover + 1) % ROSTER.length;
    else if (k === "arrowleft" || k === "a") sel.hover = (sel.hover + ROSTER.length - 1) % ROSTER.length;
    else if (k === "arrowdown" || k === "s") sel.hover = (sel.hover + 6) % ROSTER.length;
    else if (k === "arrowup" || k === "w") sel.hover = (sel.hover + ROSTER.length - 6) % ROSTER.length;
    else if (k === "enter" || k === " ") startGame(sel.hover);
  });
  function canvasPos(e) {
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (W / r.width), y: (e.clientY - r.top) * (H / r.height) };
  }

  function startGame(idx) {
    const player = ROSTER[idx];
    const opps = ROSTER.filter((_, i) => i !== idx);
    // shuffle deterministically-ish
    for (let i = opps.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [opps[i], opps[j]] = [opps[j], opps[i]]; }
    G = newMatch(player, opps);
    G.phase = "intro"; startRound(false); stakeBout();
  }

  // stake the current wager at the start of a bout (one opponent, best of 3)
  function stakeBout() {
    if (WAGER > 0 && getCredits() >= WAGER) {
      setCredits(getCredits() - WAGER); G.staked = WAGER;
      wgNote("Staked " + WAGER + " — win this bout for " + Math.round(WAGER * payMult(G.oppIdx)) + " credits.");
    } else {
      G.staked = 0;
      if (WAGER > 0) wgNote("Not enough credits — playing this bout for free.");
    }
  }

  // ---------- boot ----------
  function boot() { G = newMatch(ROSTER[0], []); G.phase = "select"; requestAnimationFrame(frame); }
  // wait a tick for images
  setTimeout(boot, 120);
})();
