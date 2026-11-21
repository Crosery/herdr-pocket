// Floating dictation & Xiaoyang capsule controller (voice-hud.html): no inline JS so CSP stays strict.
(function () {
  var MIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>';
  var SPARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.1 6.3L20.5 10l-6.4 1.7L12 18l-2.1-6.3L3.5 10l6.4-1.7L12 2zm7 13l1.1 3.1L23 19l-2.9.9L19 23l-1.1-3.1L15 19l2.9-.9L19 15z"/></svg>';
  var CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
  var BANG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 7h2v7h-2zm0 9h2v2h-2z"/></svg>';
  var CROSS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z"/></svg>';
  var N = 12;
  var CENTER = (N - 1) / 2;
  var $ = function (id) { return document.getElementById(id); };
  var hud = $("hud");
  var compactRow = $("compactRow");
  var dot = $("dot");
  var bars = $("bars");
  var title = $("title");
  var sub = $("sub");
  var dspBadge = $("dspBadge");
  var modeSwitch = $("modeSwitch");
  var btnModeDictate = $("btnModeDictate");
  var btnModeAssistant = $("btnModeAssistant");
  var time = $("time");
  var actions = $("actions");
  var btnCancel = $("btnCancel");
  var btnStop = $("btnStop");
  var progress = $("progress");
  var replyWrap = $("replyWrap");
  var replyOrb = $("replyOrb");
  var replyTitle = $("replyTitle");
  var replyDspBadge = $("replyDspBadge");
  var replyQuestion = $("replyQuestion");
  var replyAnswer = $("replyAnswer");
  var btnOpenAssistant = $("btnOpenAssistant");
  var btnDismiss = $("btnDismiss");

  var inTauri = typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

  for (var i = 0; i < N; i++) bars.appendChild(document.createElement("i"));
  btnCancel.innerHTML = CROSS;
  btnStop.innerHTML = CHECK;
  btnDismiss.innerHTML = CROSS;
  replyOrb.innerHTML = SPARK;

  var history = [];
  var last = "";
  var currentMode = "dictate";
  var latestState = null;
  var sounds = false;
  var audio = null;
  var phaseTick = 0;
  var hasExternalUpdate = false;

  function preventStealFocus(el) {
    if (!el) return;
    el.addEventListener("mousedown", function (e) { e.preventDefault(); });
  }
  [btnModeDictate, btnModeAssistant, btnCancel, btnStop, btnOpenAssistant, btnDismiss].forEach(preventStealFocus);

  function dispatchHudAction(url, localFallback) {
    window.__lastHudAction = url;
    if (inTauri) {
      window.location.href = url;
      return;
    }
    if (typeof localFallback === "function") localFallback();
  }

  function applyModeToUi(nextMode) {
    currentMode = nextMode === "assistant" ? "assistant" : "dictate";
    btnModeDictate.classList.toggle("active", currentMode === "dictate");
    btnModeAssistant.classList.toggle("active", currentMode === "assistant");
    btnModeDictate.setAttribute("aria-pressed", String(currentMode === "dictate"));
    btnModeAssistant.setAttribute("aria-pressed", String(currentMode === "assistant"));
    btnStop.title = currentMode === "assistant" ? "完成并问小羊" : "完成并填入";
    btnStop.setAttribute("aria-label", btnStop.title);
    hud.classList.toggle("mode-assistant", currentMode === "assistant");
    if (last === "recording") {
      dot.innerHTML = currentMode === "assistant" ? SPARK : MIC;
      title.textContent = currentMode === "assistant" ? "正在问小羊" : "正在听";
    }
  }

  btnModeDictate.addEventListener("click", function () {
    applyModeToUi("dictate");
    dispatchHudAction("pocket-hud://mode/dictate", function () {
      if (latestState) window.__hud(Object.assign({}, latestState, { mode: "dictate" }));
    });
  });

  btnModeAssistant.addEventListener("click", function () {
    applyModeToUi("assistant");
    dispatchHudAction("pocket-hud://mode/assistant", function () {
      if (latestState) window.__hud(Object.assign({}, latestState, { mode: "assistant" }));
    });
  });

  btnCancel.addEventListener("click", function () {
    dispatchHudAction("pocket-hud://cancel", function () {
      window.__hud({ state: "cancelled" });
    });
  });

  btnStop.addEventListener("click", function () {
    dispatchHudAction("pocket-hud://stop", function () {
      var activeMode = currentMode;
      window.__hud({ state: "transcribing", mode: activeMode, dspBadge: latestState && latestState.dspBadge });
      window.setTimeout(function () {
        if (activeMode === "assistant") {
          window.__hud({
            state: "assistant_reply",
            mode: "assistant",
            question: "当前任务有什么阻塞点？",
            answer: "目前有 1 个 Agent 等待确认迁移策略，其余分支测试已全部通过。点击右上角「打开小羊」可继续多轮追问。",
            dspBadge: latestState && latestState.dspBadge,
          });
        } else {
          window.__hud({
            state: "done",
            label: "已填入输入框",
            chars: 18,
            dspBadge: latestState && latestState.dspBadge,
          });
        }
      }, 650);
    });
  });

  btnDismiss.addEventListener("click", function () {
    dispatchHudAction("pocket-hud://dismiss", function () {
      window.__hud({ state: "hidden" });
    });
  });

  btnOpenAssistant.addEventListener("click", function () {
    dispatchHudAction("pocket-hud://open-assistant", function () {
      window.__hud({ state: "done", label: "已切换到小羊面板" });
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

  function clock(ms) {
    var s = Math.floor((ms || 0) / 1000);
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  function meter(level) {
    var raw = Math.max(0, Math.min(1, Number(level) || 0));
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
      var ripple = 0.06 * (Math.sin(phaseTick + j * 0.7) + 1);
      var px = Math.round(4 + (val * 16 + ripple * (val > 0.05 ? 5 : 1.5)) * envelope);
      kids[j].style.height = Math.max(4, Math.min(22, px)) + "px";
      kids[j].style.opacity = String(0.45 + 0.55 * Math.min(1, val * 1.4));
    }
  }

  function setDspPill(el, text) {
    var clean = typeof text === "string" ? text.trim() : "";
    el.textContent = clean;
    el.hidden = !clean;
    return Boolean(clean);
  }

  function renderHud(s) {
    if (!s || typeof s !== "object") return;
    latestState = s;
    if (typeof s.sounds === "boolean") sounds = s.sounds;
    var kind = s.state;
    var nextMode = s.mode === "assistant" ? "assistant" : s.mode === "dictate" ? "dictate" : currentMode;
    currentMode = nextMode;

    var hasDsp = typeof s.dspBadge === "string" && s.dspBadge.trim().length > 0;
    hud.className = "hud on " + kind + (nextMode === "assistant" ? " mode-assistant" : "") + (hasDsp ? " has-dsp" : "");

    if (kind === "assistant_reply") {
      compactRow.hidden = true;
      replyWrap.hidden = false;
      progress.style.width = "0%";
      replyTitle.textContent = s.error ? "小羊暂时无法回答" : "小羊回复";
      setDspPill(replyDspBadge, s.dspBadge);
      var q = typeof s.question === "string" ? s.question.trim() : "";
      replyQuestion.textContent = q ? "问：" + q : "";
      replyQuestion.hidden = !q;
      replyAnswer.textContent = typeof s.answer === "string" && s.answer.trim() ? s.answer.trim() : "已完成回复";
      replyAnswer.classList.toggle("is-error", Boolean(s.error));
      if (last !== "assistant_reply") tone([784, 1046], 95, 0.045);
      delete hud.dataset.max;
      last = kind;
      return;
    }

    compactRow.hidden = false;
    replyWrap.hidden = true;
    setDspPill(dspBadge, s.dspBadge);
    applyModeToUi(nextMode);

    if (kind === "recording") {
      if (last !== "recording") {
        history = [];
        sub.textContent = "";
        tone([660, 880], 100, 0.05);
      }
      dot.innerHTML = currentMode === "assistant" ? SPARK : MIC;
      title.textContent = currentMode === "assistant" ? "正在问小羊" : "正在听";
      if (typeof s.hint === "string") sub.textContent = s.hint;
      else if (!sub.textContent) sub.textContent = currentMode === "assistant" ? "说完点完成向小羊提问" : "松开结束，Esc 取消";
      sub.hidden = !sub.textContent;
      modeSwitch.hidden = false;
      bars.hidden = false;
      actions.hidden = false;
      time.hidden = false;
      meter(s.level);
      if (s.maxSeconds) hud.dataset.max = String(s.maxSeconds);
      var maxSec = Number(hud.dataset.max || s.maxSeconds || 0);
      var elapsed = Number(s.elapsedMs || 0);
      var left = maxSec > 0 ? maxSec * 1000 - elapsed : Infinity;
      time.textContent = left < 10000 ? Math.max(0, Math.ceil(left / 1000)) + "s" : clock(elapsed);
      if (maxSec > 0) {
        progress.style.width = Math.min(100, Math.max(0, (elapsed / (maxSec * 1000)) * 100)) + "%";
      }
    } else if (kind === "transcribing") {
      dot.innerHTML = '<div class="spin"></div>';
      title.textContent = s.label || (currentMode === "assistant" ? "正在问小羊…" : "正在整理识别…");
      sub.textContent = typeof s.hint === "string" ? s.hint : "";
      sub.hidden = !sub.textContent;
      modeSwitch.hidden = true;
      bars.hidden = true;
      actions.hidden = true;
      time.hidden = true;
      progress.style.width = "0%";
      if (last === "recording") tone([880, 660], 85, 0.045);
    } else if (kind === "done") {
      dot.innerHTML = CHECK;
      title.textContent = s.label || "已输入";
      sub.textContent = s.note || "";
      sub.hidden = !s.note;
      modeSwitch.hidden = true;
      bars.hidden = true;
      actions.hidden = true;
      time.hidden = true;
      progress.style.width = "0%";
      tone([988], 110, 0.045);
    } else if (kind === "error") {
      dot.innerHTML = BANG;
      title.textContent = s.message || "语音输入出错了";
      sub.textContent = "";
      sub.hidden = true;
      modeSwitch.hidden = true;
      bars.hidden = true;
      actions.hidden = true;
      time.hidden = true;
      progress.style.width = "0%";
      tone([330, 247], 130, 0.055);
    } else if (kind === "cancelled") {
      dot.innerHTML = CROSS;
      title.textContent = "已取消";
      sub.textContent = "";
      sub.hidden = true;
      modeSwitch.hidden = true;
      bars.hidden = true;
      actions.hidden = true;
      time.hidden = true;
      progress.style.width = "0%";
    } else {
      hud.classList.remove("on");
    }
    if (kind !== "recording") delete hud.dataset.max;
    last = kind;
  }

  window.__hud = function (s) {
    hasExternalUpdate = true;
    renderHud(s);
  };

  dot.innerHTML = MIC;

  if (!inTauri) {
    document.body.classList.add("standalone-qa");
    window.requestAnimationFrame(function () {
      if (hasExternalUpdate) return;
      var params = new URLSearchParams(window.location.search || "");
      var qaState = params.get("state") || "recording";
      var qaMode = params.get("mode") || (qaState === "assistant_reply" ? "assistant" : "dictate");
      var qaDsp = params.get("dsp") || "降噪 · 声纹";
      if (qaState === "assistant_reply") {
        renderHud({
          state: "assistant_reply",
          mode: "assistant",
          question: "帮我看下当前分支打包状态",
          answer: "所有构建校验已通过，当前有 1 个代理在等待确认部署步骤，点击「打开小羊」可继续对话。",
          dspBadge: qaDsp,
        });
      } else if (qaState === "transcribing" || qaState === "done" || qaState === "error" || qaState === "cancelled") {
        renderHud({
          state: qaState,
          mode: qaMode,
          label: "已填入输入框",
          message: "还没有连接中转服务",
          dspBadge: qaDsp,
        });
      } else {
        renderHud({
          state: "recording",
          mode: qaMode,
          level: 0.56,
          elapsedMs: 3200,
          maxSeconds: 60,
          hint: "松开结束，Esc 取消",
          dspBadge: qaDsp,
        });
      }
    });
  }
})();
