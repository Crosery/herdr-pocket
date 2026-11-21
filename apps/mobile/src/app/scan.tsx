import { useRef, useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";
import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { parseJoinLink, parsePairLink } from "@herdr-pocket/protocol";
import { EmptyState, PageBackground } from "../components/ui";
import { PocketButton } from "../components/pocket";
import { usePalette } from "../theme/theme";
import { radius, space } from "../theme/tokens";
import { markScannedInvite } from "../lib/session";

export default function ScanScreen() {
  const p = usePalette();
  const [permission, requestPermission] = useCameraPermissions();
  const [hint, setHint] = useState("对准邀请二维码，或新设备显示的加入二维码");
  const handled = useRef(false);

  if (!permission) return <PageBackground />;
  if (!permission.granted) {
    const canAsk = permission.canAskAgain !== false;
    return (
      <PageBackground>
        <EmptyState
          mood="waiting"
          title="需要用一下相机"
          body={canAsk ? "只用来扫二维码，不会拍照或录像。" : "请在系统设置中允许 Herdr Pocket 访问相机（只用来扫二维码）。"}
          action={
            <View style={{ gap: space.sm, alignItems: "center" }}>
              <PocketButton onPress={canAsk ? requestPermission : () => void Linking.openSettings()}>
                {canAsk ? "允许使用相机" : "去系统设置开启相机权限"}
              </PocketButton>
              {canAsk ? (
                <PocketButton variant="soft" size="sm" onPress={() => void Linking.openSettings()}>
                  打开系统设置
                </PocketButton>
              ) : null}
            </View>
          }
        />
      </PageBackground>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => {
          if (handled.current) return;
          // Two kinds of QR: an invite (this phone joins) and a join request (this phone lets another device in).
          const invite = parsePairLink(data);
          const join = invite ? null : parseJoinLink(data);
          if (!invite && !join) {
            setHint("这不是 Herdr Pocket 的二维码哦");
            return;
          }
          handled.current = true;
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
          if (invite) {
            markScannedInvite(invite.server, invite.code);
            router.replace({ pathname: "/pair", params: invite });
          }
          else router.replace({ pathname: "/join", params: join! });
        }}
      />
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }} pointerEvents="none">
        <View style={{ width: 240, height: 240, borderRadius: radius.xl, borderWidth: 3, borderColor: p.accentContainer }} />
        <View style={{ marginTop: space.xl, backgroundColor: "rgba(0,0,0,0.55)", paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.pill }}>
          <Text style={{ color: "#fff" }}>{hint}</Text>
        </View>
      </View>
    </View>
  );
}
