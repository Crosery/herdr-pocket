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

  var activeFilter = "all";
  var currentState = {
    enabled: true,
    mode: "compact",
    notchWidth: 0,
    topInset: 4,
    hasNotch: false,
    items: [],
    peek: null,
  };
  var hoverTimer = null;
  var leaveTimer = null;

  var islandEl = document.getElementById("island");
  var compactBarEl = document.getElementById("compactBar");
  var compactDotEl = document.getElementById("compactDot");
  var compactLabelEl = document.getElementById("compactLabel");
  var compactCountEl = document.getElementById("compactCount");
  var peekTagEl = document.getElementById("peekTag");
  var peekTitleEl = document.getElementById("peekTitle");
  var peekSubEl = document.getElementById("peekSub");
  var peekJumpBtn = document.getElementById("peekJumpBtn");
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

  function render(state) {
    currentState = Object.assign({}, currentState, state || {});
    var mode = currentState.mode || "compact";
    var hasNotch = Boolean(currentState.hasNotch);
    var notchW = Number(currentState.notchWidth) || 0;
    var topInset = Number(currentState.topInset);
    if (!Number.isFinite(topInset)) topInset = hasNotch ? 36 : 4;

    document.body.dataset.mode = mode;
    document.body.dataset.hasNotch = hasNotch ? "true" : "false";
    document.documentElement.style.setProperty("--notch-w", (notchW > 0 ? notchW + 8 : 0) + "px");
    document.documentElement.style.setProperty("--notch-top", (hasNotch ? Math.max(26, topInset) : 4) + "px");

    var items = Array.isArray(currentState.items) ? currentState.items : [];
    var lead = currentState.peek || items[0] || null;
    var leadCat = lead ? categoryOf(lead.category) : "completed";

    if (compactDotEl) compactDotEl.className = "dot " + leadCat;
    if (compactLabelEl) compactLabelEl.textContent = lead ? CATEGORY_SHORT[leadCat] : "待处理";
    if (compactCountEl) compactCountEl.textContent = String(items.length || (lead ? 1 : 0));

    if (currentState.peek) {
      var pCat = categoryOf(currentState.peek.category);
      if (peekTagEl) {
        peekTagEl.className = "cat-tag " + pCat;
        peekTagEl.textContent = CATEGORY_LABELS[pCat];
      }
      if (peekTitleEl) peekTitleEl.textContent = currentState.peek.title || "Herdr Pocket";
      if (peekSubEl) peekSubEl.textContent = currentState.peek.subtitle || "";
      if (peekJumpBtn) peekJumpBtn.setAttribute("data-agent-key", currentState.peek.agentKey || "");
    }

    if (expTotalEl) expTotalEl.textContent = String(items.length);

    if (expFiltersEl) {
      expFiltersEl.textContent = "";
      var counts = { all: items.length, approval: 0, question: 0, error: 0, completed: 0 };
      items.forEach(function (it) {
        var c = categoryOf(it.category);
        counts[c] = (counts[c] || 0) + 1;
      });
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
          card.className = "exp-card";

          var body = document.createElement("div");
          body.className = "exp-card-body";
          body.addEventListener("click", function () {
            if (item.agentKey) {
              emitCommand("pocket-notch://jump?key=" + encodeURIComponent(item.agentKey));
            }
          });

          var top = document.createElement("div");
          top.className = "peek-top";

          var tag = document.createElement("span");
          tag.className = "cat-tag " + cat;
          tag.textContent = CATEGORY_LABELS[cat];

          var title = document.createElement("span");
          title.className = "item-title";
          title.textContent = item.title || item.agentKey || "Agent";

          var sub = document.createElement("div");
          sub.className = "item-sub";
          sub.textContent = item.subtitle || "";

          top.appendChild(tag);
          top.appendChild(title);
          body.appendChild(top);
          body.appendChild(sub);

          var jump = document.createElement("button");
          jump.type = "button";
          jump.className = "jump-btn";
          jump.textContent = "跳转";
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
          dismiss.textContent = "×";
          dismiss.addEventListener("click", function (ev) {
            ev.stopPropagation();
            if (item.id) {
              emitCommand("pocket-notch://dismiss?id=" + encodeURIComponent(item.id));
            }
          });

          card.appendChild(body);
          card.appendChild(jump);
          card.appendChild(dismiss);
          expListEl.appendChild(card);
        });
      }
    }
  }

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
    render({
      enabled: true,
      mode: qaMode,
      hasNotch: qaMode === "compact",
      notchWidth: qaMode === "compact" ? 190 : 0,
      topInset: qaMode === "compact" ? 36 : 4,
      peek: {
        id: "qa-1",
        agentKey: "qa/hc:t1",
        category: "approval",
        title: "herdr-pocket · 主分支发布",
        subtitle: "请求允许运行 cargo test --release",
      },
      items: [
        {
          id: "qa-1",
          agentKey: "qa/hc:t1",
          category: "approval",
          title: "herdr-pocket · 主分支发布",
          subtitle: "请求允许运行 cargo test --release",
        },
        {
          id: "qa-2",
          agentKey: "qa/hc:t2",
          category: "question",
          title: "ibuki-next · 资源迁移",
          subtitle: "请确认是否切换为七牛 CDN 直链",
        },
        {
          id: "qa-3",
          agentKey: "qa/hc:t3",
          category: "error",
          title: "relay · 生产心跳检查",
          subtitle: "上游响应超时 (504 Gateway Timeout)",
        },
        {
          id: "qa-4",
          agentKey: "qa/hc:t4",
          category: "completed",
          title: "Taproom · 构建校验",
          subtitle: "已完成（耗时 68 秒）",
        },
      ],
    });
  }
})();
