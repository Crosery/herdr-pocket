/**
 * Looks for a new app version in the background and, once per version, asks gently.
 * After that the news only stays in Settings.
 */
import { useEffect } from "react";
import { AppState } from "react-native";
import { Text } from "react-native-paper";
import { router } from "expo-router";
import { checkForUpdate, currentVersion, downloadUpdate, useNewRelease, useUpdate } from "../lib/update";
import { useSettings } from "../lib/store";
import { Mascot } from "./Mascot";
import { PocketDialog } from "./pocket";
import { usePalette } from "../theme/theme";

export function UpdatePrompt() {
  const p = usePalette();
  const release = useNewRelease();
  const phase = useUpdate((s) => s.phase);
  const prompted = useSettings((s) => s.updatePrompted);

  useEffect(() => {
    void checkForUpdate();
    const sub = AppState.addEventListener("change", (st) => st === "active" && void checkForUpdate());
    return () => sub.remove();
  }, []);

  const visible = !!release && phase === "available" && prompted !== release.version;
  const close = () => release && useSettings.getState().set({ updatePrompted: release.version });

  return (
    <PocketDialog
      visible={visible}
      onDismiss={close}
      hero={<Mascot mood="hello" size={72} />}
      title="有新版本啦"
      body={`Herdr Pocket v${release?.version ?? ""} 已经发布，你现在用的是 v${currentVersion()}。`}
      actions={[
        { label: "以后再说", onPress: close, tone: "ghost" },
        {
          label: "现在更新",
          onPress: () => {
            close();
            router.navigate("/settings");
            void downloadUpdate();
          },
        },
      ]}
    >
      {release?.notes ? (
        <Text numberOfLines={4} style={{ color: p.faint, fontSize: 13, lineHeight: 19, textAlign: "center" }}>
          {release.notes}
        </Text>
      ) : null}
    </PocketDialog>
  );
}
