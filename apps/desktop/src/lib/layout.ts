import { useEffect, useState } from "react";
import { IS_HARMONY_TARGET, isH5Web, isHarmony, isTauri } from "./bridge";
import { recognizeWebDevice } from "./h5Identity";
import { createStore, settingsStore, type H5LayoutMode } from "./store";
import { clientConfigStore } from "./config";
import { native } from "./native";

/**
 * The one breakpoint table for JS and CSS (docs/design/desktop-v2.md section 3).
 * CSS mirrors these as `max-width: <bp - 0.02>px` so a width never falls between them.
 */
export const BP = {
  /** Below this: phone layout with a bottom tab bar (HarmonyOS always). */
  mobile: 860,
  /** Below this the sidebar folds to its icon rail on its own. */
  rail: 1100,
  /** From here on the roomiest sidebar and list widths. */
  wide: 1440,
} as const;

export type Tier = "mobile" | "rail" | "regular" | "wide";

export function tierFor(width: number, h5Mode: H5LayoutMode = "auto"): Tier {
  if (IS_HARMONY_TARGET || isHarmony()) return "mobile";
  if (isH5Web()) {
    if (h5Mode === "mobile") return "mobile";
    if (h5Mode === "desktop") {
      if (width < BP.rail) return "rail";
      if (width < BP.wide) return "regular";
      return "wide";
    }
    if (typeof navigator !== "undefined" && recognizeWebDevice().formFactor === "mobile") {
      return "mobile";
    }
  }
  if (width < BP.mobile) return isTauri() ? "rail" : "mobile";
  if (width < BP.rail) return "rail";
  if (width < BP.wide) return "regular";
  return "wide";
}

/** Layout tier only; skips re-renders on pixel-level window resizes within the same tier. */
export function useViewportTier(): Tier {
  const h5Mode = settingsStore.use((s) => s.h5LayoutMode);
  const [tier, setTier] = useState<Tier>(() =>
    tierFor(typeof window !== "undefined" ? window.innerWidth : 1200, h5Mode),
  );
  useEffect(() => {
    setTier(tierFor(typeof window !== "undefined" ? window.innerWidth : 1200, h5Mode));
    let frame = 0;
    const onResize = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const next = tierFor(window.innerWidth, settingsStore.get().h5LayoutMode);
        setTier((prev) => (prev === next ? prev : next));
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [h5Mode]);
  return tier;
}

export interface Viewport {
  width: number;
  height: number;
  tier: Tier;
}

function read(): Viewport {
  const width = typeof window !== "undefined" ? window.innerWidth : 1200;
  const height = typeof window !== "undefined" ? window.innerHeight : 800;
  return { width, height, tier: tierFor(width) };
}

/** Window size and layout tier; resize events are coalesced to one per frame. */
export function useViewport(): Viewport {
  const [vp, setVp] = useState(read);
  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const next = read();
        setVp((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return vp;
}

/** True while the window is hidden or minimised; nothing should tick or animate then. */
export function useWindowHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return hidden;
}

/**
 * Keeps two root attributes current: `data-idle` while the window is hidden and
 * `data-calm` when motion should be reduced (OS setting or the app's energy saver).
 * CSS pauses every endless animation under either.
 */
export const powerStore = createStore<{ onBattery: boolean; systemLowPower: boolean }>({ onBattery: false, systemLowPower: false });

/** `resources.lowPower`: "on" always, "auto" on battery or in the system's low power mode. */
export function useLowPower(): boolean {
  const mode = clientConfigStore.use((s) => s.config.resources.lowPower);
  const power = powerStore.use((s) => s);
  return mode === "on" || (mode === "auto" && (power.onBattery || power.systemLowPower));
}

export function useEnergyAttributes(): void {
  const hidden = useWindowHidden();
  const saver = useLowPower();
  // Battery state comes with the resource sample; one look a minute while visible is enough.
  useEffect(() => {
    if (hidden) return;
    let alive = true;
    const look = () =>
      void native.getResourceUsage().then((u) => {
        if (alive && u) powerStore.set({ onBattery: Boolean(u.onBattery), systemLowPower: Boolean(u.systemLowPower) });
      });
    look();
    const t = setInterval(look, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [hidden]);
  useEffect(() => {
    const root = document.documentElement;
    if (hidden) root.setAttribute("data-idle", "");
    else root.removeAttribute("data-idle");
  }, [hidden]);
  useEffect(() => {
    const root = document.documentElement;
    if (saver) root.setAttribute("data-calm", "");
    else root.removeAttribute("data-calm");
  }, [saver]);
}

/** Re-renders every `ms` while the window is visible, to keep "3 分钟前" labels honest. */
export function useVisibleTick(ms: number): number {
  const hidden = useWindowHidden();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (hidden) return;
    setN((v) => v + 1);
    const t = setInterval(() => setN((v) => v + 1), ms);
    return () => clearInterval(t);
  }, [hidden, ms]);
  return n;
}
