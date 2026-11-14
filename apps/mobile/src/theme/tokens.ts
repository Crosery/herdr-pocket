import { Easing } from "react-native-reanimated";
import type { AgentStatus } from "@herdr-pocket/protocol";

/** Spacing scale (dp). */
export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 } as const;

/** Corner radii: cards 20, composer/sheets 28, chips/buttons pill. */
export const radius = { xs: 8, sm: 12, md: 16, card: 20, xl: 28, pill: 999 } as const;

export const motion = {
  press: 90,
  quick: 160,
  standard: 240,
  breathe: 2400,
  glide: Easing.bezier(0.32, 0.72, 0, 1),
} as const;

export const fonts = {
  cute: "ZCOOLKuaiLe_400Regular",
  body: "Nunito_400Regular",
  bodySemi: "Nunito_600SemiBold",
  bodyBold: "Nunito_700Bold",
  mono: "MapleMono-Regular",
  monoBold: "MapleMono-Bold",
} as const;

/** Brand colours shared by light and dark (decorative fills, never small text on white). */
export const brand = {
  pink: "#FF7EA8",
  pinkPressed: "#EE5F8E",
  pinkContainer: "#FFE3EC",
  lavender: "#C9B6F7",
  lavenderContainer: "#F1EBFF",
  blush: "#FFB3C8",
  plum: "#4A3B5C",
  white: "#FFFFFF",
} as const;

export interface Palette {
  dark: boolean;
  pageTop: string;
  pageBottom: string;
  page: string;
  surface: string; // cards
  surface2: string; // nested / inputs
  surface3: string; // tinted chips, pressed
  ink: string;
  muted: string;
  faint: string;
  divider: string;
  /** Primary button fill + its label colour (AA). */
  primary: string;
  primaryPressed: string;
  onPrimary: string;
  /** Pink used for text/icons on light surfaces (AA). */
  accentText: string;
  accentContainer: string;
  lavender: string;
  lavenderContainer: string;
  onLavender: string;
  bubble: string;
  glass: string;
  shadow: string;
  error: string;
  errorContainer: string;
  dusk: string; // reasoning / planning
  duskContainer: string;
}

export function makePalette(dark: boolean): Palette {
  if (dark) {
    return {
      dark,
      pageTop: "#221D2B",
      pageBottom: "#1E1A26",
      page: "#1E1A26",
      surface: "#27212F",
      surface2: "#312A3B",
      surface3: "#3A3246",
      ink: "#F3EDF7",
      muted: "#CFC5DA",
      faint: "#A79DB5",
      divider: "#3A3246",
      primary: "#FF7EA8",
      primaryPressed: "#FF9DBD",
      onPrimary: "#1E1A26",
      accentText: "#FF9DBD",
      accentContainer: "#4A2B3A",
      lavender: "#C9B6F7",
      lavenderContainer: "#352C4A",
      onLavender: "#F3EDF7",
      bubble: "#4A2B3A",
      glass: "#27212F",
      shadow: "#000000",
      error: "#FFA3AF",
      errorContainer: "#45262C",
      dusk: "#C7B6FF",
      duskContainer: "#332B4D",
    };
  }
  return {
    dark,
    pageTop: "#FFF6F9",
    pageBottom: "#F7F2FF",
    page: "#FBF4FC",
    surface: "#FFFFFF",
    surface2: "#FFF9FB",
    surface3: "#FBF6FF",
    ink: "#4A3B5C",
    muted: "#6E6280",
    faint: "#746A83",
    divider: "#F1E4EC",
    primary: "#FF8FB3",
    primaryPressed: "#FF7EA8",
    onPrimary: "#4A3B5C",
    accentText: "#B8336A",
    accentContainer: "#FFE3EC",
    lavender: "#C9B6F7",
    lavenderContainer: "#F1EBFF",
    onLavender: "#4A3B5C",
    bubble: "#FFE3EC",
    glass: "#FFFFFF",
    shadow: "#E58AAE",
    error: "#B83A52",
    errorContainer: "#FFE6E9",
    dusk: "#6E51D2",
    duskContainer: "#F1EBFF",
  };
}

/** Status: always colour + text + tinted background. Light shades darkened for ≥4.5:1. */
export function statusColors(status: AgentStatus, dark: boolean): { fg: string; bg: string } {
  const light: Record<AgentStatus, { fg: string; bg: string }> = {
    blocked: { fg: "#B83A52", bg: "#FFE6E9" },
    working: { fg: "#177861", bg: "#DDF5EE" },
    done: { fg: "#6E51D2", bg: "#EEE8FF" },
    idle: { fg: "#716782", bg: "#F2EFF5" },
    unknown: { fg: "#716782", bg: "#F2EFF5" },
  };
  const night: Record<AgentStatus, { fg: string; bg: string }> = {
    blocked: { fg: "#FFA3AF", bg: "#45262C" },
    working: { fg: "#7DDBC0", bg: "#1F3A33" },
    done: { fg: "#C7B6FF", bg: "#332B4D" },
    idle: { fg: "#BDB3CC", bg: "#2E2936" },
    unknown: { fg: "#BDB3CC", bg: "#2E2936" },
  };
  return (dark ? night : light)[status];
}

export const statusLabel: Record<AgentStatus, string> = {
  blocked: "需要你",
  working: "工作中",
  done: "已完成",
  idle: "空闲",
  unknown: "未知",
};

/** The word on an agent's status chip: an error says so, though its status is `blocked`. */
export function agentStatusLabel(a: { status: AgentStatus; errored?: boolean }): string {
  return a.errored ? "出错了" : statusLabel[a.status];
}

/** Space swatches, reusing the status/accent pairs (all fg/bg pairs already ≥4.5:1). */
export function spaceColors(name: string, dark: boolean, hash: (s: string) => number): { fg: string; bg: string } {
  const light = [
    { fg: "#B8336A", bg: "#FFE3EC" },
    { fg: "#6E51D2", bg: "#EEE8FF" },
    { fg: "#177861", bg: "#DDF5EE" },
    { fg: "#B83A52", bg: "#FFE6E9" },
    { fg: "#716782", bg: "#F2EFF5" },
  ];
  const night = [
    { fg: "#FF9DBD", bg: "#4A2B3A" },
    { fg: "#C7B6FF", bg: "#332B4D" },
    { fg: "#7DDBC0", bg: "#1F3A33" },
    { fg: "#FFA3AF", bg: "#45262C" },
    { fg: "#BDB3CC", bg: "#2E2936" },
  ];
  const set = dark ? night : light;
  return set[hash(name) % set.length]!;
}
