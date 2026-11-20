// The dictation HUD's script (voice-hud.html): no inline script, so the app's CSP can stay strict.
(function () {
  var MIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>';
  var CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
  var BANG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 7h2v7h-2zm0 9h2v2h-2z"/></svg>';
  var CROSS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z"/></svg>';
  var N = 9;
  var $ = function (id) { return document.getElementById(id); };
  var hud = $("hud"), dot = $("dot"), bars = $("bars"), title = $("title"), sub = $("sub"), time = $("time");
  for (var i = 0; i < N; i++) bars.appendChild(document.createElement("i"));
  var history = [];
  var last = "";
  var sounds = false;
  var audio = null;

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
    } catch (e) { /* no audio output: stay silent */ }
  }

  function clock(ms) {
    var s = Math.floor((ms || 0) / 1000);
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  function meter(level) {
    var v = Math.max(0, Math.min(1, Number(level) || 0));
    history.push(Math.sqrt(v));
    if (history.length > N) history.shift();
    var kids = bars.children;
    for (var j = 0; j < N; j++) {
      var h = history[j] === undefined ? 0 : history[j];
      kids[j].style.height = Math.round(4 + h * 20) + "px";
    }
  }

  function show(on) { hud.classList.toggle("on", on); }

  window.__hud = function (s) {
    if (!s || typeof s !== "object") return;
    if (typeof s.sounds === "boolean") sounds = s.sounds;
    var kind = s.state;
    hud.className = "hud on " + kind;
    if (kind === "recording") {
      if (last !== "recording") {
        history = [];
        dot.innerHTML = MIC;
        title.textContent = "正在听…";
        tone([660, 880], 110, 0.06);
      }
      if (s.hint) { sub.textContent = s.hint; }
      sub.hidden = !sub.textContent;
      bars.hidden = false;
      meter(s.level);
      time.hidden = false;
      var left = s.maxSeconds ? s.maxSeconds * 1000 - (s.elapsedMs || 0) : Infinity;
      time.textContent = left < 10000 ? "还剩 " + Math.max(0, Math.ceil(left / 1000)) + " 秒" : clock(s.elapsedMs);
      if (s.maxSeconds) hud.dataset.max = String(s.maxSeconds);
    } else if (kind === "transcribing") {
      dot.innerHTML = '<div class="spin"></div>';
      title.textContent = "正在识别…";
      sub.textContent = "";
      sub.hidden = true;
      bars.hidden = true;
      time.hidden = true;
      if (last === "recording") tone([880, 660], 90, 0.05);
    } else if (kind === "done") {
      dot.innerHTML = CHECK;
      title.textContent = s.label || "已输入";
      sub.textContent = s.note || "";
      sub.hidden = !s.note;
      bars.hidden = true;
      time.hidden = true;
      tone([988], 120, 0.05);
    } else if (kind === "error") {
      dot.innerHTML = BANG;
      title.textContent = s.message || "语音输入出错了";
      sub.hidden = true;
      bars.hidden = true;
      time.hidden = true;
      tone([330, 247], 140, 0.06);
    } else if (kind === "cancelled") {
      dot.innerHTML = CROSS;
      title.textContent = "已取消";
      sub.hidden = true;
      bars.hidden = true;
      time.hidden = true;
    } else {
      show(false);
    }
    // maxSeconds only comes with the first recording state; keep it for the countdown.
    if (kind === "recording" && !s.maxSeconds && hud.dataset.max) {
      var max = Number(hud.dataset.max) * 1000;
      var rest = max - (s.elapsedMs || 0);
      if (rest < 10000) time.textContent = "还剩 " + Math.max(0, Math.ceil(rest / 1000)) + " 秒";
    }
    if (kind !== "recording") delete hud.dataset.max;
    last = kind;
  };
  dot.innerHTML = MIC;
})();
