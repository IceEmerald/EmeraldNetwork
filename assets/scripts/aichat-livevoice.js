/* ═══════════════════════════════════════════════════════════════
   EmeraldCore Live v1 — Live Chat UI controller

   Owns the main-screen live view, the orb + dual waveform canvases,
   the rolling transcript, and the composer-slot controls.

   All networking goes through LV.transport, which holds the real
   call: microphone in, audio out, over a WebSocket.

   The socket address, the model and the system instruction all arrive
   from the Worker as JSON. Endpoint is derived from CHAT_WORKER_URL
   (aichat.js:1) — no provider URL or model id is ever written in this
   file.
   ═══════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  if (window.__liveVoiceLoaded) return;
  window.__liveVoiceLoaded = true;

  /* Greetings for the live start screen. These mirror the list inside
     showWelcome() (aichat.js:1811) so a new live chat greets the same
     way a new normal chat does. That array is function-local, so it
     cannot be imported — this is a deliberate copy, not a second
     source of truth we control. Keep the wording in step with it. */
  const LIVE_GREETINGS = [
    (n) => `How can I help, ${n}?`,
    (n) => `What's on your agenda today, ${n}?`,
    (n) => `Ready when you are, ${n}. What do you need?`,
    (n) => `What's on your mind today, ${n}?`,
    (n) => `Hi ${n}! What would you like to explore?`
  ];

  const LIVE_LABEL = "EmeraldCore Live";

  /* Speaker name on message bubbles. Matches the name text chat uses
     (aichat.js:1853) so a live turn and a typed turn look identical.
     LIVE_LABEL stays separate — that one is the model name shown in the
     topbar chip, not who is speaking. */
  const AI_NAME = "EmeraldBot";

  /* How many turns stay on screen while a call is in progress. Older
     ones are still stored — they return the moment the chat stops. */
  const LIVE_TURNS_SHOWN = 2;

  /* The single source of truth for where live audio goes. Derived
     from the chat worker constant so there is nothing to keep in sync.
     Audio never passes through the Worker — it only issues the
     short-lived credential and the socket address, both of which come
     back from this route as JSON. */
  function liveEndpoint() {
    const base =
      typeof CHAT_WORKER_URL === "string" && CHAT_WORKER_URL
        ? CHAT_WORKER_URL
        : "";
    if (!base) return "";
    return base.replace(/^https?:/i, "wss:") + "/live";
  }

  /* HTTP base for the token route. Derived from the chat worker
     constant so there is a single place to change it. */
  const LIVE_WORKER_URL = liveEndpoint().replace(/wss:/i, "https:").replace(/\/live$/, "");

  /* ── State ───────────────────────────────────────────────── */

  const LV = {
    conn: "idle", // idle|connecting|live|reconnecting|ended|error
    phase: "blank", // blank|loading|live|ended
    starting: false,
    newSession: false,
    muted: false,
    speaking: false, // model is currently producing audio
    userSpeaking: false,
    micLevel: 0, // 0..1 smoothed
    modelLevel: 0, // 0..1 smoothed
    startedAt: 0,
    elapsedMs: 0, // milliseconds banked by the clock; survives pause/resume
    timerId: null,
    rafId: null,
    turns: [], // { role, text, at }
    savedCount: 0, // turns already written to storage
    pending: { user: null, ai: null },
    sessionHandle: null, // server resumption handle, kept for context carry-over
    sessionConv: null, // which conversation that handle belongs to
    qaHeight: 0, // last measured welcome quick-action row height
    _leaveGuard: null, // failsafe timer clearing the blur on a left-behind chat
    morphTimers: null, // timeouts driving the start-of-call morph
    prevModelName: "",
    active: false,
    /* Set once a call has actually connected. Keeps the greeting
       reserved for a live screen that has never been used, so a call
       that ended without any speech does not fall back to it. */
    everCalled: false,
    presence: 0, // slow follower for overall loudness; drives aura + brightness
    clock: 0, // accumulated seconds for orb animation; frozen when reduced/ended
    lastT: 0, // performance.now() of the previous frame, for the frame delta
    orbAlpha: 0, // cached --lv-orb-body-alpha (per theme, read from CSS)
    orbAlphaAt: 0,
    orbLine: "",
    orbAura: 0.26,
    orbWarned: false
  };

  function el(id) {
    return document.getElementById(id);
  }

  /* ── Connection state ──────────────────────────────────────────
     There is no status pill any more, so this is pure internal state
     plus the data-conn attribute the orb's colours key off. Keep it in
     one place rather than sprinkling LV.conn writes around.
     ────────────────────────────────────────────────────────── */

  /* ── Chimes ─────────────────────────────────────────────────────
     A short two-note cue when a call connects and when it ends, so the
     state change is audible as well as visible.

     Synthesised rather than shipped as a file: no asset to load, no
     decode latency, and it stays in step with the reduced-motion
     preference already tracked in this file. ─────────────────────────── */

  /* Separate from the call's own AudioContext on purpose — that one is
     closed by teardown() the instant the call ends, which would silence
     the closing cue as it played. */
  let chimeCtx = null;

  function playCue(notes) {
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      if (!chimeCtx || chimeCtx.state === "closed") chimeCtx = new Ctor();
      /* Autoplay policy suspends a context created outside a gesture.
         Both cues fire from a click, so resuming here is allowed. */
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
        /* Short attack and exponential release: a percussive blip rather
           than a tone that hangs over the conversation. */
        gain.gain.setValueAtTime(0.0001, t0 + n.at);
        gain.gain.exponentialRampToValueAtTime(n.vol, t0 + n.at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
        osc.connect(gain);
        gain.connect(chimeCtx.destination);
        osc.start(t0 + n.at);
        osc.stop(t0 + n.at + n.dur + 0.02);
      });
    } catch (e) {
      /* A missing or blocked audio context must never interrupt a call. */
    }
  }

  /* Rising for "connected", falling for "ended" — distinguishable
     without looking at the screen, and direction matches the state. */
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

  /* ── Control bar phase ────────────────────────────────────────
     blank   → "Start live chat" is the only enabled control
     loading → Start spins, everything else inert
     live    → Start hidden, Mute + End available
     ────────────────────────────────────────────────────────── */

  function setPhase(phase) {
    const bar = el("liveControls");
    const start = el("lvStartBtn");
    const mute = el("lvMuteBtn");
    const end = el("lvEndBtn");
    const stage = el("liveStage");

    if (bar) bar.setAttribute("data-phase", phase);
    LV.phase = phase;

    const live = phase === "live";
    const loading = phase === "loading";

    /* Set here rather than only in renderTranscript, so the flag is
       correct the moment the phase changes and does not depend on a
       re-render happening afterwards. A live call keeps the transcript
       capped so the orb stays in view; history gets the full height to
       scroll through. */
    const view = el("liveView");
    if (view) view.classList.toggle("live-running", live || loading);

    if (start) {
      start.classList.toggle("is-loading", loading);
      start.disabled = loading;
      start.style.display = live ? "none" : "";
    }
    if (mute) mute.disabled = !live;
    if (end) end.disabled = !live;

    /* The orb is only meaningful once audio is flowing. The loading
       stage is deliberately left hidden here and revealed by
       runStartMorph — unhiding it now would push the welcome card down
       before the morph has pinned it, and the logo would appear to
       jump as it started its flight. */
    if (stage) stage.hidden = !live;

    /* Greet the way a new normal chat does, so the start screen feels
       like the same app rather than a separate product. */
    if (phase === "blank") renderLiveBlankCopy();

    /* Entering "loading" is the moment the greeting hands over to the
       living blob. A "live" arrival does NOT cancel it — a fast
       connection would otherwise cut the animation off halfway. The
       morph's own timers always tidy up. */
    if (loading) runStartMorph();
    else if (phase !== "live") cancelStartMorph();
  }

  /* ── Start-of-call morph ────────────────────────────────────────
     greeting dissolves -> logo flies to centre, grows, blurs ->
     hands off to the orb, which settles back to normal.
     ────────────────────────────────────────────────────────── */

  /* Two stages instead of one.
     fly     — the logo flies to centre and blurs up to its peak.
     handOff — the blob resolves out of that blur.
     The gap between them is not a fixed delay: the shape waits at full
     blur for as long as the connection takes, and only resolves when the
     session actually goes live. That makes the reveal mean something —
     the orb unblurs because you are connected, not because a timer
     elapsed. */
  /* The hand-over is three timed stages, in this order: the blob grows
     into a glow, the glow resolves into the real blob, and only then does
     the conversation come back.

     The last two are deliberately sequenced rather than simultaneous.
     The orb's resolve is driven by a CSS transition (aichat.css,
     .lv-morph.lv-orb-in .live-orb), so JS cannot observe it directly —
     it has to be told how long it runs and stay out of the way. The text
     delay is set just past that, and handOff is sized to outlast the
     whole return, because cancelStartMorph() drops .lv-morph and would
     otherwise snap the transcript back mid-fade. */
  const MORPH = {
    fly: 680,
    /* .lv-orb-in filter transition, aichat.css. */
    orbResolve: 780,
    /* Starts after orbResolve: the blob is fully resolved by then. */
    textDelay: 820,
    textFade: 420,
    /* Past the last pixel of the text fade, with a little slack. */
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

    /* Animating out of the welcome box while the layout moves to its
       live shape would drag the card with it, so pin it where it is
       and let the two animate independently. */
    const card = blank.getBoundingClientRect();
    const cs = getComputedStyle(blank);
    blank.style.position = "fixed";
    blank.style.left = card.left + "px";
    blank.style.top = card.top + "px";
    blank.style.width = card.width + "px";
    /* The box matters too: the card centres its content inside its own
       padding, so pinning without it would reflow the logo. */
    blank.style.height = card.height + "px";
    blank.style.margin = "0";
    /* Pinning the box is not enough on its own. Switching to the live
       layout drops .is-welcome, and those rules also set this card's
       padding and min-height — which shifted the centred logo ~30px
       mid-flight, which read as the icon jumping. Freeze both here so
       the layout change cannot touch the card. */
    blank.style.minHeight = cs.minHeight;
    blank.style.padding = cs.padding;

    /* Measured only once the card is pinned and therefore stable. */
    const from = logo.getBoundingClientRect();

    /* A call can be started from a live chat that already has turns in
       it — the history screen, or a restart after End. The welcome card
       is not on screen then, so there is no logo to fly: its box is
       zero-sized, and the flight below would be measured against that,
       dividing by a zero width.

       Skipping it leaves the same shape the blank start has, minus the
       flight: the stage is revealed and the transcript is faded out by
       .lv-morph, so the blob simply resolves in once the call goes live.
       Without this the old transcript stayed fully visible under the
       glow for the entire wait. */
    const logoVisible = from.width > 0 && from.height > 0;

    /* Reveal the stage (hidden by the blank phase) so the orb's final
       position can be measured. It is transparent until the hand-off,
       so nothing is painted yet. */
    view.classList.remove("is-welcome");
    stage.hidden = false;
    const to = orb.getBoundingClientRect();

    /* Set on both paths: the glow has to be the right size whether it
       was arrived at by flying or by opening there. */
    view.style.setProperty("--lv-peak-blur", Math.round(to.width * 0.06) + "px");

    if (!logoVisible) {
      blank.style.display = "none";
      view.classList.add("lv-morph", "lv-at-peak");
      /* An empty list, not null: finishStartMorph bails on a null one,
         and it must still run to resolve the glow when the call goes
         live. */
      LV.morphTimers = [];
      return;
    }

    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);

    /* How far the logo blurs is a fraction of the orb it is becoming.
       Both shapes are held at this radius during the swap, so matching
       their blurred footprint is what makes the hand-off invisible —
       hence the small overshoot rather than the old 1.25, which left the
       logo visibly larger than the blob underneath it. */
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
    /* Two frames: one to commit the logo's starting position, one to
       apply the transform so the transition has somewhere to travel.
       Only the distances are set here — the timings live in the
       .lv-morph rules, so they stay adjustable in one place. */
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        logo.style.setProperty("--lv-tx", dx + "px");
        logo.style.setProperty("--lv-ty", dy + "px");
        logo.style.setProperty("--lv-sc", String(scale));
      });
    });

    /* Reaching the peak is the only timed part. From here the screen is
       a soft glow sitting at centre while the connection is negotiated,
       and it stays that way — no hand-off — until finishStartMorph()
       runs on the live event. A slow or fast connection changes how long
       the glow holds, never the animation itself. */
    LV.morphTimers = [
      setTimeout(() => {
        view.classList.add("lv-at-peak");
      }, MORPH.fly)
    ];
  }

  /* Called once the session is actually live. Resolves the glow into the
     orb. Split out of runStartMorph so the reveal is driven by the
     connection rather than by the clock. */
  function finishStartMorph() {
    const view = el("liveView");
    if (!view) return;
    /* Nothing running means the morph was cancelled (reduced motion, or
       the call ended first) — the orb is already showing. */
    if (!LV.morphTimers) return;
    if (view.classList.contains("lv-orb-in")) return;

    /* Re-render now, not at hand-off — and BEFORE the hand-off classes go
       on, which is the part that matters.

       Two reasons, both ordering:

       Correct content. The transcript only fades back in textDelay later,
       but until this ran it still held every turn from the chat the call
       was started from. So the text faded up with the full history behind
       it and then snapped to the single live exchange a moment later,
       when the hand-off timer finally re-rendered with .live-running
       applied.

       Correct starting opacity. The fade-out and fade-in are two rules on
       the same selector, and the fade-in (.lv-morph.lv-orb-in) is the more
       specific of the two. Building the message elements while
       .lv-orb-in is already set meant they were created directly at the
       fade-in's target value — a fresh element does not transition to the
       value it was born with — so the transcript appeared at full
       opacity the instant the orb began resolving, with no fade at all.
       Re-rendering first puts them under the fade-out rule, where they
       start hidden and the hand-off classes then lift them properly. */
    renderTranscript();

    view.classList.remove("lv-at-peak");
    view.classList.add("lv-orb-in", "lv-dissolve");

    const timer = setTimeout(() => {
      cancelStartMorph();
      renderTranscript();
    }, MORPH.handOff);
    LV.morphTimers.push(timer);
  }

  /* Height of the welcome screen's quick-action row. That row sits below
     the greeting, so on the real welcome screen it lifts the logo and
     heading as part of the centred group. A live chat has no such row,
     and its height changes with the viewport (wraps, stacks into a
     column below 768px, and is display:none below 640px), so it is
     measured rather than hard-coded — see .live-blank in aichat.css. */
  function welcomeReserve() {
    /* Below 768px .quick-actions is display:none (aichat.css:6166), so
       nothing is reserved. Checked here because a hidden welcome screen
       reports a height of 0 either way. */
    if (window.matchMedia && window.matchMedia("(max-width: 768px)").matches) {
      LV.qaHeight = 0;
      return 0;
    }
    const row = document.querySelector("#welcomeScreen .quick-actions");
    if (row) {
      const h = row.getBoundingClientRect().height;
      /* Only trustworthy while the welcome screen still has layout —
         it is display:none once a conversation is open. */
      if (h > 0) {
        /* Include the flex gap above the row: that space only exists
           when the row does, so the reserve must vanish with it. */
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
      /* fall through to the generic name */
    }
    const displayName = name && name !== "You" ? name : "User";
    /* _cryptoInt (aichat.js) is what showWelcome uses; fall back to
       Math.random if it is ever unavailable. */
    const idx =
      typeof _cryptoInt === "function"
        ? _cryptoInt(LIVE_GREETINGS.length)
        : Math.floor(Math.random() * LIVE_GREETINGS.length);
    heading.textContent = LIVE_GREETINGS[idx](displayName);
  }

  /* ── Canvas sizing (device-pixel aware) ──────────────────── */

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

  /* ── Orb ─────────────────────────────────────────────────── */

  const TAU = Math.PI * 2;

  /* The orb's palette is fixed rather than taken from the theme's accent
     token: light mode's accent (rgb(35,154,77)) is dark enough to read as
     muted next to the loops. Body translucency is the one per-theme value
     and comes from CSS as --lv-orb-body-alpha. */
  function orbPalette(cssLine, cssAura) {
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
    /* The line and halo strengths come from CSS: see the note on
       --lv-orb-line for why they cannot be one fixed value. */
    return { core: "rgb(214, 255, 240)", mid: "rgb(45, 212, 191)", edge: "rgb(74, 222, 128)",
             membrane: cssLine, mote: rgbTriple(cssLine), aura: "80,200,120",
             auraA: cssAura, amp: 1, speed: 1, motes: true };
  }

  /* Harmonics that deform the body. The outline is not rotated — it is
     reshaped by waves travelling around the perimeter, which is what makes
     a blob read as alive. Higher orders carry a larger energy gain, so a
     quiet orb is nearly round and a loud one is complex and organic.
     The base terms are deliberately tiny: at silence the outline should
     read as a calm circle, not a permanently wobbling one. */
  const WAVES = [
    { n: 2, base: 0.006, gain: 0.056, w: 0.90, ph: 0.0 },
    { n: 3, base: 0.004, gain: 0.050, w: -1.40, ph: 2.1 },
    { n: 5, base: 0.002, gain: 0.058, w: 2.20, ph: 4.3 }
  ];

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  /* Stable per-index pseudo-random in [0,1). Deterministic so motes hold
     their orbits instead of being re-randomised every frame. */
  function hash(i) {
    const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  function ringNoise(i, phase, seed) {
    return Math.sin(phase + i * 0.87 + seed) * 0.62 +
           Math.sin(phase * 1.63 + i * 1.71 + seed * 2.1) * 0.38;
  }

  /* Closed loop with a varying radius, as a reusable path. */
  function organicLoop(ctx, cx, cy, radius, n, amp, phase, seed, rot) {
    const p = new Array(n * 2);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rot;
      const rr = radius * (1 + ringNoise(i, phase, seed) * amp);
      p[i * 2] = cx + Math.cos(a) * rr;
      p[i * 2 + 1] = cy + Math.sin(a) * rr;
    }
    /* traceLoop appends subpaths rather than starting one, because the
       membrane needs two of them in a single fill. Every standalone loop
       has to open its own path — without this the loop is stroked onto
       whatever path happened to be current, which silently re-strokes
       the previous shape and tints it. */
    ctx.beginPath();
    traceLoop(ctx, p, n, false);
  }

  /* Appends a smooth closed subpath. Curves run through the midpoints of
     consecutive points — joining them with straight segments gives a
     polygon, which is the hard-edged look this is meant to replace.
     Reversed order is used for the membrane's inner edge so the fill
     punches a hole under the nonzero winding rule. */
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

  /* Samples the body outline at n points. Returns the outer points and a
     parallel array of radial deviations, which the membrane uses to vary
     its width — thicker where the body bulges out, thinner where it
     draws in. */
  function sampleBody(cx, cy, R, t, amp, n) {
    const p = new Array(n * 2);
    const inner = new Array(n * 2);
    const dev = new Array(n);
    let minD = Infinity;
    let maxD = -Infinity;

    /* A slow LFO on the harmonic amplitudes stops the motion from ever
       looking like it is on a fixed loop. */
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

  /* "rgb(13, 148, 94)" -> "13,148,94", for building sprite colours out of
     the themed line token. */
  function rgbTriple(color) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color || "");
    return m ? m[1] + "," + m[2] + "," + m[3] : color;
  }

  /* Soft dot sprite, built once per palette so motes are a cheap
     drawImage rather than a per-mote radial gradient. */
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

    /* Theme tokens first: the palette is built from them, so reading them
       afterwards handed it undefined and every colour string came out
       "NaN". Re-read a couple of times a second so a theme toggle is
       picked up without forcing a style flush every frame. */
    const nowMs = performance.now();
    if (!LV.orbAlpha || nowMs - LV.orbAlphaAt > 400) {
      const cs = getComputedStyle(canvas);
      const alpha = parseFloat(cs.getPropertyValue("--lv-orb-body-alpha"));
      const aura = parseFloat(cs.getPropertyValue("--lv-orb-aura"));
      LV.orbAlpha = Number.isFinite(alpha) ? alpha : 0.6;
      LV.orbAura = Number.isFinite(aura) ? aura : 0.26;
      LV.orbLine = cs.getPropertyValue("--lv-orb-line").trim() || "rgb(94, 234, 168)";
      LV.orbAlphaAt = nowMs;
    }

    const P = orbPalette(LV.orbLine, LV.orbAura);

    /* Level drives overall energy: mic when the user talks, model audio
       when it replies. */
    const raw = Math.max(LV.micLevel, LV.modelLevel * 0.9);
    /* presence is the slow memory of how loud this conversation is; raw
       is the instantaneous level. Reacts to both so a single held note
       keeps the orb lit instead of flickering with the waveform. */
    const energy = LV.presence * 0.65 + raw * 0.35;

    /* Everything is sized from the canvas half-width and kept inside a
       safety margin. The outer loops used to be derived from a fixed base
       radius and could grow past the canvas edge, which sliced the
       largest ones into flat arcs. */
    const R = Math.min(w, h) / 2;
    const SAFE = R * 0.86;
    const t = LV.clock;
    const sp = P.speed;
    const amp = energy * P.amp;

    const bodyAlpha = Math.min(1, LV.orbAlpha * (0.8 + energy * 0.45));

    ctx.save();

    /* ── 0. Aura ─────────────────────────────────────────── */
    const auraR = SAFE * (0.92 + energy * 0.16);
    const aura = ctx.createRadialGradient(cx, cy, SAFE * 0.05, cx, cy, auraR);
    aura.addColorStop(0, "rgba(" + P.aura + "," + (P.auraA * (0.65 + energy * 0.7)).toFixed(3) + ")");
    aura.addColorStop(0.5, "rgba(" + P.mote + "," + (P.auraA * 0.42).toFixed(3) + ")");
    aura.addColorStop(1, "rgba(" + P.aura + ", 0)");
    ctx.beginPath();
    ctx.arc(cx, cy, auraR, 0, TAU);
    ctx.fillStyle = aura;
    ctx.fill();

    /* ── 1. Far motes ─────────────────────────────────────── */
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

    /* ── 2/3. Orbital loops ──────────────────────────────── */
    const loops = [
      { r: 0.88, amp: 0.055, spin: 0.22, wave: 0.30, lw: 1.4, al: 0.5, n: 30, seed: 0.0,
        ex: 0.06, ey: 0.04, fq: 0.21 },
      { r: 0.72, amp: 0.08, spin: -0.41, wave: -0.5, lw: 1.9, al: 0.72, n: 24, seed: 1.7,
        ex: 0.05, ey: 0.07, fq: 0.17 }
    ];
    for (const L of loops) {
      /* The loop's centre precesses on a small ellipse and its radius
         breathes, so it reads as orbiting the body rather than sitting
         concentric to it. */
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

    /* ── 4. Inner core (behind the translucent body) ─────── */
    const bodyR = SAFE * (0.40 + amp * 0.06);
    const coreR = bodyR * (0.62 + energy * 0.16);
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    core.addColorStop(0, P.core);
    core.addColorStop(1, "rgba(80, 200, 120, 0)");
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, TAU);
    ctx.fillStyle = core;
    ctx.fill();

    /* ── 5. Body ─────────────────────────────────────────── */
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

    /* ── 6. Membrane ─────────────────────────────────────── */
    /* A ribbon of variable width hugging the body's edge, brightest where
       the body bulges. Filled as one shape rather than stroked in
       segments: a per-segment stroke with a shadow would cost dozens of
       blur passes per frame. */
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

    /* ── 7. Near motes, in front for depth ───────────────── */
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

    /* Muted: strike the halo so the state reads even in peripheral
       vision. */
    if (LV.muted) {
      organicLoop(ctx, cx, cy, SAFE * 0.62, 18, 0.06, t * 0.2, 2.2, t * 0.1);
      ctx.strokeStyle = "rgba(231, 76, 60, 0.55)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.restore();
  }

  /* ── Render loop ─────────────────────────────────────────── */

  /* One-pole follower with different attack and release coefficients.
     Raw RMS is jittery and reads as visual noise, but easing both
     directions equally is what makes a level meter feel mushy — it
     swells slowly and never quite relaxes. Punching up fast and easing
     down slowly is what gives the orb a sense of breath. */
  function follow(cur, target, attack, release) {
    return cur + (target - cur) * (target > cur ? attack : release);
  }

  function tick() {
    LV.micLevel = follow(LV.micLevel, LV.targetMicLevel, 0.35, 0.06);
    LV.modelLevel = follow(LV.modelLevel, LV.targetModelLevel, 0.35, 0.06);
    /* presence trails well behind the instantaneous level; it carries the
       slow swell of a conversation while the fast followers carry its
       detail. */
    LV.presence = follow(LV.presence, Math.max(LV.micLevel, LV.modelLevel * 0.9), 0.05, 0.025);

    const now = performance.now();
    const dt = LV.lastT ? Math.min(0.05, (now - LV.lastT) / 1000) : 0;
    LV.lastT = now;
    /* The clock is accumulated rather than read from performance.now() so
       it can be frozen: reduced-motion users get a still orb, and a
       finished call should not keep drifting. */
    if (!prefersReducedMotion() && LV.conn !== "ended") LV.clock += dt;

    /* A canvas throw used to stop the loop permanently: the next
       requestAnimationFrame is scheduled after the draw, so a single bad
       colour string left the orb frozen for the rest of the session. */
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
    /* Drop the stale frame time so the first delta after a restart is not
       the whole time the loop spent stopped. */
    LV.lastT = 0;
    if (LV.rafId == null) LV.rafId = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (LV.rafId != null) {
      cancelAnimationFrame(LV.rafId);
      LV.rafId = null;
    }
  }

  /* ── Transcript ──────────────────────────────────────────── */

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

    /* Mirrors appendUserMessageDOM (aichat.js:1950) so live and typed
       turns are indistinguishable. Text is escaped, never injected raw. */
    div.innerHTML = `
      ${avatar}
      <div class="message-body">
        <div class="message-sender">${escapeHtml(role === "user" ? userLabel() : AI_NAME)}</div>
        <div class="message-text${role === "user" ? " user-text" : ""}">${escapeHtml(text).replace(/\n/g, "<br>")}</div>
      </div>`;
    return div;
  }

  /* Like / dislike for the live transcript.

   Text chat builds these with buildMessageActionsEl and prunes all but
   the newest reply with updateLastMsgActions (both in aichat.js). This is
   the same rule for live turns: exactly one reply carries the buttons —
   the most recent completed one — and they follow the transcript as it
   grows.

   Only when the live screen is NOT running a call. While a call is up,
   the blob owns the middle of the view and the reply is sized against it,
   so a row of buttons would eat into the space that keeps the reply clear
   of the orb. It also has nowhere sensible to go: there is nothing settled
   to rate yet, and the next turn would move it. Once the call ends — or
   before one starts — the view behaves like any other conversation and the
   buttons appear.

   Driven from renderTranscript rather than at click time, because that
   rebuilds the message nodes on every streamed chunk. Rebuilding them by
   hand each time would drop the rating the user just gave. Reusing
   aichat.js's builder also means the markup, the toast and the rated
   styling stay identical to text chat instead of forking.

   data-ai is deliberately not set on live messages: several text-chat
   helpers query that attribute document-wide, and the live view stays in
   the DOM while a text chat is open.

   `running` is passed in rather than re-derived here. renderTranscript is
   the only caller and already knows the answer; asking again from the DOM
   gave the wrong one, because the class is cleared by the phase change
   that precedes the render — so a render during a call still saw the
   screen as "not running" and put the buttons back on. */
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

    /* While the call is running, keep only the most recent exchange on
       screen so the live view stays about what is being said now rather
       than scrolling a wall of repeats. Once the chat is stopped the
       full transcript comes back. */
    const running = LV.phase === "live" || LV.phase === "loading";
    let visible = running ? LV.turns.slice(-LIVE_TURNS_SHOWN) : LV.turns;

    /* …but the window has to start on the user's turn.

       Taking the last N turns blindly breaks the moment the user speaks
       again: the tail becomes [previous reply, new user turn] instead of
       [user turn, reply]. That ordering is the one the live layout is
       built around — the reply carries the blob-sized margin that seats
       it under the blob — so leading with a reply seats it under nothing
       and drops the user's turn past the blob's lower edge. The stranded
       reply then sits across the blob until the new one lands, which is
       exactly the flicker this guards against.

       While a call is up, the newest turn is the user speaking again when
       there is nothing after it. There is no reply to pair it with yet,
       and the exchange it just replaced is no longer the current one, so
       show the user alone and let the reply take its place when it
       arrives. Once it does, the tail is [user turn, reply] again and the
       pair renders as one. */
    if (running && visible.length > 1 && visible[visible.length - 1].role === "user") {
      visible = [visible[visible.length - 1]];
    }

    /* Reconcile in place so streaming updates don't make the list jump. */
    box.querySelectorAll(".message").forEach((node) => node.remove());
    visible.forEach((t) => {
      box.appendChild(turnEl(t.role, t.text, false));
    });
    if (LV.pending.ai) {
      box.appendChild(turnEl("ai", LV.pending.ai, true));
    }

    /* Rating controls ride along with the re-render, so they have to be
       reapplied with it. */
    updateLiveActions(running);

    /* The empty state stays until there is something to show. Skipped
       mid-morph, where the card is being torn down deliberately. */
    const blank = el("liveBlank");
    /* Only the genuine welcome state shows the card. While connecting
       or live the logo has already morphed into the orb, so bringing
       the greeting back would undo that.

       The greeting belongs to a live screen that has never been used.
       Once a call has actually ended with nothing said there is nothing
       to show, and re-showing the greeting made pressing Start look
       like the app had reset — so that state is left as it is. This is
       tracked with a flag rather than LV.active, which is already true
       on the New Live Chat screen and must keep its greeting. */
    const showBlank =
      !(visible.length || LV.pending.ai) &&
      (LV.phase === "blank" || LV.phase === "ended") &&
      !LV.everCalled;
    if (blank && !LV.morphTimers) blank.style.display = showBlank ? "" : "none";

    /* The welcome layout (centred greeting filling the screen) belongs
       to the blank card alone. With turns on screen the transcript must
       hug the bottom above the controls instead, so this follows the
       card rather than the connection phase. */
    const view = el("liveView");
    if (view) {
      view.classList.toggle("is-welcome", showBlank);
      /* Marks a call that is actually running. History of a finished chat
         gets the full height to scroll through; a live call keeps the orb
         in view by capping the transcript. */
      view.classList.toggle("live-running", running);
    }

    box.scrollTop = box.scrollHeight;
  }

  function addTurn(role, text) {
    const clean = String(text || "").trim();
    if (!clean) return;
    LV.turns.push({ role, text: clean, at: Date.now() });
    renderTranscript();
  }

  /* Interim text while a turn is still being spoken. */
  function setPending(role, text) {
    LV.pending[role] = text ? String(text) : null;
    renderTranscript();
  }

  function commitPending(role) {
    const text = LV.pending[role];
    LV.pending[role] = null;
    if (text && text.trim()) addTurn(role, text);
  }

  /* ── Timer ─────────────────────────────────────────────────
     A stopwatch for the conversation, not the individual call. The
     running time is banked whenever the clock stops, so pausing (End,
     leaving the screen) and resuming carries on from where it left off
     instead of snapping back to 00:00. Only a new live chat — which
     goes through resetLive — starts it over. */

  /* Formats a millisecond count as mm:ss and writes it to the clock. */
  function paintTimer(ms) {
    const secs = Math.floor(ms / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, "0");
    const ss = String(secs % 60).padStart(2, "0");
    const t = el("liveTimer");
    if (t) t.textContent = mm + ":" + ss;
  }

  /* Banked time plus the run currently in progress, if any. */
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
      /* Bank the time that has run so resuming continues rather than
         restarting from zero. */
      if (LV.startedAt) LV.elapsedMs += Date.now() - LV.startedAt;
      LV.startedAt = 0;
    }
    /* Frozen at the accrued value, not blanked. */
    paintTimer(LV.elapsedMs);
  }

  /* ── View swap ───────────────────────────────────────────── */

  function enterLiveView() {
    const view = el("liveView");
    const main = el("chatMain");

    /* Two things matter here, and neither can be read from a class:
       whether the view is actually on screen (leaveLive/exitLiveView
       may have removed and re-added .live-active inside this very
       task, so it was never really un-rendered), and whether a blur-out
       is already running from a chat switch. */
    const alreadyBlurring = !!(view && view.classList.contains("is-switching"));

    /* Entering the live screen always uses the same blur-to-unblur
       treatment as switching chats in text chat — there is no
       transform fade-in. On a view that is about to be rendered for the
       first time the blurred class must be set BEFORE that happens: an
       element coming out of display:none has no transition on its first
       style, so that style is the blurred one. */
    if (view && !alreadyBlurring) view.classList.add("is-switching");

    if (main) main.classList.add("live-active");
    if (view) view.setAttribute("aria-hidden", "false");

    /* The live model is fixed, so the topbar chip becomes a static
       label instead of a dropdown while a session is running. */
    const nameEl = el("modelSelectorName");
    if (nameEl && !LV.prevModelName) LV.prevModelName = nameEl.textContent;
    if (nameEl) nameEl.textContent = LIVE_LABEL;

    /* Intercept the chip click for as long as the call is up. The
       model cannot be switched mid-session, so the menu must not open. */
    LV._chipGuard = function (e) {
      e.preventDefault();
      e.stopPropagation();
    };
    const chip = el("modelSelectorBtn");
    if (chip && !LV._chipBound) {
      chip.addEventListener("click", LV._chipGuard, true);
      LV._chipBound = true;
    }

    LV.active = true;
    startLoop();

    /* On mobile the sidebar is an overlay; leaving it open would cover
       the live view the user just asked for. */
    try {
      if (typeof closeMobileSidebar === "function") closeMobileSidebar();
    } catch (e) {
      /* non-fatal */
    }

        /* The blur-out half is always supplied by blurSwapToLive, so this
       only has to ease the incoming view back to clear. */
    releaseBlurIn(view);
  }

  /* Eases the live view from blurred to clear. Must run after the
     blurred style has been committed, hence the forced reflow. */
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

  /* ── Persistence ─────────────────────────────────────────────
     Live conversations are marked `live: true` so they can be reopened
     into the live UI instead of the standard text transcript.
     ────────────────────────────────────────────────────────── */

  function liveTitle() {
    return "New Live Chat";
  }

  /* Creates the conversation the moment a session actually starts, so
     it appears in history straight away rather than only once the user
     ends the call. Called when starting from the sidebar button; a
     restart after End reuses the existing conversation. */
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

  /* The conversation the current live screen is bound to, if any. */
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
    /* Only persist turns that aren't already stored. Without this a
       resumed session would re-append everything said so far. */
    const fresh = LV.turns.slice(LV.savedCount);
    try {
      let conv = currentLiveConv();

      /* A conversation should already exist (created at Start). This is
         only a safety net for the case where it went missing. */
      if (!conv) {
        if (!fresh.length) return false;
        const id = beginLiveConversation();
        conv = id && typeof getConv === "function" ? getConv(id) : null;
        if (!conv) return false;
        conv.live = true;
      }

      /* Keep the clock with the conversation even when nothing new was
         said, so ending and resuming carries the elapsed time forward. */
      conv.elapsedMs = liveElapsedMs();

      if (!fresh.length) {
        conv.updatedAt = Date.now();
        if (typeof upsertConv === "function") upsertConv(conv);
        return false;
      }

      /* One turn = one message, exactly as it appeared live, so a
         reopened conversation is identical to the live one. */
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

  /* Rebuilds the in-memory turns from a stored live conversation and
     shows the live screen in its "ended" state, ready to resume. */
  /* Builds the on-screen state for a stored live conversation. */
function applyLiveConversation(conv) {
    resetLive();
    /* The clock resumes from the saved value, so reopening a live chat
       shows how long it has run rather than starting over. */
    LV.elapsedMs = Number(conv.elapsedMs) || 0;
    paintTimer(LV.elapsedMs);
    enterLiveView();

    /* loadConversation normally does this. Live chats bypass it so the
       text view never renders first, so the bookkeeping has to happen
       here — without it the reopened chat isn't the active one and a
       resumed call would write into the wrong conversation. */
    try {
      if (typeof state !== "undefined") {
        state.convId = conv.id;
        state.isTemp = false;
      }
      if (typeof updateOwnedUrl === "function") updateOwnedUrl();
      if (typeof renderSidebar === "function") renderSidebar();
      if (typeof updateTopbarTitle === "function") updateTopbarTitle(conv.title);
    } catch (e) {
      /* non-fatal */
    }

    (conv.messages || []).forEach((m) => {
      if (!m || !m.text) return;
      LV.turns.push({ role: m.role === "user" ? "user" : "ai", text: m.text, at: m.at });
    });
    /* Everything on screen is already stored, so a later save must not
       duplicate it. */
    LV.savedCount = LV.turns.length;
    renderTranscript();
    setPhase(LV.turns.length ? "ended" : "blank");
    setConn("ended");
  }

  /* Opens a stored live chat with the same blur-out / unblur-in beat
     text chat uses (animateChatSwitch, aichat.js): blur whatever is on
     screen, swap at the midpoint, then blur the incoming view back in.
     Rapid clicks collapse into the pending call, exactly as the text
     path does, rather than stacking animations. */
  let _lvSwitching = false;
  let _lvSwitchPending = null;

  /* One blur-to-unblur for every change to the live screen, matching the
     timing of animateChatSwitch (aichat.js): blur out for 150ms, swap
     at the midpoint, then blur back in over 150ms. Opening the screen
     goes through here too, otherwise it would have no blur-out half and
     read as a snap. Rapid clicks collapse into the pending call rather
     than stacking animations. */
  function blurSwapToLive(applyFn) {
    if (_lvSwitching) {
      _lvSwitchPending = applyFn;
      return;
    }
    _lvSwitching = true;

    /* Whatever is currently visible is the thing that blurs out.
       enterLiveView handles the matching blur-in when the swap lands. */
    const chat = el("chatContent");
    const currentLive = el("liveView");
    const outgoing = LV.active ? currentLive : chat;
    if (outgoing) outgoing.classList.add("is-switching");

    setTimeout(() => {
      try {
        applyFn();
      } finally {
        /* A newer click during the blur wins; render it before the
           blur-in so the user never sees stale content. */
        if (_lvSwitchPending) {
          const next = _lvSwitchPending;
          _lvSwitchPending = null;
          try {
            next();
          } catch (e) {
            /* keep going — the blur-in still needs to run */
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

  /* ── Controls ────────────────────────────────────────────── */

  function toggleLiveMute() {
    LV.muted = !LV.muted;
    const btn = el("lvMuteBtn");
    const label = el("lvMuteLabel");
    const slash = el("lvMuteSlash");
    const plainIcon = slash && slash.previousElementSibling;

    if (btn) btn.setAttribute("aria-pressed", LV.muted ? "true" : "false");
    if (label) label.textContent = LV.muted ? "Unmute" : "Mute";
    if (slash) slash.style.display = LV.muted ? "" : "none";
    if (plainIcon) plainIcon.style.display = LV.muted ? "none" : "";

    if (typeof LV.transport !== "undefined" && LV.transport && typeof LV.transport.setMuted === "function") {
      LV.transport.setMuted(LV.muted);
    }
  }

  /* ── Session lifecycle ───────────────────────────────────── */

  function resetLive() {
    stopTimer();
    /* A fresh live chat starts its clock over; pause/resume within a
       conversation is handled by banking in stopTimer, so only this
       reset clears the accrued time. */
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
    /* New Live Chat is the greeting screen again. */
    LV.everCalled = false;
    LV.pending.user = null;
    LV.pending.ai = null;
    LV.sessionHandle = null;
    LV.sessionConv = null;
    LV.muted = false;
    LV.starting = false;
    LV.newSession = false;
    LV.phase = "blank";

    /* Reset the mute button to its unpressed visual state. */
    const mute = el("lvMuteBtn");
    const slash = el("lvMuteSlash");
    if (mute) mute.setAttribute("aria-pressed", "false");
    if (slash) slash.style.display = "none";
    const label = el("lvMuteLabel");
    if (label) label.textContent = "Mute";
    const headerIcon = slash && slash.previousElementSibling;
    if (headerIcon) headerIcon.style.display = "";
  }

  /* Opens the live screen in its blank state. No microphone, no
     connection — the user presses "Start live chat" when ready.

     This always yields a NEW live chat. It must work even when the
     live screen is already showing a stored conversation, because
     "New Live Chat" is how the user asks for a fresh one. If a call is
     actually running, its transcript is saved first so nothing is lost
     on the way out. */
  function startLiveVoice() {
    if (LV.active && (LV.phase === "live" || LV.starting)) {
      /* Mid-call: bank what was said before switching away. */
      if (LV.transport && typeof LV.transport.stop === "function") LV.transport.stop();
      commitPending("user");
      commitPending("ai");
      saveTranscript();
      stopTimer();
      LV.starting = false;
      setPhase("ended");
      setConn("ended");
    }

    /* Same blur-to-unblur as a chat switch, so opening feels identical
       to switching. The screen is deliberately not torn down first —
       that would hide the view and leave nothing to blur. */
    blurSwapToLive(() => {
      resetLive();
      enterLiveView();
      renderTranscript();
      setConn("idle");
      setPhase("blank");
      LV.newSession = true;

      /* Nothing is selected now — this is a blank new chat, not a
         conversation. Clearing convId drops the .active highlight in
         Recents (aichat.js:1901) and blanks the topbar title, matching
         what New Chat does. Done last, after saving, because the save
         path needs to know which conversation to write into. */
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
      /* non-fatal: purely cosmetic */
    }
  }

  /* Second step: actually request the mic and open the socket. */
  function startLiveSession() {
    if (!LV.active || LV.starting) return;
    LV.starting = true;
    setPhase("loading");
    setConn("connecting");

    /* Create the conversation up front so it shows in history as soon
       as the call begins. On a restart after End we reuse it. */
    if (LV.newSession) {
      LV.newSession = false;
      beginLiveConversation();
    }

    LV.transport.start({
      onState: (s) => {
        setConn(s);
        /* The countdown measures the call itself, so it starts the
           moment the session goes live — not while connecting, and not
           while sitting on the blank screen. */
        if (s === "live") {
          LV.starting = false;
          /* From here the screen is a call that has run, not a fresh
             live chat, so the greeting must not come back if it ends
             without any speech. */
          LV.everCalled = true;
          setPhase("live");
          /* The glow has been sitting at peak blur this whole time; now
             that the model is really listening it resolves into the orb.
             Without a morph running (reduced motion, or it was already
             handed off) this is a no-op. */
          finishStartMorph();
          /* Fires here, not when the button is pressed: the connection is
             genuinely up and the model is listening, which is what the
             user needs confirmed. */
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
        /* Returning to the blank screen on its own reads as "nothing
           happened", so the reason is shown before the reset. */
        LV.starting = false;
        setConn("error");
        setPhase("blank");
        if (msg && typeof showToast === "function") showToast(msg, "error");
      },
      onHandle: (h) => {
        /* A resumption handle carries the server-side context it was
           issued for. Replaying one into a different live chat would
           splice two conversations together, so it is remembered
           alongside the conversation it belongs to. */
        LV.sessionHandle = h || null;
        LV.sessionConv = h ? (LV.convId || null) : null;
      }
    });
  }

  function endLiveVoice() {
    if (!LV.active) return;
    if (LV.transport && typeof LV.transport.stop === "function") LV.transport.stop();

    /* Commit whatever was mid-flight so the last spoken sentence
       isn't lost. */
    commitPending("user");
    commitPending("ai");

    saveTranscript();
    LV.starting = false;
    stopTimer();
    setConn("ended");

    /* No toast on end: the transcript visibly stays on screen, the
       conversation appears in Recents, and the Start button comes back
       — a toast would only repeat what the screen already shows. */

    /* Stay on the live screen in its blank state so "Start live chat"
       can be pressed again — the conversation and its context remain. */
    LV.targetMicLevel = 0;
    LV.targetModelLevel = 0;
    /* Closing the call is an explicit, deliberate action, so it gets its
       own cue. */
    chimeEnd();
    setPhase("ended");
    setConn("ended");

    /* Now that the call is no longer running, re-render so the full
       transcript comes back — during the call only the latest turns
       are on screen. */
    renderTranscript();
  }

/* ── Transport ───────────────────────────────────────────────
     A real call. Microphone audio is captured on the audio thread,
     downsampled to 16 kHz PCM and streamed straight to the model over
     a WebSocket; the reply comes back as 24 kHz PCM and is played out
     through a jitter buffer.

     The socket address, the model and the system instruction all come
     from the Worker, which is the only place any of them is named —
     nothing provider-specific is referenced from this file.

     The handler contract above (onState, onMicLevel, onModelLevel,
     onSpeaking, onUserTurn, onUserPending, onModelTurn,
     onModelPending, onError, onHandle) is unchanged, so nothing above
     this line knows the difference.
     ────────────────────────────────────────────────────────── */

  const CAPTURE_BLOCK = 4096;
  const SEND_RATE = 16000;
  /* Playback is driven by two numbers.

     Measured across three real replies, the model delivers audio at
     ~4.3x realtime — it synthesises ahead and dumps the result in a
     burst, with inter-chunk gaps up to ~0.35s. So playback is not
     tracking a live edge; it is playing back a batch that is already
     complete.

     PLAY_LEAD — how far ahead of arrival playback is scheduled. Kept
       small on purpose. Every chunk re-applies it, so its value is
       added as a constant offset to everything: at 2s the first word
       arrived two seconds late and every reply felt laggy. 0.3s still
       covers the largest measured gap while starting promptly.
     PLAY_MAX_BACKLOG — the point at which queued audio is discarded to
       resynchronise. This is what caused the cut-offs: at 8s a reply
       longer than the cap triggered a resync that threw away everything
       still queued. 30s sits well beyond any normal reply, so it stays
       a safety valve instead of something that fires routinely. */
  const PLAY_LEAD = 0.3;
  /* Floor on how far ahead playback stays scheduled. Below this the
     playhead runs right at the arrival edge and any network jitter
     becomes audible silence, so it is topped back up to here. */
  const PLAY_MIN = 0.3;
  const PLAY_MAX_BACKLOG = 30.0;
  const MAX_RECONNECTS = 4;

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
    let ready = false;        // setup handshake completed
    let config = null;        // { token, wsUrl, model, voice, systemInstruction }
    let attempts = 0;
    let reconnectTimer = null;
    let setupTimer = null;
    /* Why the last connection ended, kept so the failure can actually be
       explained instead of guessing. */
    let lastClose = null;
    let lastError = null;
    /* The full session config is tried first; if the server refuses it we
       fall back to the documented minimal form, which is what lets a call
       work even when an optional field turns out to be unsupported. */
    let minimalSetup = false;

    let userBuf = "";
    let modelBuf = "";
    let modelHeard = false;

    /* Local voice activity detection.

       Thresholds are relative to a running estimate of the room's own
       noise floor, not absolute levels. A fixed floor cannot work across
       rooms: in a quiet one it sits clear of the noise, but in any room
       with a fan, traffic, a hum or a keyboard it sits *underneath* the
       noise. The detector then reads ambience as speech and opens a turn
       out of nothing, and the model — handed a turn containing only room
       tone — transcribes it as whatever short sound it can find.
       "¿Qué?", "Ja", "Yes" on an otherwise silent mic is that.

       The floor is clamped at both ends so it can neither rise high enough
       to cut off a quiet voice in a noisy room, nor fall so low in a
       silent one that the detector turns twitchy. */
    const VAD_FLOOR_MIN = 0.010;
    const VAD_FLOOR_MAX = 0.045;
    /* How far above the floor counts as speech. Deliberately modest: a
       higher ratio rejects more noise but also cuts off a soft voice the
       moment the room is busy, which is a worse failure than the one it
       was meant to prevent. The floor estimate below is what does most
       of the rejecting. */
    const VAD_SNR = 2;
    /* A turn must hold this level across the turn, not merely touch it, to
       count as an utterance rather than as noise that got through.

       Checked continuously, not once at the start: a level that is only
       briefly loud — traffic passing, a door, someone dropping something —
       opens a turn, dips back to the floor, and comes up again. Judged on
       the peak alone it looked like speech and the turn was held open for
       the full hangover, handing the model seconds of room tone to
       transcribe. Judged on whether it ever *sustained* here, that same
       sound is abandoned almost immediately.

       Sat above both VAD_CONFIRM and the open threshold for any
       realistic floor, so genuinely quiet speech still clears it. */
    const VAD_CONFIRM = 0.030;
    /* Blocks above the floor required before a turn is opened at all. One
       loud block — a key strike, a door, a cough, a mouse click — clears
       the floor easily, and opening a turn on one hands the model a burst
       of noise to turn into an imaginary word. Two consecutive blocks
       costs speech very little at the onset, where the level is still
       ramping up anyway. */
    const VAD_CONFIRM_BLOCKS = 2;
    /* Threshold for interrupting the model while it speaks. Set high
       because the speakers leak its voice back into the mic, and at the
       ordinary threshold that echo opened a second turn and produced
       overlapping replies. */
    const VAD_BARGE = 0.06;
    /* Held after speech stops, so a short pause between words does not chop
       one sentence into several turns. */
    const VAD_HANG_MS = 700;
    /* How long to wait for the level to actually reach VAD_CONFIRM once a
       turn is open. A turn that never gets there — noise that grazed the
       floor — is closed after this instead of hanging on for the full
       hangover. */
    const VAD_NEAR_SILENCE_MS = 200;
    let speakingNow = false;
    let vadHang = null;
    let noiseFloor = VAD_FLOOR_MIN;
    let turnPeak = 0;
    /* Set once the turn has been seen at real speech level. Until then the
       turn has to keep reaching VAD_CONFIRM to survive, which is what
       stops noise from holding one open. */
    let confirmed = false;
    /* Blocks above the floor seen so far in the turn being considered.
       Reset whenever the level drops back, so a transient cannot
       accumulate credit across separate sounds. */
    let candidate = 0;

    let lowpass = null;
    let lowpassRate = 0;

    let levelSamples = 0;
    let levelSum = 0;

    /* ── output ───────────────────────────────────────────── */

    let nextPlayAt = 0;
    let playing = [];

    function resetPlayback() {
      const t = ctx ? ctx.currentTime : 0;
      for (const s of playing) {
        try { s.stop(); } catch (e) { /* already ended */ }
      }
      playing = [];
      nextPlayAt = t;
      /* A barge-in or a turn change invalidates any pending close, so the
         next quiet block re-evaluates from scratch instead of ending a
         turn the user is still in the middle of. */
      if (vadHang) { clearTimeout(vadHang); vadHang = null; }
      speakingNow = false;
    }

    function playChunk(int16, rate) {
      if (!ctx || stopped) return;
      const n = int16.length;
      if (!n) return;
      const buf = ctx.createBuffer(1, n, rate);
      const out = buf.getChannelData(0);
      /* No fade between chunks. They are scheduled back to back, so a
         fade here would reach zero at every boundary and audibly clip
         the consonants at each join — the speech sounded chopped even
         when no audio was being dropped. */
      for (let i = 0; i < n; i++) out[i] = int16[i] / 32768;
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.connect(ctx.destination);
      const now = ctx.currentTime;
      /* Keep a small cushion so a gap between bursts is covered by
         buffer rather than by silence.

         This is applied ONCE per burst, not per chunk. Re-applying it on
         every chunk pushed the playhead forward by a third of a second
         each time, which is how the remaining inter-word gaps were
         being manufactured: the playhead overtook audio that had
         already arrived and left silence in front of it. A lead is only
         meaningful at the point playback starts, or after the queue has
         genuinely been emptied. */
      const starved = nextPlayAt <= now;
      if (starved) {
        nextPlayAt = now + PLAY_LEAD;
      } else if (nextPlayAt < now + PLAY_MIN) {
        /* Running closer to the arrival edge than the cushion allows,
           so top up — but never jump the playhead past audio that has
           already landed. */
        nextPlayAt = Math.min(now + PLAY_MIN, nextPlayAt);
      }
      /* Overflow is the exception, not the rule: the queue is only
         trimmed once it has fallen far enough behind that the user is
         hearing stale audio. */
      if (nextPlayAt - now > PLAY_MAX_BACKLOG) {
        for (const p of playing) {
          try { p.stop(); } catch (e) { /* never started */ }
        }
        playing.length = 0;
        nextPlayAt = now + PLAY_LEAD;
      }
      node.start(nextPlayAt);
      nextPlayAt += buf.duration;
      playing.push(node);
      if (playing.length > 64) playing.splice(0, playing.length - 64);
    }

    /* ── resampling ───────────────────────────────────────── */

    /* Windowed-sinc low-pass at 7 kHz before decimating. Skipping this
       folds everything above 8 kHz back down into the voice band and
       turns the mic into a buzzer. */
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
          /* Edges clamp to the nearest sample; the head/tail of a block
             is a few ms of near-silence anyway. */
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
      /* Chunked so a long block cannot blow the argument limit. */
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      return btoa(bin);
    }

    /* Turns are framed locally with activityStart / activityEnd.

       The server's own voice activity detection never fires on this
       endpoint, so with automaticActivityDetection enabled the mic audio
       was buffered forever and the model never took a turn — silence, no
       transcript, no reply. Driving the boundaries from the local level
       meter is what actually starts a turn.

       Audio rides in `realtimeInput.audio`. The `mediaChunks` array this
       used to send is rejected outright by this endpoint ("Precondition
       check failed"), which killed the socket before any audio landed. */
    function raw(obj) {
      if (!ws || ws.readyState !== WebSocket.OPEN || !ready) return;
      ws.send(JSON.stringify({ realtimeInput: obj }));
    }

    function beginActivity() {
      speakingNow = true;
      turnPeak = 0;
      confirmed = false;
      api.onSpeaking && api.onSpeaking(true);
      raw({ activityStart: {} });
    }

    function endActivity() {
      if (!speakingNow) return;
      speakingNow = false;
      turnPeak = 0;
      confirmed = false;
      candidate = 0;
      api.onSpeaking && api.onSpeaking(false);
      raw({ activityEnd: {} });
    }

    function send(bytes) {
      if (!ws || ws.readyState !== WebSocket.OPEN || !ready) return;
      /* Capture runs continuously, so this is called for silence too.
         Turn boundaries belong to trackActivity alone — opening one here
         meant every gap between words re-fired activityStart, and the
         server read that back-to-back start/stop as barge-in, which
         chopped the reply into stutters. */
      raw({ audio: { mimeType: "audio/pcm;rate=" + SEND_RATE, data: b64(bytes) } });
    }

    /* ── levels ───────────────────────────────────────────── */

    function pushLevel(arr, target) {
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        levelSum += v * v;
        levelSamples++;
      }
      let rms = 0;
      if (levelSamples > 800) {
        rms = Math.sqrt(levelSum / levelSamples);
        /* Speech RMS sits well below 1; the curve keeps the orb lively
           without letting it pin to the top. */
        api[target](Math.min(1, rms * 7));
        levelSum = 0;
        levelSamples = 0;
      }
      return rms;
    }

    /* Speech has to clear the room's own noise, not a fixed number, or
       every fan and keyboard in the room counts as the user talking. */
    function openThreshold() {
      return Math.min(VAD_FLOOR_MAX, Math.max(VAD_FLOOR_MIN, noiseFloor * VAD_SNR));
    }

    /* Kept just under the open threshold rather than at half of it.

       Half looked safe but was the other half of this bug: in a room
       whose ambience sat between the two, the turn could never fall below
       the close level, so it stayed open indefinitely and the model
       transcribed room tone for as long as the noise lasted. Nearly
       flush still suppresses the chatter that the gap existed for, since
       the hangover window absorbs any momentary dip. */
    function closeThreshold() {
      return openThreshold() * 0.9;
    }

    /* Follows the room down quickly and up very slowly. A noise source
       that appears — a fan switching on, traffic, someone shifting in a
       chair — should raise the floor within about a second, but a passing
       sound must not drag it up and then silence the user's speech for
       the several seconds it takes to drift back down. */
    function trackNoiseFloor(rms) {
      if (rms <= 0) return;
      noiseFloor += (rms - noiseFloor) * (rms < noiseFloor ? 0.35 : 0.003);
    }

    /* Decides where one turn ends and the next begins. Runs on every
       captured block, before the audio is filtered and shipped.

       Two separate questions, deliberately kept apart: whether a turn
       should *start*, and whether a turn already open should *survive*.
       Judging survival on the same threshold that opened it is what let
       sustained noise hold a turn open for seconds. */
    function trackActivity(rms) {
      if (muted) return;

      /* Only learns the room while it is genuinely quiet. Left running
         during a turn it would take the user's own voice — or the model's
         output leaking back through the speakers — for the background and
         raise the floor above the speech it is meant to detect. */
      if (!speakingNow && !modelHeard) trackNoiseFloor(rms);

      /* While the model is talking, the speakers feed its own voice back
         into the mic. At the normal threshold that echo reads as the
         user speaking, a fresh activityStart is sent, and the model
         starts a second reply on top of the first — which is what made
         it sound like several AIs answering at once.

         So barge-in needs a far stronger signal than ordinary speech
         while the model has the floor. A real interruption is close and
         loud; residual echo of the model's own output is not. */
      const open = modelHeard ? VAD_BARGE : openThreshold();

      if (!speakingNow) {
        /* ── looking for the start of a turn ── */
        if (rms >= open) {
          if (vadHang) { clearTimeout(vadHang); vadHang = null; }
          /* Nothing is announced until the level has held for a couple of
             blocks. A lone transient — a key strike, a door, a cough — is
             far and away the most common cause of a turn containing no
             speech at all, and waiting one block more at the start of a
             word costs almost nothing, since the signal is still coming
             up there anyway. */
          if (++candidate < VAD_CONFIRM_BLOCKS) return;
          candidate = 0;
          beginActivity();
        } else {
          /* Fell back under the floor before confirming: a transient,
             abandoned without ever having been announced. */
          candidate = 0;
        }
        return;
      }

      /* ── inside a turn ──

         A turn survives on the level it actually proved, not the level it
         was opened at. One that has not yet reached VAD_CONFIRM has to
         get there or be dropped quickly, so noise that merely grazed the
         floor cannot keep a turn open for the model to transcribe. Once
         real speech has been seen the turn can fall back to the ordinary
         close level, which keeps normal pauses from splitting sentences. */
      const need = confirmed ? closeThreshold() : VAD_CONFIRM;
      if (rms >= need) {
        /* Speech is still there — cancel the pending close and keep going. */
        if (vadHang) { clearTimeout(vadHang); vadHang = null; }
        if (rms > turnPeak) turnPeak = rms;
        if (rms >= VAD_CONFIRM) confirmed = true;
      } else if (!vadHang) {
        candidate = 0;
        vadHang = setTimeout(function () {
          vadHang = null;
          if (!stopped) endActivity();
        }, confirmed ? VAD_HANG_MS : VAD_NEAR_SILENCE_MS);
      }
    }

    /* ── capture ──────────────────────────────────────────── */

    function onBlock(block) {
      if (stopped || !ctx) return;
      /* Mic level is measured on the raw capture, before filtering. */
      const rms = pushLevel(block, "onMicLevel");
      if (muted) return;
      trackActivity(rms);
      const bytes = toSendRate(block);
      send(bytes);
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
      /* Keeps the graph pulled without letting the mic reach the
         speakers — a zero-gain sink, not an unterminated node. */
      sink = ctx.createGain();
      sink.gain.value = 0;
      sink.connect(ctx.destination);

      /* An AudioWorklet is the right tool but not a hard requirement: a
         missing module (wrong path, blocked, older browser) used to throw
         straight out of here and kill the call, even though the
         ScriptProcessor below would have worked fine. */
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
        /* Main-thread fallback. Still a real capture path. */
        capture = ctx.createScriptProcessor(CAPTURE_BLOCK, 1, 1);
        capture.onaudioprocess = (e) => onBlock(e.inputBuffer.getChannelData(0).slice(0));
      }
      source.connect(capture);
      capture.connect(sink);
    }

    /* ── session ──────────────────────────────────────────── */

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

    /* The user's name and saved memories, gathered the same way the text
       chat gathers them (aichat.js loadMemories / loadSettings) so a live
       call is as context-aware as a typed one. Every lookup is guarded:
       this file is loaded independently of aichat.js internals, and a
       missing helper must degrade to "no context", never throw and kill
       the call before it starts. */
    function livePersonalContext() {
      const ctx = { memories: [] };
      try {
        if (typeof loadSettings === "function") {
          const name = (loadSettings().userName || "").trim();
          if (name && name !== "You") ctx.userDisplayName = name;
        }
      } catch (e) { /* settings unavailable — carry on without a name */ }
      try {
        if (typeof loadMemories === "function") {
          const list = loadMemories() || [];
          if (Array.isArray(list)) {
            /* Newest first in storage, and the Worker keeps the tail, so
               reverse to send oldest-first and preserve the cap. */
            ctx.memories = list
              .map((m) => (typeof m === "string" ? m : m && m.text))
              .filter((t) => typeof t === "string" && t.trim())
              .reverse();
          }
        }
      } catch (e) { /* memories unavailable — the call still works */ }
      return ctx;
    }

    /* `detail` is the developer-facing half: it goes to the console so a
       report says what actually went wrong, while `msg` is what the user
       reads. */
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
          /* Same context the text chat sends. Without it a live call
             starts blank: the model has no idea who it is speaking to or
             anything they asked it to remember, so it has to be asked
             again every single call. */
          body: JSON.stringify(livePersonalContext())
        });
        if (!res.ok) {
          /* 404 almost always means the Worker was never redeployed with
             the live route, and 403 means this origin is not allowed.
             Both are invisible otherwise — the call just quietly resets. */
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

      /* If the server never answers the setup, the call would sit in
         "connecting" with no timer and no way back. Give it a deadline. */
      setupTimer = setTimeout(() => {
        if (stopped || ready) return;
        try { socket.close(); } catch (e) { /* already closing */ }
        fail("Live chat did not respond.", "no setupComplete after 12s");
      }, 12000);

      socket.onopen = () => {
        /* The server validates this whole message before it answers, and
           it is strict: one misplaced key rejects the entire setup with
           close code 1007 and no explanation. All three of these live
           under `generationConfig` — responseModalities AND speechConfig.
           Sent at the top level they come back as
           'Unknown name "responseModalities" at setup', which is what
           made every session die before setupComplete.

           The VAD sensitivity knobs are deliberately absent. The server
           rejects them on this endpoint regardless of value ("HIGH",
           "LOW", "MEDIUM", "HIGHEST" and the bare enum names all fail),
           so the server-side defaults are used instead. */
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
              /* Server-side activity detection never fires on this
                 endpoint, so leaving it enabled just buffers mic audio
                 that never becomes a turn. The boundaries are detected
                 locally instead — see trackActivity(). */
              automaticActivityDetection: { disabled: true }
            },
            sessionResumption: {}
          });
          body.generationConfig.speechConfig = {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice } }
          };
        }
        const setup = { setup: body };
        /* Carry the previous context across a reconnect, but only when
           the handle belongs to this conversation. */
        const handle =
          LV.sessionHandle && LV.sessionConv === (LV.convId || null)
            ? LV.sessionHandle
            : null;
        if (handle && !minimalSetup) body.sessionResumption = { handle };
        socket.send(JSON.stringify(setup));
      };

      /* The server sends every frame as a BINARY websocket frame, not
         text. In a browser that arrives as a Blob, so the obvious
         JSON.parse(ev.data) throws on "[object Blob]" and the catch
         swallows it — which silently drops *every* message, including
         setupComplete. The socket stays open and the session is billed,
         so it looks connected while nothing is processed.

         binaryType is set to "arraybuffer" so the payload arrives as an
         ArrayBuffer instead of a Blob, which also removes the async
         Blob.text() round-trip from the audio path. */
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

        /* Servers report bad configuration here rather than in a field we
           were already reading. */
        if (msg.error) {
          lastError = msg.error.message || JSON.stringify(msg.error);
          return;
        }

        if (msg.setupComplete) {
          ready = true;
          attempts = 0;
          api.onState("live");
          return;
        }

        /* The field is `newHandle`. Reading `resumableHandle` always
           returned undefined, so reconnects silently lost the server-side
           context instead of resuming it. */
        const resumption = msg.sessionResumptionUpdate;
        if (resumption && (resumption.newHandle || resumption.resumableHandle)) {
          api.onHandle(resumption.newHandle || resumption.resumableHandle);
          return;
        }

        /* The server says this session is about to be closed. Reconnect
           on our terms rather than waiting for the socket to drop —
           a long call would otherwise end silently partway through. */
        if (msg.goAway) {
          if (setupTimer) clearTimeout(setupTimer);
          setupTimer = null;
          commitUser();
          commitModel();
          resetPlayback();
          try { socket.close(); } catch (e) { /* already closing */ }
          return;
        }

        /* Transcriptions arrive NESTED inside serverContent
           (serverContent.inputTranscription / .outputTranscription) — the
           server does not put them at the top level. Reading only
           msg.inputTranscription therefore found nothing, and every
           transcript was discarded while the model spoke perfectly well.
           Both locations are checked so this keeps working whichever
           shape the server sends. */
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

        /* The user started talking over the reply — drop everything the
           model queued up and commit the partials so the transcript
           reads like a real conversation. */
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
          /* Deliberately does NOT reset playback.
             The model synthesises faster than audio can be played — one
             measured reply delivered 41.8s of audio in 13.8s — so when
             turnComplete arrives there is typically far more queued than
             has been heard. Clearing the queue here threw that away and
             cut the reply off after the first few seconds. Finishing the
             turn only ends the model's turn bookkeeping; the buffer is
             left to play out. */
          modelHeard = false;
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
        /* Read before clearing: this is what distinguishes "the server
           refused the session" from "a live call dropped". */
        const wasReady = ready;
        ready = false;
        lastClose = { code: ev ? ev.code : null, reason: ev ? ev.reason : "" };
        commitUser();
        commitModel();
        resetPlayback();

        /* Closed before the handshake finished. That is not a flaky
           network — the server did not accept the session — so retrying
           the identical config four times only wastes ten seconds. Try
           the minimal form once, then stop. */
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
        /* A token is single-use, so a reconnect always needs a fresh one. */
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
        try { ws.close(); } catch (e) { /* already closing */ }
        ws = null;
      }
      if (capture) {
        try {
          if (capture.port) capture.port.onmessage = null;
          if (capture.onaudioprocess) capture.onaudioprocess = null;
          capture.disconnect();
        } catch (e) { /* already detached */ }
        capture = null;
      }
      if (source) { try { source.disconnect(); } catch (e) {} source = null; }
      if (sink) { try { sink.disconnect(); } catch (e) {} sink = null; }
      if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
      if (ctx) { ctx.close().catch(() => {}); ctx = null; }
      levelSum = 0;
      levelSamples = 0;
    }

    return {
      async start(handlers) {
        api = handlers;
        stopped = false;
        muted = false;
        userBuf = "";
        modelBuf = "";
        attempts = 0;
        /* Fresh call, fresh turn state — otherwise a previous hangover
           would suppress the first activityStart. */
        speakingNow = false;
        if (vadHang) { clearTimeout(vadHang); vadHang = null; }
        api.onState("connecting");
        try {
          await openMic();
        } catch (e) {
          /* Almost always a denied or missing microphone. */
          return fail("Microphone unavailable. Allow access and try again.", String(e));
        }
        if (stopped) return;
        connect();
      },
      setMuted(v) {
        muted = !!v;
        /* Keep the capture running so unmuting is instant; just stop
           putting the microphone on the wire. */
        if (muted && ctx) resetPlayback();
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
  /* ── Global exports ───────────────────────────────────────────
     Required because the sidebar button uses an inline onclick. */
  window.startLiveVoice = startLiveVoice;
  window.startLiveSession = startLiveSession;
  window.endLiveVoice = endLiveVoice;
  window.toggleLiveMute = toggleLiveMute;

  /* ── Lifecycle hooks ─────────────────────────────────────── */

  window.addEventListener("beforeunload", function () {
    if (LV.active && LV.transport && typeof LV.transport.stop === "function") {
      LV.transport.stop();
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

  /* Tear the live session down without saving — used when the user
     navigates away (New Chat, opening another conversation). Without
     this the mic and socket would stay open behind a screen the user
     has already left. */
  function leaveLive() {
    if (!LV.active) return;
    if (LV.transport && typeof LV.transport.stop === "function") LV.transport.stop();
    LV.starting = false;
    stopTimer();
    exitLiveView();
    setPhase("blank");
    setConn("idle");
  }

  /* Prime the quick-action measurement while the welcome screen still
     has layout. Once a conversation is open it is display:none and
     reports a height of 0, so this is the only reliable moment. */
  function primeWelcomeReserve() {
    try {
      welcomeReserve();
    } catch (e) {
      /* non-fatal: the fallback keeps the greeting close enough */
    }
  }
  primeWelcomeReserve();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", primeWelcomeReserve, { once: true });
  }

  /* aichat.js exposes these on window for the inline onclick handlers
     (aichat.js:9760, :9771). Wrapping them means clicking New Chat or
     switching conversations always releases the live session first, and
     lets a stored live conversation reopen into the live UI. */
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
      /* non-fatal: the interval guard below still covers teardown */
    }
  }

  /* Live conversations reopen into the live screen, not the text
     transcript, so the user can pick the call back up. This must run
     INSTEAD of the normal loader — letting it through first would
     render the live chat as text and then swap, which flashes. */
  /* Leaving the live screen for the normal chat. Without this the live
     view is hidden in a single frame, so switching from a live chat to
     New Chat snaps where every other switch blurs. Mirrors the shape of
     blurSwapToLive: blur the live view out over 150ms, swap at the
     midpoint, and let the incoming chat blur back in. */
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
      /* Pre-blur the incoming chat before the swap renders it, so it
         arrives blurred and eases clear. The release is managed here
         rather than left to the loader's animateChatSwitch: that only
         runs when messages were already on screen, so from a live chat
         nothing would ever remove the class and the whole chat would
         stay blurred. */
      if (chat) {
        chat.classList.add("is-switching");
        void chat.offsetWidth;
      }
      const release = function () {
        if (chat) chat.classList.remove("is-switching");
        clearTimeout(LV._leaveGuard);
        LV._leaveGuard = null;
      };
      /* Failsafe: whatever happens, the chat must not be left blurred. */
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
        /* Only tear the screen down when we are NOT already on it.
           Tearing it down here would hide the outgoing view before the
           blur starts (so there is nothing to blur) and let the
           first-entry fade-in restart, which reads as a transform
           animation instead of the blur swap text chat uses. */
        if (!LV.active) leaveLive();
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
      /* non-fatal: the interval guard still covers teardown */
    }
  }

  /* Deleting the conversation that is open sends the user to a new chat,
     which showWelcome() handles for the text view only. Live was left
     out, so deleting an open live chat left its transcript on screen —
     a conversation that no longer exists anywhere. Same reason
     clearAllChats is handled below. */
  const _origDeleteConvConfirm = window.deleteConvConfirm;
  if (
    typeof _origDeleteConvConfirm === "function" &&
    !_origDeleteConvConfirm.__lvWrapped
  ) {
    const wrappedDelete = function (id) {
      /* Decided before the original runs: it nulls state.convId as part of
         deleting, so checking afterwards could never tell whether the
         open conversation was the one removed. */
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
      /* Tear the call down first — its conversation is about to vanish
         from storage, so the turn buffers and resumption handle keyed to
         it would be orphaned. */
      leaveLive();
      _origDeleteConvConfirm.apply(self, args);
      /* Reopen the live screen blank, so deleting an open live chat
         lands on a new live chat the way it lands on a new chat in text. */
      startLiveVoice();
    };
    wrappedDelete.__lvWrapped = true;
    try {
      window.deleteConvConfirm = wrappedDelete;
    } catch (e) {
      /* non-fatal: the interval guard below still covers teardown */
    }
  }

  /* "Clear all chats" wipes every stored conversation, live ones
     included, and showWelcome() only resets the text-chat DOM. Left
     alone that leaves a live call on screen showing a transcript whose
     conversation no longer exists in Recents — so clearing while a live
     chat is open resets to a fresh blank live chat, the same way
     clearing from inside a text chat lands on a new chat. */
  const _origClearAllChats = window.clearAllChats;
  if (typeof _origClearAllChats === "function" && !_origClearAllChats.__lvWrapped) {
    const wrappedClear = function () {
      const args = arguments;
      const self = this;
      if (!LV.active) {
        _origClearAllChats.apply(self, args);
        return;
      }
      /* Tear the call down first: the conversation it is bound to is
         about to disappear from storage, so any state keyed to it (the
         resumption handle, the turn buffers) would be orphaned. */
      leaveLive();
      _origClearAllChats.apply(self, args);
      /* Reopen the live screen in its blank state so the user lands on
         a new live chat rather than the text welcome screen they can no
         longer return to. */
      startLiveVoice();
    };
    wrappedClear.__lvWrapped = true;
    try {
      window.clearAllChats = wrappedClear;
    } catch (e) {
      /* non-fatal: the interval guard below still covers teardown */
    }
  }

  /* Safety net for any other path that drops the live-active class. */
  const guard = setInterval(function () {
    const main = el("chatMain");
    if (main && !main.classList.contains("live-active")) leaveLive();
  }, 700);
  window.addEventListener("pagehide", function () {
    clearInterval(guard);
  });

  window.__LV = LV;
  window.__leaveLive = leaveLive;
})();