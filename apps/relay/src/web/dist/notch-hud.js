(function () {
  var CATEGORY_LABELS = {
    approval: "需要审批",
    question: "提问待答",
    error: "异常报错",
    completed: "任务完成",
  };

  var CATEGORY_SHORT = {
    approval: "审批",
    question: "提问",
    error: "异常",
    completed: "完成",
  };

  var MODE_RADII = {
    compact: { tr: 6, br: 14 },
    peek: { tr: 15, br: 22 },
    expanded: { tr: 19, br: 24 },
  };

  var activeFilter = "all";
  var currentState = {
    enabled: true,
    theme: "dark",
    mode: "compact",
    notchWidth: 0,
    topInset: 32,
    hasNotch: false,
    items: [],
    peek: null,
  };
  var hoverTimer = null;
  var leaveTimer = null;

  var islandEl = document.getElementById("island");
  var notchSvgEl = document.getElementById("notchSvg");
  var notchBgPathEl = document.getElementById("notchBgPath");
  var notchGlowPathEl = document.getElementById("notchGlowPath");
  var notchRimPathEl = document.getElementById("notchRimPath");

  var compactBarEl = document.getElementById("compactBar");
  var compactDotEl = document.getElementById("compactDot");
  var compactLabelEl = document.getElementById("compactLabel");
  var compactCountEl = document.getElementById("compactCount");
  var compactMascotEl = document.getElementById("compactMascot");

  var peekHeadMascotEl = document.getElementById("peekHeadMascot");
  var peekCountLabelEl = document.getElementById("peekCountLabel");
  var peekSquircleEl = document.getElementById("peekSquircle");
  var peekMascotEl = document.getElementById("peekMascot");
  var peekTagEl = document.getElementById("peekTag");
  var peekTitleEl = document.getElementById("peekTitle");
  var peekSubEl = document.getElementById("peekSub");
  var peekJumpBtn = document.getElementById("peekJumpBtn");

  var expMascotEl = document.getElementById("expMascot");
  var expTotalEl = document.getElementById("expTotal");
  var expFiltersEl = document.getElementById("expFilters");
  var expListEl = document.getElementById("expList");
  var openMainBtn = document.getElementById("openMainBtn");
  var clearAllBtn = document.getElementById("clearAllBtn");

  function emitCommand(url) {
    if (window.location.search.indexOf("qa=1") !== -1) {
      if (url === "pocket-notch://expand") {
        currentState.mode = "expanded";
        render(currentState);
      } else if (url === "pocket-notch://collapse") {
        currentState.mode = currentState.peek ? "peek" : "compact";
        render(currentState);
      }
      return;
    }
    window.location.href = url;
  }

  function categoryOf(raw) {
    return CATEGORY_LABELS[raw] ? raw : "question";
  }

  function mascotSrcForCategory(cat) {
    return cat === "completed" ? "assets/mascot/yay.webp" : "assets/mascot/waiting.webp";
  }

  function createSvgEl(tag, attrs) {
    var el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        el.setAttribute(k, attrs[k]);
      });
    }
    return el;
  }

  function chevronSvg() {
    var svg = createSvgEl("svg", { width: "12", height: "12", viewBox: "0 0 12 12", fill: "none", "aria-hidden": "true" });
    svg.appendChild(createSvgEl("path", {
      d: "M4.5 2.75L7.75 6L4.5 9.25",
      stroke: "currentColor",
      "stroke-width": "1.6",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }));
    return svg;
  }

  function categorySvg(cat) {
    var svg = createSvgEl("svg", { width: "15", height: "15", viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" });
    if (cat === "approval") {
      svg.appendChild(createSvgEl("path", {
        d: "M8 1.8L13 3.9V7.5C13 10.7 10.9 13.3 8 14.3C5.1 13.3 3 10.7 3 7.5V3.9L8 1.8Z",
        stroke: "currentColor",
        "stroke-width": "1.5",
        "stroke-linejoin": "round",
      }));
      svg.appendChild(createSvgEl("path", {
        d: "M8 5.6V8.6",
        stroke: "currentColor",
        "stroke-width": "1.6",
        "stroke-linecap": "round",
      }));
      svg.appendChild(createSvgEl("circle", { cx: "8", cy: "11", r: "0.85", fill: "currentColor" }));
    } else if (cat === "question") {
      svg.appendChild(createSvgEl("path", {
        d: "M3 4.2C3 3.2 3.8 2.5 4.8 2.5H11.2C12.2 2.5 13 3.2 13 4.2V9.3C13 10.3 12.2 11 11.2 11H7.1L4.2 13.3V11H4.8C3.8 11 3 10.3 3 9.3V4.2Z",
        stroke: "currentColor",
        "stroke-width": "1.5",
        "stroke-linejoin": "round",
      }));
      svg.appendChild(createSvgEl("circle", { cx: "6.2", cy: "6.8", r: "0.9", fill: "currentColor" }));
      svg.appendChild(createSvgEl("circle", { cx: "9.8", cy: "6.8", r: "0.9", fill: "currentColor" }));
    } else if (cat === "error") {
      svg.appendChild(createSvgEl("path", {
        d: "M8 2.2L14 12.8H2L8 2.2Z",
        stroke: "currentColor",
        "stroke-width": "1.5",
        "stroke-linejoin": "round",
      }));
      svg.appendChild(createSvgEl("path", {
        d: "M8 6.3V9.3",
        stroke: "currentColor",
        "stroke-width": "1.6",
        "stroke-linecap": "round",
      }));
      svg.appendChild(createSvgEl("circle", { cx: "8", cy: "11.2", r: "0.8", fill: "currentColor" }));
    } else {
      svg.appendChild(createSvgEl("circle", { cx: "8", cy: "8", r: "5.7", stroke: "currentColor", "stroke-width": "1.5" }));
      svg.appendChild(createSvgEl("path", {
        d: "M5.4 8.2L7.2 10L10.8 6.2",
        stroke: "currentColor",
        "stroke-width": "1.6",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      }));
    }
    return svg;
  }

  function closeSvg() {
    var svg = createSvgEl("svg", { width: "12", height: "12", viewBox: "0 0 12 12", fill: "none", "aria-hidden": "true" });
    svg.appendChild(createSvgEl("path", {
      d: "M3 3l6 6M9 3l-6 6",
      stroke: "currentColor",
      "stroke-width": "1.6",
      "stroke-linecap": "round",
    }));
    return svg;
  }

  function updateNotchGeometry() {
    if (!islandEl || !notchBgPathEl) return;
    var W = islandEl.clientWidth || 320;
    var H = islandEl.clientHeight || 40;
    var mode = currentState.mode || "compact";
    var preset = MODE_RADII[mode] || MODE_RADII.compact;
    var tr = Math.max(4, Math.min(preset.tr, Math.floor((W - 40) / 4)));
    var br = Math.max(8, Math.min(preset.br, Math.floor((H - tr) * 0.72)));

    if (notchSvgEl) {
      notchSvgEl.setAttribute("viewBox", "0 0 " + W + " " + H);
    }

    var fillPath = [
      "M 0 0",
      "Q " + tr + " 0 " + tr + " " + tr,
      "L " + tr + " " + (H - br),
      "Q " + tr + " " + H + " " + (tr + br) + " " + H,
      "L " + (W - tr - br) + " " + H,
      "Q " + (W - tr) + " " + H + " " + (W - tr) + " " + (H - br),
      "L " + (W - tr) + " " + tr,
      "Q " + (W - tr) + " 0 " + W + " 0",
      "Z",
    ].join(" ");

    var rimPath = [
      "M 0.5 0.5",
      "Q " + tr + " 0.5 " + tr + " " + tr,
      "L " + tr + " " + (H - br),
      "Q " + tr + " " + (H - 0.5) + " " + (tr + br) + " " + (H - 0.5),
      "L " + (W - tr - br) + " " + (H - 0.5),
      "Q " + (W - tr) + " " + (H - 0.5) + " " + (W - tr) + " " + (H - br),
      "L " + (W - tr) + " " + tr,
      "Q " + (W - tr) + " 0.5 " + (W - 0.5) + " 0.5",
    ].join(" ");

    notchBgPathEl.setAttribute("d", fillPath);
    if (notchGlowPathEl) notchGlowPathEl.setAttribute("d", fillPath);
    if (notchRimPathEl) notchRimPathEl.setAttribute("d", rimPath);
    document.documentElement.style.setProperty("--ear-r", tr + "px");
  }

  function renderJumpButton(btn, labelText) {
    btn.textContent = labelText;
    btn.appendChild(chevronSvg());
  }

  function render(state) {
    currentState = Object.assign({}, currentState, state || {});
    var mode = currentState.mode || "compact";
    var hasNotch = Boolean(currentState.hasNotch);
    var notchW = Number(currentState.notchWidth) || 0;
    var topInset = Number(currentState.topInset);
    if (!Number.isFinite(topInset)) topInset = hasNotch ? 38 : 32;

    if (currentState.theme === "dark" || currentState.theme === "light") {
      document.documentElement.setAttribute("data-theme", currentState.theme);
    }
    document.body.dataset.mode = mode;
    document.body.dataset.hasNotch = hasNotch ? "true" : "false";
    document.documentElement.style.setProperty("--notch-w", (hasNotch && notchW > 0 ? notchW : 0) + "px");
    var headerH = mode === "compact" ? (hasNotch ? Math.max(32, topInset) : 34) : (hasNotch ? Math.max(34, topInset) : 36);
    document.documentElement.style.setProperty("--header-h", headerH + "px");

    var items = Array.isArray(currentState.items) ? currentState.items : [];
    var lead = currentState.peek || items[0] || null;
    var leadCat = lead ? categoryOf(lead.category) : "completed";
    var mascotSrc = mascotSrcForCategory(leadCat);

    if (compactMascotEl && compactMascotEl.getAttribute("src") !== mascotSrc) compactMascotEl.src = mascotSrc;
    if (peekHeadMascotEl && peekHeadMascotEl.getAttribute("src") !== mascotSrc) peekHeadMascotEl.src = mascotSrc;
    if (peekMascotEl && peekMascotEl.getAttribute("src") !== mascotSrc) peekMascotEl.src = mascotSrc;
    if (expMascotEl && expMascotEl.getAttribute("src") !== mascotSrc) expMascotEl.src = mascotSrc;

    if (compactDotEl) compactDotEl.className = "dot " + leadCat;
    if (compactLabelEl) compactLabelEl.textContent = lead ? CATEGORY_SHORT[leadCat] : "待处理";
    if (compactCountEl) compactCountEl.textContent = String(items.length || (lead ? 1 : 0));

    if (peekCountLabelEl) peekCountLabelEl.textContent = String(Math.max(1, items.length)) + " 条待处理";
    if (clearAllBtn) clearAllBtn.textContent = hasNotch ? "已读" : "全部已读";

    if (currentState.peek) {
      var pCat = categoryOf(currentState.peek.category);
      if (peekSquircleEl) peekSquircleEl.className = "peek-squircle " + pCat;
      if (peekTagEl) {
        peekTagEl.className = "cat-tag " + pCat;
        peekTagEl.textContent = CATEGORY_LABELS[pCat];
      }
      if (peekTitleEl) peekTitleEl.textContent = currentState.peek.title || "Herdr Pocket";
      if (peekSubEl) peekSubEl.textContent = currentState.peek.subtitle || "";
      if (peekJumpBtn) {
        peekJumpBtn.setAttribute("data-agent-key", currentState.peek.agentKey || "");
        renderJumpButton(peekJumpBtn, pCat === "approval" ? "去审批" : "查看");
      }
    }

    if (expTotalEl) expTotalEl.textContent = String(items.length);

    if (expFiltersEl) {
      expFiltersEl.textContent = "";
      var counts = { all: items.length, approval: 0, question: 0, error: 0, completed: 0 };
      items.forEach(function (it) {
        var c = categoryOf(it.category);
        counts[c] = (counts[c] || 0) + 1;
      });
      var distinctCats = ["approval", "question", "error", "completed"].filter(function (c) {
        return counts[c] > 0;
      });
      if (distinctCats.length < 2) {
        activeFilter = "all";
        expFiltersEl.setAttribute("hidden", "");
      } else {
        expFiltersEl.removeAttribute("hidden");
        var filterDefs = [
          ["all", "全部"],
          ["approval", "审批"],
          ["question", "提问"],
          ["error", "异常"],
          ["completed", "完成"],
        ];
        filterDefs.forEach(function (pair) {
          var id = pair[0];
          var label = pair[1];
          if (id !== "all" && !counts[id]) return;
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "filter-chip" + (activeFilter === id ? " active" : "");
          btn.textContent = label + " " + String(counts[id] || 0);
          btn.addEventListener("click", function () {
            activeFilter = id;
            render(currentState);
          });
          expFiltersEl.appendChild(btn);
        });
      }
    }

    if (expListEl) {
      expListEl.textContent = "";
      var visible = items.filter(function (it) {
        return activeFilter === "all" || categoryOf(it.category) === activeFilter;
      });
      if (!visible.length) {
        var empty = document.createElement("div");
        empty.className = "exp-empty";
        empty.textContent = "暂无待处理提醒";
        expListEl.appendChild(empty);
      } else {
        visible.forEach(function (item) {
          var cat = categoryOf(item.category);
          var card = document.createElement("div");
          card.className = "item-card";

          var badge = document.createElement("div");
          badge.className = "cat-badge " + cat;
          badge.appendChild(categorySvg(cat));

          var body = document.createElement("div");
          body.className = "item-body";
          body.addEventListener("click", function () {
            if (item.agentKey) {
              emitCommand("pocket-notch://jump?key=" + encodeURIComponent(item.agentKey));
            }
          });

          var top = document.createElement("div");
          top.className = "peek-top";

          var tag = document.createElement("span");
          tag.className = "cat-tag " + cat;
          tag.textContent = CATEGORY_SHORT[cat];

          var title = document.createElement("span");
          title.className = "item-title";
          title.textContent = item.title || item.agentKey || "Agent";

          var sub = document.createElement("div");
          sub.className = "item-sub";
          sub.textContent = item.subtitle || "";

          top.appendChild(tag);
          top.appendChild(title);
          body.appendChild(top);
          if (sub.textContent) body.appendChild(sub);

          var jump = document.createElement("button");
          jump.type = "button";
          jump.className = "jump-btn";
          renderJumpButton(jump, cat === "approval" ? "审批" : "跳转");
          jump.addEventListener("click", function (ev) {
            ev.stopPropagation();
            if (item.agentKey) {
              emitCommand("pocket-notch://jump?key=" + encodeURIComponent(item.agentKey));
            }
          });

          var dismiss = document.createElement("button");
          dismiss.type = "button";
          dismiss.className = "exp-close";
          dismiss.setAttribute("aria-label", "忽略此提醒");
          dismiss.appendChild(closeSvg());
          dismiss.addEventListener("click", function (ev) {
            ev.stopPropagation();
            if (item.id) {
              emitCommand("pocket-notch://dismiss?id=" + encodeURIComponent(item.id));
            }
          });

          card.appendChild(badge);
          card.appendChild(body);
          card.appendChild(jump);
          card.appendChild(dismiss);
          expListEl.appendChild(card);
        });
      }
    }

    updateNotchGeometry();
    window.requestAnimationFrame(updateNotchGeometry);
  }

  window.addEventListener("resize", updateNotchGeometry);

  if (compactBarEl) {
    compactBarEl.addEventListener("click", function () {
      emitCommand("pocket-notch://expand");
    });
  }

  if (peekJumpBtn) {
    peekJumpBtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      var key = peekJumpBtn.getAttribute("data-agent-key");
      if (key) emitCommand("pocket-notch://jump?key=" + encodeURIComponent(key));
    });
  }

  if (openMainBtn) {
    openMainBtn.addEventListener("click", function () {
      emitCommand("pocket-notch://open-main");
    });
  }

  if (clearAllBtn) {
    clearAllBtn.addEventListener("click", function () {
      emitCommand("pocket-notch://clear-all");
    });
  }

  if (islandEl) {
    islandEl.addEventListener("mouseenter", function () {
      if (leaveTimer) {
        window.clearTimeout(leaveTimer);
        leaveTimer = null;
      }
      if (currentState.mode !== "expanded" && !hoverTimer) {
        hoverTimer = window.setTimeout(function () {
          hoverTimer = null;
          emitCommand("pocket-notch://expand");
        }, 90);
      }
    });
    islandEl.addEventListener("mouseleave", function () {
      if (hoverTimer) {
        window.clearTimeout(hoverTimer);
        hoverTimer = null;
      }
      if (currentState.mode === "expanded" && !leaveTimer) {
        leaveTimer = window.setTimeout(function () {
          leaveTimer = null;
          emitCommand("pocket-notch://collapse");
        }, 160);
      }
    });
  }

  window.__notch = function (next) {
    render(next);
  };

  if (window.location.search.indexOf("qa=1") !== -1) {
    var params = new URLSearchParams(window.location.search);
    var qaMode = params.get("mode") || "expanded";
    var qaTheme = params.get("theme") || "light";
    var qaNotch = params.get("hasNotch") === "true" || (params.get("hasNotch") !== "false" && qaMode === "compact");
    var qaSingle = params.get("items") === "1";
    document.body.classList.add("standalone-qa");
    var sampleItems = [
      {
        id: "qa-1",
        agentKey: "qa/hc:t1",
        category: "approval",
        title: "herdr-pocket · 主干发布",
        subtitle: "Bash · 请求运行 cargo test --release",
      },
      {
        id: "qa-2",
        agentKey: "qa/hc:t2",
        category: "question",
        title: "relay · 身份配置确认",
        subtitle: "确认启用 Passkey 优先登录策略",
      },
      {
        id: "qa-3",
        agentKey: "qa/hc:t3",
        category: "completed",
        title: "demo-app · 端到端测试",
        subtitle: "已完成：全部检查通过",
      },
    ];
    render({
      enabled: true,
      theme: qaTheme,
      mode: qaMode,
      hasNotch: qaNotch,
      notchWidth: qaNotch ? 200 : 0,
      topInset: qaNotch ? 38 : 32,
      peek: {
        id: "qa-1",
        agentKey: "qa/hc:t1",
        category: qaSingle ? "completed" : "approval",
        title: qaSingle ? "demo-app · 端到端测试" : "herdr-pocket · 主干发布",
        subtitle: qaSingle ? "已完成：全部检查通过" : "Bash · 请求运行 cargo test --release",
      },
      items: qaSingle ? [sampleItems[0]] : sampleItems,
    });
  }
})();
