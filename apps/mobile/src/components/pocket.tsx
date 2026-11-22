/**
 * The app's own controls, in place of stock Material looks: pink pill buttons,
 * choice chips, a segmented switch, bottom sheets, dialogs, an action sheet, a
 * search box, a progress bar, a check box and the platform spinner. Every
 * pressable is at least 44 pt tall (or reaches it with hitSlop) and keeps its
 * accessibility role, label and state.
 */
import { useState, type ComponentProps, type ReactNode } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import { Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { usePalette } from "../theme/theme";
import { fonts, radius, space, type Palette } from "../theme/tokens";
import { horizontalPad } from "../lib/layoutMetrics";
import { useKeyboardState } from "../lib/useKeyboardState";
import { CuteIcon } from "./icons";
import { PocketKeyboardAvoidingView } from "./PocketKeyboardAvoidingView";
import { IconTile } from "./ui";

export type PocketIcon = ComponentProps<typeof MaterialCommunityIcons>["name"];

/** The platform's own spinner (iOS takes only two sizes), in the app's pink. */
export function PocketSpinner({ size = 18, color, style }: { size?: number; color?: string; style?: StyleProp<ViewStyle> }) {
  const p = usePalette();
  const s = Platform.OS === "ios" ? (size >= 28 ? "large" : "small") : size;
  return <ActivityIndicator size={s} color={color ?? p.accentText} style={style} />;
}

export type ButtonVariant = "primary" | "soft" | "ghost" | "danger" | "text";
export type ButtonSize = "sm" | "md" | "lg";

function buttonLook(p: Palette, v: ButtonVariant, danger: boolean): { bg: string; pressed: string; fg: string; border?: string } {
  if (danger && v === "text") return { bg: "transparent", pressed: p.errorContainer, fg: p.error };
  switch (v) {
    case "primary":
      return danger
        ? { bg: p.dark ? "#E2687E" : "#E0566F", pressed: p.dark ? "#EE7E92" : "#C9445E", fg: "#FFFFFF" }
        : { bg: p.primary, pressed: p.primaryPressed, fg: p.onPrimary };
    case "soft":
      return { bg: p.accentContainer, pressed: p.dark ? "#5A3447" : "#FFD3E2", fg: p.dark ? p.accentText : p.accentText, border: p.dark ? undefined : "#FFD3E2" };
    case "ghost":
      return { bg: p.surface, pressed: p.surface3, fg: p.ink, border: p.divider };
    case "danger":
      return { bg: p.errorContainer, pressed: p.dark ? "#5A2F37" : "#FFD5DB", fg: p.error, border: p.dark ? undefined : "#F6C5D2" };
    default:
      return { bg: "transparent", pressed: p.surface3, fg: p.accentText };
  }
}

const SIZES: Record<ButtonSize, { h: number; px: number; font: number; icon: number }> = {
  sm: { h: 36, px: 13, font: 13, icon: 16 },
  md: { h: 44, px: 18, font: 14.5, icon: 18 },
  lg: { h: 50, px: 22, font: 16, icon: 20 },
};

/**
 * Pill button. `primary` is the one main action of a screen, `soft` a pink
 * helper, `ghost` a quiet outlined one, `danger` a destructive one, `text` a
 * bare link-like action. `danger` also turns `primary` and `text` red.
 */
export function PocketButton({
  children,
  onPress,
  onLongPress,
  variant = "primary",
  size = "md",
  icon,
  lead,
  loading,
  disabled,
  danger,
  block,
  grow,
  a11y,
  style,
}: {
  children: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: PocketIcon;
  lead?: ReactNode;
  loading?: boolean;
  disabled?: boolean;
  danger?: boolean;
  /** Full width of its column. */
  block?: boolean;
  /** Share a row with its siblings (flex: 1). */
  grow?: boolean;
  a11y?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const p = usePalette();
  const look = buttonLook(p, variant, !!danger || variant === "danger");
  const sz = SIZES[size];
  const off = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y ?? (typeof children === "string" ? children : undefined)}
      accessibilityState={{ disabled: !!disabled, busy: !!loading }}
      disabled={off}
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={size === "sm" ? 4 : 0}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 7,
          minHeight: sz.h,
          paddingHorizontal: variant === "text" ? Math.max(8, sz.px - 6) : sz.px,
          borderRadius: radius.pill,
          backgroundColor: pressed ? look.pressed : look.bg,
          borderWidth: look.border ? 1 : 0,
          borderColor: look.border,
          opacity: disabled ? 0.45 : 1,
          transform: [{ scale: pressed ? 0.96 : 1 }],
          // Unset: full width in a column (like the stock button it replaces), content width in a row.
          alignSelf: block ? "stretch" : undefined,
        },
        variant === "primary" && !off && !p.dark ? { shadowColor: p.shadow, shadowOpacity: 0.28, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 2 } : null,
        grow ? { flex: 1 } : null,
        style,
      ]}
    >
      {loading ? <PocketSpinner size={sz.icon} color={look.fg} /> : icon ? <MaterialCommunityIcons name={icon} size={sz.icon} color={look.fg} /> : lead}
      <Text numberOfLines={1} style={{ color: look.fg, fontFamily: fonts.bodyBold, fontSize: sz.font, flexShrink: 1 }}>
        {children}
      </Text>
    </Pressable>
  );
}

/** A pill to pick one of a few choices (radio), or to toggle one of many (`multi`). */
export function PocketChip({
  on,
  label,
  onPress,
  lead,
  icon,
  a11y,
  disabled,
  multi,
  trailing,
  maxWidth = 220,
  mono,
}: {
  on: boolean;
  label: string;
  onPress: () => void;
  lead?: ReactNode;
  icon?: PocketIcon;
  a11y?: string;
  disabled?: boolean;
  multi?: boolean;
  trailing?: ReactNode;
  maxWidth?: number;
  mono?: boolean;
}) {
  const p = usePalette();
  const hasLead = !!lead || !!icon;
  return (
    <Pressable
      accessibilityRole={multi ? "checkbox" : "radio"}
      accessibilityState={{ checked: on, disabled: !!disabled }}
      accessibilityLabel={a11y ?? label}
      disabled={disabled}
      onPress={onPress}
      hitSlop={{ top: 2, bottom: 2 }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        minHeight: 40,
        paddingLeft: hasLead ? 8 : 14,
        paddingRight: 14,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: on ? p.accentText : p.divider,
        backgroundColor: on ? p.accentContainer : pressed ? p.surface3 : p.surface,
        opacity: disabled ? 0.5 : 1,
      })}
    >
      {icon ? <MaterialCommunityIcons name={icon} size={17} color={on ? p.accentText : p.muted} /> : lead}
      {multi && on && !hasLead ? <CuteIcon name="check" size={14} color={p.accentText} strokeWidth={2.6} /> : null}
      <Text numberOfLines={1} style={{ maxWidth, color: p.ink, fontFamily: mono ? fonts.mono : on ? fonts.bodyBold : fonts.bodySemi, fontSize: mono ? 13 : 13.5 }}>
        {label}
      </Text>
      {trailing}
    </Pressable>
  );
}

export function PocketChips({ children, multi, style }: { children: ReactNode; multi?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <View accessibilityRole={multi ? undefined : "radiogroup"} style={[{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }, style]}>
      {children}
    </View>
  );
}

export interface Segment<T extends string> {
  value: T;
  label: string;
  icon?: PocketIcon;
  a11y?: string;
}

/** Two to four equal segments in a soft pink track; the chosen one is a raised white pill. */
export function PocketSegmented<T extends string>({
  value,
  onChange,
  segments,
  style,
  compact,
}: {
  value: T;
  onChange: (v: T) => void;
  segments: Segment<T>[];
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
}) {
  const p = usePalette();
  return (
    <View
      accessibilityRole="tablist"
      style={[{ flexDirection: "row", padding: 3, gap: 3, borderRadius: radius.pill, backgroundColor: p.dark ? p.surface2 : "#FBE7EF" }, style]}
    >
      {segments.map((s) => {
        const on = s.value === value;
        return (
          <Pressable
            key={s.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={s.a11y ?? s.label}
            onPress={() => onChange(s.value)}
            hitSlop={{ top: 3, bottom: 3 }}
            style={({ pressed }) => ({
              flex: 1,
              minWidth: 0,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 5,
              minHeight: compact ? 34 : 38,
              paddingHorizontal: space.sm,
              borderRadius: radius.pill,
              backgroundColor: on ? p.surface : pressed ? (p.dark ? p.surface3 : "#F7D9E5") : "transparent",
              ...(on && !p.dark ? { shadowColor: p.shadow, shadowOpacity: 0.18, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 2 } : {}),
            })}
          >
            {s.icon ? <MaterialCommunityIcons name={s.icon} size={16} color={on ? p.accentText : p.muted} /> : null}
            <Text numberOfLines={1} style={{ flexShrink: 1, minWidth: 0, color: on ? p.accentText : p.muted, fontFamily: fonts.bodyBold, fontSize: compact ? 13 : 13.5 }}>
              {s.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const SCRIM = "rgba(30,26,38,0.38)";

/**
 * Bottom sheet: a scrim, a grab handle, a cute title with a close button, the
 * body (scrolling by default) and an optional footer pinned above the gesture bar.
 */
export function PocketSheet({
  visible,
  onDismiss,
  title,
  sub,
  lead,
  footer,
  children,
  scroll = true,
  maxHeight = "88%",
}: {
  visible: boolean;
  onDismiss: () => void;
  title: string;
  sub?: string;
  lead?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  scroll?: boolean;
  maxHeight?: `${number}%`;
}) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { keyboardOpen } = useKeyboardState();
  const padLeft = horizontalPad(space.lg, insets.left);
  const padRight = horizontalPad(space.lg, insets.right);
  const closedBottom = keyboardOpen ? 0 : insets.bottom;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onDismiss} statusBarTranslucent navigationBarTranslucent>
      <PocketKeyboardAvoidingView insideModal style={{ flex: 1, justifyContent: "flex-end" }}>
        <Pressable accessibilityLabel="关闭" onPress={onDismiss} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: SCRIM }} />
        <View accessibilityViewIsModal style={{ maxHeight, backgroundColor: p.page, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, overflow: "hidden" }}>
          <View style={{ alignItems: "center", paddingTop: space.sm }}>
            <View style={{ width: 40, height: 5, borderRadius: 3, backgroundColor: p.dark ? p.surface3 : "#EBD9E3" }} />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingLeft: padLeft, paddingRight: horizontalPad(space.md, insets.right), paddingTop: space.sm, paddingBottom: space.xs }}>
            {lead}
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text accessibilityRole="header" numberOfLines={1} style={{ fontFamily: fonts.cute, fontSize: 22, lineHeight: 30, color: p.ink }}>
                {title}
              </Text>
              {sub ? (
                <Text numberOfLines={2} style={{ color: p.muted, fontSize: 13, lineHeight: 18 }}>
                  {sub}
                </Text>
              ) : null}
            </View>
            <IconTile icon="close" tone="plain" size={40} onPress={onDismiss} a11y="关闭" />
          </View>
          {scroll ? (
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingTop: space.lg, paddingLeft: padLeft, paddingRight: padRight, gap: space.lg, paddingBottom: footer ? space.lg : closedBottom + space.lg }}>
              {children}
            </ScrollView>
          ) : (
            <View style={{ paddingBottom: footer ? 0 : closedBottom }}>{children}</View>
          )}
          {footer ? (
            <View style={{ paddingLeft: padLeft, paddingRight: padRight, paddingTop: space.sm, paddingBottom: closedBottom + space.md, gap: space.xs, borderTopWidth: 1, borderTopColor: p.divider }}>{footer}</View>
          ) : null}
        </View>
      </PocketKeyboardAvoidingView>
    </Modal>
  );
}

export interface DialogAction {
  label: string;
  onPress: () => void;
  /** `primary` (default for the last one), `danger`, or `ghost` (default for the others). */
  tone?: "primary" | "danger" | "ghost";
  disabled?: boolean;
  loading?: boolean;
}

/** Centered question card: a cute title, one paragraph (or children), and its buttons. */
export function PocketDialog({
  visible,
  onDismiss,
  title,
  body,
  children,
  actions,
  scroll,
  hero,
}: {
  visible: boolean;
  onDismiss: () => void;
  title: string;
  body?: string;
  children?: ReactNode;
  actions: DialogAction[];
  /** The body may be long (a list): it scrolls inside the card. */
  scroll?: boolean;
  /** A picture over a centred title (the mascot, for good news). */
  hero?: ReactNode;
}) {
  const p = usePalette();
  // Two short buttons sit side by side; longer labels or more buttons stack, main action on top.
  const stacked = actions.length > 2 || actions.some((a) => a.label.length > 6);
  const ordered = stacked ? [...actions].reverse() : actions;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss} statusBarTranslucent navigationBarTranslucent>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl }}>
        <Pressable accessibilityLabel="关闭" onPress={onDismiss} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: SCRIM }} />
        <View
          accessibilityViewIsModal
          style={{
            width: "100%",
            maxWidth: 400,
            maxHeight: "84%",
            backgroundColor: p.surface,
            borderRadius: radius.xl,
            paddingTop: space.xl,
            paddingBottom: space.lg,
            gap: space.md,
            shadowColor: "#000",
            shadowOpacity: 0.2,
            shadowRadius: 20,
            elevation: 12,
          }}
        >
          {hero ? <View style={{ alignItems: "center" }}>{hero}</View> : null}
          <Text accessibilityRole="header" style={{ fontFamily: fonts.cute, fontSize: 21, lineHeight: 28, color: p.ink, paddingHorizontal: space.xl, textAlign: hero ? "center" : "left" }}>
            {title}
          </Text>
          {scroll ? (
            <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} contentContainerStyle={{ paddingHorizontal: space.lg }}>
              {body ? <Text style={{ color: p.muted, lineHeight: 22, paddingHorizontal: space.sm }}>{body}</Text> : null}
              {children}
            </ScrollView>
          ) : (
            <View style={{ paddingHorizontal: space.xl, gap: space.md }}>
              {body ? <Text style={{ color: p.muted, fontSize: 14.5, lineHeight: 22, textAlign: hero ? "center" : "left" }}>{body}</Text> : null}
              {children}
            </View>
          )}
          <View style={{ flexDirection: stacked ? "column" : "row", gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.xs }}>
            {ordered.map((a, i) => {
              const isMain = stacked ? i === 0 : i === ordered.length - 1;
              const tone = a.tone ?? (isMain ? "primary" : "ghost");
              return (
                <PocketButton
                  key={a.label}
                  grow={!stacked}
                  variant={tone === "ghost" ? "ghost" : "primary"}
                  danger={tone === "danger"}
                  disabled={a.disabled}
                  loading={a.loading}
                  onPress={a.onPress}
                  block={stacked}
                >
                  {a.label}
                </PocketButton>
              );
            })}
          </View>
        </View>
      </View>
    </Modal>
  );
}

export interface SheetAction {
  key: string;
  label: string;
  sub?: string;
  icon: PocketIcon;
  onPress: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/** A short list of things to do with one item (long-press menus, "more" buttons). */
export function PocketActionSheet({
  visible,
  onDismiss,
  title,
  sub,
  lead,
  actions,
}: {
  visible: boolean;
  onDismiss: () => void;
  title: string;
  sub?: string;
  lead?: ReactNode;
  actions: SheetAction[];
}) {
  const p = usePalette();
  return (
    <PocketSheet visible={visible} onDismiss={onDismiss} title={title} sub={sub} lead={lead} scroll={false}>
      <View style={{ paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: space.md }}>
        <View style={{ backgroundColor: p.surface, borderRadius: radius.card, paddingVertical: space.xs, overflow: "hidden" }}>
          {actions.map((a, i) => (
            <View key={a.key}>
              {i ? <View style={{ height: 1, backgroundColor: p.divider, marginLeft: space.lg + 36 + space.md }} /> : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={a.sub ? `${a.label}，${a.sub}` : a.label}
                accessibilityState={{ disabled: !!a.disabled }}
                disabled={a.disabled}
                onPress={() => {
                  onDismiss();
                  // iOS cannot present a new modal (a dialog, another sheet) while this one is still sliding away.
                  if (Platform.OS === "ios") setTimeout(a.onPress, 350);
                  else a.onPress();
                }}
                android_ripple={{ color: p.surface3 }}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space.md,
                  minHeight: 54,
                  paddingHorizontal: space.lg,
                  opacity: a.disabled ? 0.45 : 1,
                  backgroundColor: pressed && Platform.OS === "ios" ? p.surface3 : "transparent",
                })}
              >
                <View style={{ width: 36, height: 36, borderRadius: radius.sm, alignItems: "center", justifyContent: "center", backgroundColor: a.danger ? p.errorContainer : p.accentContainer }}>
                  <MaterialCommunityIcons name={a.icon} size={19} color={a.danger ? p.error : p.accentText} />
                </View>
                <View style={{ flex: 1, gap: 1 }}>
                  <Text style={{ fontFamily: fonts.bodyBold, fontSize: 15, color: a.danger ? p.error : p.ink }}>{a.label}</Text>
                  {a.sub ? (
                    <Text numberOfLines={1} style={{ color: p.muted, fontSize: 12.5 }}>
                      {a.sub}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            </View>
          ))}
        </View>
      </View>
    </PocketSheet>
  );
}

/** The app's text box with a leading icon and an optional trailing action (paste, clear...). */
export function PocketInput({ icon, trailing, mono, style, ...rest }: TextInputProps & { icon?: PocketIcon; trailing?: ReactNode; mono?: boolean }) {
  const p = usePalette();
  const [focused, setFocused] = useState(false);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        minHeight: 50,
        paddingLeft: icon ? space.md : 0,
        paddingRight: trailing ? 4 : 0,
        borderRadius: radius.md,
        backgroundColor: p.surface2,
        borderWidth: focused ? 1.5 : 1,
        borderColor: focused ? p.primary : p.divider,
      }}
    >
      {icon ? <MaterialCommunityIcons name={icon} size={20} color={focused ? p.accentText : p.muted} /> : null}
      <TextInput
        placeholderTextColor={p.faint}
        autoCorrect={false}
        {...rest}
        onFocus={(e) => {
          setFocused(true);
          rest.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          rest.onBlur?.(e);
        }}
        style={[{ flex: 1, minHeight: 48, paddingHorizontal: icon ? 0 : space.md, color: p.ink, fontFamily: mono ? fonts.mono : fonts.body, fontSize: mono ? 14.5 : 15.5 }, style]}
      />
      {trailing}
    </View>
  );
}

/** Rounded search box with a clear button. */
export function PocketSearch({ value, onChangeText, placeholder, autoFocus, style, ...rest }: Omit<TextInputProps, "style"> & { style?: StyleProp<ViewStyle> }) {
  const p = usePalette();
  const [focused, setFocused] = useState(false);
  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          minHeight: 46,
          paddingLeft: space.md,
          paddingRight: 4,
          borderRadius: radius.pill,
          backgroundColor: p.surface,
          borderWidth: focused ? 1.5 : 1,
          borderColor: focused ? p.primary : p.divider,
        },
        style,
      ]}
    >
      <CuteIcon name="search" size={18} color={p.muted} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={p.faint}
        autoFocus={autoFocus}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        accessibilityLabel={placeholder}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{ flex: 1, minHeight: 44, color: p.ink, fontFamily: fonts.body, fontSize: 15, paddingVertical: 0 }}
        {...rest}
      />
      {value ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="清空"
          onPress={() => onChangeText?.("")}
          style={({ pressed }) => ({ width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? p.surface3 : "transparent" })}
        >
          <CuteIcon name="close" size={15} color={p.muted} strokeWidth={2.6} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** A slim rounded progress bar (0..1). */
export function PocketProgress({ progress, color, height = 6, style }: { progress: number; color?: string; height?: number; style?: StyleProp<ViewStyle> }) {
  const p = usePalette();
  const v = Math.max(0, Math.min(1, progress));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(v * 100) }}
      style={[{ height, borderRadius: height / 2, backgroundColor: p.surface3, overflow: "hidden" }, style]}
    >
      <View style={{ width: `${v * 100}%`, height, borderRadius: height / 2, backgroundColor: color ?? p.primary }} />
    </View>
  );
}

/** Rounded check box (for lists that turn items on and off). */
export function PocketCheck({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled: !!disabled }}
      disabled={disabled}
      onPress={() => onChange(!checked)}
      hitSlop={10}
      style={{ width: 24, height: 24, borderRadius: 8, alignItems: "center", justifyContent: "center", borderWidth: checked ? 0 : 2, borderColor: p.faint, backgroundColor: checked ? p.primary : "transparent", opacity: disabled ? 0.5 : 1 }}
    >
      {checked ? <CuteIcon name="check" size={15} color={p.onPrimary} strokeWidth={2.8} /> : null}
    </Pressable>
  );
}

/** Small round icon action for list rows (reorder, remove...): 44 pt target around a 36 pt tile. */
export function RowAction({ icon, onPress, a11y, disabled, danger }: { icon: PocketIcon; onPress: () => void; a11y: string; disabled?: boolean; danger?: boolean }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed ? (danger ? p.errorContainer : p.accentContainer) : danger ? (p.dark ? p.errorContainer : "#FFF1F3") : p.surface2,
        borderWidth: 1,
        borderColor: danger ? (p.dark ? p.errorContainer : "#F6C5D2") : p.divider,
        opacity: disabled ? 0.35 : 1,
      })}
    >
      <MaterialCommunityIcons name={icon} size={20} color={danger ? p.error : p.ink} />
    </Pressable>
  );
}
