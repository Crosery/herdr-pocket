// Floating Xiaoyang realtime voice call capsule controller (voice-hud.html): strict CSP, zero inline JS.
(function () {
  var MIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>';
  var MIC_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>';
  var PHONE_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.996.996 0 0 1 0-1.41C2.86 9.1 7.21 7.5 12 7.5c1.73 0 3.38.24 4.95.67l-1.9 1.9C14.07 9.39 13.05 9 12 9zm9.71 2.67l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.1-.7-.28-.79-.73-1.68-1.36-2.66-1.85a.996.996 0 0 1-.56-.9v-2.06l-9.9 9.9-1.41-1.41L19.9 2.23l1.41 1.41-3.36 3.36c1.45.77 2.73 1.77 3.76 2.96.39.39.39 1.03 0 1.71z"/></svg>';
  var BANG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 7h2v7h-2zm0 9h2v2h-2z"/></svg>';

  var MASCOT_URLS = {
    connecting: "assets/call/connecting.webp",
    idle: "assets/call/idle.webp",
    listening: "assets/call/listening.webp",
    thinking: "assets/call/thinking.webp",
    speaking: "assets/call/speaking.webp",
    muted: "assets/call/muted.webp",
  };
  var ACTIVE_SUB_FACES = { listening: true, thinking: true, speaking: true };
  var FACE_SETTLE_MS = 200;
  var FACE_HOLD_MS = 450;

  var preloadedMascots = [];
  if (typeof Image === "function") {
    Object.keys(MASCOT_URLS).forEach(function (face) {
      var img = new Image();
      img.src = MASCOT_URLS[face];
      preloadedMascots.push(img);
    });
  }

  var N = 12;
  var CENTER = (N - 1) / 2;
  var $ = function (id) { return document.getElementById(id); };
  var hud = $("hud");
  var mascotImg = $("mascotImg");
  var mascotBadge = $("mascotBadge");
  var title = $("title");
  var dspBadge = $("dspBadge");
  var sub = $("sub");
  var bars = $("bars");
  var time = $("time");
  var actions = $("actions");
  var btnMute = $("btnMute");
  var btnHangup = $("btnHangup");

  var inTauri = typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

  for (var i = 0; i < N; i++) bars.appendChild(document.createElement("i"));
  btnMute.innerHTML = MIC;
  btnHangup.innerHTML = PHONE_OFF + "<span>挂断</span>";

  var history = [];
  var lastKind = "";
  var latestState = null;
  var sounds = false;
  var audio = null;
  var phaseTick = 0;
  var hasExternalUpdate = false;
  var clockTimer = null;
  var currentImgFace = "connecting";
  var shownFace = "connecting";
  var faceShownAt = 0;
  var pendingFace = null;
  var faceTimer = null;
  var lastBadgeKey = "";

  function preventStealFocus(el) {
    if (!el) return;
    el.addEventListener("mousedown", function (e) { e.preventDefault(); });
  }
  [btnMute, btnHangup].forEach(preventStealFocus);

  function dispatchHudAction(url, localFallback) {
    window.__lastHudAction = url;
    if (inTauri) {
      window.location.href = url;
      return;
    }
    if (typeof localFallback === "function") localFallback();
  }

  btnMute.addEventListener("click", function () {
    dispatchHudAction("pocket-hud://toggle-mute", function () {
      if (latestState) {
        renderHud(Object.assign({}, latestState, { muted: !latestState.muted }));
      }
    });
  });

  btnHangup.addEventListener("click", function () {
    dispatchHudAction("pocket-hud://hangup", function () {
      renderHud({ state: "hidden" });
    });
  });

  function tone(freqs, ms, gain) {
    if (!sounds) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      var t = audio.currentTime;
      freqs.forEach(function (f, k) {
        var o = audio.createOscillator(), g = audio.createGain();
        o.type = "sine";
        o.frequency.value = f;
        var s = t + k * (ms / 1000) * 0.8;
        g.gain.setValueAtTime(0.0001, s);
        g.gain.exponentialRampToValueAtTime(gain, s + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, s + ms / 1000);
        o.connect(g).connect(audio.destination);
        o.start(s);
        o.stop(s + ms / 1000 + 0.02);
      });
    } catch (e) { /* silent fallback */ }
  }

  function formatClock(startedAt) {
    if (typeof startedAt !== "number" || !isFinite(startedAt)) return "00:00";
    var sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    var m = String(Math.floor(sec / 60)).padStart(2, "0");
    var s = String(sec % 60).padStart(2, "0");
    return m + ":" + s;
  }

  function stopClock() {
    if (clockTimer !== null) {
      window.clearInterval(clockTimer);
      clockTimer = null;
    }
  }

  function syncClock(startedAt, isActive) {
    if (!isActive || typeof startedAt !== "number" || !isFinite(startedAt)) {
      stopClock();
      time.textContent = "00:00";
      return;
    }
    time.textContent = formatClock(startedAt);
    if (clockTimer === null) {
      clockTimer = window.setInterval(function () {
        if (!latestState || latestState.state !== "active") {
          stopClock();
          return;
        }
        time.textContent = formatClock(latestState.startedAt);
      }, 250);
    }
  }

  function meter(level, muted) {
    var raw = muted ? 0 : Math.max(0, Math.min(1, Number(level) || 0));
    var energy = Math.sqrt(raw);
    phaseTick += 0.45;
    history.push(energy);
    if (history.length > N) history.shift();
    var kids = bars.children;
    for (var j = 0; j < N; j++) {
      var distFromCenter = Math.abs(j - CENTER) / CENTER;
      var envelope = 1 - 0.55 * distFromCenter;
      var mirrorIdx = Math.max(0, history.length - 1 - Math.round(Math.abs(j - CENTER)));
      var val = history[mirrorIdx] === undefined ? 0 : history[mirrorIdx];
      var ripple = muted ? 0 : 0.06 * (Math.sin(phaseTick + j * 0.7) + 1);
      var px = muted ? 4 : Math.round(4 + (val * 16 + ripple * (val > 0.05 ? 5 : 1.5)) * envelope);
      kids[j].style.height = Math.max(4, Math.min(22, px)) + "px";
      kids[j].style.opacity = muted ? "0.35" : String(0.45 + 0.55 * Math.min(1, val * 1.4));
    }
  }

  function setDspPill(text) {
    var clean = typeof text === "string" ? text.trim() : "";
    dspBadge.textContent = clean;
    dspBadge.hidden = !clean;
  }

  function resolveTitle(kind, phase, muted) {
    if (kind === "connecting") return "正在接通小羊…";
    if (muted && phase !== "speaking") return "麦克风已静音";
    if (phase === "speaking") return "小羊正在说…";
    if (phase === "thinking") return "小羊在想…";
    return "和小羊通话中";
  }

  function resolveSub(s, kind) {
    var task = typeof s.task === "string" ? s.task.trim() : "";
    if (task) return "正在处理：" + task;
    var caption = typeof s.caption === "string" ? s.caption.trim() : "";
    if (caption) return caption;
    if (kind === "connecting") return "正在建立实时语音连接";
    return "直接说话即可 · 再按快捷键挂断";
  }

  function resolveMascotFace(kind, phase, muted) {
    if (kind === "connecting") return "connecting";
    if (kind === "error") return "idle";
    if (muted && phase !== "speaking") return "muted";
    if (phase === "speaking") return "speaking";
    if (phase === "thinking") return "thinking";
    return "listening";
  }

  function clearFaceTimer() {
    if (faceTimer !== null) {
      window.clearTimeout(faceTimer);
      faceTimer = null;
    }
    pendingFace = null;
  }

  function applyMascotFace(face) {
    shownFace = face;
    faceShownAt = Date.now();
    if (currentImgFace !== face) {
      currentImgFace = face;
      mascotImg.src = MASCOT_URLS[face] || MASCOT_URLS.listening;
    }
  }

  function syncMascotFace(targetFace, immediate) {
    if (immediate || !ACTIVE_SUB_FACES[shownFace] || !ACTIVE_SUB_FACES[targetFace]) {
      clearFaceTimer();
      applyMascotFace(targetFace);
      return;
    }
    if (targetFace === shownFace) {
      clearFaceTimer();
      return;
    }
    if (pendingFace === targetFace && faceTimer !== null) {
      return;
    }
    clearFaceTimer();
    pendingFace = targetFace;
    var wait = Math.max(FACE_SETTLE_MS, FACE_HOLD_MS - (Date.now() - faceShownAt));
    faceTimer = window.setTimeout(function () {
      faceTimer = null;
      var next = pendingFace;
      pendingFace = null;
      if (next) applyMascotFace(next);
    }, wait);
  }

  function applyMascotBadge(kind, muted) {
    var badgeKey = kind === "connecting" ? "connecting" : kind === "error" ? "error" : muted ? "muted" : "none";
    if (badgeKey === lastBadgeKey) return;
    lastBadgeKey = badgeKey;
    if (badgeKey === "connecting") {
      mascotBadge.className = "mascot-badge is-connecting";
      mascotBadge.innerHTML = '<div class="spin"></div>';
      mascotBadge.hidden = false;
    } else if (badgeKey === "error") {
      mascotBadge.className = "mascot-badge is-error";
      mascotBadge.innerHTML = BANG;
      mascotBadge.hidden = false;
    } else if (badgeKey === "muted") {
      mascotBadge.className = "mascot-badge is-muted";
      mascotBadge.innerHTML = MIC_OFF;
      mascotBadge.hidden = false;
    } else {
      mascotBadge.className = "mascot-badge";
      mascotBadge.innerHTML = "";
      mascotBadge.hidden = true;
    }
  }

  function applyMuteButton(muted) {
    btnMute.innerHTML = muted ? MIC_OFF : MIC;
    btnMute.classList.toggle("is-muted", Boolean(muted));
    btnMute.title = muted ? "取消静音" : "静音";
    btnMute.setAttribute("aria-label", btnMute.title);
    btnMute.setAttribute("aria-pressed", String(Boolean(muted)));
  }

  function renderHud(s) {
    if (!s || typeof s !== "object") return;
    latestState = s;
    if (typeof s.sounds === "boolean") sounds = s.sounds;
    var kind = s.state;

    if (kind === "hidden" || !kind) {
      stopClock();
      clearFaceTimer();
      history = [];
      hud.className = "hud";
      lastKind = "hidden";
      return;
    }

    if (kind === "error") {
      stopClock();
      history = [];
      hud.className = "hud on error";
      syncMascotFace("idle", true);
      applyMascotBadge("error", false);
      title.textContent = s.message || "无法接通小羊语音";
      setDspPill("");
      sub.textContent = "";
      sub.hidden = true;
      bars.hidden = true;
      time.hidden = true;
      actions.hidden = true;
      if (lastKind !== "error") tone([330, 247], 130, 0.05);
      lastKind = "error";
      return;
    }

    var isConnecting = kind === "connecting";
    var phase = s.phase === "speaking" ? "speaking" : s.phase === "thinking" ? "thinking" : "idle";
    var muted = Boolean(s.muted);
    var resolvedKind = isConnecting ? "connecting" : "active";

    hud.className =
      "hud on " +
      resolvedKind +
      " phase-" + phase +
      (muted ? " is-muted" : "");

    syncMascotFace(resolveMascotFace(resolvedKind, phase, muted), isConnecting || lastKind !== "active");
    applyMascotBadge(resolvedKind, muted);
    title.textContent = resolveTitle(resolvedKind, phase, muted);
    setDspPill(s.dspBadge);
    sub.textContent = resolveSub(s, resolvedKind);
    sub.hidden = !sub.textContent;
    bars.hidden = false;
    time.hidden = false;
    actions.hidden = false;
    applyMuteButton(muted);

    if (isConnecting) {
      if (lastKind !== "connecting" && lastKind !== "active") {
        history = [];
        tone([587, 784], 80, 0.04);
      }
      meter(typeof s.level === "number" ? s.level : 0.14, muted);
      syncClock(null, false);
    } else {
      if (lastKind !== "active" && lastKind !== "connecting") {
        history = [];
        tone([660, 880], 85, 0.045);
      }
      meter(s.level, muted);
      syncClock(s.startedAt, true);
    }

    lastKind = resolvedKind;
  }

  window.__hud = function (s) {
    hasExternalUpdate = true;
    renderHud(s);
  };

  if (!inTauri) {
    document.body.classList.add("standalone-qa");
    var params = new URLSearchParams(window.location.search || "");
    var qaTheme = params.get("theme");
    if (qaTheme === "dark" || qaTheme === "light") {
      document.documentElement.setAttribute("data-theme", qaTheme);
    }
    window.requestAnimationFrame(function () {
      if (hasExternalUpdate) return;
      var qaState = params.get("state") || "active";
      var qaDsp = params.get("dsp") !== null ? params.get("dsp") : "降噪 · 声纹";
      if (qaState === "connecting") {
        renderHud({
          state: "connecting",
          dspBadge: qaDsp,
          muted: false,
        });
      } else if (qaState === "error") {
        renderHud({
          state: "error",
          message: "请在弹出的窗口里允许使用麦克风，然后再按一次",
        });
      } else if (qaState === "speaking") {
        renderHud({
          state: "active",
          phase: "speaking",
          muted: false,
          level: 0.72,
          startedAt: Date.now() - 42000,
          caption: "小羊：buildbox 的构建已经完成，正在跑最后一项检查。",
          dspBadge: qaDsp,
        });
      } else if (qaState === "thinking") {
        renderHud({
          state: "active",
          phase: "thinking",
          muted: false,
          level: 0.12,
          startedAt: Date.now() - 18000,
          task: "查看各设备最新终端状态",
          dspBadge: qaDsp,
        });
      } else if (qaState === "muted") {
        renderHud({
          state: "active",
          phase: "idle",
          muted: true,
          level: 0,
          startedAt: Date.now() - 65000,
          dspBadge: qaDsp,
        });
      } else {
        renderHud({
          state: "active",
          phase: "idle",
          muted: false,
          level: 0.48,
          startedAt: Date.now() - 12000,
          dspBadge: qaDsp,
        });
      }
    });
  }
})();
