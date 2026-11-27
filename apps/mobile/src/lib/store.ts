import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { Agent, ChatDisplayMode, Device, PortalDisplayMode, TutorialStatus } from "@herdr-pocket/protocol";
import type { TermKeyLayout } from "./termkeys";

export const safeAsyncStorage: StateStorage = {
  getItem: async (name) => {
    try {
      return await AsyncStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: async (name, value) => {
    try {
      await AsyncStorage.setItem(name, value);
    } catch {
      /* ignore SQLite/CursorWindow quota errors */
    }
  },
  removeItem: async (name) => {
    try {
      await AsyncStorage.removeItem(name);
    } catch {
      /* ignore */
    }
  },
};

export type ThemeMode = "system" | "light" | "dark";

export const VOICEPRINT_MODEL_VERSION = "eres2netv2-voxlock-v2";

export interface SavedVoiceprint {
  embedding: number[];
  prototypes?: number[][];
  modelVersion?: string;
  hasSample?: boolean;
  route?: string;
  snrDb?: number;
  seconds: number;
  consistency: number;
  createdAt: number;
}

/** A newer app release found on GitHub (see lib/update.ts). */
export interface ReleaseInfo {
  version: string;
  /** APK download URL; empty when the release has no Android asset yet. */
  url: string;
  fileName: string;
  size: number;
  /** The APK's SHA-256 from the release, when known; the download is checked against it. */
  sha256?: string;
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
  chatDisplayMode: ChatDisplayMode;
  portalDisplayMode: PortalDisplayMode;
  showShells: boolean;
  /** Agent list device switcher: a host deviceId, or null for all hosts. */
  hostFilter: string | null;
  /** Agent list groups the person folded (status keys, or `space:<host>:<name>` in the space view). */
  foldedGroups: string[];
  /** Agent list layout: one group per computer space, or one per status. */
  agentGrouping: "space" | "status";
  /** Computer the last agent was created on; the create sheet opens there when nothing else is asked for. */
  lastCreateHost: string | null;
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
  /** On-device call denoising and owner voiceprint filter. */
  voiceDenoise: boolean;
  voiceFilter: boolean;
  voiceThreshold: number;
  voiceTier: "auto" | "denoise" | "sv" | "tse";
  voiceFirstSpeaker: boolean;
  voiceprint: SavedVoiceprint | null;
  /** First-run real-UI walkthrough progress synced monotonically with the relay (0=new, 1=skipped, 2=done). */
  tutorialStatus: TutorialStatus;
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
      chatDisplayMode: "standard",
      portalDisplayMode: "collapsed",
      showShells: false,
      hostFilter: null,
      foldedGroups: [],
      agentGrouping: "space",
      lastCreateHost: null,
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
      voiceDenoise: true,
      voiceFilter: true,
      voiceThreshold: 0.38,
      voiceTier: "auto",
      voiceFirstSpeaker: false,
      voiceprint: null,
      tutorialStatus: 0,
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
  /** Computers this phone reaches directly (no relay): device id -> the address used. */
  direct: Record<string, string>;
  /** True once the relay has sent welcome.tutorialStatus for this connection. */
  tutorialServerSynced: boolean;
  /** Manual replay trigger from Settings. */
  tutorialReplayOpen: boolean;
  reset: () => void;
}

export const useLive = create<LiveState>()((set) => ({
  link: "idle",
  rttMs: null,
  self: null,
  devices: {},
  agents: {},
  lastError: null,
  direct: {},
  tutorialServerSynced: false,
  tutorialReplayOpen: false,
  reset: () =>
    set({
      link: "idle",
      rttMs: null,
      self: null,
      devices: {},
      agents: {},
      lastError: null,
      direct: {},
      tutorialServerSynced: false,
      tutorialReplayOpen: false,
    }),
}));

export function mergeMobileTutorialStatus(local: TutorialStatus, incoming: unknown): TutorialStatus {
  const n = incoming === 2 ? 2 : incoming === 1 ? 1 : 0;
  return (n > local ? n : local) as TutorialStatus;
}

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

/**
 * Where a message sent from this phone is: on its way, typed into the agent,
 * waiting behind the agent's turn, unconfirmed, or not delivered (see lib/outbox.ts).
 */
export type SendState = "sending" | "sent" | "queued" | "uncertain" | "failed";

/** A message sent from this phone, shown at once and followed until the agent's conversation shows it. */
export interface PendingSend {
  id: string;
  /** What the person wrote (without the picture paths the agent got). */
  text: string;
  ts: number;
  /** Image URIs of the pictures sent with it, for thumbnails. */
  pictures?: string[];
  state: SendState;
  /** The computer's send-queue id, matched against its `queue` stream events. */
  queueId?: string;
  /** It arrived during a turn: the agent's program holds it until the turn ends. */
  waiting?: boolean;
  /** When the computer took it. */
  sentAt?: number;
  /** Why it was not delivered. */
  error?: string;
  /** Id of the conversation's own copy, once it showed up: the bubble is that message from then on. */
  echo?: string;
}

interface PendingState {
  byAgent: Record<string, PendingSend[]>;
  /** Adds a message in the `sending` state; returns its id. */
  add: (agentKey: string, text: string, pictures?: string[]) => string;
  update: (agentKey: string, id: string, patch: Partial<Omit<PendingSend, "id">>) => void;
  drop: (agentKey: string, ids: string[]) => void;
}

const PENDING_PERSIST_MAX_CHARS = 1_500_000;
const INTERRUPTED_PENDING_ERROR = "应用重启前结果待确认";

function compactPendingByAgent(byAgent: Record<string, PendingSend[]>): Record<string, PendingSend[]> {
  const out: Record<string, PendingSend[]> = {};
  for (const [agentKey, list] of Object.entries(byAgent)) {
    if (!Array.isArray(list)) continue;
    const keep = list
      .filter((item) => item && item.state !== "sent" && !item.echo)
      .slice(-20)
      .map((item) => ({ ...item }));
    if (keep.length) out[agentKey] = keep;
  }
  if (JSON.stringify({ byAgent: out }).length <= PENDING_PERSIST_MAX_CHARS) {
    return out;
  }
  // Strip inline picture URIs oldest-first so message text/state survives under Android CursorWindow limits.
  const refs: Array<{ agentKey: string; item: PendingSend }> = [];
  for (const [agentKey, list] of Object.entries(out)) {
    for (const item of list) {
      if (item.pictures?.length) refs.push({ agentKey, item });
    }
  }
  refs.sort((a, b) => a.item.ts - b.item.ts);
  for (const { item } of refs) {
    delete item.pictures;
    if (JSON.stringify({ byAgent: out }).length <= PENDING_PERSIST_MAX_CHARS) {
      return out;
    }
  }
  // Still over budget: trim oldest entries across agents.
  const keys = Object.keys(out);
  while (JSON.stringify({ byAgent: out }).length > PENDING_PERSIST_MAX_CHARS && keys.length) {
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const k of keys) {
      const head = out[k]?.[0];
      if (head && head.ts < oldestTs) {
        oldestTs = head.ts;
        oldestKey = k;
      }
    }
    if (!oldestKey) break;
    out[oldestKey]!.shift();
    if (!out[oldestKey]!.length) {
      delete out[oldestKey];
      keys.splice(keys.indexOf(oldestKey), 1);
    }
  }
  return out;
}

function rehydratePendingByAgent(byAgent: unknown): Record<string, PendingSend[]> {
  if (!byAgent || typeof byAgent !== "object" || Array.isArray(byAgent)) return {};
  const out: Record<string, PendingSend[]> = {};
  for (const [agentKey, list] of Object.entries(byAgent as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const restored: PendingSend[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as PendingSend;
      if (typeof item.id !== "string" || typeof item.text !== "string") continue;
      if (item.state === "sent" || item.echo) continue;
      restored.push(
        item.state === "sending"
          ? { ...item, state: "uncertain", error: INTERRUPTED_PENDING_ERROR }
          : item,
      );
    }
    if (restored.length) out[agentKey] = restored.slice(-20);
  }
  return out;
}

export const usePending = create<PendingState>()(
  persist(
    (set) => ({
      byAgent: {},
      add: (agentKey, text, pictures) => {
        const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        set((s) => ({
          byAgent: {
            ...s.byAgent,
            [agentKey]: [
              ...(s.byAgent[agentKey] ?? []),
              {
                id,
                text,
                ts: Date.now(),
                pictures: pictures?.length ? pictures : undefined,
                state: "sending" as const,
              },
            ].slice(-20),
          },
        }));
        return id;
      },
      update: (agentKey, id, patch) =>
        set((s) => {
          const list = s.byAgent[agentKey];
          if (!list?.some((x) => x.id === id)) return s;
          return {
            byAgent: {
              ...s.byAgent,
              [agentKey]: list.map((x) => (x.id === id ? { ...x, ...patch } : x)),
            },
          };
        }),
      drop: (agentKey, ids) =>
        set((s) => {
          const left = (s.byAgent[agentKey] ?? []).filter((x) => !ids.includes(x.id));
          const next = { ...s.byAgent };
          if (left.length) next[agentKey] = left;
          else delete next[agentKey];
          return { byAgent: next };
        }),
    }),
    {
      name: "hp.mobile.pending.v1",
      storage: createJSONStorage(() => safeAsyncStorage),
      partialize: (s) => ({ byAgent: compactPendingByAgent(s.byAgent) }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        state.byAgent = rehydratePendingByAgent(state.byAgent);
      },
    },
  ),
);

export type AppToastTone = "hangup" | "info" | "error";

interface AppToastState {
  id: number;
  message: string | null;
  tone: AppToastTone;
  duration?: number;
  show: (message: string, opts?: { tone?: AppToastTone; duration?: number }) => void;
  dismiss: () => void;
}

/** App-wide transient feedback banner for actions that dismiss sheets or switch routes. */
export const useAppToast = create<AppToastState>()((set) => ({
  id: 0,
  message: null,
  tone: "info",
  duration: undefined,
  show: (message, opts) =>
    set((s) => ({
      id: s.id + 1,
      message,
      tone: opts?.tone ?? "info",
      duration: opts?.duration,
    })),
  dismiss: () => set({ message: null, duration: undefined }),
}));

export function showAppToast(message: string, opts?: { tone?: AppToastTone; duration?: number }): void {
  useAppToast.getState().show(message, opts);
}
