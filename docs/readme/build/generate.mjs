// Generates the SVG images used by README.md and README.zh-CN.md: the hero
// banner, the architecture diagram and the feature grid, in light and dark,
// English and Chinese.
//
// SVGs shown through <img> cannot load fonts, so every piece of text is turned
// into outlines here (Nunito, ZCOOL KuaiLe, Maple Mono: SIL OFL 1.1, read from
// apps/mobile's installed packages). Mascot and agent avatars are embedded as
// small WebP data URIs. Needs magick and cwebp on PATH.
//
//   cd docs/readme/build && pnpm install && pnpm build
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "opentype.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const OUT = path.resolve(HERE, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hp-readme-"));

// ---------------------------------------------------------------- fonts
const gf = path.join(ROOT, "apps/mobile/node_modules/@expo-google-fonts");
function pick(...candidates) {
  const f = candidates.find((c) => fs.existsSync(c));
  if (!f) throw new Error(`font not found: ${candidates[0]} (run pnpm install in apps/mobile)`);
  return f;
}
const google = (pkg, dir, file) => pick(path.join(gf, pkg, dir, file), path.join(gf, `.ignored_${pkg}`, dir, file));
function load(key, file) {
  const b = fs.readFileSync(file);
  const font = parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  font.key = key;
  return font;
}
const F = {
  black: load("b", google("nunito", "900Black", "Nunito_900Black.ttf")),
  xbold: load("x", google("nunito", "800ExtraBold", "Nunito_800ExtraBold.ttf")),
  bold: load("n", google("nunito", "700Bold", "Nunito_700Bold.ttf")),
  zcool: load("z", google("zcool-kuaile", "400Regular", "ZCOOLKuaiLe_400Regular.ttf")),
  mono: load("m", pick(path.join(ROOT, "apps/mobile/assets/fonts/MapleMono-Bold.ttf"))),
};

const r1 = (n) => Math.round(n * 10) / 10;
const r3 = (n) => Math.round(n * 1000) / 1000;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Text as outlines. Each glyph is defined once per file and placed with <use>. */
class Ink {
  constructor() {
    this.glyphs = new Map();
    this.extra = [];
  }
  ref(font, glyph) {
    const key = `${font.key}${glyph.index}`;
    let g = this.glyphs.get(key);
    if (!g) {
      g = { id: `g${this.glyphs.size.toString(36)}`, d: glyph.getPath(0, 0, 100).toPathData(1) };
      this.glyphs.set(key, g);
    }
    return g;
  }
  layout(str, size, fonts, spacing = 0) {
    const items = [];
    let x = 0;
    let prev = null;
    for (const ch of Array.from(str)) {
      // First font that has the character: Nunito for Latin, ZCOOL KuaiLe for Chinese.
      const font = fonts.find((f) => f.charToGlyphIndex(ch) > 0) ?? fonts[0];
      const glyph = font.charToGlyph(ch);
      const s = size / font.unitsPerEm;
      if (prev && prev.font === font) x += font.getKerningValue(prev.glyph, glyph) * s;
      items.push({ font, glyph, x });
      x += glyph.advanceWidth * s + spacing;
      prev = { font, glyph };
    }
    return { items, width: Math.max(0, x - spacing) };
  }
  width(str, size, fonts) {
    return this.layout(str, size, fonts).width;
  }
  /** Returns the SVG for one line. `max` shrinks the line to fit that width. */
  text(str, { x, y, size, fonts, fill, anchor = "start", max, gradient, spacing = 0 }) {
    let L = this.layout(str, size, fonts, spacing);
    if (max && L.width > max) {
      const k = max / L.width;
      size *= k;
      spacing *= k;
      L = this.layout(str, size, fonts, spacing);
    }
    const x0 = anchor === "middle" ? x - L.width / 2 : anchor === "end" ? x - L.width : x;
    const k = size / 100;
    let paint = fill;
    if (gradient) {
      const id = `t${this.extra.length}`;
      this.extra.push(
        `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${r1(L.width / k)}" y2="0"><stop offset="0" stop-color="${gradient[0]}"/><stop offset="1" stop-color="${gradient[1]}"/></linearGradient>`,
      );
      paint = `url(#${id})`;
    }
    const uses = L.items
      .map((it) => {
        const g = this.ref(it.font, it.glyph);
        return g.d ? `<use href="#${g.id}" x="${r1(it.x / k)}"/>` : "";
      })
      .join("");
    return `<g fill="${paint}" transform="translate(${r1(x0)} ${r1(y)}) scale(${r3(k)})">${uses}</g>`;
  }
  defs() {
    const paths = [...this.glyphs.values()].filter((g) => g.d).map((g) => `<path id="${g.id}" d="${g.d}"/>`);
    return paths.join("") + this.extra.join("");
  }
}

// ---------------------------------------------------------------- art
function webp(src, { w = "", h = "", trim = false, q = 80 }) {
  const base = path.join(TMP, `${path.basename(src).replace(/\W/g, "_")}-${w}x${h}`);
  const args = [src];
  if (trim) args.push("-trim", "+repage");
  args.push("-resize", `${w}x${h}`, `${base}.png`);
  execFileSync("magick", args);
  execFileSync("cwebp", ["-quiet", "-q", String(q), "-alpha_q", "90", "-m", "6", `${base}.png`, "-o", `${base}.webp`]);
  const [pw, ph] = execFileSync("magick", ["identify", "-format", "%w %h", `${base}.png`]).toString().trim().split(" ").map(Number);
  return { href: `data:image/webp;base64,${fs.readFileSync(`${base}.webp`).toString("base64")}`, w: pw, h: ph };
}
const MASCOT = webp(path.join(ROOT, "docs/brand/stickers/yay.png"), { h: 440, trim: true, q: 78 });
const vendor = (name) => webp(path.join(ROOT, `apps/site/public/assets/vendors/${name}.webp`), { w: 96, q: 82 });
const AV = { claude: vendor("claude-code"), codex: vendor("codex"), gemini: vendor("gemini"), kimi: vendor("kimi") };

const THEMES = {
  light: {
    bg1: "#FFF6F9", bg2: "#F5EEFF", ink: "#4A3550", ink2: "#8E7E98", accent: "#F27BA6", deep: "#D9578C",
    lav: "#B48CF0", lavDeep: "#7A5BD0", lavSoft: "#EFE7FF", mint: "#2E8A6A", mintSoft: "#DDF5EC",
    pinkSoft: "#FDE6EF", surface: "#FFFFFF", line: "#F2DCE7", cloud: "#FFFFFF", cloudShade: "#F6E2EC",
    glowMint: "#9EE6C8", shadow: "#C04C86", shadowOpacity: 0.16, flow: "#F27BA6", track: "#F6E4EC",
  },
  dark: {
    bg1: "#272030", bg2: "#1C1722", ink: "#F7ECF3", ink2: "#B9A9C2", accent: "#FF8FB8", deep: "#FF8FB8",
    lav: "#C9B6F7", lavDeep: "#C9B6F7", lavSoft: "#352B45", mint: "#7FDBB6", mintSoft: "#1E3A31",
    pinkSoft: "#43283A", surface: "#2A2231", line: "#3D3249", cloud: "#3B3049", cloudShade: "#2E2539",
    glowMint: "#7FDBB6", shadow: "#000000", shadowOpacity: 0.35, flow: "#FF8FB8", track: "#342A3F",
  },
};

const ICONS = {
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
  keys: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7.5 14h9"/>',
  term: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7.5 9 3 3-3 3M13 15h3.5"/>',
  chat: '<path d="M4 5.5h16v10H9l-5 4v-14Z"/><path d="M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01"/>',
  call: '<path d="M5.5 4h3l1.8 4.6-2.3 1.5a11 11 0 0 0 5.9 5.9l1.5-2.3 4.6 1.8v3a2 2 0 0 1-2 2A15.5 15.5 0 0 1 3.5 6a2 2 0 0 1 2-2Z"/>',
  qr: '<rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.5"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1.5"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1.5"/><path d="M14 14h3v3M20.5 14v.01M14 20.5h3M20.5 17.5v3"/>',
  swap: '<path d="M4 8h15l-3.5-3.5M20 16H5l3.5 3.5"/>',
  server: '<rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7.5 7.5h.01M7.5 16.5h.01"/>',
  update: '<path d="M19.5 11a7.5 7.5 0 0 0-13.6-4.3L4.5 8.5M4.5 4v4.5H9M4.5 13a7.5 7.5 0 0 0 13.6 4.3l1.4-1.8M19.5 20v-4.5H15"/>',
  logs: '<path d="M6 3h8.5L19 7.5V21H6Z"/><path d="M14 3v5h5M9.5 12.5h6M9.5 16.5h4"/>',
  laptop: '<rect x="4.5" y="5" width="15" height="10.5" rx="2"/><path d="M2.5 19h19"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.6"/><path d="M11 18h2"/>',
  shield: '<path d="M12 3 4.5 6v5.6c0 4.5 3.1 8.3 7.5 9.4 4.4-1.1 7.5-4.9 7.5-9.4V6L12 3Z"/><path d="m8.8 12 2.2 2.2 4.3-4.4"/>',
  sparkle: '<path d="M12 3.5c.6 4.1 2.6 6.1 6.7 6.7-4.1.6-6.1 2.6-6.7 6.7-.6-4.1-2.6-6.1-6.7-6.7 4.1-.6 6.1-2.6 6.7-6.7Z"/><path d="M18.5 16.5v4M16.5 18.5h4"/>',
};
const icon = (name, cx, cy, size, color, width = 2.1) =>
  `<g transform="translate(${r1(cx - size / 2)} ${r1(cy - size / 2)}) scale(${r3(size / 24)})" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</g>`;

const sparkle = (x, y, r, color, delay = 0) =>
  `<path class="tw" style="animation-delay:${delay}s" fill="${color}" d="M${x} ${y - r}Q${x} ${y} ${x + r} ${y}Q${x} ${y} ${x} ${y + r}Q${x} ${y} ${x - r} ${y}Q${x} ${y} ${x} ${y - r}Z"/>`;

function cloud(cx, cy, w, t) {
  const s = r3(w / 200);
  return `<g transform="translate(${cx} ${cy}) scale(${s})"><ellipse cx="0" cy="14" rx="98" ry="24" fill="${t.cloudShade}"/><circle cx="-54" cy="-4" r="34" fill="${t.cloud}"/><circle cx="-8" cy="-26" r="46" fill="${t.cloud}"/><circle cx="46" cy="-6" r="36" fill="${t.cloud}"/><rect x="-96" y="-10" width="192" height="34" rx="17" fill="${t.cloud}"/></g>`;
}

const commonDefs = (t, W, H, rx) =>
  `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.bg1}"/><stop offset="1" stop-color="${t.bg2}"/></linearGradient>` +
  `<radialGradient id="gp"><stop offset="0" stop-color="${t.accent}" stop-opacity=".26"/><stop offset="1" stop-color="${t.accent}" stop-opacity="0"/></radialGradient>` +
  `<radialGradient id="gm"><stop offset="0" stop-color="${t.glowMint}" stop-opacity=".28"/><stop offset="1" stop-color="${t.glowMint}" stop-opacity="0"/></radialGradient>` +
  `<radialGradient id="gl"><stop offset="0" stop-color="${t.lav}" stop-opacity=".3"/><stop offset="1" stop-color="${t.lav}" stop-opacity="0"/></radialGradient>` +
  `<clipPath id="panel"><rect width="${W}" height="${H}" rx="${rx}"/></clipPath>` +
  `<clipPath id="round" clipPathUnits="objectBoundingBox"><circle cx=".5" cy=".5" r=".5"/></clipPath>` +
  `<filter id="sh" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="${t.shadow}" flood-opacity="${t.shadowOpacity}"/></filter>`;

const STYLE =
  "@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}" +
  "@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}" +
  "@keyframes drift{0%,100%{transform:translateX(0)}50%{transform:translateX(16px)}}" +
  "@keyframes tw{0%,100%{opacity:.3;transform:scale(.6)}50%{opacity:1;transform:scale(1)}}" +
  "@keyframes flow{to{stroke-dashoffset:-32}}" +
  ".float{animation:float 4.4s ease-in-out infinite}.bob{animation:bob 3.6s ease-in-out infinite}" +
  ".drift{animation:drift 10s ease-in-out infinite}" +
  ".tw{transform-box:fill-box;transform-origin:center;animation:tw 2.8s ease-in-out infinite}" +
  ".flow{animation:flow 1.4s linear infinite}" +
  "@media (prefers-reduced-motion:reduce){*{animation:none!important}}";

function doc({ w, h, title, ink, defs, body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><style>${STYLE}</style><defs>${ink.defs()}${defs}</defs>${body}</svg>`;
}

const avatar = (a, x, y, r, t, delay) =>
  `<g transform="translate(${x} ${y})"><g class="bob" style="animation-delay:${delay}s"><circle r="${r}" fill="${t.surface}" stroke="${t.line}" stroke-width="2" filter="url(#sh)"/><image href="${a.href}" x="${-r + 6}" y="${-r + 6}" width="${2 * r - 12}" height="${2 * r - 12}" clip-path="url(#round)"/></g></g>`;

function pills(ink, labels, { x, y, size, fonts, gap = 12, pad = 20, h = 44, align = "start", tints }, t) {
  const widths = labels.map((l) => ink.width(l, size, fonts) + pad * 2);
  const total = widths.reduce((a, b) => a + b, 0) + gap * (labels.length - 1);
  let cx = align === "middle" ? x - total / 2 : x;
  return labels
    .map((l, i) => {
      const [bg, fg] = tints[i % tints.length];
      const out = `<rect x="${r1(cx)}" y="${y}" width="${r1(widths[i])}" height="${h}" rx="${h / 2}" fill="${t[bg]}"/>${ink.text(l, { x: cx + pad, y: y + h / 2 + size * 0.36, size, fonts, fill: t[fg] })}`;
      cx += widths[i] + gap;
      return out;
    })
    .join("");
}

// ---------------------------------------------------------------- copy
const COPY = {
  en: {
    hero: {
      title: "Herdr Pocket: every coding agent on every computer, in your pocket. The mascot Xiaoyang cheers from a cloud.",
      lines: ["Every coding agent", "on every computer,", "in your pocket."],
      chips: ["Open source", "Self-hosted", "Android"],
    },
    arch: {
      title: "How Herdr Pocket connects: Android phones and computers running herdr-pocket all connect out over wss to a relay on your own server, which also talks to the text and voice model providers you configure.",
      phone: "Android app", phoneItems: ["Xiaoyang assistant", "Voice calls"], phone2: "Another phone",
      relay: "Relay", relaySub: "your own server", relayTags: ["pairing", "forwarding", "Xiaoyang"],
      compA: "Computer A", compB: "Computer B", agents: "agents in herdr",
      models: "Text models / voice", modelsSub: "providers you configure",
      caption: "Every device connects out to the relay; computers open no ports.",
    },
    features: {
      title: "Features at a glance: see it all, hands on, new agents, Xiaoyang, voice calls, scan to connect, computer to computer, your own server, auto updates, logs.",
      items: [
        ["grid", "See it all", "Working · waiting · done"],
        ["keys", "Hands on", "Esc, Tab, arrows, Ctrl+C"],
        ["term", "New agents", "Start any installed agent"],
        ["chat", "Xiaoyang", "Just ask, she gets it done"],
        ["call", "Call her", "Talk while you walk"],
        ["qr", "Scan to connect", "QR codes are https links"],
        ["swap", "Computer to computer", "Read, send, press keys"],
        ["server", "Your own server", "Docker, Tunnel, systemd…"],
        ["update", "Auto updates", "From Releases, with rollback"],
        ["logs", "Logs", "herdr-pocket logs and /admin"],
      ],
    },
  },
  zh: {
    hero: {
      title: "Herdr Pocket：所有电脑上的 coding agent，都装进你的口袋。吉祥物小羊站在云朵上欢呼。",
      lines: ["所有电脑上的 coding agent，", "都装进你的口袋。"],
      chips: ["开源", "自托管", "Android"],
    },
    arch: {
      title: "Herdr Pocket 怎么连起来：安卓手机和运行 herdr-pocket 的电脑都通过 wss 主动连到你自己服务器上的中转服务，中转服务再调用你配置的文字模型和语音服务。",
      phone: "安卓 App", phoneItems: ["小羊助理", "语音通话"], phone2: "另一台手机",
      relay: "中转服务", relaySub: "你自己的服务器", relayTags: ["配对", "转发", "小羊"],
      compA: "电脑 A", compB: "电脑 B", agents: "herdr 里的 agent",
      models: "文字模型 / 语音服务", modelsSub: "你配置的厂商",
      caption: "所有设备都只主动连中转服务，电脑不用开端口。",
    },
    features: {
      title: "功能一览：一眼看全、随手操作、开新 agent、助理小羊、打电话、扫码就连、电脑互相调用、自己的服务器、自动更新、有日志可查。",
      items: [
        ["grid", "一眼看全", "在干活 · 在等你 · 跑完了"],
        ["keys", "随手操作", "Esc、Tab、方向键、Ctrl+C"],
        ["term", "开新 agent", "启动任意装好的 agent"],
        ["chat", "助理小羊", "说一句，她直接去办"],
        ["call", "打电话", "边走路边指挥"],
        ["qr", "扫码就连", "二维码就是 https 链接"],
        ["swap", "电脑互相调用", "看终端、发消息、按键"],
        ["server", "自己的服务器", "Docker、Tunnel、systemd……"],
        ["update", "自动更新", "出问题能一键退回"],
        ["logs", "有日志可查", "logs 命令和 /admin 控制台"],
      ],
    },
  },
};
const FONTS = {
  en: { head: [F.black], sub: [F.xbold], body: [F.bold] },
  zh: { head: [F.black, F.zcool], sub: [F.xbold, F.zcool], body: [F.bold, F.zcool] },
};

// ---------------------------------------------------------------- hero
function hero(lang, theme) {
  const t = THEMES[theme];
  const c = COPY[lang].hero;
  const f = FONTS[lang];
  const ink = new Ink();
  const W = 1200;
  const H = 500;
  const L = lang === "en" ? { name: 160, size: 46, lines: [236, 290, 344], chips: 380 } : { name: 172, size: 50, lines: [256, 322], chips: 364 };

  const text = [
    ink.text("Herdr Pocket", { x: 80, y: L.name, size: 92, fonts: [F.black], fill: t.ink, max: 600 }),
    ...c.lines.map((line, i) =>
      ink.text(line, {
        x: 80, y: L.lines[i], size: L.size, fonts: f.sub, max: 600,
        ...(i === c.lines.length - 1 ? { gradient: [t.accent, t.lav] } : { fill: t.ink }),
      }),
    ),
    pills(ink, c.chips, { x: 80, y: L.chips, size: 25, h: 50, pad: 22, fonts: f.sub, tints: [["pinkSoft", "deep"], ["lavSoft", "lavDeep"], ["mintSoft", "mint"]] }, t),
  ].join("");

  const mh = 320;
  const mw = (MASCOT.w * mh) / MASCOT.h;
  const sparkles = [
    [520, 64, 10, t.accent, 0], [470, 452, 8, t.lav, -1.1], [690, 236, 8, t.lav, -0.4], [860, 72, 8, t.accent, -1.7],
    [1062, 58, 12, t.lav, -0.9], [1172, 204, 9, t.mint, -2.1], [640, 430, 9, t.mint, -1.4], [40, 52, 8, t.lav, -0.6],
    [1180, 420, 7, t.accent, -2.4], [620, 120, 6, t.mint, -0.2],
  ].map(([x, y, r, col, d]) => sparkle(x, y, r, col, d)).join("");

  const body =
    `<g clip-path="url(#panel)"><rect width="${W}" height="${H}" fill="url(#bg)"/>` +
    `<circle cx="960" cy="190" r="340" fill="url(#gp)"/><circle cx="80" cy="30" r="260" fill="url(#gm)"/><circle cx="430" cy="540" r="320" fill="url(#gl)"/>` +
    sparkles +
    `<g class="drift">${cloud(150, 540, 300, t)}</g><g class="drift" style="animation-delay:-4s">${cloud(540, 522, 230, t)}</g><g class="drift" style="animation-delay:-7s">${cloud(1170, 478, 250, t)}</g>` +
    cloud(930, 452, 360, t) +
    avatar(AV.claude, 742, 150, 38, t, 0) + avatar(AV.codex, 1124, 108, 38, t, -1.2) + avatar(AV.gemini, 1146, 300, 38, t, -2.3) + avatar(AV.kimi, 706, 304, 38, t, -0.7) +
    `<g transform="translate(${r1(930 - mw / 2)} 120)"><g class="float"><image href="${MASCOT.href}" width="${r1(mw)}" height="${mh}" filter="url(#sh)"/></g></g>` +
    cloud(850, 490, 220, t) + cloud(1010, 498, 240, t) +
    `</g><rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="35" fill="none" stroke="${t.line}" stroke-width="2"/>` +
    text;
  return doc({ w: W, h: H, title: c.title, ink, defs: commonDefs(t, W, H, 36), body });
}

// ---------------------------------------------------------------- architecture
function architecture(lang, theme) {
  const t = THEMES[theme];
  const c = COPY[lang].arch;
  const f = FONTS[lang];
  const ink = new Ink();
  const W = 1000;
  const H = 600;
  const card = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="24" fill="${t.surface}" stroke="${t.line}" stroke-width="2" filter="url(#sh)"/>`;
  const bubble = (cx, cy, r, tint, name, color) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${t[tint]}"/>${icon(name, cx, cy, r * 1.15, t[color])}`;
  const link = (d, cls = "flow", color = t.flow, dash = "0.1 16") =>
    `<path d="${d}" fill="none" stroke="${t.track}" stroke-width="8" stroke-linecap="round"/><path class="${cls}" d="${d}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${dash}"/>`;

  // Paths run from each device to the relay: devices dial out.
  const links =
    link("M280 148C330 148 330 172 380 172") +
    link("M280 304C330 304 330 262 380 262") +
    link("M720 116C670 116 670 172 620 172") +
    link("M720 312C670 312 670 262 620 262") +
    link("M500 346L500 430", "flow", t.lav);
  const wss = (x, y) => `<rect x="${x - 30}" y="${y - 17}" width="60" height="34" rx="17" fill="${t.surface}" stroke="${t.line}" stroke-width="2"/>${ink.text("wss", { x, y: y + 6.5, size: 18, fonts: [F.mono], fill: t.deep, anchor: "middle" })}`;

  const phone =
    card(20, 60, 260, 176) + bubble(62, 106, 26, "pinkSoft", "phone", "deep") +
    ink.text(c.phone, { x: 100, y: 116, size: 28, fonts: f.head, fill: t.ink, max: 160 }) +
    c.phoneItems.map((s, i) => `<circle cx="46" cy="${162 + i * 40}" r="5" fill="${t.accent}"/>` + ink.text(s, { x: 62, y: 170 + i * 40, size: 22, fonts: f.body, fill: t.ink2, max: 200 })).join("") +
    card(20, 262, 260, 84) + bubble(60, 304, 22, "lavSoft", "phone", "lavDeep") +
    ink.text(c.phone2, { x: 94, y: 313, size: 25, fonts: f.head, fill: t.ink, max: 170 });

  const relay =
    `<rect x="380" y="60" width="240" height="286" rx="28" fill="${t.surface}" stroke="${t.accent}" stroke-width="2.5" filter="url(#sh)"/>` +
    `<circle cx="500" cy="122" r="38" fill="${t.pinkSoft}"/>${icon("shield", 500, 122, 42, t.deep, 2.2)}` +
    ink.text(c.relay, { x: 500, y: 200, size: 32, fonts: f.head, fill: t.ink, anchor: "middle", max: 210 }) +
    ink.text(c.relaySub, { x: 500, y: 234, size: 21, fonts: f.body, fill: t.ink2, anchor: "middle", max: 210 }) +
    `<path d="M410 256H590" stroke="${t.line}" stroke-width="2"/>` +
    (lang === "en"
      ? pills(ink, c.relayTags.slice(0, 2), { x: 500, y: 270, size: 17, fonts: f.sub, pad: 13, gap: 8, h: 30, align: "middle", tints: [["lavSoft", "lavDeep"], ["mintSoft", "mint"]] }, t) +
        pills(ink, c.relayTags.slice(2), { x: 500, y: 306, size: 17, fonts: f.sub, pad: 13, h: 30, align: "middle", tints: [["pinkSoft", "deep"]] }, t)
      : pills(ink, c.relayTags, { x: 500, y: 284, size: 18, fonts: f.sub, pad: 14, gap: 8, h: 32, align: "middle", tints: [["lavSoft", "lavDeep"], ["mintSoft", "mint"], ["pinkSoft", "deep"]] }, t));

  const computer = (y, title, avs) =>
    card(720, y, 260, 170) + bubble(762, y + 46, 26, "mintSoft", "laptop", "mint") +
    ink.text(title, { x: 800, y: y + 56, size: 28, fonts: f.head, fill: t.ink, max: 160 }) +
    ink.text("herdr-pocket", { x: 746, y: y + 98, size: 21, fonts: [F.mono], fill: t.deep }) +
    avs.map((a, i) => `<circle cx="${762 + i * 38}" cy="${y + 132}" r="18" fill="${t.surface}" stroke="${t.line}" stroke-width="2"/><image href="${a.href}" x="${747 + i * 38}" y="${y + 117}" width="30" height="30" clip-path="url(#round)"/>`).join("") +
    ink.text(c.agents, { x: 834, y: y + 139, size: 19, fonts: f.body, fill: t.ink2, max: 136 });

  const models =
    card(340, 430, 320, 100) + bubble(386, 480, 26, "lavSoft", "sparkle", "lavDeep") +
    ink.text(c.models, { x: 426, y: 474, size: 24, fonts: f.head, fill: t.ink, max: 218 }) +
    ink.text(c.modelsSub, { x: 426, y: 506, size: 20, fonts: f.body, fill: t.ink2, max: 218 });

  const body =
    `<g clip-path="url(#panel)"><rect width="${W}" height="${H}" fill="url(#bg)"/><circle cx="500" cy="200" r="320" fill="url(#gp)"/><circle cx="900" cy="560" r="260" fill="url(#gm)"/><circle cx="60" cy="560" r="240" fill="url(#gl)"/></g>` +
    `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="31" fill="none" stroke="${t.line}" stroke-width="2"/>` +
    links + wss(330, 224) + wss(670, 214) + phone + relay + computer(30, c.compA, [AV.claude, AV.codex]) + computer(226, c.compB, [AV.gemini, AV.kimi]) + models +
    ink.text(c.caption, { x: 500, y: 574, size: 20, fonts: f.body, fill: t.ink2, anchor: "middle", max: 940 });
  return doc({ w: W, h: H, title: c.title, ink, defs: commonDefs(t, W, H, 32), body });
}

// ---------------------------------------------------------------- features
function features(lang, theme, narrow = false) {
  const t = THEMES[theme];
  const c = COPY[lang].features;
  const f = FONTS[lang];
  const ink = new Ink();
  // narrow: one column for phones, so the text stays readable at 360 px wide
  const cols = narrow ? 1 : 2;
  const W = narrow ? 600 : 1000;
  const pad = 24;
  const gap = narrow ? 14 : 20;
  const cw = (W - pad * 2 - gap * (cols - 1)) / cols;
  const ch = narrow ? 112 : 128;
  const rows = Math.ceil(c.items.length / cols);
  const H = pad * 2 + rows * ch + (rows - 1) * gap;
  const S = narrow
    ? { ix: 58, r: 36, ic: 38, tx: 114, ty: 50, ts: 32, ly: 88, ls: 24 }
    : { ix: 64, r: 38, ic: 40, tx: 124, ty: 58, ts: 31, ly: 96, ls: 23 };
  const tints = [["pinkSoft", "deep"], ["lavSoft", "lavDeep"], ["mintSoft", "mint"]];
  const cards = c.items
    .map(([ic, title, line], i) => {
      const x = pad + (i % cols) * (cw + gap);
      const y = pad + Math.floor(i / cols) * (ch + gap);
      const [bg, fg] = tints[(Math.floor(i / cols) + (i % cols)) % 3];
      return (
        `<rect x="${x}" y="${y}" width="${cw}" height="${ch}" rx="26" fill="${t.surface}" stroke="${t.line}" stroke-width="2" filter="url(#sh)"/>` +
        `<circle cx="${x + S.ix}" cy="${y + ch / 2}" r="${S.r}" fill="${t[bg]}"/>${icon(ic, x + S.ix, y + ch / 2, S.ic, t[fg])}` +
        ink.text(title, { x: x + S.tx, y: y + S.ty, size: S.ts, fonts: f.head, fill: t.ink, max: cw - S.tx - 22 }) +
        ink.text(line, { x: x + S.tx, y: y + S.ly, size: S.ls, fonts: f.body, fill: t.ink2, max: cw - S.tx - 22 })
      );
    })
    .join("");
  const body =
    `<g clip-path="url(#panel)"><rect width="${W}" height="${H}" fill="url(#bg)"/><circle cx="${W - 120}" cy="80" r="320" fill="url(#gp)"/><circle cx="100" cy="${H}" r="320" fill="url(#gl)"/></g>` +
    `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="31" fill="none" stroke="${t.line}" stroke-width="2"/>` +
    cards;
  return doc({ w: W, h: H, title: c.title, ink, defs: commonDefs(t, W, H, 32), body });
}

// Phone layout of the diagram: phones on top, the relay with the model providers
// beside it in the middle, computers below.
function architectureNarrow(lang, theme) {
  const t = THEMES[theme];
  const c = COPY[lang].arch;
  const f = FONTS[lang];
  const ink = new Ink();
  const W = 600;
  const H = 884;
  const card = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="24" fill="${t.surface}" stroke="${t.line}" stroke-width="2" filter="url(#sh)"/>`;
  const bubble = (cx, cy, r, tint, name, color) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${t[tint]}"/>${icon(name, cx, cy, r * 1.15, t[color])}`;
  const link = (d, color = t.flow) =>
    `<path d="${d}" fill="none" stroke="${t.track}" stroke-width="8" stroke-linecap="round"/><path class="flow" d="${d}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-dasharray="0.1 16"/>`;
  const wss = (x, y) => `<rect x="${x - 30}" y="${y - 17}" width="60" height="34" rx="17" fill="${t.surface}" stroke="${t.line}" stroke-width="2"/>${ink.text("wss", { x, y: y + 6.5, size: 18, fonts: [F.mono], fill: t.deep, anchor: "middle" })}`;
  const links =
    link("M156 174C156 237 124 237 124 300") +
    link("M444 174C444 237 274 237 274 300") +
    link("M156 640C156 604 124 604 124 568") +
    link("M444 640C444 604 274 604 274 568") +
    link("M324 434L360 434", t.lav);
  const phones =
    card(24, 24, 264, 150) + bubble(64, 68, 26, "pinkSoft", "phone", "deep") +
    ink.text(c.phone, { x: 102, y: 78, size: 28, fonts: f.head, fill: t.ink, max: 168 }) +
    c.phoneItems.map((s, i) => `<circle cx="50" cy="${116 + i * 32}" r="5" fill="${t.accent}"/>` + ink.text(s, { x: 66, y: 124 + i * 32, size: 22, fonts: f.body, fill: t.ink2, max: 200 })).join("") +
    card(312, 24, 264, 150) + bubble(352, 99, 26, "lavSoft", "phone", "lavDeep") +
    ink.text(c.phone2, { x: 390, y: 109, size: 26, fonts: f.head, fill: t.ink, max: 170 });
  const tags3 = [["lavSoft", "lavDeep"], ["mintSoft", "mint"], ["pinkSoft", "deep"]];
  const relay =
    `<rect x="24" y="300" width="300" height="268" rx="28" fill="${t.surface}" stroke="${t.accent}" stroke-width="2.5" filter="url(#sh)"/>` +
    `<circle cx="174" cy="352" r="36" fill="${t.pinkSoft}"/>${icon("shield", 174, 352, 40, t.deep, 2.2)}` +
    ink.text(c.relay, { x: 174, y: 424, size: 32, fonts: f.head, fill: t.ink, anchor: "middle", max: 260 }) +
    ink.text(c.relaySub, { x: 174, y: 456, size: 21, fonts: f.body, fill: t.ink2, anchor: "middle", max: 260 }) +
    `<path d="M54 476H294" stroke="${t.line}" stroke-width="2"/>` +
    (lang === "en"
      ? pills(ink, c.relayTags.slice(0, 2), { x: 174, y: 490, size: 17, fonts: f.sub, pad: 13, gap: 8, h: 30, align: "middle", tints: tags3 }, t) +
        pills(ink, c.relayTags.slice(2), { x: 174, y: 526, size: 17, fonts: f.sub, pad: 13, h: 30, align: "middle", tints: [tags3[2]] }, t)
      : pills(ink, c.relayTags, { x: 174, y: 500, size: 18, fonts: f.sub, pad: 14, gap: 8, h: 32, align: "middle", tints: tags3 }, t));
  const models =
    card(360, 349, 216, 170) + bubble(468, 397, 26, "lavSoft", "sparkle", "lavDeep") +
    ink.text(c.models, { x: 468, y: 457, size: 22, fonts: f.head, fill: t.ink, anchor: "middle", max: 192 }) +
    ink.text(c.modelsSub, { x: 468, y: 489, size: 18, fonts: f.body, fill: t.ink2, anchor: "middle", max: 192 });
  const computer = (x, y, title, avs) =>
    card(x, y, 264, 170) + bubble(x + 42, y + 46, 26, "mintSoft", "laptop", "mint") +
    ink.text(title, { x: x + 80, y: y + 56, size: 28, fonts: f.head, fill: t.ink, max: 170 }) +
    ink.text("herdr-pocket", { x: x + 26, y: y + 98, size: 21, fonts: [F.mono], fill: t.deep }) +
    avs.map((a, i) => `<circle cx="${x + 42 + i * 38}" cy="${y + 132}" r="18" fill="${t.surface}" stroke="${t.line}" stroke-width="2"/><image href="${a.href}" x="${x + 27 + i * 38}" y="${y + 117}" width="30" height="30" clip-path="url(#round)"/>`).join("") +
    ink.text(c.agents, { x: x + 114, y: y + 139, size: 19, fonts: f.body, fill: t.ink2, max: 136 });
  const body =
    `<g clip-path="url(#panel)"><rect width="${W}" height="${H}" fill="url(#bg)"/><circle cx="300" cy="430" r="300" fill="url(#gp)"/><circle cx="560" cy="860" r="240" fill="url(#gm)"/><circle cx="40" cy="80" r="220" fill="url(#gl)"/></g>` +
    `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="31" fill="none" stroke="${t.line}" stroke-width="2"/>` +
    links + wss(215, 237) + wss(215, 604) + phones + relay + models +
    computer(24, 640, c.compA, [AV.claude, AV.codex]) + computer(312, 640, c.compB, [AV.gemini, AV.kimi]) +
    ink.text(c.caption, { x: 300, y: 852, size: 20, fonts: f.body, fill: t.ink2, anchor: "middle", max: 552 });
  return doc({ w: W, h: H, title: c.title, ink, defs: commonDefs(t, W, H, 32), body });
}

// ---------------------------------------------------------------- write
const jobs = {
  hero,
  architecture,
  "architecture-narrow": architectureNarrow,
  features,
  "features-narrow": (lang, theme) => features(lang, theme, true),
};
for (const [name, fn] of Object.entries(jobs))
  for (const lang of ["en", "zh"])
    for (const theme of ["light", "dark"]) {
      const file = path.join(OUT, `${name}-${lang}-${theme}.svg`);
      fs.writeFileSync(file, fn(lang, theme));
      console.log(`${path.basename(file)}  ${(fs.statSync(file).size / 1024).toFixed(1)} KB`);
    }
fs.rmSync(TMP, { recursive: true, force: true });
