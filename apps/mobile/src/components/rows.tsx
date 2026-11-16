import type { ComponentProps, ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";
import { Text } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import Animated, { interpolateColor, useAnimatedStyle, useDerivedValue, withTiming } from "react-native-reanimated";
import { usePalette } from "../theme/theme";
import { fonts, motion, radius, space } from "../theme/tokens";

export type RowIcon = ComponentProps<typeof MaterialCommunityIcons>["name"];

/** Hairline between rows of a settings card, starting after the icon tile. */
export function RowDivider() {
  const p = usePalette();
  return <View style={{ height: 1, backgroundColor: p.divider, marginLeft: space.lg + 40 + space.md, marginRight: space.lg }} />;
}

/**
 * One setting: a tinted icon tile, what it is, one line of what it does, and its
 * control on the right. Bigger controls (theme tiles, sizes) go underneath as children.
 */
export function Row({
  icon,
  title,
  sub,
  right,
  onPress,
  tone,
  dim,
  children,
}: {
  icon: RowIcon;
  title: string;
  sub?: string;
  right?: ReactNode;
  onPress?: () => void;
  tone?: "error";
  dim?: boolean;
  children?: ReactNode;
}) {
  const p = usePalette();
  const fg = tone === "error" ? p.error : p.accentText;
  const body = (
    <View style={{ paddingHorizontal: space.lg, paddingVertical: space.md, opacity: dim ? 0.55 : 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 44 }}>
        <View style={{ width: 40, height: 40, borderRadius: radius.sm, backgroundColor: tone === "error" ? p.errorContainer : p.accentContainer, alignItems: "center", justifyContent: "center" }}>
          <MaterialCommunityIcons name={icon} size={21} color={fg} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ fontFamily: fonts.bodyBold, fontSize: 15.5, color: tone === "error" ? p.error : p.ink }}>{title}</Text>
          {sub ? <Text style={{ color: p.muted, fontSize: 12.5, lineHeight: 17 }}>{sub}</Text> : null}
        </View>
        {right ?? (onPress ? <MaterialCommunityIcons name="chevron-right" size={22} color={p.faint} /> : null)}
      </View>
      {children ? <View style={{ paddingLeft: 40 + space.md }}>{children}</View> : null}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={sub ? `${title}，${sub}` : title}
      onPress={onPress}
      android_ripple={{ color: p.surface3 }}
      // iOS has no ripple: the same tint while pressed.
      style={({ pressed }) => (pressed && Platform.OS === "ios" ? { backgroundColor: p.surface3 } : null)}
    >
      {body}
    </Pressable>
  );
}

/** Pill switch in the app's pink; the stock one does not take the palette on every phone. */
export function Toggle({ value, onChange, disabled, label }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  const p = usePalette();
  const t = useDerivedValue(() => withTiming(value ? 1 : 0, { duration: motion.quick, easing: motion.glide }), [value]);
  const off = p.dark ? "#4A4158" : "#E4DCEC";
  const track = useAnimatedStyle(() => ({ backgroundColor: interpolateColor(t.value, [0, 1], [off, p.primary]) }), [off, p.primary]);
  const knob = useAnimatedStyle(() => ({ transform: [{ translateX: t.value * 22 }] }));
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      disabled={disabled}
      hitSlop={10}
      onPress={() => onChange(!value)}
      style={{ opacity: disabled ? 0.5 : 1 }}
    >
      <Animated.View style={[{ width: 52, height: 30, borderRadius: 15, padding: 3 }, track]}>
        <Animated.View style={[{ width: 24, height: 24, borderRadius: 12, backgroundColor: "#FFFFFF", elevation: 2, shadowColor: "#000", shadowOpacity: 0.15, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } }, knob]} />
      </Animated.View>
    </Pressable>
  );
}
