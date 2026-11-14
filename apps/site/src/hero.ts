// Hero stage: mascot interactions, orbiting agent avatars, status bubbles.
import { onLang, t } from "./i18n";
import { reducedMotion, finePointer, slowNetwork, afterLoad, h, $ } from "./util";

const VENDORS: [string, string, "work" | "wait" | "done"][] = [
  ["claude-code", "Claude Code", "work"],
  ["codex", "Codex", "wait"],
  ["gemini", "Gemini", "work"],
  ["opencode", "OpenCode", "done"],
  ["kimi", "Kimi", "work"],
  ["qwen", "Qwen", "done"],
  ["cursor", "Cursor", "work"],
  ["pi", "pi", "wait"],
];

export function initHero(): void {
  const stage = $("#stage")!;
  const orbit = $("#orbit")!;
  const mascotBtn = $<HTMLButtonElement>("#mascot")!;
  const img = mascotBtn.querySelector<HTMLImageElement>("img")!;
  const say = $("#mascot-say")!;
  const bubbles = $("#bubbles")!;
  const still = reducedMotion();

  // ---- Swap the static poster for the animated loop (about 1 MB) once the page
  // has loaded and the stage is on screen. Data saver and 2G/3G keep the poster.
  const idleUrl = img.dataset.anim!;
  const tapUrl = img.dataset.tap!;
  if (!still && !slowNetwork()) {
    afterLoad(() => {
      const io = new IntersectionObserver(([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        const pre = new Image();
        pre.decoding = "async";
        pre.src = idleUrl;
        pre.onload = () => {
          img.src = idleUrl;
        };
      });
      io.observe(stage);
    });
  }

  // ---- Orbit
  const items = VENDORS.map(([v, name, st]) => {
    const el = h(`<div class="orbit-item" title="${name}"><img src="assets/vendors/${v}.webp" alt="" width="62" height="62" /><b class="${st}"></b></div>`);
    orbit.appendChild(el);
    return el;
  });
  let angle = 0;
  let last = performance.now();
  let visible = true;
  let raf = 0;
  const tilt = (-14 * Math.PI) / 180;
  const place = () => {
    const w = stage.clientWidth;
    const rx = w * 0.47;
    const ry = w * 0.13;
    const cx = w / 2;
    const cy = w * 0.64;
    items.forEach((el, i) => {
      const a = angle + (i / items.length) * Math.PI * 2;
      const ex = Math.cos(a) * rx;
      const ey = Math.sin(a) * ry;
      const x = ex * Math.cos(tilt) - ey * Math.sin(tilt);
      const y = ex * Math.sin(tilt) + ey * Math.cos(tilt);
      const depth = Math.sin(a); // +1 front, -1 back
      const s = 0.62 + 0.38 * ((depth + 1) / 2);
      el.style.transform = `translate3d(${(cx + x - w / 2).toFixed(1)}px, ${(cy + y - w / 2).toFixed(1)}px, 0) scale(${s.toFixed(3)})`;
      el.style.zIndex = depth > 0.05 ? "5" : "2";
      el.style.opacity = (0.55 + 0.45 * ((depth + 1) / 2)).toFixed(2);
      el.style.filter = depth < -0.2 ? `blur(${((-depth - 0.2) * 2.2).toFixed(2)}px)` : "none";
    });
  };
  const tick = (now: number) => {
    const dt = Math.min(64, now - last);
    last = now;
    angle += dt * 0.00018;
    place();
    raf = requestAnimationFrame(tick);
  };
  place();
  window.addEventListener("resize", place);

  // The orbit only runs while the stage is on screen; no frame callbacks otherwise.
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    cancelAnimationFrame(raf);
    if (visible && !still) {
      last = performance.now();
      raf = requestAnimationFrame(tick);
    }
  }).observe(stage);

  // ---- Parallax tilt toward the pointer
  if (finePointer() && !still) {
    const hero = stage.closest(".hero") as HTMLElement;
    hero.addEventListener("pointermove", (e) => {
      const r = stage.getBoundingClientRect();
      const mx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width * 0.9)));
      const my = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (r.height * 0.9)));
      stage.style.setProperty("--mx", mx.toFixed(3));
      stage.style.setProperty("--my", my.toFixed(3));
    });
  }

  // ---- Speech bubble lines
  const lines = () => [
    t("要我帮你看看谁在等你吗？", "Want me to check who's waiting on you?"),
    t("Codex 刚跑完，测试全过。", "Codex just finished. All tests pass."),
    t("我在盯着 3 台电脑哦。", "I'm keeping an eye on 3 computers."),
    t("说一声，我直接去办。", "Say the word and I'll do it."),
    t("戳我一下试试？", "Go on, give me a poke."),
  ];
  let li = 0;
  let sayTimer = 0;
  const showSay = (text: string, ms = 3200) => {
    say.textContent = text;
    say.classList.add("is-on");
    clearTimeout(sayTimer);
    sayTimer = window.setTimeout(() => say.classList.remove("is-on"), ms);
  };
  if (!still) {
    setTimeout(() => showSay(lines()[0]), 1600);
    setInterval(() => {
      if (!visible || document.hidden) return;
      li = (li + 1) % lines().length;
      showSay(lines()[li]);
    }, 6500);
  }
  onLang(() => say.classList.remove("is-on"));

  // ---- Tap: play the tap animation, burst hearts
  let tapBlob: Blob | null = null;
  let busy = false;
  const heartSvg =
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20.5s-7.5-4.6-7.5-10.1A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.8c0 5.5-7.5 10.1-7.5 10.1Z"/></svg>';
  mascotBtn.addEventListener("click", async () => {
    showSay(
      [t("嘿嘿，在呢！", "Hehe, I'm here!"), t("我会盯好它们的。", "I'll keep watch."), t("有事随时叫我～", "Call me anytime.")][
        Math.floor(Math.random() * 3)
      ],
      2200,
    );
    if (still) return;
    // hearts
    for (let i = 0; i < 6; i++) {
      const el = h(`<span class="heart">${heartSvg}</span>`);
      stage.appendChild(el);
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.8;
      const d = 90 + Math.random() * 80;
      el.style.left = "50%";
      el.style.top = "26%";
      el.animate(
        [
          { transform: "translate(-50%,-50%) scale(.3)", opacity: 0 },
          { transform: "translate(-50%,-50%) scale(1)", opacity: 1, offset: 0.2 },
          {
            transform: `translate(calc(-50% + ${Math.cos(a) * d}px), calc(-50% + ${Math.sin(a) * d}px)) scale(${0.6 + Math.random() * 0.6}) rotate(${(Math.random() - 0.5) * 60}deg)`,
            opacity: 0,
          },
        ],
        { duration: 1100 + Math.random() * 500, easing: "cubic-bezier(.22,1,.36,1)" },
      ).onfinish = () => el.remove();
    }
    if (busy) return;
    busy = true;
    try {
      tapBlob ??= await (await fetch(tapUrl)).blob();
      const url = URL.createObjectURL(tapBlob);
      img.src = url;
      setTimeout(() => {
        img.src = idleUrl;
        URL.revokeObjectURL(url);
        busy = false;
      }, 2350);
    } catch {
      busy = false;
    }
  });

  // ---- Status bubbles popping around the stage
  const narrow = window.matchMedia("(max-width: 520px)").matches;
  const slots = narrow
    ? [
        { left: "0%", top: "14%" },
        { left: "60%", top: "34%" },
        { left: "0%", top: "48%" },
      ]
    : [
        { left: "-8%", top: "16%" },
        { left: "70%", top: "30%" },
        { left: "-10%", top: "52%" },
      ];
  const msgs = () => [
    ["claude-code", "Claude Code", "st-wait", t("等你确认", "Needs your OK")],
    ["codex", "Codex", "st-done", t("跑完了 · 测试全过", "Done · tests pass")],
    ["gemini", "Gemini", "st-work", t("工作中 · 第 41 轮", "Working · turn 41")],
    ["kimi", "Kimi", "st-done", t("报表生成好了", "Report is ready")],
    ["opencode", "OpenCode", "st-work", t("工作中 · 组件迁移", "Working · migration")],
    ["qwen", "Qwen", "st-wait", t("想跑 rm -rf dist，等你批准", "Wants to run rm -rf dist")],
  ];
  const live: (HTMLElement | null)[] = [null, null, null];
  let mi = 0;
  const pop = (slot: number) => {
    const [v, name, cls, text] = msgs()[mi % msgs().length];
    mi++;
    const el = h(`<div class="bubble"><img src="assets/vendors/${v}.webp" alt="" /><div><b>${name}</b><small class="${cls}">${text}</small></div></div>`);
    Object.assign(el.style, slots[slot]);
    bubbles.appendChild(el);
    if (!still) el.animate([{ opacity: 0, transform: "translateY(14px) scale(.85)" }, { opacity: 1, transform: "none" }], { duration: 600, easing: "cubic-bezier(.34,1.56,.64,1)" });
    const old = live[slot];
    if (old) {
      if (still) old.remove();
      else old.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(-12px) scale(.9)" }], { duration: 350, fill: "forwards" }).onfinish = () => old.remove();
    }
    live[slot] = el;
  };
  pop(0);
  pop(1);
  pop(2);
  let si = 0;
  if (!still) {
    setInterval(() => {
      if (!visible || document.hidden) return;
      pop(si % 3);
      si++;
    }, 2600);
  }
  onLang(() => {
    for (let s = 0; s < 3; s++) pop(s);
  });
}
