

(function () {
  "use strict";

  if (window.__liveVoiceLoaded) return;
  window.__liveVoiceLoaded = true;

  const LIVE_GREETINGS = [
    (n) => `How can I help, ${n}?`,
    (n) => `What's on your agenda today, ${n}?`,
    (n) => `Ready when you are, ${n}. What do you need?`,
    (n) => `What's on your mind today, ${n}?`,
    (n) => `Hi ${n}! What would you like to explore?`
  ];

  const LIVE_LABEL = "EmeraldCore Live";

  const AI_NAME = "EmeraldBot";

  const LIVE_TURNS_SHOWN = 2;

  function liveEndpoint() {
    const base =
      typeof CHAT_WORKER_URL === "string" && CHAT_WORKER_URL
        ? CHAT_WORKER_URL
        : "";
    if (!base) return "";
    return base.replace(/^https?:/i, "wss:") + "/live";
  }

  const LIVE_WORKER_URL = liveEndpoint().replace(/wss:/i, "https:").replace(/\/live$/, "");

  const LV = {
    conn: "idle",
    phase: "blank",
    starting: false,
    newSession: false,
    muted: false,
    speaking: false,
    userSpeaking: false,
    micLevel: 0,
    modelLevel: 0,
    startedAt: 0,
    elapsedMs: 0,
    timerId: null,
    rafId: null,
    turns: [],
    savedCount: 0,
    pending: { user: null, ai: null },
    sessionHandle: null,
    sessionConv: null,
    qaHeight: 0,
    _leaveGuard: null,
    morphTimers: null,
    prevModelName: "",
    active: false,

    everCalled: false,
    presence: 0,
    clock: 0,
    lastT: 0,
    orbAlpha: 0,
    orbAlphaAt: 0,
    orbLine: "",
    orbAura: 0.26,
    orbCore: "",
    orbMid: "",
    orbEdge: "",
    orbAuraColor: "",
    orbWarned: false,

    videoMode: "off",

    videoPending: false,
    videoOpening: "off",

    videoFlipping: false
  };

  function el(id) {
    return document.getElementById(id);
  }

  let chimeCtx = null;

  function playCue(notes) {
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      if (!chimeCtx || chimeCtx.state === "closed") chimeCtx = new Ctor();

      if (chimeCtx.state === "suspended") {
        const r = chimeCtx.resume();
        if (r && typeof r.catch === "function") r.catch(() => {});
      }
      const t0 = chimeCtx.currentTime + 0.01;
      notes.forEach((n, i) => {
        const osc = chimeCtx.createOscillator();
        const gain = chimeCtx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(n.freq, t0 + n.at);

        gain.gain.setValueAtTime(0.0001, t0 + n.at);
        gain.gain.exponentialRampToValueAtTime(n.vol, t0 + n.at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
        osc.connect(gain);
        gain.connect(chimeCtx.destination);
        osc.start(t0 + n.at);
        osc.stop(t0 + n.at + n.dur + 0.02);
      });
    } catch (e) {

    }
  }

  function chimeStart() {
    playCue([
      { freq: 587.33, at: 0, dur: 0.18, vol: 0.06 },
      { freq: 880.0, at: 0.11, dur: 0.26, vol: 0.06 }
    ]);
  }

  function chimeEnd() {
    playCue([
      { freq: 659.25, at: 0, dur: 0.16, vol: 0.05 },
      { freq: 392.0, at: 0.1, dur: 0.32, vol: 0.05 }
    ]);
  }

  function setConn(next) {
    LV.conn = next;
    const view = el("liveView");
    if (view) view.setAttribute("data-conn", next);
  }

  function setPhase(phase) {
    const bar = el("liveControls");
    const start = el("lvStartBtn");
    const mute = el("lvMuteBtn");
    const cam = el("lvCamBtn");

    const screenBtn = el("lvScreenBtn");
    const end = el("lvEndBtn");
    const typeBtn = el("lvTypeBtn");
    const stage = el("liveStage");

    if (bar) bar.setAttribute("data-phase", phase);
    LV.phase = phase;

    const live = phase === "live";
    const loading = phase === "loading";

    const view = el("liveView");
    if (view) view.classList.toggle("live-running", live || loading);

    if (start) {
      start.classList.toggle("is-loading", loading);
      start.disabled = loading;
      start.style.display = live ? "none" : "";
    }
    if (mute) mute.disabled = !live;

    if (typeBtn) typeBtn.disabled = !live;

    if (cam) cam.disabled = !live;
    if (screenBtn) screenBtn.disabled = !live;

    if (end) {
      end.disabled = !live;
      end.style.display = live ? "" : "none";
    }

    if (stage) stage.hidden = !live;

    syncLiveShines();

    if (phase === "blank") renderLiveBlankCopy();

    if (loading) runStartMorph();
    else if (phase !== "live") cancelStartMorph();
  }

  var SHINE_MS = 2100;

  var SHINE_SWEEP = 0.62;
  var SHINE_REST = (1 - SHINE_SWEEP) / 2;

  var shineRaf = 0;
  var shineFrom = 0;
  var shineGradient = null;

  function easeInOut(p) {
    return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
  }

  function shineTravel(p) {
    if (p < SHINE_SWEEP) return easeInOut(p / SHINE_SWEEP);
    if (p < SHINE_SWEEP + SHINE_REST) return 1;
    return 0;
  }

  function shineCore(progress, width, band) {
    return -band + shineTravel(progress) * (width + 2 * band);
  }

  function paintShine(btn, progress) {
    var box = btn.getBoundingClientRect();
    if (!box.width) return;
    var band = Math.max(34, box.width * 0.3);
    var core = shineCore(progress, box.width, band);

    var icon = btn.querySelector(".live-ctl-icon");
    if (icon) {
      var ir = icon.getBoundingClientRect();

      if (ir.width) {
        var span = (band / ir.width) * 24;
        var at = ((core - (ir.left - box.left)) / ir.width) * 24;
        shineGradient.setAttribute("x2", span);
        shineGradient.setAttribute("gradientTransform", "translate(" + (at - span / 2) + " 0)");
      }
    }

    var label = btn.querySelector(".live-ctl-label");
    if (label) {
      var lr = label.getBoundingClientRect();

      if (lr.width) {

        label.style.backgroundSize = band * 2 + "px 100%, 100% 100%";
        label.style.backgroundPosition = core - (lr.left - box.left) - band + "px 0px, 0px 0px";
      }
    }
  }

  function syncLiveShines() {
    var waiting = document.querySelectorAll(".live-ctl-btn.is-loading");
    if (!waiting.length || prefersReducedMotion() || typeof requestAnimationFrame !== "function") {
      if (shineRaf) {
        cancelAnimationFrame(shineRaf);
        shineRaf = 0;
      }
      return;
    }
    if (shineRaf) return;

    var buttons = [];
    for (var i = 0; i < waiting.length; i++) buttons.push(waiting[i]);
    if (!shineGradient) shineGradient = document.getElementById("liveSweepGrad");
    if (!shineGradient) return;

    shineFrom = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    var step = function (now) {
      var progress = (((now - shineFrom) % SHINE_MS) + SHINE_MS) % SHINE_MS / SHINE_MS;
      for (var j = 0; j < buttons.length; j++) {
        try {
          paintShine(buttons[j], progress);
        } catch (err) {

        }
      }
      shineRaf = requestAnimationFrame(step);
    };
    shineRaf = requestAnimationFrame(step);
  }

  const MORPH = {
    fly: 680,

    orbResolve: 780,

    textDelay: 820,
    textFade: 420,

    handOff: 820 + 420 + 80,
  };

  function cancelStartMorph() {
    if (LV.morphTimers) LV.morphTimers.forEach(clearTimeout);
    LV.morphTimers = null;
    const view = el("liveView");
    if (view) {
      view.classList.remove("lv-morph", "lv-orb-in", "lv-dissolve", "lv-at-peak");
      view.style.removeProperty("--lv-peak-blur");
    }
    const blank = el("liveBlank");
    if (blank) {
      blank.style.position = "";
      blank.style.left = "";
      blank.style.top = "";
      blank.style.width = "";
      blank.style.height = "";
      blank.style.margin = "";
      blank.style.minHeight = "";
      blank.style.padding = "";
      blank.style.opacity = "";
    }
    const logo = blank && blank.querySelector("img");
    if (logo) {
      logo.style.removeProperty("--lv-tx");
      logo.style.removeProperty("--lv-ty");
      logo.style.removeProperty("--lv-sc");
    }
  }

  function runStartMorph() {
    const view = el("liveView");
    const blank = el("liveBlank");
    const stage = el("liveStage");
    const orb = el("liveOrb");
    const logo = blank && blank.querySelector("img");
    if (!view || !blank || !stage || !orb || !logo) return;
    if (LV.morphTimers) return;

    const card = blank.getBoundingClientRect();
    const cs = getComputedStyle(blank);
    blank.style.position = "fixed";
    blank.style.left = card.left + "px";
    blank.style.top = card.top + "px";
    blank.style.width = card.width + "px";

    blank.style.height = card.height + "px";
    blank.style.margin = "0";

    blank.style.minHeight = cs.minHeight;
    blank.style.padding = cs.padding;

    const from = logo.getBoundingClientRect();

    const logoVisible = from.width > 0 && from.height > 0;

    view.classList.remove("is-welcome");
    stage.hidden = false;
    const to = orb.getBoundingClientRect();

    view.style.setProperty("--lv-peak-blur", Math.round(to.width * 0.06) + "px");

    if (!logoVisible) {
      blank.style.display = "none";
      view.classList.add("lv-morph", "lv-at-peak");

      LV.morphTimers = [];
      return;
    }

    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);

    const scale = (to.width / from.width) * 1.05;

    const reduced =
      prefersReducedMotion();

    if (reduced) {
      blank.style.display = "none";
      cancelStartMorph();
      view.classList.remove("is-welcome");
      stage.hidden = false;
      return;
    }

    view.classList.add("lv-morph");

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        logo.style.setProperty("--lv-tx", dx + "px");
        logo.style.setProperty("--lv-ty", dy + "px");
        logo.style.setProperty("--lv-sc", String(scale));
      });
    });

    LV.morphTimers = [
      setTimeout(() => {
        view.classList.add("lv-at-peak");
      }, MORPH.fly)
    ];
  }

  function finishStartMorph() {
    const view = el("liveView");
    if (!view) return;

    if (!LV.morphTimers) return;
    if (view.classList.contains("lv-orb-in")) return;

    renderTranscript();

    view.classList.remove("lv-at-peak");
    view.classList.add("lv-orb-in", "lv-dissolve");

    const timer = setTimeout(() => {
      cancelStartMorph();
      renderTranscript();
    }, MORPH.handOff);
    LV.morphTimers.push(timer);
  }

  function welcomeReserve() {

    if (window.matchMedia && window.matchMedia("(max-width: 768px)").matches) {
      LV.qaHeight = 0;
      return 0;
    }
    const row = document.querySelector("#welcomeScreen .quick-actions");
    if (row) {
      const h = row.getBoundingClientRect().height;

      if (h > 0) {

        LV.qaHeight = h + 26;
        return LV.qaHeight;
      }
    }
    return LV.qaHeight || 0;
  }

  function renderLiveBlankCopy() {
    const heading = el("liveBlankHeading");
    const blank = el("liveBlank");
    if (blank) {
      blank.style.setProperty("--lv-welcome-reserve", welcomeReserve() + "px");
    }
    if (!heading) return;
    let name = "";
    try {
      name = (loadSettings().userName || "").trim();
    } catch (e) {

    }
    const displayName = name && name !== "You" ? name : "User";

    const idx =
      typeof _cryptoInt === "function"
        ? _cryptoInt(LIVE_GREETINGS.length)
        : Math.floor(Math.random() * LIVE_GREETINGS.length);
    heading.textContent = LIVE_GREETINGS[idx](displayName);
  }

  function fitCanvas(canvas) {
    if (!canvas) return null;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: rect.width, h: rect.height };
  }

  const TAU = Math.PI * 2;

  function orbPalette(T) {
    if (LV.conn === "error") {
      return { core: "rgb(255, 235, 235)", mid: "rgb(252, 165, 165)", edge: "rgb(220, 38, 38)",
               membrane: "rgb(254, 202, 202)", mote: "248,113,113", aura: "239,68,68",
               auraA: 0.20, amp: 0.6, speed: 0.7, motes: false };
    }
    if (LV.conn === "ended") {
      return { core: "rgb(240, 240, 240)", mid: "rgb(186, 186, 186)", edge: "rgb(120, 120, 120)",
               membrane: "rgb(168, 168, 168)", mote: "140,140,140", aura: "140,140,140",
               auraA: 0.09, amp: 0.45, speed: 0.35, motes: false };
    }
    if (LV.muted) {
      return { core: "rgb(245, 245, 245)", mid: "rgb(196, 196, 196)", edge: "rgb(128, 128, 128)",
               membrane: "rgb(158, 158, 158)", mote: "150,150,150", aura: "150,150,150",
               auraA: 0.12, amp: 0.5, speed: 0.6, motes: true };
    }
    return { core: T.core, mid: T.mid, edge: T.edge,
             membrane: T.line, mote: rgbTriple(T.line), aura: T.auraColor,
             auraA: T.aura, amp: 1, speed: 1, motes: true };
  }

  const WAVES = [
    { n: 2, base: 0.006, gain: 0.056, w: 0.90, ph: 0.0 },
    { n: 3, base: 0.004, gain: 0.050, w: -1.40, ph: 2.1 },
    { n: 5, base: 0.002, gain: 0.058, w: 2.20, ph: 4.3 }
  ];

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function hash(i) {
    const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  function ringNoise(i, phase, seed) {
    return Math.sin(phase + i * 0.87 + seed) * 0.62 +
           Math.sin(phase * 1.63 + i * 1.71 + seed * 2.1) * 0.38;
  }

  function organicLoop(ctx, cx, cy, radius, n, amp, phase, seed, rot) {
    const p = new Array(n * 2);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rot;
      const rr = radius * (1 + ringNoise(i, phase, seed) * amp);
      p[i * 2] = cx + Math.cos(a) * rr;
      p[i * 2 + 1] = cy + Math.sin(a) * rr;
    }

    ctx.beginPath();
    traceLoop(ctx, p, n, false);
  }

  function traceLoop(ctx, p, n, reverse) {
    const g = (i) => (reverse ? (n - i) % n : i);
    const px = (i) => p[g(i) * 2];
    const py = (i) => p[g(i) * 2 + 1];
    ctx.moveTo((px(n - 1) + px(0)) / 2, (py(n - 1) + py(0)) / 2);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      ctx.quadraticCurveTo(px(i), py(i), (px(i) + px(j)) / 2, (py(i) + py(j)) / 2);
    }
    ctx.closePath();
  }

  function sampleBody(cx, cy, R, t, amp, n) {
    const p = new Array(n * 2);
    const inner = new Array(n * 2);
    const dev = new Array(n);
    let minD = Infinity;
    let maxD = -Infinity;

    const lfo = 1 + Math.sin(t * 0.23) * 0.18;

    for (let i = 0; i < n; i++) {
      const theta = (i / n) * TAU;
      let d = 0;
      for (const w of WAVES) {
        d += (w.base + amp * w.gain * lfo) * Math.sin(w.n * theta - w.w * t + w.ph);
      }
      const r = R * (1 + d);
      const ca = Math.cos(theta);
      const sa = Math.sin(theta);
      p[i * 2] = cx + ca * r;
      p[i * 2 + 1] = cy + sa * r;
      dev[i] = d;
      if (d < minD) minD = d;
      if (d > maxD) maxD = d;
    }
    return { p, dev, minD, maxD, n };
  }

  function rgbTriple(color) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color || "");
    return m ? m[1] + "," + m[2] + "," + m[3] : color;
  }

  let moteSprite = null;
  let moteKey = "";
  function getMoteSprite(rgb, key) {
    if (moteSprite && moteKey === key) return moteSprite;
    const S = 32;
    const c = document.createElement("canvas");
    c.width = S;
    c.height = S;
    const x = c.getContext("2d");
    const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, "rgba(" + rgb + ", 0.95)");
    g.addColorStop(0.35, "rgba(" + rgb + ", 0.42)");
    g.addColorStop(1, "rgba(" + rgb + ", 0)");
    x.fillStyle = g;
    x.beginPath();
    x.arc(S / 2, S / 2, S / 2, 0, TAU);
    x.fill();
    moteSprite = c;
    moteKey = key;
    return c;
  }

  function drawOrb() {
    const canvas = el("liveOrb");
    const fitted = fitCanvas(canvas);
    if (!fitted) return;
    const { ctx, w, h } = fitted;
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;

    const nowMs = performance.now();
    if (!LV.orbAlpha || nowMs - LV.orbAlphaAt > 400) {
      const cs = getComputedStyle(canvas);
      const alpha = parseFloat(cs.getPropertyValue("--lv-orb-body-alpha"));
      const aura = parseFloat(cs.getPropertyValue("--lv-orb-aura"));
      LV.orbAlpha = Number.isFinite(alpha) ? alpha : 0.6;
      LV.orbAura = Number.isFinite(aura) ? aura : 0.26;
      LV.orbLine = cs.getPropertyValue("--lv-orb-line").trim() || "rgb(94, 234, 168)";

      LV.orbCore = cs.getPropertyValue("--lv-orb-core").trim() || "rgb(214, 255, 240)";
      LV.orbMid = cs.getPropertyValue("--lv-orb-mid").trim() || "rgb(45, 212, 191)";
      LV.orbEdge = cs.getPropertyValue("--lv-orb-edge").trim() || "rgb(74, 222, 128)";
      LV.orbAuraColor = cs.getPropertyValue("--lv-orb-aura-color").trim() || "rgb(80, 200, 120)";
      LV.orbAlphaAt = nowMs;
    }

    const P = orbPalette({
      core: LV.orbCore, mid: LV.orbMid, edge: LV.orbEdge,
      line: LV.orbLine, aura: LV.orbAura, auraColor: rgbTriple(LV.orbAuraColor)
    });

    const raw = Math.max(LV.micLevel, LV.modelLevel * 0.9);

    const energy = LV.presence * 0.65 + raw * 0.35;

    const R = Math.min(w, h) / 2;
    const SAFE = R * 0.86;
    const t = LV.clock;
    const sp = P.speed;
    const amp = energy * P.amp;

    const bodyAlpha = Math.min(1, LV.orbAlpha * (0.8 + energy * 0.45));

    ctx.save();

    const auraR = SAFE * (0.92 + energy * 0.16);
    const aura = ctx.createRadialGradient(cx, cy, SAFE * 0.05, cx, cy, auraR);
    aura.addColorStop(0, "rgba(" + P.aura + "," + (P.auraA * (0.65 + energy * 0.7)).toFixed(3) + ")");
    aura.addColorStop(0.5, "rgba(" + P.mote + "," + (P.auraA * 0.42).toFixed(3) + ")");
    aura.addColorStop(1, "rgba(" + P.aura + ", 0)");
    ctx.beginPath();
    ctx.arc(cx, cy, auraR, 0, TAU);
    ctx.fillStyle = aura;
    ctx.fill();

    if (P.motes) {
      const sprite = getMoteSprite(P.mote, P.mote);
      for (let i = 0; i < 8; i++) {
        const orbR = SAFE * (0.52 + hash(i + 11) * 0.42);
        const spd = (hash(i + 31) - 0.5) * 0.42;
        const ph = hash(i + 51) * TAU;
        const a = ph + t * spd * sp;
        const rr = orbR * (1 + Math.sin(t * 0.6 + ph) * 0.08);
        const sz = SAFE * (0.035 + hash(i + 71) * 0.03);
        ctx.globalAlpha = 0.3 + 0.4 * Math.abs(Math.sin(t * 0.9 + ph));
        ctx.drawImage(sprite, cx + Math.cos(a) * rr - sz, cy + Math.sin(a) * rr - sz, sz * 2, sz * 2);
      }
      ctx.globalAlpha = 1;
    }

    const loops = [
      { r: 0.88, amp: 0.055, spin: 0.22, wave: 0.30, lw: 1.4, al: 0.5, n: 30, seed: 0.0,
        ex: 0.06, ey: 0.04, fq: 0.21 },
      { r: 0.72, amp: 0.08, spin: -0.41, wave: -0.5, lw: 1.9, al: 0.72, n: 24, seed: 1.7,
        ex: 0.05, ey: 0.07, fq: 0.17 }
    ];
    for (const L of loops) {

      const ox = Math.cos(t * L.fq) * L.ex * SAFE * sp;
      const oy = Math.sin(t * L.fq * 1.3) * L.ey * SAFE * sp;
      organicLoop(ctx, cx + ox, cy + oy, SAFE * L.r * (1 + amp * 0.05), L.n, L.amp,
                  t * L.wave * sp, L.seed, t * L.spin * sp);
      ctx.strokeStyle = P.membrane;
      ctx.globalAlpha = L.al;
      ctx.lineWidth = L.lw;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    const bodyR = SAFE * (0.40 + amp * 0.06);
    const coreR = bodyR * (0.62 + energy * 0.16);
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    core.addColorStop(0, P.core);
    core.addColorStop(1, "rgba(" + P.aura + ", 0)");
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, TAU);
    ctx.fillStyle = core;
    ctx.fill();

    const N = 96;
    const body = sampleBody(cx, cy, bodyR, t, amp, N);

    ctx.beginPath();
    traceLoop(ctx, body.p, N, false);
    const g = ctx.createRadialGradient(
      cx - bodyR * 0.34, cy - bodyR * 0.38, bodyR * 0.06,
      cx, cy, bodyR * 1.06
    );
    g.addColorStop(0, P.core);
    g.addColorStop(0.52, P.mid);
    g.addColorStop(1, P.edge);
    ctx.globalAlpha = bodyAlpha;
    ctx.fillStyle = g;
    ctx.fill();
    ctx.globalAlpha = 1;

    const span = Math.max(1e-4, body.maxD - body.minD);
    const wBase = bodyR * 0.085;
    const inner = new Array(N * 2);
    for (let i = 0; i < N; i++) {
      const k = (body.dev[i] - body.minD) / span;
      const cxr = body.p[i * 2] - cx;
      const cyr = body.p[i * 2 + 1] - cy;
      const len = Math.hypot(cxr, cyr) || 1;
      const inset = wBase * (0.40 + k * 1.7);
      inner[i * 2] = body.p[i * 2] - (cxr / len) * inset;
      inner[i * 2 + 1] = body.p[i * 2 + 1] - (cyr / len) * inset;
    }
    ctx.beginPath();
    traceLoop(ctx, body.p, N, false);
    traceLoop(ctx, inner, N, true);
    const mg = ctx.createLinearGradient(cx - bodyR, cy - bodyR, cx + bodyR, cy + bodyR);
    mg.addColorStop(0, P.core);
    mg.addColorStop(0.5, P.membrane);
    mg.addColorStop(1, P.edge);
    ctx.fillStyle = mg;
    ctx.shadowColor = P.mote;
    ctx.shadowBlur = bodyR * (0.18 + energy * 0.26);
    ctx.fill();
    ctx.shadowBlur = 0;

    if (P.motes) {
      const sprite = getMoteSprite(P.mote, P.mote);
      for (let i = 0; i < 4; i++) {
        const orbR = SAFE * (0.26 + hash(i + 91) * 0.22);
        const spd = (hash(i + 111) - 0.5) * 0.7;
        const ph = hash(i + 131) * TAU;
        const a = ph + t * spd * sp;
        const sz = SAFE * (0.022 + hash(i + 151) * 0.022);
        ctx.globalAlpha = 0.4 + 0.35 * Math.abs(Math.sin(t * 1.3 + ph));
        ctx.drawImage(sprite, cx + Math.cos(a) * orbR - sz, cy + Math.sin(a) * orbR - sz, sz * 2, sz * 2);
      }
      ctx.globalAlpha = 1;
    }

    if (LV.muted) {
      organicLoop(ctx, cx, cy, SAFE * 0.62, 18, 0.06, t * 0.2, 2.2, t * 0.1);
      ctx.strokeStyle = "rgba(231, 76, 60, 0.55)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.restore();
  }

  function follow(cur, target, attack, release) {
    return cur + (target - cur) * (target > cur ? attack : release);
  }

  function tick() {
    LV.micLevel = follow(LV.micLevel, LV.targetMicLevel, 0.35, 0.06);
    LV.modelLevel = follow(LV.modelLevel, LV.targetModelLevel, 0.35, 0.06);

    LV.presence = follow(LV.presence, Math.max(LV.micLevel, LV.modelLevel * 0.9), 0.05, 0.025);

    const now = performance.now();
    const dt = LV.lastT ? Math.min(0.05, (now - LV.lastT) / 1000) : 0;
    LV.lastT = now;

    if (!prefersReducedMotion() && LV.conn !== "ended") LV.clock += dt;

    try {
      drawOrb();
    } catch (err) {
      if (!LV.orbWarned) {
        LV.orbWarned = true;
        console.warn("[live] orb draw failed", err);
      }
    }

    LV.rafId = requestAnimationFrame(tick);
  }

  function startLoop() {

    LV.lastT = 0;
    if (LV.rafId == null) LV.rafId = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (LV.rafId != null) {
      cancelAnimationFrame(LV.rafId);
      LV.rafId = null;
    }
  }

  function turnEl(role, text, pending) {
    const div = document.createElement("div");
    div.className = role === "user" ? "message message--user" : "message";
    if (pending) div.className += " live-turn--pending";

    let avatar;
    if (role === "user") {
      const initials = typeof getUserInitials === "function" ? getUserInitials() : "U";
      const avatarImg = userAvatar();
      avatar = avatarImg
        ? `<div class="message-avatar-user user message-avatar--img"><img src="${escapeHtmlAttr(avatarImg)}" alt="${escapeHtml(initials)}"></div>`
        : `<div class="message-avatar-user user">${escapeHtml(initials)}</div>`;
    } else {
      avatar = `<div class="message-avatar ai"><img src="/assets/images/favicon.webp" alt="EmeraldBot"></div>`;
    }

    div.innerHTML = `
      ${avatar}
      <div class="message-body">
        <div class="message-sender">${escapeHtml(role === "user" ? userLabel() : AI_NAME)}</div>
        <div class="message-text${role === "user" ? " user-text" : ""}">${escapeHtml(text).replace(/\n/g, "<br>")}</div>
      </div>`;
    return div;
  }

function updateLiveActions(running) {
    const box = el("liveTranscript");
    if (!box || typeof buildMessageActionsEl !== "function") return;

    const msgs = Array.from(box.children).filter(
      (n) => n.classList && n.classList.contains("message"),
    );

    let last = null;
    if (!running) {
      msgs.forEach((m) => {
        if (!m.classList.contains("message--user") && !m.classList.contains("live-turn--pending")) last = m;
      });
    }

    msgs.forEach((m) => {
      const cur = m.querySelector(":scope > .message-body > .message-actions");
      if (m === last) {
        if (cur) return;
        const body = m.querySelector(".message-body");
        if (body) body.appendChild(buildMessageActionsEl("live"));
      } else if (cur) {
        cur.remove();
      }
    });
  }

  function userAvatar() {
    try {
      return loadSettings().avatar || "";
    } catch {
      return "";
    }
  }

  function userLabel() {
    try {
      return loadSettings().userName || "You";
    } catch {
      return "You";
    }
  }

  function renderTranscript() {
    const box = el("liveTranscript");
    if (!box) return;

    const running = LV.phase === "live" || LV.phase === "loading";
    let visible = running ? LV.turns.slice(-LIVE_TURNS_SHOWN) : LV.turns;

    if (running && visible.length > 1 && visible[visible.length - 1].role === "user") {
      visible = [visible[visible.length - 1]];
    }

    box.querySelectorAll(".message").forEach((node) => node.remove());
    visible.forEach((t) => {
      box.appendChild(turnEl(t.role, t.text, false));
    });
    if (LV.pending.ai) {
      box.appendChild(turnEl("ai", LV.pending.ai, true));
    }

    updateLiveActions(running);

    const blank = el("liveBlank");

    const showBlank =
      !(visible.length || LV.pending.ai) &&
      (LV.phase === "blank" || LV.phase === "ended") &&
      !LV.everCalled;
    if (blank && !LV.morphTimers) blank.style.display = showBlank ? "" : "none";

    const view = el("liveView");
    if (view) {
      view.classList.toggle("is-welcome", showBlank);

      view.classList.toggle("live-running", running);
    }

    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(function () { box.scrollTop = box.scrollHeight; });
    } else {
      box.scrollTop = box.scrollHeight;
    }
  }

  function addTurn(role, text) {
    const clean = String(text || "").trim();
    if (!clean) return;
    LV.turns.push({ role, text: clean, at: Date.now() });
    renderTranscript();
  }

  function setPending(role, text) {
    LV.pending[role] = text ? String(text) : null;
    renderTranscript();
  }

  function commitPending(role) {
    const text = LV.pending[role];
    LV.pending[role] = null;
    if (text && text.trim()) addTurn(role, text);
  }

  function paintTimer(ms) {
    const secs = Math.floor(ms / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, "0");
    const ss = String(secs % 60).padStart(2, "0");
    const t = el("liveTimer");
    if (t) t.textContent = mm + ":" + ss;
  }

  function liveElapsedMs() {
    return LV.elapsedMs + (LV.startedAt ? Date.now() - LV.startedAt : 0);
  }

  function startTimer() {
    stopTimer();
    LV.startedAt = Date.now();
    const paint = () => paintTimer(liveElapsedMs());
    paint();
    LV.timerId = setInterval(paint, 1000);
  }

  function stopTimer() {
    if (LV.timerId != null) {
      clearInterval(LV.timerId);
      LV.timerId = null;

      if (LV.startedAt) LV.elapsedMs += Date.now() - LV.startedAt;
      LV.startedAt = 0;
    }

    paintTimer(LV.elapsedMs);
  }

  function enterLiveView() {
    const view = el("liveView");
    const main = el("chatMain");

    const alreadyBlurring = !!(view && view.classList.contains("is-switching"));

    if (view && !alreadyBlurring) view.classList.add("is-switching");

    if (main) main.classList.add("live-active");
    if (view) view.setAttribute("aria-hidden", "false");

    const nameEl = el("modelSelectorName");
    if (nameEl && !LV.prevModelName) LV.prevModelName = nameEl.textContent;
    if (nameEl) nameEl.textContent = LIVE_LABEL;

    if (!LV._chipGuard) {
      LV._chipGuard = function (e) {
        e.preventDefault();
        e.stopPropagation();
      };
    }
    const chip = el("modelSelectorBtn");
    if (chip && !LV._chipBound) {
      chip.addEventListener("click", LV._chipGuard, true);
      LV._chipBound = true;
    }

    LV.active = true;
    startLoop();

    try {
      if (typeof closeMobileSidebar === "function") closeMobileSidebar();
    } catch (e) {

    }

    releaseBlurIn(view);
  }

  function releaseBlurIn(view) {
    if (!view) return;
    void view.offsetWidth;
    const release = function () {
      view.classList.remove("is-switching");
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(release);
    } else {
      setTimeout(release, 16);
    }
  }

  function exitLiveView() {
    const main = el("chatMain");
    if (main) main.classList.remove("live-active");
    const view = el("liveView");
    if (view) {
      view.setAttribute("aria-hidden", "true");
      view.classList.remove("is-switching");
    }

    const nameEl = el("modelSelectorName");
    if (nameEl && LV.prevModelName) nameEl.textContent = LV.prevModelName;
    const chip = el("modelSelectorBtn");
    if (chip && LV._chipBound) {
      chip.removeEventListener("click", LV._chipGuard, true);
      LV._chipBound = false;
    }

    LV.active = false;
    stopLoop();
  }

  function liveTitle() {
    return "New Live Chat";
  }

  function beginLiveConversation() {
    try {
      const id = typeof genChatId === "function" ? genChatId() : String(Date.now());
      const now = Date.now();
      const conv = {
        id,
        title: liveTitle(),
        messages: [],
        live: true,
        elapsedMs: 0,
        createdAt: now,
        updatedAt: now
      };
      if (typeof upsertConv === "function") upsertConv(conv);
      if (typeof state !== "undefined") state.convId = id;
      if (typeof updateOwnedUrl === "function") updateOwnedUrl();
      if (typeof renderSidebar === "function") renderSidebar();
      if (typeof updateTopbarTitle === "function") updateTopbarTitle(conv.title);
      return id;
    } catch (e) {
      if (typeof console !== "undefined") console.warn("[live] could not create conversation:", e);
      return null;
    }
  }

  function currentLiveConv() {
    try {
      const id = typeof state !== "undefined" ? state.convId : null;
      if (!id || typeof getConv !== "function") return null;
      const conv = getConv(id);
      return conv && conv.live ? conv : null;
    } catch (e) {
      return null;
    }
  }

  function saveTranscript() {

    const fresh = LV.turns.slice(LV.savedCount);
    try {
      let conv = currentLiveConv();

      if (!conv) {
        if (!fresh.length) return false;
        const id = beginLiveConversation();
        conv = id && typeof getConv === "function" ? getConv(id) : null;
        if (!conv) return false;
        conv.live = true;
      }

      conv.elapsedMs = liveElapsedMs();

      if (!fresh.length) {
        conv.updatedAt = Date.now();
        if (typeof upsertConv === "function") upsertConv(conv);
        return false;
      }

      const messages = Array.isArray(conv.messages) ? conv.messages.slice() : [];
      fresh.forEach((t) => {
        messages.push({
          role: t.role === "user" ? "user" : "assistant",
          text: t.text,
          at: t.at,
          fromLive: true
        });
      });
      conv.messages = messages;
      conv.live = true;
      conv.updatedAt = Date.now();
      LV.savedCount = LV.turns.length;

      if (typeof upsertConv === "function") upsertConv(conv);
      if (typeof renderSidebar === "function") renderSidebar();
      if (typeof updateTopbarTitle === "function") updateTopbarTitle(conv.title);
      return true;
    } catch (e) {
      if (typeof console !== "undefined") console.warn("[live] save failed:", e);
      return false;
    }
  }

  function flushLiveTranscript() {

    commitPending("user");
    commitPending("ai");
    if (LV.turns.length <= LV.savedCount) return false;
    return saveTranscript();
  }

function applyLiveConversation(conv) {
    resetLive();

    LV.elapsedMs = Number(conv.elapsedMs) || 0;
    paintTimer(LV.elapsedMs);
    enterLiveView();

    try {
      if (typeof state !== "undefined") {
        state.convId = conv.id;
        state.isTemp = false;
      }
      if (typeof updateOwnedUrl === "function") updateOwnedUrl();
      if (typeof renderSidebar === "function") renderSidebar();
      if (typeof updateTopbarTitle === "function") updateTopbarTitle(conv.title);
    } catch (e) {

    }

    (conv.messages || []).forEach((m) => {
      if (!m || !m.text) return;
      LV.turns.push({ role: m.role === "user" ? "user" : "ai", text: m.text, at: m.at });
    });

    LV.savedCount = LV.turns.length;
    renderTranscript();
    setPhase(LV.turns.length ? "ended" : "blank");
    setConn("ended");
  }

  let _lvSwitching = false;
  let _lvSwitchPending = null;

  function blurSwapToLive(applyFn) {
    if (_lvSwitching) {
      _lvSwitchPending = applyFn;
      return;
    }
    _lvSwitching = true;

    const chat = el("chatContent");
    const currentLive = el("liveView");
    const outgoing = LV.active ? currentLive : chat;
    if (outgoing) outgoing.classList.add("is-switching");

    setTimeout(() => {
      try {
        applyFn();
      } finally {

        if (_lvSwitchPending) {
          const next = _lvSwitchPending;
          _lvSwitchPending = null;
          try {
            next();
          } catch (e) {

          }
        }
        if (chat) chat.classList.remove("is-switching");
        setTimeout(() => {
          _lvSwitching = false;
        }, 180);
      }
    }, 150);
  }

  function switchToLiveConversation(conv) {
    blurSwapToLive(() => applyLiveConversation(conv));
  }

  function toggleLiveMute() {
    LV.muted = !LV.muted;
    const btn = el("lvMuteBtn");
    const label = el("lvMuteLabel");
    const slash = el("lvMuteSlash");
    const plainIcon = el("lvMuteIcon");

    if (btn) {
      btn.setAttribute("aria-pressed", LV.muted ? "true" : "false");
      btn.setAttribute("aria-label", LV.muted ? "Unmute microphone" : "Mute microphone");

      btn.title = LV.muted ? "Unmute microphone (the AI stays audible)" : "Mute microphone";
    }
    if (label) label.textContent = LV.muted ? "Unmute" : "Mute";
    if (slash) slash.style.display = LV.muted ? "" : "none";
    if (plainIcon) plainIcon.style.display = LV.muted ? "none" : "";

    const heldByTyping = !!(el("lvTypeBar") && !el("lvTypeBar").hidden);
    if (btn && !LV.muted && heldByTyping) {
      btn.title = "Your microphone stays off while the typing bar is open";
    }

    if (typeof LV.transport !== "undefined" && LV.transport && typeof LV.transport.setMuted === "function") {
      LV.transport.setMuted(LV.muted);
    }
  }

  function paintLiveTyping(open) {
    const bar = el("lvTypeBar");
    const row = document.querySelector("#liveControls .live-controls-row");
    const btn = el("lvTypeBtn");
    const input = el("lvTypeInput");

    if (bar) bar.hidden = !open;
    if (row) row.hidden = open;
    if (btn) btn.setAttribute("aria-pressed", open ? "true" : "false");

    const shell = el("liveControls");
    if (shell) shell.classList.toggle("is-typing", open);

    if (LV.transport && typeof LV.transport.setTyping === "function") {
      LV.transport.setTyping(open);
    }

    if (open && input) {

      const focus = function () {
        if (input) input.focus();
      };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(focus);
      else setTimeout(focus, 16);
    }
  }

  function toggleLiveTyping() {
    const open = !!(el("lvTypeBar") && !el("lvTypeBar").hidden);
    paintLiveTyping(!open);
  }

  function closeLiveTyping() {
    paintLiveTyping(false);
  }

  const LV_TYPE_MAX_H = 180;

  function autoGrowLiveType() {
    const input = el("lvTypeInput");
    if (!input) return;
    input.style.height = "auto";
    const h = Math.min(input.scrollHeight, LV_TYPE_MAX_H);
    input.style.height = h + "px";
    input.style.overflowY = input.scrollHeight > LV_TYPE_MAX_H ? "auto" : "hidden";
  }

  function liveTypeKey(e) {
    if (e.key !== "Enter" || e.shiftKey) return;
    if (typeof e.isComposing === "boolean" && e.isComposing) return;
    e.preventDefault();
    sendLiveTyped();
  }

  function sendLiveTyped() {
    const input = el("lvTypeInput");
    if (!input) return;
    const text = input.value;
    if (!String(text || "").trim()) return;

    const sent = LV.transport && typeof LV.transport.sendText === "function"
      ? LV.transport.sendText(text)
      : false;

    if (!sent) {

      if (typeof showToast === "function") {
        showToast("Not connected yet — the message was kept.");
      }
      input.focus();
      return;
    }

    addTurn("user", text);
    input.value = "";
    autoGrowLiveType();
    input.focus();
  }

  function videoIntent() {
    return LV.videoPending ? LV.videoOpening : LV.videoMode;
  }

  function paintVideoUi() {
    const panel = el("liveVideoPanel");
    const badge = el("liveVideoBadge");
    const cam = el("lvCamBtn");
    const screenBtn = el("lvScreenBtn");

    const mode = videoIntent();
    const on = mode !== "off";

    if (panel) {
      panel.hidden = !on;
      panel.setAttribute("data-source", on ? mode : "off");
    }
    if (badge) badge.textContent = mode === "screen" ? "Screen" : "Camera";

    if (cam) cam.setAttribute("aria-pressed", mode === "camera" ? "true" : "false");
    if (screenBtn) screenBtn.setAttribute("aria-pressed", mode === "screen" ? "true" : "false");

    const camLabel = el("lvCamLabel");
    if (camLabel) camLabel.textContent = mode === "camera" ? "Stop" : "Camera";
    const screenLabel = el("lvScreenLabel");
    if (screenLabel) screenLabel.textContent = mode === "screen" ? "Stop" : "Screen";

    if (cam) cam.title = mode === "camera" ? "Stop sharing camera" : "Share camera";
    if (screenBtn) {
      screenBtn.title = mode === "screen" ? "Stop sharing screen" : "Share screen";
    }

    const flip = el("lvFlipBtn");
    if (flip) {
      const onCamera = mode === "camera";
      const canFlip = onCamera && LV.transport &&
        typeof LV.transport.canFlipCamera === "function" &&
        LV.transport.canFlipCamera();
      flip.hidden = !canFlip;
      flip.disabled = !canFlip || LV.videoPending || LV.videoFlipping;
      const back = LV.transport && typeof LV.transport.cameraFacing === "function" &&
        LV.transport.cameraFacing() === "environment";
      const verb = back ? "Switch to front camera" : "Switch to back camera";
      flip.title = verb;
      flip.setAttribute("aria-label", verb);
      const flipLabel = el("lvFlipLabel");
      if (flipLabel) flipLabel.textContent = "Flip";
    }

    if (cam) {
      if (LV.videoFlipping) cam.setAttribute("aria-busy", "true");
      else cam.removeAttribute("aria-busy");
    }

    if (cam) cam.classList.toggle("is-loading", LV.videoPending && LV.videoOpening === "camera");
    if (screenBtn) {
      screenBtn.classList.toggle(
        "is-loading",
        LV.videoPending && LV.videoOpening === "screen"
      );
    }
    syncLiveShines();
  }

  let videoQueue = Promise.resolve();

  function setLiveVideo(mode) {
    videoQueue = videoQueue.then(() => applyLiveVideo(mode)).catch(() => {});
    return videoQueue;
  }

  async function applyLiveVideo(mode) {
    if (!LV.transport || typeof LV.transport.setVideo !== "function") return;

    if (LV.phase !== "live") return;
    if (mode === LV.videoMode) return;

    if (LV.videoMode !== "off") {

      if (mode === "off") LV.transport.setVideo("off");
      else LV.transport.releaseVideo();
      LV.videoMode = "off";
      paintVideoUi();
    }
    if (mode === "off") return;

    LV.videoPending = true;
    LV.videoOpening = mode;
    paintVideoUi();

    const ok = await LV.transport.setVideo(mode);

    LV.videoPending = false;
    LV.videoOpening = "off";
    LV.videoMode = ok && LV.phase === "live" ? mode : "off";
    paintVideoUi();
  }

  function toggleLiveCamera() {
    setLiveVideo(videoIntent() === "camera" ? "off" : "camera");
  }

  function toggleLiveScreen() {
    setLiveVideo(videoIntent() === "screen" ? "off" : "screen");
  }

  function flipLiveCamera() {
    videoQueue = videoQueue.then(() => applyLiveFlip()).catch(() => {});
    return videoQueue;
  }

  async function applyLiveFlip() {
    if (!LV.transport || typeof LV.transport.flipCamera !== "function") return;
    if (LV.phase !== "live" || LV.videoMode !== "camera" || LV.videoPending) return;

    LV.videoFlipping = true;
    paintVideoUi();

    const res = await LV.transport.flipCamera();

    LV.videoFlipping = false;

    paintVideoUi();
    return res;
  }

  function resetVideoUi() {
    if (LV.transport && typeof LV.transport.releaseVideo === "function") {
      LV.transport.releaseVideo();
    }
    LV.videoMode = "off";
    LV.videoPending = false;
    LV.videoOpening = "off";
    LV.videoFlipping = false;
    paintVideoUi();
  }

  function resetLive() {
    stopTimer();

    LV.elapsedMs = 0;
    LV.startedAt = 0;
    paintTimer(0);
    stopLoop();
    LV.targetMicLevel = 0;
    LV.targetModelLevel = 0;
    LV.micLevel = 0;
    LV.modelLevel = 0;
    LV.presence = 0;
    LV.speaking = false;
    LV.userSpeaking = false;
    LV.turns = [];
    LV.savedCount = 0;

    LV.everCalled = false;
    LV.pending.user = null;
    LV.pending.ai = null;
    LV.sessionHandle = null;
    LV.sessionConv = null;
    LV.muted = false;
    LV.starting = false;
    LV.newSession = false;
    LV.phase = "blank";

    const mute = el("lvMuteBtn");
    const slash = el("lvMuteSlash");
    if (mute) {
      mute.setAttribute("aria-pressed", "false");
      mute.setAttribute("aria-label", "Mute microphone");
      mute.title = "Mute microphone";
    }
    if (slash) slash.style.display = "none";
    const label = el("lvMuteLabel");
    if (label) label.textContent = "Mute";
    const headerIcon = el("lvMuteIcon");
    if (headerIcon) headerIcon.style.display = "";

    paintLiveTyping(false);
    const typeInput = el("lvTypeInput");
    if (typeInput) {
      typeInput.value = "";
      typeInput.style.height = "auto";
      typeInput.style.overflowY = "hidden";
    }

    resetVideoUi();
  }

  function startLiveVoice() {
    if (LV.active && (LV.phase === "live" || LV.starting)) {

      if (LV.transport && typeof LV.transport.stop === "function") LV.transport.stop();
      commitPending("user");
      commitPending("ai");
      saveTranscript();
      stopTimer();
      LV.starting = false;
      setPhase("ended");
      setConn("ended");
    }

    blurSwapToLive(() => {
      resetLive();
      enterLiveView();
      renderTranscript();
      setConn("idle");
      setPhase("blank");
      LV.newSession = true;

      clearConversationSelection();
    });
  }

  function clearConversationSelection() {
    try {
      if (typeof state !== "undefined") state.convId = null;
      if (typeof updateOwnedUrl === "function") updateOwnedUrl();
      if (typeof updateTopbarTitle === "function") updateTopbarTitle("");
      if (typeof renderSidebar === "function") renderSidebar();
    } catch (e) {

    }
  }

  function startLiveSession() {
    if (!LV.active || LV.starting) return;
    LV.starting = true;
    setPhase("loading");
    setConn("connecting");

    if (LV.newSession) {
      LV.newSession = false;
      beginLiveConversation();
    }

    LV.transport.start({
      onState: (s) => {
        setConn(s);

        if (s === "live") {
          LV.starting = false;

          LV.everCalled = true;
          setPhase("live");

          finishStartMorph();

          chimeStart();
          startTimer();
        }
      },
      onMicLevel: (v) => {
        LV.targetMicLevel = v;
      },
      onModelLevel: (v) => {
        LV.targetModelLevel = v;
      },
      onSpeaking: (v) => {
        LV.speaking = v;
      },
      onUserTurn: (text) => {
        setPending("user", null);
        addTurn("user", text);
      },
      onUserPending: (text) => setPending("user", text),
      onModelTurn: (text) => {
        setPending("ai", null);
        addTurn("ai", text);
      },
      onModelPending: (text) => setPending("ai", text),
      onError: (msg) => {

        LV.starting = false;
        setConn("error");
        setPhase("blank");

        resetVideoUi();
        if (msg && typeof showToast === "function") showToast(msg, "error");
      },
      onHandle: (h) => {

        LV.sessionHandle = h || null;
        LV.sessionConv = h ? (typeof state !== "undefined" ? state.convId : null) : null;
      },
      onVideoError: (msg) => {

        LV.videoPending = false;
        LV.videoOpening = "off";
        LV.videoMode = "off";
        paintVideoUi();
        if (msg && typeof showToast === "function") showToast(msg, "error");
      },
      onVideoEnded: () => {

        LV.videoMode = "off";
        paintVideoUi();
      }
    });
  }

  function endLiveVoice() {
    if (!LV.active) return;
    if (LV.transport && typeof LV.transport.stop === "function") LV.transport.stop();

    resetVideoUi();

    LV.muted = false;
    const mute = el("lvMuteBtn");
    const slash = el("lvMuteSlash");
    if (mute) {
      mute.setAttribute("aria-pressed", "false");
      mute.setAttribute("aria-label", "Mute microphone");
      mute.title = "Mute microphone";
    }
    if (slash) slash.style.display = "none";
    const muteLabel = el("lvMuteLabel");
    if (muteLabel) muteLabel.textContent = "Mute";
    const headerIcon = el("lvMuteIcon");
    if (headerIcon) headerIcon.style.display = "";

    paintLiveTyping(false);
    const typeInput = el("lvTypeInput");
    if (typeInput) {
      typeInput.value = "";
      typeInput.style.height = "auto";
      typeInput.style.overflowY = "hidden";
    }

    commitPending("user");
    commitPending("ai");

    saveTranscript();
    LV.starting = false;
    stopTimer();
    setConn("ended");

    LV.targetMicLevel = 0;
    LV.targetModelLevel = 0;

    chimeEnd();
    setPhase("ended");
    setConn("ended");

    renderTranscript();
  }

  const CAPTURE_BLOCK = 4096;
  const SEND_RATE = 16000;

  const PLAY_LEAD = 0.3;

  const PLAY_MIN = 0.3;
  const PLAY_MAX_BACKLOG = 30.0;
  const MAX_RECONNECTS = 4;

  const VIDEO_FRAME_MS = 1000;
  const VIDEO_LONG_EDGE = 640;
  const VIDEO_SCREEN_LONG_EDGE = 768;
  const VIDEO_QUALITY = 0.55;

  const VIDEO_FLIP_WAIT_MS = 1200;

  const VIDEO_NUDGE_MS = 600;

  const VIDEO_TURN_HOLD = 900;

  const VIDEO_CAPTURE_WIDTH = 1280;
  const VIDEO_CAPTURE_HEIGHT = 720;
  const VIDEO_CAPTURE_FPS = 5;

  LV.targetMicLevel = 0;
  LV.targetModelLevel = 0;

  function makeLiveTransport() {
    let api = null;
    let stopped = false;
    let muted = false;

    let ctx = null;
    let stream = null;
    let source = null;
    let sink = null;
    let capture = null;

    let ws = null;
    let ready = false;
    let config = null;
    let attempts = 0;
    let reconnectTimer = null;
    let setupTimer = null;

    let lastClose = null;
    let lastError = null;

    let minimalSetup = false;

    let videoStream = null;
    let videoTrack = null;
    let videoTimer = null;
    let videoNudgeTimer = null;
    let videoTurnTimer = null;
    let videoMode = "off";

    let videoFacing = "user";

    let videoInputCount = 0;
    let videoTurnOpen = false;
    let lastVideoAt = 0;
    let videoCanvas = null;
    let videoCtx = null;

    let userBuf = "";
    let modelBuf = "";
    let modelHeard = false;

    let typing = false;

    function applyMuted(v) {
      muted = !!v;
      syncMicGate();
    }

    function micIsOff() {
      return muted || typing;
    }

    function syncMicGate() {
      if (!micIsOff()) return;

      if (speakingNow && !videoOnlyTurn) endActivity();
      if (vadHang) { clearTimeout(vadHang); vadHang = null; }
    }

    function applyTyping(v) {
      typing = !!v;
      syncMicGate();
    }

    const VAD_FLOOR_MIN = 0.010;
    const VAD_FLOOR_MAX = 0.045;

    const VAD_SNR = 2;

    const VAD_CONFIRM = 0.030;

    const VAD_CONFIRM_BLOCKS = 2;

    const VAD_BARGE = 0.06;

    const VAD_BARGE_BLOCKS = 3;

    const VOICED_ZCR = 0.25;

    const VAD_SEED_OPEN = 0.06;

    const VAD_HANG_MS = 700;

    const VAD_NEAR_SILENCE_MS = 200;

    const MODEL_ECHO_TAIL = 0.5;
    let speakingNow = false;
    let vadHang = null;
    let noiseFloor = VAD_FLOOR_MIN;

    let noiseSeeded = false;
    let seedMin = Infinity;
    let seedBlocks = 0;
    let turnPeak = 0;

    let confirmed = false;

    let videoOnlyTurn = false;

    let candidate = 0;

    let bargeVoiced = false;

    let lowpass = null;
    let lowpassRate = 0;

    let levelSamples = 0;
    let levelSum = 0;

    let nextPlayAt = 0;
    let playing = [];

    function resetPlayback() {
      const t = ctx ? ctx.currentTime : 0;
      for (const s of playing) {
        try { s.stop(); } catch (e) {  }
      }
      playing = [];
      nextPlayAt = t;

      if (vadHang) { clearTimeout(vadHang); vadHang = null; }
      speakingNow = false;
    }

    function playChunk(int16, rate) {
      if (!ctx || stopped) return;
      const n = int16.length;
      if (!n) return;
      const buf = ctx.createBuffer(1, n, rate);
      const out = buf.getChannelData(0);

      for (let i = 0; i < n; i++) out[i] = int16[i] / 32768;
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.connect(ctx.destination);
      const now = ctx.currentTime;

      const starved = nextPlayAt <= now;
      if (starved) {
        nextPlayAt = now + PLAY_LEAD;
      } else if (nextPlayAt < now + PLAY_MIN) {

        nextPlayAt = Math.min(now + PLAY_MIN, nextPlayAt);
      }

      if (nextPlayAt - now > PLAY_MAX_BACKLOG) {
        for (const p of playing) {
          try { p.stop(); } catch (e) {  }
        }
        playing.length = 0;
        nextPlayAt = now + PLAY_LEAD;
      }
      node.start(nextPlayAt);
      nextPlayAt += buf.duration;
      playing.push(node);
      if (playing.length > 64) playing.splice(0, playing.length - 64);
    }

    function lowpassFor(rate) {
      if (lowpass && lowpassRate === rate) return lowpass;
      const taps = 31;
      const fc = 7000 / rate;
      const mid = (taps - 1) / 2;
      const h = new Float32Array(taps);
      let sum = 0;
      for (let i = 0; i < taps; i++) {
        const n = i - mid;
        const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
        const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
        h[i] = sinc * w;
        sum += h[i];
      }
      for (let i = 0; i < taps; i++) h[i] /= sum;
      lowpass = h;
      lowpassRate = rate;
      return h;
    }

    function toSendRate(input) {
      const inRate = ctx ? ctx.sampleRate : 48000;
      const h = lowpassFor(inRate);
      const taps = h.length;
      const mid = (taps - 1) / 2;
      const outLen = Math.max(1, Math.round(input.length * SEND_RATE / inRate));
      const out = new Int16Array(outLen);

      for (let o = 0; o < outLen; o++) {
        const centre = o * inRate / SEND_RATE + mid;
        let acc = 0;
        let first = Math.ceil(centre - mid);
        for (let k = 0; k < taps; k++) {
          const idx = first + k - mid;

          const s = input[idx < 0 ? 0 : idx >= input.length ? input.length - 1 : idx];
          acc += s * h[k];
        }
        out[o] = acc > 1 ? 32767 : acc < -1 ? -32768 : acc * 32767 | 0;
      }
      return out;
    }

    function b64(int16) {
      const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
      let bin = "";

      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      return btoa(bin);
    }

    function raw(obj) {
      if (!ws || ws.readyState !== WebSocket.OPEN || !ready) return;
      ws.send(JSON.stringify({ realtimeInput: obj }));
    }

    function beginActivity() {
      speakingNow = true;
      turnPeak = 0;
      confirmed = false;
      candidate = 0;
      bargeVoiced = false;

      videoOnlyTurn = false;
      api.onSpeaking && api.onSpeaking(true);
      raw({ activityStart: {} });
    }

    function endActivity() {
      if (!speakingNow) return;
      speakingNow = false;
      turnPeak = 0;
      confirmed = false;
      candidate = 0;
      bargeVoiced = false;
      videoOnlyTurn = false;
      videoTurnOpen = false;
      if (videoTurnTimer) { clearTimeout(videoTurnTimer); videoTurnTimer = null; }
      api.onSpeaking && api.onSpeaking(false);
      raw({ activityEnd: {} });
    }

    function send(bytes) {
      if (!ws || ws.readyState !== WebSocket.OPEN || !ready) return;

      raw({ audio: { mimeType: "audio/pcm;rate=" + SEND_RATE, data: b64(bytes) } });
    }

    function pushLevel(arr, target) {

      const scale = arr instanceof Int16Array ? 1 / 32768 : 1;
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i] * scale;
        levelSum += v * v;
        levelSamples++;
      }
      let rms = 0;
      if (levelSamples > 800) {
        rms = Math.sqrt(levelSum / levelSamples);

        api[target](Math.min(1, rms * 7));
        levelSum = 0;
        levelSamples = 0;
      }
      return rms;
    }

    function zeroCrossRate(buf) {
      if (!buf || buf.length < 2) return 1;
      let z = 0;
      for (let i = 1; i < buf.length; i++) {
        if ((buf[i] >= 0) !== (buf[i - 1] >= 0)) z++;
      }
      return z / buf.length;
    }

    function openThreshold() {
      return Math.min(VAD_FLOOR_MAX, Math.max(VAD_FLOOR_MIN, noiseFloor * VAD_SNR));
    }

    function closeThreshold() {
      return openThreshold() * 0.9;
    }

    const NOISE_SEED_BLOCKS = 12;

    function trackNoiseFloor(rms) {
      if (rms <= 0) return;

      if (!noiseSeeded) {
        seedBlocks++;
        if (rms < seedMin) seedMin = rms;
        if (seedBlocks < NOISE_SEED_BLOCKS) return;
        noiseSeeded = true;
        noiseFloor = Math.min(VAD_FLOOR_MAX, Math.max(VAD_FLOOR_MIN, seedMin));
        return;
      }
      noiseFloor += (rms - noiseFloor) * (rms < noiseFloor ? 0.35 : 0.003);
    }

    function modelStillAudible() {
      if (!modelHeard) return false;
      if (!ctx) return false;
      const draining = nextPlayAt + MODEL_ECHO_TAIL > ctx.currentTime;
      if (!draining) modelHeard = false;
      return draining;
    }

    function trackActivity(rms, zcr) {

      if (micIsOff()) return;

      const modelAudible = modelStillAudible();
      if (!speakingNow && !modelAudible) trackNoiseFloor(rms);

      const open = modelAudible
        ? VAD_BARGE
        : noiseSeeded
          ? openThreshold()
          : VAD_SEED_OPEN;

      const needBlocks = modelAudible ? VAD_BARGE_BLOCKS : VAD_CONFIRM_BLOCKS;

      if (!speakingNow) {

        if (rms >= open) {
          if (vadHang) { clearTimeout(vadHang); vadHang = null; }

          candidate++;

          if (zcr < VOICED_ZCR) bargeVoiced = true;
          if (candidate < needBlocks) return;

          if (modelAudible && !bargeVoiced) {
            candidate = 0;
            bargeVoiced = false;
            return;
          }
          candidate = 0;
          bargeVoiced = false;
          beginActivity();

          flushPreroll();
        } else {

          candidate = 0;
          bargeVoiced = false;
        }
        return;
      }

      const need = confirmed ? closeThreshold() : VAD_CONFIRM;
      if (rms >= need) {

        if (vadHang) { clearTimeout(vadHang); vadHang = null; }
        if (rms > turnPeak) turnPeak = rms;
        if (rms >= VAD_CONFIRM) {
          confirmed = true;

          videoOnlyTurn = false;
        }
      } else if (!vadHang) {
        candidate = 0;
        vadHang = setTimeout(function () {
          vadHang = null;
          if (!stopped) endActivity();
        }, confirmed ? VAD_HANG_MS : VAD_NEAR_SILENCE_MS);
      }
    }

    const PREROLL_BLOCKS = 3;
    const preroll = [];

    function flushPreroll() {

      for (const b of preroll) send(b);
      preroll.length = 0;
    }

    function onBlock(block) {
      if (stopped || !ctx) return;

      const rms = pushLevel(block, "onMicLevel");

      pumpVideoTick();

      const bytes = toSendRate(block);
      preroll.push(bytes);
      if (preroll.length > PREROLL_BLOCKS) preroll.shift();
      if (micIsOff()) return;
      trackActivity(rms, zeroCrossRate(block));

      if (videoOnlyTurn) return;

      if (speakingNow) send(bytes);
    }

    async function openMic() {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      ctx = new AudioCtor({ latencyHint: "interactive" });
      if (ctx.state === "suspended") await ctx.resume();

      source = ctx.createMediaStreamSource(stream);

      sink = ctx.createGain();
      sink.gain.value = 0;
      sink.connect(ctx.destination);

      let usedWorklet = false;
      if (ctx.audioWorklet) {
        try {
          await ctx.audioWorklet.addModule("/assets/scripts/live-pcm-capture.js");
          capture = new AudioWorkletNode(ctx, "live-pcm-capture", {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions: { blockSize: CAPTURE_BLOCK }
          });
          capture.port.onmessage = (e) => onBlock(e.data);
          usedWorklet = true;
        } catch (e) {
          capture = null;
        }
      }
      if (!usedWorklet) {

        capture = ctx.createScriptProcessor(CAPTURE_BLOCK, 1, 1);
        capture.onaudioprocess = (e) => onBlock(e.inputBuffer.getChannelData(0).slice(0));
      }
      source.connect(capture);
      capture.connect(sink);
    }

    function grabFrame(longEdge, quality) {
      const v = el("liveVideoEl");
      if (!v || !v.videoWidth || !v.videoHeight) return null;
      const scale = Math.min(1, longEdge / Math.max(v.videoWidth, v.videoHeight));
      const w = Math.max(2, Math.round(v.videoWidth * scale));
      const h = Math.max(2, Math.round(v.videoHeight * scale));

      if (!videoCanvas) videoCanvas = document.createElement("canvas");

      if (videoCanvas.width !== w || videoCanvas.height !== h) {
        videoCanvas.width = w;
        videoCanvas.height = h;
      }
      const c =
        videoCtx || (videoCtx = videoCanvas.getContext("2d", { alpha: false }));
      if (!c) return null;

      try {
        c.drawImage(v, 0, 0, w, h);
      } catch (e) {

        return null;
      }

      try {

        const url = videoCanvas.toDataURL("image/jpeg", quality);
        const comma = url.indexOf(",");
        return comma > 0 ? url.slice(comma + 1) : null;
      } catch (e) {
        return null;
      }
    }

    function sendVideoFrame(data) {
      if (!ws || ws.readyState !== WebSocket.OPEN || !ready) return false;
      raw({ video: { mimeType: "image/jpeg", data } });
      return true;
    }

    function pumpVideo() {
      if (stopped || videoMode === "off" || !ready) return;
      const frame = grabFrame(
        videoMode === "screen" ? VIDEO_SCREEN_LONG_EDGE : VIDEO_LONG_EDGE,
        VIDEO_QUALITY
      );
      if (frame) {
        sendVideoFrame(frame);
        lastVideoAt = videoClock();
      }
    }

    function pumpVideoTick() {
      if (stopped || videoMode === "off") return;
      const now = videoClock();
      if (lastVideoAt && now - lastVideoAt < VIDEO_FRAME_MS) return;
      pumpVideo();
    }

    function videoClock() {
      return typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();
    }

    function pushVideoTurn(frame) {
      if (!frame || !ready) return false;
      if (!speakingNow) {
        beginActivity();

        confirmed = true;
        videoTurnOpen = true;

        videoOnlyTurn = true;
        if (micIsOff()) {
          if (videoTurnTimer) clearTimeout(videoTurnTimer);
          videoTurnTimer = setTimeout(endActivity, VIDEO_TURN_HOLD);
        }
      }
      return sendVideoFrame(frame);
    }

    function nudgeVideoTurn() {
      if (videoMode === "off") return;
      pushVideoTurn(
        grabFrame(
          videoMode === "screen" ? VIDEO_SCREEN_LONG_EDGE : VIDEO_LONG_EDGE,
          VIDEO_QUALITY
        )
      );
    }

    function videoError(msg, detail) {
      if (detail && typeof console !== "undefined") console.warn("[live] " + msg + " — " + detail);
      stopVideo();
      if (api && typeof api.onVideoError === "function") api.onVideoError(msg);
      return false;
    }

    function videoDeniedMessage(mode, e) {
      const name = e && e.name;
      if (name === "NotAllowedError" || name === "AbortError") {
        return mode === "screen" ? null : "Camera unavailable. Allow access and try again.";
      }
      if (name === "NotFoundError" || name === "OverconstrainedError") {
        return mode === "screen"
          ? "Nothing available to share."
          : "No camera found on this device.";
      }
      if (name === "NotReadableError") {
        return mode === "screen"
          ? "That screen could not be captured."
          : "The camera is already in use by another app.";
      }
      return mode === "screen" ? "Screen sharing failed." : "Camera unavailable.";
    }

    async function openVideo(mode, opts) {
      const facing = (opts && opts.facing) || "user";
      const md = navigator.mediaDevices;
      if (!md) {
        return videoError("Camera and screen sharing need a secure (https) connection.",
                          "navigator.mediaDevices unavailable");
      }

      let acquired;
      try {
        if (mode === "screen") {
          if (typeof md.getDisplayMedia !== "function") {
            return videoError("Screen sharing is not supported in this browser.",
                              "getDisplayMedia missing");
          }

          acquired = await md.getDisplayMedia({
            video: { frameRate: { ideal: VIDEO_CAPTURE_FPS } },
            audio: false
          });
        } else {
          if (typeof md.getUserMedia !== "function") {
            return videoError("Camera is not supported in this browser.", "getUserMedia missing");
          }
          acquired = await md.getUserMedia({
            video: {
              facingMode: facing,

              width: { ideal: VIDEO_CAPTURE_WIDTH },
              height: { ideal: VIDEO_CAPTURE_HEIGHT },
              frameRate: { ideal: VIDEO_CAPTURE_FPS }
            },
            audio: false
          });
        }
      } catch (e) {
        const msg = videoDeniedMessage(mode, e);

        if (!msg) {
          if (typeof console !== "undefined") {
            console.info("[live] " + mode + " share cancelled (" + (e && e.name) + ")");
          }
          return false;
        }
        return videoError(msg, String(e));
      }

      const track = acquired && acquired.getVideoTracks && acquired.getVideoTracks()[0];
      if (!track) {
        return videoError(
          mode === "screen" ? "That share produced no video." : "That camera produced no video.",
          "no video track in the acquired stream"
        );
      }

      if (stopped) {
        acquired.getTracks().forEach((t) => {
          try { t.stop(); } catch (e) {  }
        });
        return false;
      }

      videoStream = acquired;
      videoTrack = track;
      videoMode = mode;

      try {
        const s = track.getSettings ? track.getSettings() : null;
        if (s && s.facingMode) videoFacing = s.facingMode;
        else videoFacing = facing;
      } catch (e) {
        videoFacing = facing;
      }

      if (mode === "camera" && typeof md.enumerateDevices === "function") {
        try {
          md.enumerateDevices().then((list) => {
            videoInputCount = list.filter((d) => d.kind === "videoinput").length;
          }).catch(() => {});
        } catch (e) {

        }
      }

      track.addEventListener("ended", () => {
        if (videoTrack !== track) return;

        stopVideo({ announce: true });
        if (api && typeof api.onVideoEnded === "function") api.onVideoEnded();
      });

      const v = el("liveVideoEl");
      if (v) {
        v.srcObject = acquired;

        try {
          const p = v.play();
          if (p && typeof p.catch === "function") p.catch(() => {});
        } catch (e) {

        }
      }

      videoTimer = setInterval(pumpVideoTick, VIDEO_FRAME_MS);

      pumpVideoTick();
      videoNudgeTimer = setTimeout(() => {
        videoNudgeTimer = null;
        nudgeVideoTurn();
      }, VIDEO_NUDGE_MS);

      return true;
    }

    function sendClient(msg) {
      if (!ws || ws.readyState !== WebSocket.OPEN || !ready) return false;
      ws.send(JSON.stringify(msg));
      return true;
    }

    function announceVideoOff(mode) {
      const what = mode === "screen" ? "screen share" : "camera";

      sendClient({
        clientContent: {
          turns: [
            {
              role: "user",
              parts: [
                {
                  text:
                    "[The user has just turned off their " + what + ". You can no longer see " +
                    "anything at all. Do not describe, refer to or claim to see anything from now " +
                    "on — including things you saw earlier in this call, which you can no longer " +
                    "verify. If you are asked what is on screen, say plainly that the feed has been " +
                    "turned off. Acknowledge this in one short sentence.]"
                }
              ]
            }
          ],
          turnComplete: true
        }
      });
    }

    function waitForPreviewFrames(ms) {
      const v = el("liveVideoEl");
      if (!v || v.readyState >= 2) return Promise.resolve(true);
      return new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          v.removeEventListener("loadeddata", onData);
          clearTimeout(timer);
          resolve(ok);
        };
        const onData = () => finish(true);
        const timer = setTimeout(() => finish(false), ms);
        v.addEventListener("loadeddata", onData);
      });
    }

    function stopVideo(opts) {
      const announce = !!(opts && opts.announce);
      const keepPreview = !!(opts && opts.keepPreview);
      const was = videoMode;

      if (videoTimer) { clearInterval(videoTimer); videoTimer = null; }
      if (videoNudgeTimer) { clearTimeout(videoNudgeTimer); videoNudgeTimer = null; }
      if (videoTurnTimer) { clearTimeout(videoTurnTimer); videoTurnTimer = null; }

      const v = el("liveVideoEl");
      if (v && !keepPreview) {
        try { v.pause(); } catch (e) {  }
        v.srcObject = null;
      }
      if (videoStream) {
        videoStream.getTracks().forEach((t) => {
          try { t.stop(); } catch (e) {  }
        });
      }
      videoStream = null;
      videoTrack = null;
      videoMode = "off";

      lastVideoAt = 0;

      if (videoTurnOpen) {
        videoTurnOpen = false;
        endActivity();
      }

      if (speakingNow) endActivity();

      if (announce && was !== "off") announceVideoOff(was);
    }

    function commitUser() {
      const text = userBuf.trim();
      userBuf = "";
      if (text) api.onUserTurn(text);
    }

    function commitModel() {
      const text = modelBuf.trim();
      modelBuf = "";
      if (text && api.onModelTurn) api.onModelTurn(text);
    }

    function livePersonalContext() {
      const ctx = { memories: [] };
      try {
        if (typeof loadSettings === "function") {
          const name = (loadSettings().userName || "").trim();
          if (name && name !== "You") ctx.userDisplayName = name;
        }
      } catch (e) {  }
      try {
        if (typeof loadMemories === "function") {
          const list = loadMemories() || [];
          if (Array.isArray(list)) {

            ctx.memories = list
              .map((m) => (typeof m === "string" ? m : m && m.text))
              .filter((t) => typeof t === "string" && t.trim())
              .reverse();
          }
        }
      } catch (e) {  }
      return ctx;
    }

    function fail(msg, detail) {
      if (stopped) return;
      stopped = true;
      teardown();
      if (detail && typeof console !== "undefined") console.warn("[live] " + msg + " — " + detail);
      api.onError(msg);
    }

    async function connect() {
      if (stopped) return;
      let cfg;
      try {
        const res = await fetch(LIVE_WORKER_URL + "/live/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },

          body: JSON.stringify(livePersonalContext())
        });
        if (!res.ok) {

          if (res.status === 404) {
            return fail("Live chat is not available yet — the server has not been updated.",
                        "live token route returned 404");
          }
          if (res.status === 403) {
            return fail("Live chat is blocked for this site.", "live token route returned 403");
          }
          return fail("Could not reach live chat (" + res.status + ").",
                      "live token route returned " + res.status);
        }
        cfg = await res.json();
        if (!cfg || !cfg.wsUrl) {
          return fail("Live chat did not return a connection.", "token response had no wsUrl");
        }
      } catch (e) {
        return fail("Could not reach live chat.", String(e));
      }
      if (stopped) return;
      config = cfg;

      let socket;
      try {
        socket = new WebSocket(cfg.wsUrl);
      } catch (e) {
        return fail("Could not open a live call.", String(e));
      }
      ws = socket;
      ready = false;

      if (setupTimer) clearTimeout(setupTimer);
      setupTimer = setTimeout(() => {
        if (stopped || ready) return;
        try { socket.close(); } catch (e) {  }
        fail("Live chat did not respond.", "no setupComplete after 12s");
      }, 12000);

      socket.onopen = () => {

        const body = {
          model: "models/" + cfg.model,
          generationConfig: { responseModalities: ["AUDIO"] }
        };
        if (!minimalSetup) {
          Object.assign(body, {
            systemInstruction: { parts: [{ text: cfg.systemInstruction }] },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            realtimeInputConfig: {

              automaticActivityDetection: { disabled: true }
            },
            sessionResumption: {}
          });
          body.generationConfig.speechConfig = {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice } }
          };
        }
        const setup = { setup: body };

        const handle =
          LV.sessionHandle && LV.sessionConv === (typeof state !== "undefined" ? state.convId : null)
            ? LV.sessionHandle
            : null;
        if (handle && !minimalSetup) body.sessionResumption = { handle };
        socket.send(JSON.stringify(setup));
      };

      socket.binaryType = "arraybuffer";

      socket.onmessage = (ev) => {
        let msg;
        try {
          const raw = typeof ev.data === "string"
            ? ev.data
            : new TextDecoder("utf-8").decode(ev.data);
          msg = JSON.parse(raw);
        } catch (e) {
          return;
        }

        if (msg.error) {
          lastError = msg.error.message || JSON.stringify(msg.error);
          return;
        }

        if (msg.setupComplete) {
          ready = true;
          attempts = 0;
          api.onState("live");

          if (videoMode !== "off") nudgeVideoTurn();
          return;
        }

        const resumption = msg.sessionResumptionUpdate;
        if (resumption && (resumption.newHandle || resumption.resumableHandle)) {
          api.onHandle(resumption.newHandle || resumption.resumableHandle);
          return;
        }

        if (msg.goAway) {
          if (setupTimer) clearTimeout(setupTimer);
          setupTimer = null;
          commitUser();
          commitModel();
          resetPlayback();
          try { socket.close(); } catch (e) {  }
          return;
        }

        const scBox = msg.serverContent || {};
        const userTx = msg.inputTranscription || scBox.inputTranscription;
        const modelTx = msg.outputTranscription || scBox.outputTranscription;

        if (userTx && userTx.text) {
          userBuf += userTx.text;
          api.onUserPending(userBuf);
        }

        if (modelTx && modelTx.text) {
          modelBuf += modelTx.text;
          api.onModelPending(modelBuf);
        }

        const sc = msg.serverContent;
        if (!sc) return;

        if (sc.interrupted) {
          resetPlayback();
          commitUser();
          commitModel();
          modelHeard = false;
          api.onSpeaking(false);
          return;
        }

        if (sc.modelTurn && sc.modelTurn.parts) {
          for (const part of sc.modelTurn.parts) {
            if (part.inlineData && part.inlineData.data) {
              if (!modelHeard) {
                modelHeard = true;
                commitUser();
                api.onSpeaking(true);
              }
              const mime = part.inlineData.mimeType || "";
              const m = /rate=(\d+)/.exec(mime);
              const rate = m ? parseInt(m[1], 10) : 24000;
              const bin = atob(part.inlineData.data);
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              const pcm = new Int16Array(bytes.buffer);
              pushLevel(pcm, "onModelLevel");
              playChunk(pcm, rate);
            }
          }
        }

        if (sc.turnComplete) {
          commitUser();
          commitModel();

          api.onSpeaking(false);
          if (vadHang) { clearTimeout(vadHang); vadHang = null; }
          speakingNow = false;

        }
      };

      socket.onerror = () => {
        if (stopped || ready) return;
        fail("Could not open live chat.", "socket error before setup completed");
      };

      socket.onclose = (ev) => {
        if (stopped) return;

        const wasReady = ready;
        ready = false;
        lastClose = { code: ev ? ev.code : null, reason: ev ? ev.reason : "" };
        commitUser();
        commitModel();
        resetPlayback();

        if (!wasReady) {
          if (!minimalSetup) {
            minimalSetup = true;
            attempts++;
            reconnectTimer = setTimeout(connect, 300);
            return;
          }
          const why =
            (lastError ? "server said: " + lastError + "; " : "") +
            "close code " + lastClose.code + (lastClose.reason ? " (" + lastClose.reason + ")" : "");
          return fail("Live chat could not start.", why);
        }

        if (attempts >= MAX_RECONNECTS) {
          return fail(
            "The live call was interrupted.",
            (lastError ? "server said: " + lastError + "; " : "") +
            "close code " + lastClose.code + (lastClose.reason ? " (" + lastClose.reason + ")" : "")
          );
        }
        attempts++;

        reconnectTimer = setTimeout(connect, Math.min(600 * attempts, 4000));
      };
    }

    function teardown() {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (setupTimer) clearTimeout(setupTimer);
      setupTimer = null;
      ready = false;
      resetPlayback();
      if (ws) {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        try { ws.close(); } catch (e) {  }
        ws = null;
      }
      if (capture) {
        try {
          if (capture.port) capture.port.onmessage = null;
          if (capture.onaudioprocess) capture.onaudioprocess = null;
          capture.disconnect();
        } catch (e) {  }
        capture = null;
      }
      if (source) { try { source.disconnect(); } catch (e) {} source = null; }
      if (sink) { try { sink.disconnect(); } catch (e) {} sink = null; }
      if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
      if (ctx) { ctx.close().catch(() => {}); ctx = null; }

      stopVideo();
      levelSum = 0;
      levelSamples = 0;
      preroll.length = 0;
    }

    return {
      async start(handlers) {
        api = handlers;
        stopped = false;
        muted = false;
        userBuf = "";
        modelBuf = "";

        typing = false;
        attempts = 0;

        speakingNow = false;

        noiseSeeded = false;
        noiseFloor = VAD_FLOOR_MIN;
        seedMin = Infinity;
        seedBlocks = 0;
        videoOnlyTurn = false;
        if (vadHang) { clearTimeout(vadHang); vadHang = null; }
        api.onState("connecting");
        try {
          await openMic();
        } catch (e) {

          return fail("Microphone unavailable. Allow access and try again.", String(e));
        }
        if (stopped) return;
        connect();
      },
      setMuted(v) {
        applyMuted(v);
      },

      setTyping(v) {
        applyTyping(v);
      },

      async setVideo(mode) {
        if (stopped || !mode || mode === "off") {

          stopVideo({ announce: true });
          return false;
        }

        if (videoMode !== "off") stopVideo();
        if (stopped) return false;
        return openVideo(mode);
      },

      releaseVideo() {
        stopVideo();
      },

      cameraFacing() {
        return videoFacing;
      },

      canFlipCamera() {
        if (videoMode !== "camera" || !videoTrack) return false;
        try {
          if (videoTrack.getSettings && videoTrack.getSettings().facingMode) return true;
        } catch (e) {

        }
        return videoInputCount > 1;
      },

      async flipCamera() {
        if (stopped || videoMode !== "camera") {
          return { ok: false, facing: videoFacing };
        }
        const next = videoFacing === "environment" ? "user" : "environment";

        if (videoTrack && typeof videoTrack.applyConstraints === "function") {
          try {
            await videoTrack.applyConstraints({ facingMode: next });
            const got = videoTrack.getSettings ? videoTrack.getSettings().facingMode : next;
            if (got === next) {
              videoFacing = next;

              await waitForPreviewFrames(VIDEO_FLIP_WAIT_MS);
              return { ok: true, facing: next };
            }
          } catch (e) {

          }
        }

        stopVideo({ keepPreview: true });
        if (stopped) return { ok: false, facing: videoFacing };
        const ok = await openVideo("camera", { facing: next });
        if (ok) await waitForPreviewFrames(VIDEO_FLIP_WAIT_MS);
        return { ok: !!ok, facing: videoFacing };
      },

      pump() {
        if (stopped || videoMode === "off" || !ready) return false;
        pumpVideo();
        return true;
      },

      sendText(text) {
        const body = String(text || "").trim();
        if (!body || stopped) return false;
        if (!sendClient({
          clientContent: {
            turns: [{ role: "user", parts: [{ text: body }] }],
            turnComplete: true
          }
        })) {
          return false;
        }

        if (micIsOff() && speakingNow && !videoOnlyTurn) endActivity();
        return true;
      },
      stop() {
        stopped = true;
        teardown();
        if (api) {
          api.onSpeaking(false);
          api.onMicLevel(0);
          api.onModelLevel(0);
        }
      }
    };
  }

  LV.transport = makeLiveTransport();

  window.startLiveVoice = startLiveVoice;
  window.startLiveSession = startLiveSession;
  window.endLiveVoice = endLiveVoice;
  window.toggleLiveMute = toggleLiveMute;
  window.toggleLiveTyping = toggleLiveTyping;
  window.closeLiveTyping = closeLiveTyping;
  window.sendLiveTyped = sendLiveTyped;
  window.autoGrowLiveType = autoGrowLiveType;
  window.liveTypeKey = liveTypeKey;
  window.toggleLiveCamera = toggleLiveCamera;
  window.toggleLiveScreen = toggleLiveScreen;
  window.flipLiveCamera = flipLiveCamera;

  window.addEventListener("beforeunload", function () {
    if (LV.active && LV.transport && typeof LV.transport.stop === "function") {
      LV.transport.stop();

      flushLiveTranscript();
    }
  });

  let resizeRaf = null;
  window.addEventListener("resize", function () {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      if (LV.active) {
        drawOrb();
      }
    });
  });

  function leaveLive() {
    if (!LV.active) return;
    if (LV.transport && typeof LV.transport.stop === "function") LV.transport.stop();

    flushLiveTranscript();

    resetVideoUi();
    LV.starting = false;
    stopTimer();
    exitLiveView();
    setPhase("blank");
    setConn("idle");
  }

  function primeWelcomeReserve() {
    try {
      welcomeReserve();
    } catch (e) {

    }
  }
  primeWelcomeReserve();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", primeWelcomeReserve, { once: true });
  }

  const _origNewChat = window.newChat;
  if (typeof _origNewChat === "function" && !_origNewChat.__lvWrapped) {
    const wrappedNew = function () {
      const args = arguments;
      const self = this;
      leaveLiveAnimated(() => _origNewChat.apply(self, args));
    };
    wrappedNew.__lvWrapped = true;
    try {
      window.newChat = wrappedNew;
    } catch (e) {

    }
  }

  function leaveLiveAnimated(swapFn) {
    const live = el("liveView");
    const chat = el("chatContent");

    if (!LV.active || !live) {
      leaveLive();
      swapFn();
      return;
    }

    live.classList.add("is-switching");
    setTimeout(() => {

      if (chat) {
        chat.classList.add("is-switching");
        void chat.offsetWidth;
      }
      const release = function () {
        if (chat) chat.classList.remove("is-switching");
        clearTimeout(LV._leaveGuard);
        LV._leaveGuard = null;
      };

      LV._leaveGuard = setTimeout(release, 400);
      try {
        leaveLive();
        swapFn();
      } catch (e) {
        release();
        return;
      }
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(release);
      } else {
        setTimeout(release, 16);
      }
    }, 150);
  }

  const _origLoadConversation = window.loadConversation;
  if (typeof _origLoadConversation === "function" && !_origLoadConversation.__lvWrapped) {
    const wrappedLoad = function (id) {
      const conv = typeof getConv === "function" ? getConv(id) : null;
      if (conv && conv.live) {

        if (!LV.active) leaveLive();

        else flushLiveTranscript();
        switchToLiveConversation(conv);
        return;
      }
      const self = this;
      leaveLiveAnimated(() =>
        _origLoadConversation.apply(self, arguments)
      );
    };
    wrappedLoad.__lvWrapped = true;
    try {
      window.loadConversation = wrappedLoad;
    } catch (e) {

    }
  }

  const _origDeleteConvConfirm = window.deleteConvConfirm;
  if (
    typeof _origDeleteConvConfirm === "function" &&
    !_origDeleteConvConfirm.__lvWrapped
  ) {
    const wrappedDelete = function (id) {

      const deletingOpen =
        LV.active &&
        typeof state !== "undefined" &&
        state.convId === id;
      const args = arguments;
      const self = this;
      if (!deletingOpen) {
        _origDeleteConvConfirm.apply(self, args);
        return;
      }

      leaveLive();
      _origDeleteConvConfirm.apply(self, args);

      startLiveVoice();
    };
    wrappedDelete.__lvWrapped = true;
    try {
      window.deleteConvConfirm = wrappedDelete;
    } catch (e) {

    }
  }

  const _origClearAllChats = window.clearAllChats;
  if (typeof _origClearAllChats === "function" && !_origClearAllChats.__lvWrapped) {
    const wrappedClear = function () {
      const args = arguments;
      const self = this;
      if (!LV.active) {
        _origClearAllChats.apply(self, args);
        return;
      }

      leaveLive();
      _origClearAllChats.apply(self, args);

      startLiveVoice();
    };
    wrappedClear.__lvWrapped = true;
    try {
      window.clearAllChats = wrappedClear;
    } catch (e) {

    }
  }

  const guard = setInterval(function () {
    const main = el("chatMain");
    if (main && !main.classList.contains("live-active")) leaveLive();
  }, 700);
  window.addEventListener("pagehide", function () {
    clearInterval(guard);

    if (LV.active) flushLiveTranscript();
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) return;
    if (LV.videoMode === "off") return;
    if (!LV.transport || typeof LV.transport.pump !== "function") return;
    LV.transport.pump();
  });

  window.__LV = LV;
  window.__leaveLive = leaveLive;
})();