// Floating dictation capsule controller (voice-hud.html): no inline JS so CSP stays strict.
(function () {
  var MIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>';
  var CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
  var BANG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 7h2v7h-2zm0 9h2v2h-2z"/></svg>';
  var CROSS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z"/></svg>';
  var N = 16;
  var CENTER = (N - 1) / 2;
  var $ = function (id) { return document.getElementById(id); };
  var hud = $("hud"), dot = $("dot"), bars = $("bars"), title = $("title"), sub = $("sub");
  var time = $("time"), actions = $("actions"), btnCancel = $("btnCancel"), btnStop = $("btnStop"), progress = $("progress");

  for (var i = 0; i < N; i++) bars.appendChild(document.createElement("i"));
  btnCancel.innerHTML = CROSS;
  btnStop.innerHTML = CHECK;

  btnCancel.addEventListener("click", function () {
    window.location.href = "pocket-hud://cancel";
  });
  btnStop.addEventListener("click", function () {
    window.location.href = "pocket-hud://stop";
  });

  var history = [];
  var last = "";
  var sounds = false;
  var audio = null;
  var phaseTick = 0;

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
      var px = Math.round(4 + (val * 19 + ripple * (val > 0.05 ? 6 : 1.5)) * envelope);
      kids[j].style.height = Math.max(4, Math.min(25, px)) + "px";
      kids[j].style.opacity = String(0.42 + 0.58 * Math.min(1, val * 1.4));
    }
  }

  window.__hud = function (s) {
    if (!s || typeof s !== "object") return;
    if (typeof s.sounds === "boolean") sounds = s.sounds;
    var kind = s.state;
    hud.className = "hud on " + kind;
    if (kind === "recording") {
      if (last !== "recording") {
        history = [];
        dot.innerHTML = MIC;
        title.textContent = "正在听";
        tone([660, 880], 100, 0.05);
      }
      if (typeof s.hint === "string") sub.textContent = s.hint;
      sub.hidden = !sub.textContent;
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
      title.textContent = "正在整理识别…";
      sub.textContent = "";
      sub.hidden = true;
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
      bars.hidden = true;
      actions.hidden = true;
      time.hidden = true;
      progress.style.width = "0%";
      tone([988], 110, 0.045);
    } else if (kind === "error") {
      dot.innerHTML = BANG;
      title.textContent = s.message || "语音输入出错了";
      sub.hidden = true;
      bars.hidden = true;
      actions.hidden = true;
      time.hidden = true;
      progress.style.width = "0%";
      tone([330, 247], 130, 0.055);
    } else if (kind === "cancelled") {
      dot.innerHTML = CROSS;
      title.textContent = "已取消";
      sub.hidden = true;
      bars.hidden = true;
      actions.hidden = true;
      time.hidden = true;
      progress.style.width = "0%";
    } else {
      hud.classList.remove("on");
    }
    if (kind !== "recording") delete hud.dataset.max;
    last = kind;
  };
  dot.innerHTML = MIC;
})();
