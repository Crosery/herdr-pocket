import { useRef, useState } from "react";
import { assetUrl } from "../lib/api";

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

/** Square portrait art; the other moods are full-body transparent stickers shown whole. */
const PORTRAIT_MOODS = new Set<MascotMood>(["default", "speaking", "listening", "idle"]);

export function XiaoyangOrb({
  mood = "hello",
  size = 84,
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
    if (ref.current) {
      ref.current.animate?.(
        [
          { transform: "scale(0.9) rotate(-4deg)" },
          { transform: "scale(1.04) rotate(2deg)" },
          { transform: "scale(1) rotate(0deg)" },
        ],
        { duration: 420, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
      );
    }
    setBounced((v) => !v);
    onClick?.();
  };

  return (
    <div
      ref={ref}
      className={PORTRAIT_MOODS.has(mood) ? "xiaoyang-orb portrait" : "xiaoyang-orb"}
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
  "github-copilot": "copilot",
  "copilot-cli": "copilot",
  "command-code": "commandcode",
  "oh-my-pi": "omp",
  "mimo-code": "mimocode",
  "minimax-code": "minimax",
  "craft-agents": "craft",
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
  omp: { label: "omp", ...LAVENDER, sticker: "vendors/omp.webp", glyph: "π" },
  qwen: { label: "Qwen", ...ROSE, sticker: "vendors/qwen.webp", glyph: "Q" },
  antigravity: { label: "Antigravity", ...SKY, sticker: "vendors/antigravity.webp", glyph: "A" },
  cline: { label: "Cline", ...GREY, sticker: "vendors/cline.webp", glyph: "C" },
  codebuddy: { label: "CodeBuddy", ...LAVENDER, sticker: "vendors/codebuddy.webp", glyph: "C" },
  commandcode: { label: "Command Code", ...GREY, sticker: "vendors/commandcode.webp", glyph: "⌘" },
  copilot: { label: "Copilot", ...GREY, sticker: "vendors/copilot.webp", glyph: "C" },
  devin: { label: "Devin", ...MINT, sticker: "vendors/devin.webp", glyph: "D" },
  dsh: { label: "DeepSeek Harness", ...SKY, sticker: "vendors/dsh.webp", glyph: "D" },
  grok: { label: "Grok", ...GREY, sticker: "vendors/grok.webp", glyph: "G" },
  kilo: { label: "Kilo Code", ...BUTTER, sticker: "vendors/kilo.webp", glyph: "K" },
  kiro: { label: "Kiro", ...LAVENDER, sticker: "vendors/kiro.webp", glyph: "K" },
  mimocode: { label: "MiMo Code", ...PEACH, sticker: "vendors/mimocode.webp", glyph: "M" },
  minimax: { label: "MiniMax Code", ...ROSE, sticker: "vendors/minimax.webp", glyph: "M" },
  openclaw: { label: "OpenClaw", ...ROSE, sticker: "vendors/openclaw.webp", glyph: "O" },
  qoder: { label: "Qoder", ...MINT, sticker: "vendors/qoder.webp", glyph: "Q" },
  reasonix: { label: "Reasonix", ...SKY, sticker: "vendors/reasonix.webp", glyph: "R" },
  roo: { label: "Roo Code", ...PEACH, sticker: "vendors/roo.webp", glyph: "R" },
  zcode: { label: "ZCode", ...GREY, sticker: "vendors/zcode.webp", glyph: "Z" },
  workbuddy: { label: "WorkBuddy", ...SKY, sticker: "vendors/workbuddy.webp", glyph: "W" },
  factory: { label: "Factory Droid", ...PEACH, sticker: "vendors/factory.webp", glyph: "D" },
  craft: { label: "Craft Agents", ...LAVENDER, sticker: "vendors/craft.webp", glyph: "C" },
  crosery: { label: "Crosery Agent", ...ROSE, sticker: "vendors/crosery.webp", glyph: "C" },
  prime: { label: "Prime Agent", ...GREY, sticker: "vendors/prime.webp", glyph: "P" },
  kodu: { label: "Kodu", ...MINT, sticker: "vendors/kodu.webp", glyph: "K" },
  amp: { label: "Amp", ...PEACH, sticker: "vendors/amp.webp", glyph: "A" },
  crush: { label: "Crush", ...ROSE, sticker: "vendors/crush.webp", glyph: "C" },
  goose: { label: "Goose", ...BUTTER, sticker: "vendors/goose.webp", glyph: "G" },
  aider: { label: "Aider", ...MINT, sticker: "vendors/aider.webp", glyph: "A" },
  iflow: { label: "iFlow", ...SKY, sticker: "vendors/iflow.webp", glyph: "i" },
};

export function resolveVendor(harness: string, isShell: boolean): VendorLook {
  if (isShell) {
    return { label: "终端", ...GREY, sticker: "vendors/shell.webp", glyph: ">_", mono: true };
  }
  const raw = (harness || "unknown").toLowerCase();
  const id = ALIASES[raw] ?? raw;
  const known = LOOKS[id];
  if (known) return known;
  // The generic sticker is always drawn here, so the tile takes its rose disc colour;
  // any other colour shows in the rounded tile's corners.
  return {
    label: harness || "Agent",
    ...ROSE,
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
  dark: boolean;
  size?: number;
}) {
  const look = resolveVendor(harness, isShell);
  return (
    <div
      className="vendor-avatar"
      style={{
        width: size,
        height: size,
        backgroundColor: dark ? look.darkBg : look.bg,
      }}
      title={look.label}
    >
      {look.sticker ? (
        <img src={assetUrl(look.sticker)} alt={look.label} />
      ) : (
        <span
          className={look.mono ? "mono" : undefined}
          style={{
            fontWeight: 900,
            fontSize: Math.round(size * 0.4),
            color: dark ? "#F3EDF7" : "#4A3B5C",
          }}
        >
          {look.glyph}
        </span>
      )}
    </div>
  );
}

/** Signature pink bow emblem from mobile's Settings footer. */
export function PocketBowMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={Math.round(size * 0.6)} viewBox="0 0 36 22" fill="none" aria-hidden="true">
      <path
        d="M15.5 11C11 5.5 3.5 2.5 2 8.2C0.5 13.8 7.5 17.5 15.5 11Z"
        fill="#FF7EA8"
        stroke="var(--ink)"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M20.5 11C25 5.5 32.5 2.5 34 8.2C35.5 13.8 28.5 17.5 20.5 11Z"
        fill="#FF7EA8"
        stroke="var(--ink)"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="18" cy="11" r="3.4" fill="#FFB3C8" stroke="var(--ink)" strokeWidth="1.8" />
    </svg>
  );
}
