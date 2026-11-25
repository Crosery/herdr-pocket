// Side-by-side macOS permission drag companion controller (perm-companion.html): strict CSP, zero inline JS.
(function () {
  var ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  var ICON_ARROW_LEFT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5m6 6-6-6 6-6"/></svg>';
  var ICON_ARROW_RIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>';
  var ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  var $ = function (id) { return document.getElementById(id); };
  var panel = $("panel");
  var titleEl = $("title");
  var pillEl = $("pill");
  var hintEl = $("hint");
  var dragChip = $("dragChip");
  var bundlePathEl = $("bundlePath");
  var dragTagEl = $("dragTag");
  var btnClose = $("btnClose");
  var btnFinder = $("btnFinder");
  var btnReset = $("btnReset");
  var btnRelaunch = $("btnRelaunch");

  var inTauri = typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
  btnClose.innerHTML = ICON_CLOSE;

  function dispatchAction(action) {
    var url = "pocket-perm://" + action;
    window.__lastPermAction = url;
    if (inTauri) {
      window.location.href = url;
    }
  }

  function applyTheme(theme) {
    if (theme === "light" || theme === "dark") {
      document.documentElement.setAttribute("data-theme", theme);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }

  function render(state) {
    var s = state && typeof state === "object" ? state : {};
    var granted = Boolean(s.granted);
    var arrowDir = s.arrowDir === "right" ? "right" : "left";
    var title = typeof s.title === "string" && s.title ? s.title : "系统权限";
    applyTheme(s.theme);

    titleEl.textContent = title;
    panel.classList.toggle("granted", granted);
    pillEl.textContent = granted ? "已开启" : "待开启";

    if (granted) {
      hintEl.innerHTML = ICON_CHECK + "<span>已开启，正在自动返回…</span>";
      dragTagEl.textContent = "已就绪";
    } else if (arrowDir === "right") {
      hintEl.innerHTML = "<span>开启开关，或将下方应用拖进右侧列表</span>" + ICON_ARROW_RIGHT;
      dragTagEl.textContent = "按住向右拖";
    } else {
      hintEl.innerHTML = ICON_ARROW_LEFT + "<span>开启开关，或将下方应用拖进左侧列表</span>";
      dragTagEl.textContent = "按住向左拖";
    }

    bundlePathEl.textContent =
      typeof s.bundlePath === "string" && s.bundlePath ? s.bundlePath : "/Applications/Herdr Pocket.app";
    btnReset.hidden = granted || !s.canReset;
    btnRelaunch.hidden = !s.needsRelaunch;
  }

  window.__permCompanion = render;

  var pressOrigin = null;
  var dragStarted = false;
  function resetDrag() {
    pressOrigin = null;
    dragStarted = false;
    dragChip.classList.remove("dragging");
  }

  dragChip.addEventListener("pointerdown", function (e) {
    if (e.button !== 0) return;
    e.preventDefault();
    pressOrigin = { x: e.clientX, y: e.clientY };
    dragStarted = false;
    dragChip.classList.add("dragging");
  });

  dragChip.addEventListener("pointermove", function (e) {
    if (!pressOrigin || dragStarted) return;
    if ((e.buttons & 1) === 0) {
      resetDrag();
      return;
    }
    if (Math.hypot(e.clientX - pressOrigin.x, e.clientY - pressOrigin.y) >= 3) {
      dragStarted = true;
      dispatchAction("start-drag");
    }
  });

  dragChip.addEventListener("pointerup", resetDrag);
  dragChip.addEventListener("pointercancel", resetDrag);
  dragChip.addEventListener("blur", resetDrag);
  dragChip.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      dispatchAction("reveal-finder");
    }
  });

  btnClose.addEventListener("click", function () { dispatchAction("close"); });
  btnFinder.addEventListener("click", function () { dispatchAction("reveal-finder"); });
  btnReset.addEventListener("click", function () { dispatchAction("reset-cache"); });
  btnRelaunch.addEventListener("click", function () { dispatchAction("relaunch"); });

  try {
    var q = new URLSearchParams(window.location.search);
    if (q.get("qa") === "1" || q.get("title") || q.get("granted") || q.get("arrowDir") || q.get("theme")) {
      render({
        kind: q.get("kind") || "screenRecording",
        title: q.get("title") || "屏幕录制",
        arrowDir: q.get("arrowDir") || "left",
        granted: q.get("granted") === "1",
        canReset: q.get("canReset") !== "0",
        needsRelaunch: q.get("needsRelaunch") === "1",
        theme: q.get("theme") || "light",
      });
    } else {
      render({ title: "屏幕录制", arrowDir: "left", granted: false, canReset: true, needsRelaunch: false });
    }
  } catch {
    render({ title: "屏幕录制", arrowDir: "left", granted: false, canReset: true, needsRelaunch: false });
  }
})();
