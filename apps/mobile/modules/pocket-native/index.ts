import { requireOptionalNativeModule, type EventSubscription } from "expo";

/** A picture from `pickImages`. */
export interface PickedImage {
  name: string;
  mime: "image/jpeg";
  /** Base64, no line breaks. */
  data: string;
  width: number;
  height: number;
  bytes: number;
}

/**
 * Native side: voice call audio, alerts as notifications, in-app updates, picking pictures.
 * Android (Kotlin) has all of it. iOS (Swift) has voice, pictures and notifications while
 * the app is open; it has no background alert service (`notifierState().background` false),
 * no battery exemption and no in-app install (`canInstallUpdates()` false, no download/install).
 */
interface PocketNativeModule {
  startCall(server: string, token: string): void;
  hangup(): void;
  setMuted(muted: boolean): void;
  callState(): { active: boolean; muted: boolean };
  configureNotifier(server: string | null, token: string | null, enabled: boolean, kinds: string[], name: string | null): void;
  /** `background`: alerts also arrive with the app closed. Absent on Android, where they always do; false on iOS. */
  notifierState(): { enabled: boolean; connected: boolean; notificationsAllowed: boolean; batteryUnrestricted: boolean; background?: boolean };
  requestBatteryExemption(): void;
  openNotificationSettings(): void;
  testNotice(title: string, body: string): void;
  /** iOS: asks for the microphone (Android uses PermissionsAndroid). */
  requestMicrophone?(): Promise<boolean>;
  /** iOS: asks to show notifications (Android uses PermissionsAndroid). */
  requestNotificationPermission?(): Promise<boolean>;
  /** In-app update (absent in builds before it existed). */
  appVersion?(): string | null;
  /** `sha256`: the APK's expected hash, or "" when unknown. */
  downloadUpdate?(url: string, fileName: string, size: number, sha256: string): Promise<string>;
  cancelUpdate?(): void;
  installUpdate?(path: string): "started" | "permission" | "missing";
  canInstallUpdates?(): boolean;
  /**
   * Picture picker (absent in builds before it existed): up to `max` pictures,
   * each a base64 JPEG whose longest side is at most `maxSide`. Cancelled: [].
   */
  pickImages?(max: number, maxSide: number, quality: number): Promise<PickedImage[]>;
  addListener(event: "onCall", fn: (e: { state: "connecting" | "ready" | "ended"; message?: string; muted?: boolean }) => void): EventSubscription;
  addListener(event: "onCallEvent", fn: (e: { json: string }) => void): EventSubscription;
  addListener(event: "onLevel", fn: (e: { mic: number; out: number }) => void): EventSubscription;
  addListener(event: "onNotice", fn: (e: { json: string }) => void): EventSubscription;
  /** iOS also reports `notificationsAllowed` when the person changes it in system settings. */
  addListener(event: "onNotifier", fn: (e: { connected: boolean; notificationsAllowed?: boolean }) => void): EventSubscription;
  addListener(event: "onUpdateProgress", fn: (e: { received: number; total: number }) => void): EventSubscription;
}

/** Null in builds without the module (e.g. a JS-only reload of an older APK). */
export const PocketNative = requireOptionalNativeModule<PocketNativeModule>("PocketNative");
