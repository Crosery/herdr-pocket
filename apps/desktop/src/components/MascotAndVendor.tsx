import { useRef, useState } from "react";
import { assetUrl } from "../lib/bridge";
import type { AgentStatus } from "@herdr-pocket/protocol";

export type MascotMood =
  | "hello"
  | "working"
  | "waiting"
  | "sleepy"
  | "yay"
  | "default"
  | "speaking"
  | "listening"
  | "idle";

const MOOD_PATH: Record<MascotMood, string> = {
  hello: "mascot/hello.webp",
  working: "mascot/working.webp",
  waiting: "mascot/waiting.webp",
  sleepy: "mascot/sleepy.webp",
  yay: "mascot/yay.webp",
  default: "mascot/default.webp",
  speaking: "call/speaking.webp",
  listening: "call/listening.webp",
  idle: "call/idle.webp",
};

export function XiaoyangOrb({
  mood = "hello",
  size = 76,
  alt = "小羊",
  onClick,
}: {
  mood?: MascotMood;
  size?: number;
  alt?: string;
  onClick?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [bounced, setBounced] = useState(false);

  const handleClick = () => {
    ref.current?.animate?.(
      [
        { transform: "scale(0.9) rotate(-4deg)" },
        { transform: "scale(1.04) rotate(2deg)" },
        { transform: "scale(1) rotate(0deg)" },
      ],
      { duration: 420, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
    );
    setBounced((v) => !v);
    onClick?.();
  };

  return (
    <div
      ref={ref}
      className="xiaoyang-orb"
      style={{ width: size, height: size }}
      onClick={handleClick}
      role={onClick ? "button" : undefined}
      title={bounced ? "小羊：我在认真盯着呢" : "点一下和小羊打招呼"}
    >
      <div className="ring-outer" />
      <div className="ring-inner" />
      <img src={assetUrl(MOOD_PATH[mood])} alt={alt} />
    </div>
  );
}

interface VendorLook {
  label: string;
  bg: string;
  darkBg: string;
  sticker?: string;
  glyph: string;
  mono?: boolean;
}

const PEACH = { bg: "#FFDCCB", darkBg: "#5A3A33" };
const LAVENDER = { bg: "#E6DCFF", darkBg: "#41365C" };
const MINT = { bg: "#CFF1E5", darkBg: "#244339" };
const SKY = { bg: "#D4EBFB", darkBg: "#243F55" };
const BUTTER = { bg: "#FFF0B8", darkBg: "#4D4426" };
const GREY = { bg: "#ECE8F1", darkBg: "#3A3446" };
const ROSE = { bg: "#FFDDE7", darkBg: "#4E2C3A" };
const FALLBACKS = [ROSE, SKY, MINT, PEACH] as const;

const ALIASES: Record<string, string> = {
  "claude-code": "claude",
  "cursor-agent": "cursor",
  qodercli: "qoder",
  droid: "factory",
  "factory-droid": "factory",
  agy: "antigravity",
  "kimi-code": "kimi",
  "kimi-cli": "kimi",
  "kiro-cli": "kiro",
  kilocode: "kilo",
  "kilo-code": "kilo",
  "roo-code": "roo",
  "gemini-cli": "gemini",
  "qwen-code": "qwen",
  "oh-my-pi": "omp",
};

const LOOKS: Record<string, VendorLook> = {
  claude: { label: "Claude Code", ...PEACH, sticker: "vendors/claude-code.webp", glyph: "C" },
  codex: { label: "Codex", ...MINT, sticker: "vendors/codex.webp", glyph: "</>", mono: true },
  cursor: { label: "Cursor", ...GREY, sticker: "vendors/cursor.webp", glyph: "C" },
  gemini: { label: "Gemini", ...BUTTER, sticker: "vendors/gemini.webp", glyph: "G" },
  hermes: { label: "Hermes", ...BUTTER, sticker: "vendors/hermes.webp", glyph: "H" },
  kimi: { label: "Kimi", ...SKY, sticker: "vendors/kimi.webp", glyph: "K" },
  opencode: { label: "OpenCode", ...SKY, sticker: "vendors/opencode.webp", glyph: "{ }", mono: true },
  pi: { label: "Pi", ...LAVENDER, sticker: "vendors/pi.webp", glyph: "π" },
  omp: { label: "omp", ...LAVENDER, sticker: "vendors/pi.webp", glyph: "π" },
  qwen: { label: "Qwen", ...ROSE, sticker: "vendors/qwen.webp", glyph: "Q" },
  antigravity: { label: "Antigravity", ...SKY, glyph: "A" },
};

export function resolveVendor(harness: string, isShell: boolean): VendorLook {
  if (isShell) {
    return { label: "终端", ...GREY, sticker: "vendors/shell.webp", glyph: ">_", mono: true };
  }
  const raw = (harness || "unknown").toLowerCase();
  const id = ALIASES[raw] ?? raw;
  const known = LOOKS[id];
  if (known) return known;
  let h = 0;
  for (const ch of raw) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return {
    label: harness || "Agent",
    ...FALLBACKS[h % FALLBACKS.length]!,
    sticker: "vendors/unknown.webp",
    glyph: (harness?.[0] ?? "?").toUpperCase(),
  };
}

export function VendorAvatar({
  harness,
  isShell,
  dark,
  size = 44,
}: {
  harness: string;
  isShell: boolean;
  dark?: boolean;
  size?: number;
}) {
  const look = resolveVendor(harness, isShell);
  const bg = dark ? look.darkBg : look.bg;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: bg,
        display: "grid",
        placeItems: "center",
        flexShrink: 0,
        overflow: "hidden",
      }}
      title={look.label}
    >
      {look.sticker ? (
        <img src={assetUrl(look.sticker)} alt={look.label} style={{ width: size, height: size, objectFit: "cover" }} />
      ) : (
        <span style={{ fontWeight: 800, fontSize: Math.round(size * 0.4), color: dark ? "#F3EDF7" : "#4A3B5C" }}>
          {look.glyph}
        </span>
      )}
    </div>
  );
}

export function statusTone(s: AgentStatus): "pink" | "lav" | "mint" | "blush" | "neutral" {
  switch (s) {
    case "blocked":
      return "blush";
    case "working":
      return "pink";
    case "done":
      return "mint";
    case "idle":
      return "neutral";
    default:
      return "lav";
  }
}
