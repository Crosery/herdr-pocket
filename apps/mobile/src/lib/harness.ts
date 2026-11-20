import type { ComponentProps } from "react";
import type { ImageSourcePropType } from "react-native";
import type { MaterialCommunityIcons } from "@expo/vector-icons";
import { HARNESS_GLYPHS, type GlyphPath } from "./harnessIcons";

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
  /** Monochrome brand mark on a 24x24 canvas (lib/harnessIcons.ts), drawn in the glyph colour. */
  svg?: readonly GlyphPath[];
  /** Round sticker avatar (assets/vendors), drawn in the app's style. */
  image?: ImageSourcePropType;
  /**
   * Uniflo harness id to ask a computer for a mark (`harness.icons`), set when the
   * app has no sticker or bundled glyph of its own. Drawn instead of `glyph` once it arrives.
   */
  remoteId?: string;
  /** Not a harness the app knows: `image` is the generic sticker, and a mark from the computer wins over it. */
  generic?: boolean;
}

const IMG = {
  aider: require("../../assets/vendors/aider.webp"),
  amp: require("../../assets/vendors/amp.webp"),
  antigravity: require("../../assets/vendors/antigravity.webp"),
  claude: require("../../assets/vendors/claude-code.webp"),
  cline: require("../../assets/vendors/cline.webp"),
  codebuddy: require("../../assets/vendors/codebuddy.webp"),
  codex: require("../../assets/vendors/codex.webp"),
  commandcode: require("../../assets/vendors/commandcode.webp"),
  copilot: require("../../assets/vendors/copilot.webp"),
  craft: require("../../assets/vendors/craft.webp"),
  crosery: require("../../assets/vendors/crosery.webp"),
  crush: require("../../assets/vendors/crush.webp"),
  cursor: require("../../assets/vendors/cursor.webp"),
  devin: require("../../assets/vendors/devin.webp"),
  dsh: require("../../assets/vendors/dsh.webp"),
  factory: require("../../assets/vendors/factory.webp"),
  gemini: require("../../assets/vendors/gemini.webp"),
  goose: require("../../assets/vendors/goose.webp"),
  grok: require("../../assets/vendors/grok.webp"),
  hermes: require("../../assets/vendors/hermes.webp"),
  iflow: require("../../assets/vendors/iflow.webp"),
  kilo: require("../../assets/vendors/kilo.webp"),
  kimi: require("../../assets/vendors/kimi.webp"),
  kiro: require("../../assets/vendors/kiro.webp"),
  kodu: require("../../assets/vendors/kodu.webp"),
  mimocode: require("../../assets/vendors/mimocode.webp"),
  minimax: require("../../assets/vendors/minimax.webp"),
  omp: require("../../assets/vendors/omp.webp"),
  opencode: require("../../assets/vendors/opencode.webp"),
  openclaw: require("../../assets/vendors/openclaw.webp"),
  pi: require("../../assets/vendors/pi.webp"),
  prime: require("../../assets/vendors/prime.webp"),
  qoder: require("../../assets/vendors/qoder.webp"),
  qwen: require("../../assets/vendors/qwen.webp"),
  reasonix: require("../../assets/vendors/reasonix.webp"),
  roo: require("../../assets/vendors/roo.webp"),
  shell: require("../../assets/vendors/shell.webp"),
  unknown: require("../../assets/vendors/unknown.webp"),
  workbuddy: require("../../assets/vendors/workbuddy.webp"),
  zcode: require("../../assets/vendors/zcode.webp"),
} as const;

const PEACH = { bg: "#FFDCCB", darkBg: "#5A3A33" };
const LAVENDER = { bg: "#E6DCFF", darkBg: "#41365C" };
const MINT = { bg: "#CFF1E5", darkBg: "#244339" };
const SKY = { bg: "#D4EBFB", darkBg: "#243F55" };
const BUTTER = { bg: "#FFF0B8", darkBg: "#4D4426" };
const GREY = { bg: "#ECE8F1", darkBg: "#3A3446" };
const ROSE = { bg: "#FFDDE7", darkBg: "#4E2C3A" };

const G = HARNESS_GLYPHS;

/** By Uniflo harness id. Stickers where the app has one; otherwise the brand glyph, or a letter when there is none. */
const LOOKS: Record<string, HarnessLook> = {
  claude: { label: "Claude Code", ...PEACH, icon: "star-four-points", svg: G.claude, image: IMG.claude },
  codex: { label: "Codex", ...MINT, glyph: "</>", mono: true, svg: G.codex, image: IMG.codex },
  cursor: { label: "Cursor", ...GREY, glyph: "C", svg: G.cursor, image: IMG.cursor },
  gemini: { label: "Gemini", ...BUTTER, icon: "creation", svg: G.gemini, image: IMG.gemini },
  hermes: { label: "Hermes", ...BUTTER, glyph: "H", svg: G.hermes, image: IMG.hermes },
  kimi: { label: "Kimi", ...SKY, glyph: "K", svg: G.kimi, image: IMG.kimi },
  opencode: { label: "OpenCode", ...SKY, glyph: "{ }", mono: true, svg: G.opencode, image: IMG.opencode },
  pi: { label: "Pi", ...LAVENDER, glyph: "π", svg: G.pi, image: IMG.pi },
  omp: { label: "omp", ...LAVENDER, glyph: "π", svg: G.omp, image: IMG.omp },
  qwen: { label: "Qwen", ...ROSE, glyph: "Q", svg: G.qwen, image: IMG.qwen },

  antigravity: { label: "Antigravity", ...SKY, glyph: "A", svg: G.antigravity, image: IMG.antigravity },
  cline: { label: "Cline", ...GREY, glyph: "C", svg: G.cline, image: IMG.cline },
  codebuddy: { label: "CodeBuddy", ...LAVENDER, glyph: "C", svg: G.codebuddy, image: IMG.codebuddy },
  commandcode: { label: "Command Code", ...GREY, glyph: "⌘", svg: G.commandcode, image: IMG.commandcode },
  copilot: { label: "Copilot", ...GREY, glyph: "C", svg: G.copilot, image: IMG.copilot },
  devin: { label: "Devin", ...MINT, glyph: "D", svg: G.devin, image: IMG.devin },
  dsh: { label: "DeepSeek Harness", ...SKY, glyph: "D", svg: G.dsh, image: IMG.dsh },
  grok: { label: "Grok", ...GREY, glyph: "G", svg: G.grok, image: IMG.grok },
  kilo: { label: "Kilo Code", ...BUTTER, glyph: "K", svg: G.kilo, image: IMG.kilo },
  kiro: { label: "Kiro", ...LAVENDER, glyph: "K", svg: G.kiro, image: IMG.kiro },
  mimocode: { label: "MiMo Code", ...PEACH, glyph: "M", svg: G.mimocode, image: IMG.mimocode },
  minimax: { label: "MiniMax Code", ...ROSE, glyph: "M", svg: G.minimax, image: IMG.minimax },
  openclaw: { label: "OpenClaw", ...ROSE, glyph: "O", svg: G.openclaw, image: IMG.openclaw },
  qoder: { label: "Qoder", ...MINT, glyph: "Q", svg: G.qoder, image: IMG.qoder },
  reasonix: { label: "Reasonix", ...SKY, glyph: "R", svg: G.reasonix, image: IMG.reasonix },
  roo: { label: "Roo Code", ...PEACH, glyph: "R", svg: G.roo, image: IMG.roo },
  zcode: { label: "ZCode", ...GREY, glyph: "Z", svg: G.zcode, image: IMG.zcode },

  // No bundled brand mark (see scripts/harness-icons.mjs); the sticker stands in for it.
  workbuddy: { label: "WorkBuddy", ...SKY, glyph: "W", image: IMG.workbuddy },
  factory: { label: "Factory Droid", ...PEACH, glyph: "D", image: IMG.factory },
  craft: { label: "Craft Agents", ...LAVENDER, glyph: "C", image: IMG.craft },
  crosery: { label: "Crosery Agent", ...ROSE, glyph: "C", image: IMG.crosery },
  prime: { label: "Prime Agent", ...GREY, glyph: "P", image: IMG.prime },
  kodu: { label: "Kodu", ...MINT, glyph: "K", image: IMG.kodu },
  // Launchers the computer offers that Uniflo doesn't track.
  amp: { label: "Amp", ...PEACH, glyph: "A", image: IMG.amp },
  crush: { label: "Crush", ...ROSE, glyph: "C", image: IMG.crush },
  goose: { label: "Goose", ...BUTTER, glyph: "G", image: IMG.goose },
  aider: { label: "Aider", ...MINT, glyph: "A", image: IMG.aider },
  iflow: { label: "iFlow", ...SKY, glyph: "i", image: IMG.iflow },
};

/** Program names herdr/hc report (lower-case) that differ from the Uniflo harness id. */
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

const SHELL: HarnessLook = { label: "终端", ...GREY, glyph: ">_", mono: true, image: IMG.shell };
const FALLBACKS = [ROSE, SKY, MINT, PEACH];

/** Uniflo harness id for a herdr/hc program name or a Uniflo id (claude-code -> claude, droid -> factory). */
export function unifloHarnessId(harness: string): string {
  const name = harness.toLowerCase();
  return ALIASES[name] ?? name;
}

/** Shape the relay accepts for `harness.icons` ids. */
const UNIFLO_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const cache = new Map<string, HarnessLook>();

export function harnessLook(harness: string, isShell: boolean): HarnessLook {
  if (isShell) return SHELL;
  const id = unifloHarnessId(harness);
  let look = cache.get(id);
  if (!look) {
    const known = LOOKS[id];
    const remoteId = UNIFLO_ID.test(id) ? id : undefined;
    if (known) look = known.image || known.svg ? known : { ...known, remoteId };
    else {
      let h = 0;
      for (const ch of harness) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      look = { label: harness, ...FALLBACKS[h % FALLBACKS.length]!, glyph: (harness[0] ?? "?").toUpperCase(), image: IMG.unknown, remoteId, generic: true };
    }
    cache.set(id, look);
  }
  return look;
}
