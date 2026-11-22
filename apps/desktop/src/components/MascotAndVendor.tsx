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
  | "connecting"
  | "thinking"
  | "muted"
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
  connecting: "call/connecting.webp",
  thinking: "call/thinking.webp",
  muted: "call/muted.webp",
  speaking: "call/speaking.webp",
  listening: "call/listening.webp",
  idle: "call/idle.webp",
};

/** Square portrait art; the other moods are full-body transparent stickers shown whole. */
const PORTRAIT_MOODS = new Set<MascotMood>([
  "default",
  "connecting",
  "thinking",
  "muted",
  "speaking",
  "listening",
  "idle",
]);

/** Returns the asset relative path for a Xiaoyang mascot mood. */
export function mascotAssetPath(mood: MascotMood): string {
  return MOOD_PATH[mood];
}

/** Maps live voice call state into the matching Xiaoyang call portrait mood. */
export function resolveCallMascotMood(state: {
  status: "idle" | "connecting" | "ready";
  assistant: "idle" | "thinking" | "speaking";
  muted: boolean;
}): MascotMood {
  if (state.status === "idle") return "idle";
  if (state.status === "connecting") return "connecting";
  if (state.assistant === "speaking") return "speaking";
  if (state.assistant === "thinking") return "thinking";
  if (state.muted) return "muted";
  return "listening";
}

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
      className={PORTRAIT_MOODS.has(mood) ? "xiaoyang-orb portrait" : "xiaoyang-orb"}
      style={{ width: size, height: size, ["--orb-img" as string]: size < 44 ? "58%" : "62%" }}
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
  "oh-my-pi": "omp",
  "github-copilot": "copilot",
  "copilot-cli": "copilot",
  "command-code": "commandcode",
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
  // unknown.webp has a rose disc, so its tile is rose too.
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

/** The harness sticker at list size (14-18px), without the avatar's circle. */
export function VendorIcon({ harness, isShell, size = 16 }: { harness: string; isShell: boolean; size?: number }) {
  const look = resolveVendor(harness, isShell);
  return look.sticker ? (
    <img className="vendor-icon" src={assetUrl(look.sticker)} alt="" title={look.label} width={size} height={size} style={{ width: size, height: size, objectFit: "contain", flexShrink: 0 }} />
  ) : (
    <span className="vendor-icon glyph" title={look.label} style={{ width: size, height: size, fontSize: Math.round(size * 0.62), background: look.bg }}>
      {look.glyph}
    </span>
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
