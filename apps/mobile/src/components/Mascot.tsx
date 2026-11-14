/**
 * The Herdr Pocket mascot — the anime sheep girl from docs/brand/.
 * Each mood maps to a trimmed transparent sticker (≤512px) in assets/mascot/.
 * `size` is the side of the square box the sticker is fitted into (aspect ratio kept).
 */
import { memo } from "react";
import { Image } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { brand } from "../theme/tokens";

export type MascotMood = "default" | "hello" | "waiting" | "sleepy" | "yay";

const STICKERS = {
  default: require("../../assets/mascot/default.png"),
  hello: require("../../assets/mascot/hello.png"),
  waiting: require("../../assets/mascot/waiting.png"),
  sleepy: require("../../assets/mascot/sleepy.png"),
  yay: require("../../assets/mascot/yay.png"),
} as const;

const LABEL: Record<MascotMood, string> = {
  default: "小羊",
  hello: "小羊在挥手",
  waiting: "小羊举手等你",
  sleepy: "小羊抱着枕头睡着了",
  yay: "小羊在欢呼",
};

export const Mascot = memo(function Mascot({ mood = "default", size = 64 }: { mood?: MascotMood; size?: number }) {
  return (
    <Image
      source={STICKERS[mood]}
      resizeMode="contain"
      style={{ width: size, height: size }}
      accessible
      accessibilityRole="image"
      accessibilityLabel={LABEL[mood]}
    />
  );
});

/** Animated stickers (animated WebP with alpha; the first frame shows where animation is off). */
export const MASCOT_ANIM = {
  idle: require("../../assets/mascot/anim/idle.webp"),
  tap: require("../../assets/mascot/anim/tap.webp"),
  working: require("../../assets/mascot/anim/working.webp"),
} as const;

/** The mascot hard at work, on a loop (the agent is busy). */
export const BusyMascot = memo(function BusyMascot({ size = 30 }: { size?: number }) {
  return <Image source={MASCOT_ANIM.working} resizeMode="contain" style={{ width: size, height: size }} accessible accessibilityRole="image" accessibilityLabel="小羊在忙" />;
});

const PLUM = "#4A3B5C";
const SPARKLE = "M0 -16 C2.5 -4 4 -2.5 16 0 C4 2.5 2.5 4 0 16 C-2.5 4 -4 2.5 -16 0 C-4 -2.5 -2.5 -4 0 -16Z";

/** Tiny four-point sparkle (use sparingly, ≤2 per screen). */
export function Sparkle({ size = 14, color = brand.pink }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="-16 -16 32 32">
      <Path d={SPARKLE} fill={color} />
    </Svg>
  );
}

/** Small bow motif with a plum outline. */
export function Bow({ size = 18, color = brand.pink }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size * 0.62} viewBox="-66 -42 132 84">
      <Path d="M0 0 C-13 -28 -54 -37 -58 -6 C-60 20 -21 22 0 0Z" fill={color} stroke={PLUM} strokeWidth={9} strokeLinejoin="round" />
      <Path d="M0 0 C13 -28 54 -37 58 -6 C60 20 21 22 0 0Z" fill={color} stroke={PLUM} strokeWidth={9} strokeLinejoin="round" />
      <Circle r={14} fill={brand.pinkPressed} stroke={PLUM} strokeWidth={9} />
    </Svg>
  );
}
