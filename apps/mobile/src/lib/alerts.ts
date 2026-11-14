/**
 * Background alerts: a resident Android service keeps /v1/notify open and posts
 * a notification when an agent needs you, finishes, or a reminder is due.
 */
import { useEffect } from "react";
import { PermissionsAndroid, Platform } from "react-native";
import { create } from "zustand";
import { PocketNative } from "../../modules/pocket-native";
import { useSettings } from "./store";
import { loadToken } from "./auth";
import { isMockServer } from "./mock";

export const alertsSupported = !!PocketNative;

interface AlertsState {
  connected: boolean;
  notificationsAllowed: boolean;
  batteryUnrestricted: boolean;
}

export const useAlerts = create<AlertsState>()(() => ({ connected: false, notificationsAllowed: true, batteryUnrestricted: false }));

export function refreshAlertState() {
  if (!PocketNative) return;
  const s = PocketNative.notifierState();
  useAlerts.setState({ connected: s.connected, notificationsAllowed: s.notificationsAllowed, batteryUnrestricted: s.batteryUnrestricted });
}

PocketNative?.addListener("onNotifier", (e) => useAlerts.setState({ connected: e.connected }));

/** Asks for the notification permission (Android 13+). */
export async function askNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  if (Number(Platform.Version) < 33) return true;
  const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  refreshAlertState();
  return r === PermissionsAndroid.RESULTS.GRANTED;
}

async function sync() {
  if (!PocketNative) return;
  const s = useSettings.getState();
  const real = !!s.server && !isMockServer(s.server);
  const token = real ? await loadToken() : null;
  const kinds = ["reminder", ...(s.alertBlocked ? ["blocked"] : []), ...(s.alertDone ? ["done"] : [])];
  try {
    PocketNative.configureNotifier(real ? s.server : null, token, real && s.alertsOn && !!token, kinds, "小羊");
  } catch {
    // Starting a foreground service can be refused while the app is in the background; it is retried on the next change.
  }
  refreshAlertState();
}

/** Keeps the native service in step with the pairing and the alert settings. */
export function useAlertSync() {
  const hydrated = useSettings((s) => s.hydrated);
  const server = useSettings((s) => s.server);
  const deviceId = useSettings((s) => s.deviceId);
  const on = useSettings((s) => s.alertsOn);
  const blocked = useSettings((s) => s.alertBlocked);
  const done = useSettings((s) => s.alertDone);
  const asked = useSettings((s) => s.alertsAsked);
  useEffect(() => {
    if (!hydrated) return;
    void sync();
  }, [hydrated, server, deviceId, on, blocked, done]);
  // First time on a real server: ask once, so alerts can show at all.
  useEffect(() => {
    if (!hydrated || asked || !server || isMockServer(server) || !PocketNative) return;
    useSettings.getState().set({ alertsAsked: true });
    void askNotificationPermission();
  }, [hydrated, asked, server]);
}
