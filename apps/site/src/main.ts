import "./styles/base.css";
import "./styles/sections.css";
import "./styles/phone.css";

import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { initI18n, setLang, getLang, onLang } from "./i18n";
import { initHero } from "./hero";
import { initFlow } from "./flow";
import {
  initMarquee,
  initStatement,
  initViews,
  initAssistant,
  initCall,
  initCommands,
  initBento,
  initReveal,
  initFaq,
  initVideo,
  initDownloads,
  initDesktopShowcase,
  initNav,
  wrapTitleLines,
} from "./sections";
import { $, $$, afterLoad, finePointer, isNarrow, reducedMotion, slowNetwork } from "./util";

gsap.registerPlugin(ScrollTrigger);
document.documentElement.classList.add("js");

initI18n();

// ---- smooth wheel scrolling on mouse and trackpad (skipped for reduced motion).
// Touch screens keep native scrolling: Lenis does not smooth touch anyway, and
// native scrolling runs off the main thread, so it stays fluid while the page works.
let lenis: Lenis | null = null;
if (!reducedMotion() && finePointer()) {
  lenis = new Lenis({ lerp: 0.1, smoothWheel: true, anchors: { offset: -72 } });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((time) => lenis!.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
} else if (!reducedMotion()) {
  // the same gentle glide to in-page anchors that Lenis gives on desktop
  document.addEventListener("click", (e) => {
    const a = (e.target as Element).closest<HTMLAnchorElement>('a[href^="#"]');
    const target = a && !a.classList.contains("skip") ? document.getElementById(a.hash.slice(1)) : null;
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: "smooth" });
  });
}

// ---- theme + language toggles
// A theme switch restyles the whole page once. With transitions running, colour
// fades (an inherited one on <body> above all) restyled it again on every frame for
// 0.4 s, which is what made the switch stutter. So: switch with the colour fades off
// (.theme-switching) and turn them back on once the new theme is on screen.
// Only the elements that have such a fade get the rule, read from the style sheets
// once, so turning them back on restyles those few, not the whole page.
// The cross-fade (View Transitions) is for mouse and trackpad machines: on a phone it
// doubled the work of a switch.
const root = document.documentElement;
const colourFade = /(^|,)\s*(all|color|background|border|box-shadow|fill|stroke|outline)/;
let fadesOff = false;
const prepareSwitch = () => {
  if (fadesOff) return;
  fadesOff = true;
  const sels = new Set<string>();
  const walk = (rules: CSSRuleList) => {
    for (const r of Array.from(rules)) {
      if (r instanceof CSSStyleRule) {
        // a shorthand with var() in it leaves the longhands empty: read its text too
        if (!colourFade.test(r.style.transitionProperty) && !colourFade.test(r.style.getPropertyValue("transition"))) continue;
        for (const sel of r.selectorText.split(",")) {
          const s = sel.trim().replace(/^(:root|html)((\[[^\]]*\])|(\.[\w-]+))*\s*/, "");
          if (s) sels.add(`.theme-switching ${s}`);
        }
      } else if ("cssRules" in r) walk((r as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walk(sheet.cssRules);
    } catch {}
  }
  if (!sels.size) return;
  const style = document.createElement("style");
  style.textContent = `${[...sels].join(",\n")} { transition: none !important; }`;
  document.head.append(style);
};
const themeMeta = () => document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
const setTheme = (next: "light" | "dark") => {
  prepareSwitch();
  root.classList.add("theme-switching");
  root.dataset.theme = next;
  try {
    localStorage.setItem("hp-theme", next);
  } catch {}
  themeMeta().forEach((m) => (m.content = next === "dark" ? "#1C1722" : "#FFF6F9"));
};
const endSwitch = () => root.classList.remove("theme-switching");
$("#theme-toggle")!.addEventListener("click", () => {
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  if (document.startViewTransition && finePointer() && !reducedMotion()) {
    document.startViewTransition(() => setTheme(next)).finished.finally(endSwitch);
  } else {
    setTheme(next);
    requestAnimationFrame(() => requestAnimationFrame(endSwitch));
  }
});
$("#lang-toggle")!.addEventListener("click", () => setLang(getLang() === "zh" ? "en" : "zh"));

// ---- hero title intro
const title = $(".hero-title")!;
const animateTitle = (first: boolean) => {
  const lines = wrapTitleLines(title);
  if (!first || reducedMotion()) return;
  gsap.from(lines, { yPercent: 110, duration: 1.1, ease: "expo.out", stagger: 0.12, delay: 0.1 });
  gsap.from([".hero-pill", ".hero-sub", ".hero-ctas", ".hero-needs"], {
    y: 24,
    opacity: 0,
    duration: 0.9,
    ease: "power3.out",
    stagger: 0.08,
    delay: 0.35,
  });
  gsap.from("#stage", { scale: 0.86, opacity: 0, duration: 1.3, ease: "expo.out", delay: 0.2 });
};
animateTitle(true);
onLang(() => animateTitle(false));
// Text in the other language changes section heights: measure again once every
// section has re-rendered (the listeners run in order, this one last by a frame).
onLang(() => requestAnimationFrame(() => ScrollTrigger.refresh()));

// ---- pause the CSS loops of sections that are off screen (see .is-offscreen)
const offscreen = new IntersectionObserver(
  (entries) => entries.forEach((e) => e.target.classList.toggle("is-offscreen", !e.isIntersecting)),
  { rootMargin: "200px 0px" },
);
$$("main > section, body > footer").forEach((s) => offscreen.observe(s));

// ---- skip painting sections far from the screen (content-visibility: auto, see .cv in base.css).
// It cuts the paint of a theme switch about sevenfold. Each section keeps its measured
// height as its stand-in size, so ScrollTrigger positions and anchor jumps stay exact:
// every ScrollTrigger refresh (load, fonts, resize, language) measures with it off.
const lazySections = $$("main > section:not(.hero):not(.flow), body > footer");
ScrollTrigger.addEventListener("refreshInit", () => root.classList.remove("cv"));
ScrollTrigger.addEventListener("refresh", () => {
  // the stand-in size is the content box: padding and border come on top of it
  for (const s of lazySections) {
    const c = getComputedStyle(s);
    const pad = parseFloat(c.paddingTop) + parseFloat(c.paddingBottom) + parseFloat(c.borderTopWidth) + parseFloat(c.borderBottomWidth);
    // no `auto`: a size remembered from another width or language would win over this one
    s.style.containIntrinsicSize = `${Math.max(0, s.getBoundingClientRect().height - pad).toFixed(2)}px`;
  }
  root.classList.add("cv");
});
// ScrollTrigger lets resizes pass on touch screens; a new width (a rotated phone)
// still changes every height, so refresh for that.
let lastWidth = window.innerWidth;
let widthTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(widthTimer);
  widthTimer = window.setTimeout(() => {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    ScrollTrigger.refresh();
  }, 250);
});

initNav();
initHero();
initDownloads();
initMarquee();
initStatement();
initFlow(lenis);
initViews();
initDesktopShowcase();
initAssistant();
initCall();
initCommands();
initBento();
initReveal();
initFaq();
initVideo();

// ---- section headings: soft rise on enter
if (!reducedMotion()) {
  gsap.utils.toArray<HTMLElement>(".h2, .eyebrow, .lead").forEach((el) => {
    if (el.closest(".flow-pin") || el.closest(".hero")) return;
    gsap.from(el, {
      y: 30,
      opacity: 0,
      duration: 1,
      ease: "power3.out",
      scrollTrigger: { trigger: el, start: "top 88%", once: true },
    });
  });
  // the hero copy drifts up and fades as you leave
  gsap.to(".hero-copy", {
    yPercent: -12,
    opacity: 0.2,
    ease: "none",
    scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: true },
  });
  gsap.to("#stage", {
    yPercent: 10,
    scale: 0.94,
    ease: "none",
    scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: true },
  });
}

// ---- the 3D background: desktop-class devices only, after load, once the hero is on screen.
// Phones and small or weak machines keep the CSS gradient under #hero-canvas;
// the shader sky and glossy materials cost more GPU than they can spare.
const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
const desktopClass = finePointer() && !isNarrow() && (navigator.hardwareConcurrency || 4) >= 4 && memory >= 4;
const canWebGL = () => {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
};
if (desktopClass && !reducedMotion() && !slowNetwork() && canWebGL()) {
  afterLoad(() => {
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      import("./hero3d")
        .then((m) => m.startHero3D($("#hero-canvas")!))
        .catch((err) => console.warn("hero 3D disabled:", err));
    });
    io.observe($(".hero")!);
  });
}

window.addEventListener("load", () => ScrollTrigger.refresh());
document.fonts?.ready.then(() => ScrollTrigger.refresh());
