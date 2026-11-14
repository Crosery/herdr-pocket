import { requireOptionalNativeModule, type EventSubscription } from "expo";

/** Android-only native side: voice call audio, the background alert service, notifications, in-app updates. */
interface PocketNativeModule {
  startCall(server: string, token: string): void;
  hangup(): void;
  setMuted(muted: boolean): void;
  callState(): { active: boolean; muted: boolean };
  configureNotifier(server: string | null, token: string | null, enabled: boolean, kinds: string[], name: string | null): void;
  notifierState(): { enabled: boolean; connected: boolean; notificationsAllowed: boolean; batteryUnrestricted: boolean };
  requestBatteryExemption(): void;
  openNotificationSettings(): void;
  testNotice(title: string, body: string): void;
  /** In-app update (absent in builds before it existed). */
  appVersion?(): string | null;
  downloadUpdate?(url: string, fileName: string, size: number): Promise<string>;
  cancelUpdate?(): void;
  installUpdate?(path: string): "started" | "permission" | "missing";
  canInstallUpdates?(): boolean;
  addListener(event: "onCall", fn: (e: { state: "connecting" | "ready" | "ended"; message?: string; muted?: boolean }) => void): EventSubscription;
  addListener(event: "onCallEvent", fn: (e: { json: string }) => void): EventSubscription;
  addListener(event: "onLevel", fn: (e: { mic: number; out: number }) => void): EventSubscription;
  addListener(event: "onNotice", fn: (e: { json: string }) => void): EventSubscription;
  addListener(event: "onNotifier", fn: (e: { connected: boolean }) => void): EventSubscription;
  addListener(event: "onUpdateProgress", fn: (e: { received: number; total: number }) => void): EventSubscription;
}

/** Null in builds without the module (e.g. a JS-only reload of an older APK). */
export const PocketNative = requireOptionalNativeModule<PocketNativeModule>("PocketNative");
