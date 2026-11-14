import type { ComponentProps } from "react";
import type { ImageSourcePropType } from "react-native";
import type { MaterialCommunityIcons } from "@expo/vector-icons";

type IconName = ComponentProps<typeof MaterialCommunityIcons>["name"];

export interface HarnessLook {
  label: string;
  /** Pastel circle colour (light / dark). Glyph is always plum (light) or near-white (dark). */
  bg: string;
  darkBg: string;
  glyph?: string;
  /** Glyph is code-like (`</>`, `>_`): render in mono. */
  mono?: boolean;
  icon?: IconName;
  /** Round sticker avatar (assets/vendors), drawn in the app's style. */
  image?: ImageSourcePropType;
}

const IMG = {
  claude: require("../../assets/vendors/claude-code.webp"),
  codex: require("../../assets/vendors/codex.webp"),
  cursor: require("../../assets/vendors/cursor.webp"),
  gemini: require("../../assets/vendors/gemini.webp"),
  hermes: require("../../assets/vendors/hermes.webp"),
  kimi: require("../../assets/vendors/kimi.webp"),
  opencode: require("../../assets/vendors/opencode.webp"),
  pi: require("../../assets/vendors/pi.webp"),
  qwen: require("../../assets/vendors/qwen.webp"),
  shell: require("../../assets/vendors/shell.webp"),
  unknown: require("../../assets/vendors/unknown.webp"),
} as const;

const PEACH = { bg: "#FFDCCB", darkBg: "#5A3A33" };
const LAVENDER = { bg: "#E6DCFF", darkBg: "#41365C" };
const MINT = { bg: "#CFF1E5", darkBg: "#244339" };
const SKY = { bg: "#D4EBFB", darkBg: "#243F55" };
const BUTTER = { bg: "#FFF0B8", darkBg: "#4D4426" };
const GREY = { bg: "#ECE8F1", darkBg: "#3A3446" };
const ROSE = { bg: "#FFDDE7", darkBg: "#4E2C3A" };

const LOOKS: Record<string, HarnessLook> = {
  "claude-code": { label: "Claude Code", ...PEACH, icon: "star-four-points", image: IMG.claude },
  claude: { label: "Claude Code", ...PEACH, icon: "star-four-points", image: IMG.claude },
  omp: { label: "omp", ...LAVENDER, glyph: "π", image: IMG.pi },
  pi: { label: "Pi", ...LAVENDER, glyph: "π", image: IMG.pi },
  codex: { label: "Codex", ...MINT, glyph: "</>", mono: true, image: IMG.codex },
  opencode: { label: "OpenCode", ...SKY, glyph: "{ }", mono: true, image: IMG.opencode },
  gemini: { label: "Gemini", ...BUTTER, icon: "creation", image: IMG.gemini },
  qwen: { label: "Qwen", ...ROSE, glyph: "Q", image: IMG.qwen },
  hermes: { label: "Hermes", ...BUTTER, glyph: "H", image: IMG.hermes },
  cursor: { label: "Cursor", ...GREY, glyph: "C", image: IMG.cursor },
  "cursor-agent": { label: "Cursor", ...GREY, glyph: "C", image: IMG.cursor },
  kimi: { label: "Kimi", ...SKY, glyph: "K", image: IMG.kimi },
};

const SHELL: HarnessLook = { label: "终端", ...GREY, glyph: ">_", mono: true, image: IMG.shell };
const FALLBACKS = [ROSE, SKY, MINT, PEACH];

export function harnessLook(harness: string, isShell: boolean): HarnessLook {
  if (isShell) return SHELL;
  const known = LOOKS[harness.toLowerCase()];
  if (known) return known;
  let h = 0;
  for (const ch of harness) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { label: harness, ...FALLBACKS[h % FALLBACKS.length]!, glyph: (harness[0] ?? "?").toUpperCase(), image: IMG.unknown };
}
