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

export type VoiceTier = "auto" | "denoise" | "sv" | "tse";

export interface VoiceBenchmarkResult {
  recommendedTier: "denoise" | "sv" | "tse";
  reason: string;
  dpdfUs: number;
  tseRtf: number;
  cores: number;
  ramMb: number;
  soc: string;
  at: number;
}

export interface NativeVoiceState {
  denoise: boolean;
  filter: boolean;
  threshold: number;
  voiceTier?: VoiceTier;
  firstSpeaker?: boolean;
  enrolled: boolean;
  svReady?: boolean;
  tseModelsReady?: boolean;
  tseReady?: boolean;
  modelVersion?: string;
  legacyEnrolled?: boolean;
  modelReady: boolean;
  modelDownloading: boolean;
  svSize?: number;
  modelSize: number;
  recommendedTier?: "denoise" | "sv" | "tse" | null;
  recommendReason?: string | null;
  benchDpdfUs?: number | null;
  benchTseRtf?: number | null;
  benchAt?: number;
}

export interface EnrolledVoiceprint {
  embedding: number[];
  prototypes?: number[][];
  modelVersion?: string;
  hasSample?: boolean;
  route?: string;
  snrDb?: number;
  seconds: number;
  consistency: number;
  lowest: number;
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
  /** On-device voice denoising and owner voiceprint filtering (absent in older builds). */
  voiceState?(): NativeVoiceState;
  setVoiceSettings?(denoise: boolean, filter: boolean, threshold: number): void;
  setVoiceMode?(tier: VoiceTier, firstSpeaker: boolean): void;
  setVoiceprint?(embedding: number[] | null): void;
  setVoiceprintMeta?(prototypes: number[][] | null, modelVersion: string | null): void;
  prepareVoiceModel?(): Promise<boolean>;
  prepareVoiceTier?(tier: "sv" | "tse"): Promise<boolean>;
  benchmarkVoiceDevice?(): Promise<VoiceBenchmarkResult>;
  cancelVoiceModel?(): void;
  startVoiceEnroll?(): Promise<boolean>;
  finishVoiceEnroll?(): Promise<EnrolledVoiceprint>;
  cancelVoiceEnroll?(): void;
  startVoiceTest?(threshold: number): Promise<boolean>;
  stopVoiceTest?(): void;
  addListener(event: "onCall", fn: (e: { state: "connecting" | "ready" | "ended"; message?: string; muted?: boolean }) => void): EventSubscription;
  addListener(event: "onCallEvent", fn: (e: { json: string }) => void): EventSubscription;
  addListener(event: "onLevel", fn: (e: { mic: number; out: number }) => void): EventSubscription;
  addListener(event: "onNotice", fn: (e: { json: string }) => void): EventSubscription;
  /** iOS also reports `notificationsAllowed` when the person changes it in system settings. */
  addListener(event: "onNotifier", fn: (e: { connected: boolean; notificationsAllowed?: boolean }) => void): EventSubscription;
  addListener(event: "onUpdateProgress", fn: (e: { received: number; total: number }) => void): EventSubscription;
  addListener(event: "onVoiceModelProgress", fn: (e: { received: number; total: number }) => void): EventSubscription;
  addListener(event: "onEnrollProgress", fn: (e: { level: number; seconds: number; full: boolean }) => void): EventSubscription;
  addListener(
    event: "onVoiceTest",
    fn: (e: {
      level: number;
      speaking: boolean;
      score?: number;
      rawScore?: number;
      protoScore?: number;
      pass?: boolean;
      inferMs?: number;
      route?: string;
    }) => void,
  ): EventSubscription;
}

/** Null in builds without the module (e.g. a JS-only reload of an older APK). */
export const PocketNative = requireOptionalNativeModule<PocketNativeModule>("PocketNative");
