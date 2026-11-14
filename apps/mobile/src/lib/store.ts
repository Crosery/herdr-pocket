import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Agent, Device } from "@herdr-pocket/protocol";
import type { TermKeyLayout } from "./termkeys";

export type ThemeMode = "system" | "light" | "dark";

/** A newer app release found on GitHub (see lib/update.ts). */
export interface ReleaseInfo {
  version: string;
  /** APK download URL; empty when the release has no Android asset yet. */
  url: string;
  fileName: string;
  size: number;
  /** Release page, for reading or downloading by hand. */
  page: string;
  notes: string;
}

interface SettingsState {
  /** Relay base URL, e.g. https://pocket.example.com, or mock://demo. Null until set up. */
  server: string | null;
  /** Last real relay this phone paired with; kept across sign-out so re-pairing only needs a code. */
  lastServer: string | null;
  deviceId: string | null;
  deviceName: string | null;
  themeMode: ThemeMode;
  textScale: number;
  showShells: boolean;
  /** Agent list device switcher: a host deviceId, or null for all hosts. */
  hostFilter: string | null;
  /** Agent list groups the person folded (blocked / working / done / idle / offline). */
  foldedGroups: string[];
  /** Accessory key bar order/visibility (normalise with normalizeTermKeyLayout). */
  termKeys: TermKeyLayout | null;
  /** Terminal keyboard button opens the phone's own key panel ("pad") or the system input method. */
  termInput: "pad" | "system";
  /** Key row height of that panel in dp (clampPadRow). */
  termPadRow: number;
  /** Background alerts (a resident service keeps the push channel open). */
  alertsOn: boolean;
  alertBlocked: boolean;
  alertDone: boolean;
  /** Whether the notification permission was asked once already. */
  alertsAsked: boolean;
  /** In-app update: last check, what it found, and the version the one-time prompt was shown for. */
  updateCheckedAt: number;
  updateRelease: ReleaseInfo | null;
  updatePrompted: string | null;
  hydrated: boolean;
  set: (patch: Partial<Omit<SettingsState, "set" | "hydrated">>) => void;
  signOut: () => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      server: null,
      lastServer: null,
      deviceId: null,
      deviceName: null,
      themeMode: "system",
      textScale: 1,
      showShells: false,
      hostFilter: null,
      foldedGroups: [],
      termKeys: null,
      termInput: "pad",
      termPadRow: 34,
      alertsOn: true,
      alertBlocked: true,
      alertDone: true,
      alertsAsked: false,
      updateCheckedAt: 0,
      updateRelease: null,
      updatePrompted: null,
      hydrated: false,
      set: (patch) => set(patch),
      signOut: () =>
        set((s) => ({
          server: null,
          deviceId: null,
          deviceName: null,
          hostFilter: null,
          lastServer: s.server && !s.server.startsWith("mock://") ? s.server : s.lastServer,
        })),
    }),
    {
      name: "herdr-pocket.settings",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: ({ hydrated: _h, set: _s, signOut: _o, ...rest }) => rest,
      onRehydrateStorage: () => () => {
        useSettings.setState({ hydrated: true });
      },
    },
  ),
);

export type LinkStatus = "idle" | "connecting" | "online" | "offline" | "unauthorized";

interface LiveState {
  link: LinkStatus;
  rttMs: number | null;
  self: Device | null;
  devices: Record<string, Device>;
  /** Agents keyed by host deviceId. */
  agents: Record<string, Agent[]>;
  lastError: string | null;
  reset: () => void;
}

export const useLive = create<LiveState>()((set) => ({
  link: "idle",
  rttMs: null,
  self: null,
  devices: {},
  agents: {},
  lastError: null,
  reset: () => set({ link: "idle", rttMs: null, self: null, devices: {}, agents: {}, lastError: null }),
}));

export function allAgents(agents: Record<string, Agent[]>): Agent[] {
  return Object.values(agents).flat();
}

export function findAgent(key: string): Agent | undefined {
  const { agents } = useLive.getState();
  for (const list of Object.values(agents)) {
    const a = list.find((x) => x.key === key);
    if (a) return a;
  }
  return undefined;
}

/** A message sent from this phone that the agent's conversation has not shown yet. */
export interface PendingSend {
  id: string;
  /** What the person wrote (without the picture paths the agent got). */
  text: string;
  ts: number;
  /** Image URIs of the pictures sent with it, for thumbnails. */
  pictures?: string[];
}

interface PendingState {
  byAgent: Record<string, PendingSend[]>;
  add: (agentKey: string, text: string, pictures?: string[]) => void;
  drop: (agentKey: string, ids: string[]) => void;
}

export const usePending = create<PendingState>()((set) => ({
  byAgent: {},
  add: (agentKey, text, pictures) =>
    set((s) => ({
      byAgent: {
        ...s.byAgent,
        [agentKey]: [...(s.byAgent[agentKey] ?? []), { id: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text, ts: Date.now(), pictures: pictures?.length ? pictures : undefined }].slice(-20),
      },
    })),
  drop: (agentKey, ids) =>
    set((s) => {
      const left = (s.byAgent[agentKey] ?? []).filter((x) => !ids.includes(x.id));
      return { byAgent: { ...s.byAgent, [agentKey]: left } };
    }),
}));
