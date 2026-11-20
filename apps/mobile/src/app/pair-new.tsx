/** Invite: one QR + code that lets in a phone (scan it) or a computer (run the command). */
import { useEffect, useRef, useState } from "react";
import { ScrollView, Share, View } from "react-native";
import { Text } from "react-native-paper";
import QRCode from "react-native-qrcode-svg";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useMutation } from "@tanstack/react-query";
import type { PairCode } from "@herdr-pocket/protocol";
import { createPairCode } from "../lib/relay";
import { loadToken } from "../lib/auth";
import { friendlyError } from "../lib/session";
import { useLive, useSettings } from "../lib/store";
import { Card } from "../components/ui";
import { PocketButton, PocketProgress, PocketSpinner } from "../components/pocket";
import { Mascot, Sparkle } from "../components/Mascot";
import { usePalette } from "../theme/theme";
import { brand, fonts, radius, space } from "../theme/tokens";

const TTL_FALLBACK = 10 * 60_000;

function useCountdown(until?: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  if (!until) return null;
  const ms = Math.max(0, until - now);
  const s = Math.round(ms / 1000);
  return { ms, left: s, text: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` };
}

export default function InviteScreen() {
  const p = usePalette();
  const server = useSettings((s) => s.server);
  const [copied, setCopied] = useState(false);
  const [issuedAt, setIssuedAt] = useState(Date.now());
  // Devices that existed when the invite was issued; a new one means the invite was used.
  const known = useRef<Set<string> | null>(null);
  const m = useMutation<PairCode, Error, void>({
    mutationFn: async () => createPairCode(server ?? "", (await loadToken()) ?? "mock-token"),
    onSuccess: () => {
      setIssuedAt(Date.now());
      known.current = new Set(Object.keys(useLive.getState().devices));
    },
  });
  const devices = useLive((s) => s.devices);
  const joined = m.data && known.current ? Object.values(devices).find((d) => !known.current!.has(d.id)) : undefined;
  const cd = useCountdown(m.data?.expiresAt);
  const expired = cd?.left === 0;
  const total = m.data ? Math.max(1, m.data.expiresAt - issuedAt) : TTL_FALLBACK;

  useEffect(() => {
    m.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The link carries the server too, so the computer needs nothing else.
  const hostCmd = m.data ? `herdr-pocket up ${m.data.link}` : "";

  async function share() {
    if (!m.data || !cd) return;
    const mins = Math.max(1, Math.floor(cd.left / 60));
    await Share.share({
      message: `用 Herdr Pocket 打开这个链接就能连上（${mins} 分钟内有效，只能用一次）：\n${m.data.link}\n打不开时在 App 里输入配对码 ${m.data.code}`,
    }).catch(() => undefined);
  }

  if (joined) {
    const waiting = joined.kind === "host" && !joined.online;
    return (
      <View style={{ flex: 1, backgroundColor: p.page, alignItems: "center", justifyContent: "center", padding: space.xxl, gap: space.md }}>
        <Mascot mood="yay" size={150} />
        <Text style={{ fontFamily: fonts.cute, fontSize: 26, lineHeight: 34, color: p.ink, textAlign: "center" }}>“{joined.name}”加入啦</Text>
        <Text style={{ color: p.muted, textAlign: "center", lineHeight: 21 }}>
          {joined.kind === "viewer"
            ? "那台手机已经可以看到你的 agent 了。"
            : waiting
              ? "电脑已经登记，但还没上线。在那台电脑上运行 herdr-pocket up，它的 agent 才会出现在列表里。"
              : "电脑已经上线，它的 agent 会出现在列表里。"}
        </Text>
        <PocketButton size="lg" block onPress={() => router.back()} style={{ marginTop: space.md }}>
          完成
        </PocketButton>
        <PocketButton variant="text" onPress={() => m.mutate()}>
          再邀请一台
        </PocketButton>
      </View>
    );
  }

  return (
    // contentInsetAdjustmentBehavior: iOS keeps the last line clear of the home indicator; Android ignores it.
    <ScrollView style={{ backgroundColor: p.page }} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
      <Card style={{ alignItems: "center", gap: space.lg, padding: space.xl, borderRadius: radius.xl }}>
        {m.isPending ? (
          <PocketSpinner size={32} style={{ marginVertical: 120 }} />
        ) : m.isError ? (
          <View style={{ alignItems: "center", gap: space.md, paddingVertical: space.xxl }}>
            <Mascot mood="waiting" size={80} />
            <Text style={{ color: p.error, textAlign: "center" }}>{friendlyError(m.error)}</Text>
            <PocketButton variant="text" onPress={() => m.mutate()}>再试一次</PocketButton>
          </View>
        ) : m.data ? (
          <>
            <Text style={{ color: p.muted, textAlign: "center", lineHeight: 21 }}>让另一台手机用相机或 Herdr Pocket 扫这个码，它就连上了</Text>
            <View style={{ padding: space.md, backgroundColor: "#FFFFFF", borderRadius: radius.card, opacity: expired ? 0.3 : 1 }}>
              <QRCode value={m.data.link} size={196} color={brand.plum} backgroundColor="#FFFFFF" />
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Sparkle size={12} />
              <Text selectable style={{ fontFamily: fonts.cute, fontSize: 26, lineHeight: 34, letterSpacing: 2, color: expired ? p.faint : p.ink }}>
                {m.data.code}
              </Text>
              <Sparkle size={12} color={brand.lavender} />
            </View>
            <View style={{ alignSelf: "stretch", gap: space.sm }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ color: expired ? p.error : p.muted, fontSize: 13.5 }}>{expired ? "已过期" : "有效期，只能用一次"}</Text>
                <Text style={{ fontFamily: fonts.cute, fontSize: 16, color: expired ? p.error : p.ink }}>{cd?.text}</Text>
              </View>
              <PocketProgress progress={cd ? cd.ms / total : 0} color={brand.pink} />
            </View>
            {expired ? (
              <PocketButton icon="refresh" onPress={() => m.mutate()}>
                换一个新的
              </PocketButton>
            ) : (
              <PocketButton variant="soft" size="lg" block icon="share-variant" onPress={share}>
                把邀请链接发给自己的另一台设备
              </PocketButton>
            )}
          </>
        ) : null}
      </Card>

      {m.data ? (
        <Card style={{ padding: space.lg, gap: space.md }}>
          <Text style={{ fontFamily: fonts.bodyBold, color: p.ink, fontSize: 15 }}>要加的是电脑？</Text>
          <Text style={{ color: p.muted, fontSize: 13.5, lineHeight: 20 }}>
            在那台电脑上运行这条命令就连上了。也可以在那台电脑上运行 herdr-pocket up --server 服务器地址，再回“设备”页点“扫一扫”扫它的二维码。
          </Text>
          <View style={{ backgroundColor: p.surface3, borderRadius: radius.sm, padding: space.md }}>
            <Text selectable style={{ fontFamily: fonts.mono, fontSize: 12.5, lineHeight: 19, color: p.ink }}>
              {hostCmd}
            </Text>
          </View>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <PocketButton variant="soft" grow icon={copied ? "check" : "content-copy"} onPress={async () => {
                await Clipboard.setStringAsync(hostCmd);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}>
              {copied ? "已复制" : "复制命令"}
            </PocketButton>
            <PocketButton variant="ghost" grow icon="qrcode-scan" onPress={() => router.replace("/scan")}>
              去扫一扫
            </PocketButton>
          </View>
        </Card>
      ) : null}

      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.xs }}>
        <Mascot mood="hello" size={64} />
        <Text style={{ flex: 1, color: p.muted, fontSize: 13.5, lineHeight: 20 }}>对方连上后这里会自动提示。只把二维码给你自己的设备看。</Text>
      </View>
    </ScrollView>
  );
}
