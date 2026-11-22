/**
 * Pieces shared by the assistant configuration screens (models, providers,
 * voice, prompts): labelled fields, choice chips, the write-only key field,
 * badges, the warning card, the save bar, dialogs and the short confirmation.
 */
import { useCallback, useState, type ReactNode } from "react";
import { Pressable, TextInput, View, type TextInputProps } from "react-native";
import { Text } from "react-native-paper";
import { useIsFocused, usePreventRemove } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { KeyView } from "@herdr-pocket/protocol";
import { flash, keyLine, useAssistantConfig } from "../lib/assistantConfig";
import { useKeyboardState } from "../lib/useKeyboardState";
import { Mascot } from "./Mascot";
import { PocketToast } from "./ui";
import { PocketButton, PocketChip, PocketChips, PocketDialog, PocketSpinner } from "./pocket";
import { usePalette } from "../theme/theme";
import { fonts, radius, space, statusColors } from "../theme/tokens";

/** A label over its input, with an optional hint (or an error) under it. */
export function Field({ title, hint, error, children, right }: { title: string; hint?: string; error?: string | null; children: ReactNode; right?: ReactNode }) {
  const p = usePalette();
  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Text style={{ flex: 1, fontFamily: fonts.bodyBold, color: p.ink, fontSize: 14 }}>{title}</Text>
        {right}
      </View>
      {children}
      {error ? <Text style={{ color: p.error, fontSize: 12.5, lineHeight: 18 }}>{error}</Text> : hint ? <Text style={{ color: p.faint, fontSize: 12.5, lineHeight: 18 }}>{hint}</Text> : null}
    </View>
  );
}

/** The app's soft text box; `mono` for addresses, ids and model names. */
export function Input({ mono, style, onFocus, onBlur, ...rest }: TextInputProps & { mono?: boolean }) {
  const p = usePalette();
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      placeholderTextColor={p.faint}
      autoCorrect={false}
      onFocus={(e) => {
        setFocused(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        onBlur?.(e);
      }}
      style={[
        {
          backgroundColor: p.surface2,
          borderRadius: radius.md,
          borderWidth: focused ? 1.5 : 1,
          borderColor: focused ? p.primary : p.divider,
          paddingHorizontal: space.md,
          minHeight: 48,
          color: p.ink,
          fontFamily: mono ? fonts.mono : fonts.body,
          fontSize: mono ? 14 : 15,
        },
        style,
      ]}
      {...rest}
    />
  );
}

/** A pill to pick one of a few choices. */
export function Chip({ on, label, onPress, icon, a11y, disabled }: { on: boolean; label: string; onPress: () => void; icon?: ReactNode; a11y?: string; disabled?: boolean }) {
  return <PocketChip on={on} label={label} onPress={onPress} lead={icon} a11y={a11y} disabled={disabled} />;
}

export function Chips({ children }: { children: ReactNode }) {
  return <PocketChips>{children}</PocketChips>;
}

export type PillTone = "primary" | "soft" | "lavender" | "plain" | "good";

/** A small label: 主模型, 备用 1, 改过, 服务器上的… */
export function Pill({ text, tone = "soft" }: { text: string; tone?: PillTone }) {
  const p = usePalette();
  const good = statusColors("working", p.dark);
  const look =
    tone === "primary"
      ? { bg: p.primary, fg: p.onPrimary }
      : tone === "lavender"
        ? { bg: p.lavenderContainer, fg: p.dusk }
        : tone === "plain"
          ? { bg: p.surface3, fg: p.muted }
          : tone === "good"
            ? { bg: good.bg, fg: good.fg }
            : { bg: p.accentContainer, fg: p.accentText };
  return (
    <View style={{ alignSelf: "flex-start", backgroundColor: look.bg, borderRadius: radius.pill, paddingHorizontal: 9, paddingVertical: 2 }}>
      <Text style={{ color: look.fg, fontFamily: fonts.bodyBold, fontSize: 11.5, lineHeight: 17 }}>{text}</Text>
    </View>
  );
}

/** Things that keep part of the setup from working, said softly at the top of a screen. */
export function WarningCard({ lines }: { lines: string[] }) {
  const p = usePalette();
  if (!lines.length) return null;
  return (
    <View accessibilityRole="alert" style={{ flexDirection: "row", gap: space.md, backgroundColor: p.errorContainer, borderRadius: radius.card, padding: space.lg }}>
      <MaterialCommunityIcons name="alert-circle-outline" size={20} color={p.error} style={{ marginTop: 1 }} />
      <View style={{ flex: 1, gap: 6 }}>
        <Text style={{ color: p.error, fontFamily: fonts.bodyBold, fontSize: 14 }}>{lines.length > 1 ? `有 ${lines.length} 处要看一下` : "有一处要看一下"}</Text>
        {lines.map((l, i) => (
          <Text key={i} style={{ color: p.ink, fontSize: 13.5, lineHeight: 20 }}>
            {l}
          </Text>
        ))}
      </View>
    </View>
  );
}

/**
 * A key goes one way: typed here, sent once, then the box is empty again. The
 * relay only says whether one is set and its last characters. An empty box
 * keeps the key that is there.
 */
export function KeyField({
  value,
  onChange,
  current,
  onClearPhoneKey,
  busy,
  label = "密钥",
}: {
  value: string;
  onChange: (v: string) => void;
  current?: KeyView;
  onClearPhoneKey?: () => void;
  busy?: boolean;
  label?: string;
}) {
  const p = usePalette();
  const set = current?.set ?? false;
  const hint = value ? "保存后这里会清空，App 不会留下它" : set ? "不改就留空。保存后 App 不会留下它，也看不到原来的密钥" : "保存后 App 不会留下它，之后只显示最后几位";
  return (
    <Field title={label}>
      {current ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <MaterialCommunityIcons name={set ? "key-variant" : "key-remove"} size={16} color={set ? statusColors("working", p.dark).fg : p.error} />
          <Text style={{ flex: 1, color: set ? p.ink : p.error, fontSize: 13.5 }}>{keyLine(current)}</Text>
        </View>
      ) : null}
      <Input
        value={value}
        onChangeText={(t) => onChange(t.trim())}
        secureTextEntry
        autoCapitalize="none"
        autoComplete="off"
        importantForAutofill="no"
        textContentType="none"
        placeholder={set ? "输入新的密钥来替换" : "粘贴密钥"}
        accessibilityLabel={set ? `${label}，已设置，输入新的来替换` : label}
        mono
      />
      <Text style={{ color: p.faint, fontSize: 12.5, lineHeight: 18 }}>{hint}</Text>
      {current?.from === "phone" && onClearPhoneKey ? (
        <Pressable accessibilityRole="button" onPress={onClearPhoneKey} disabled={busy} hitSlop={8} style={{ alignSelf: "flex-start", minHeight: 36, justifyContent: "center", opacity: busy ? 0.5 : 1 }}>
          <Text style={{ color: p.error, fontFamily: fonts.bodySemi, fontSize: 13.5 }}>清除 App 里设的密钥</Text>
        </Pressable>
      ) : null}
    </Field>
  );
}

/** The save bar pinned under a form, above the gesture bar. */
export function SaveBar({ children, note, keyboardOpen }: { children: ReactNode; note?: string; keyboardOpen?: boolean }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { keyboardOpen: detectedKeyboardOpen } = useKeyboardState();
  const open = keyboardOpen ?? detectedKeyboardOpen;
  return (
    <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: (open ? 0 : insets.bottom) + space.md, gap: space.xs, borderTopWidth: 1, borderTopColor: p.divider, backgroundColor: p.page }}>
      {note ? <Text style={{ color: p.faint, fontSize: 12, textAlign: "center" }}>{note}</Text> : null}
      <View style={{ flexDirection: "row", gap: space.sm }}>{children}</View>
    </View>
  );
}

/** The app's question dialog: a cute title, one paragraph, cancel and the action. */
export function ConfirmDialog({
  visible,
  title,
  body,
  action,
  danger,
  onConfirm,
  onDismiss,
  cancel = "取消",
}: {
  visible: boolean;
  title: string;
  body: string;
  action: string;
  danger?: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
  cancel?: string;
}) {
  return (
    <PocketDialog
      visible={visible}
      onDismiss={onDismiss}
      title={title}
      body={body}
      actions={[
        { label: cancel, onPress: onDismiss, tone: "ghost" },
        { label: action, onPress: onConfirm, tone: danger ? "danger" : "primary" },
      ]}
    />
  );
}

/**
 * The short line at the bottom: what this screen says (a save went through, an
 * error), else what the store has to tell (another phone's change, a save made
 * on the screen just closed). Only the screen in view shows it.
 */
export function ConfigSnackbar({ message, onDismiss, action, bottom = 0 }: { message: string | null; onDismiss: () => void; action?: { label: string; onPress: () => void }; bottom?: number }) {
  const focused = useIsFocused();
  const shared = useAssistantConfig((s) => s.flash);
  const text = message ?? (focused ? shared : null);
  const isErr = !!text && /(失败|错误|无效|不能|没法|断|超时|冲突|不对)/.test(text);
  return (
    <PocketToast
      visible={focused && !!text}
      message={text}
      tone={isErr ? "error" : "info"}
      bottom={Math.max(24, bottom)}
      action={message && action ? action : undefined}
      onDismiss={() => (message ? onDismiss() : flash(null))}
    />
  );
}

/** Loading, or why it could not load with a way to try again. */
export function LoadState({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  const p = usePalette();
  if (!error) return <PocketSpinner size={32} style={{ marginVertical: 120 }} />;
  return (
    <View style={{ alignItems: "center", gap: space.md, paddingVertical: space.xxxl, paddingHorizontal: space.xl }}>
      <Mascot mood="waiting" size={96} />
      <Text style={{ color: p.error, textAlign: "center", lineHeight: 21 }}>{error}</Text>
      <PocketButton variant="soft" icon="refresh" onPress={onRetry}>
        再试一次
      </PocketButton>
    </View>
  );
}

/**
 * Asks before leaving a form with unsaved changes (back button, gesture or
 * header). `leave` is for going on purpose, e.g. right after a save.
 */
export function useLeaveGuard(dirty: boolean): { dialog: ReactNode; leave: (go: () => void) => void } {
  const [released, setReleased] = useState(false);
  const [asked, setAsked] = useState<{ repeat: () => void } | null>(null);
  const disable = usePreventRemove(dirty && !released, ({ repeat }) => setAsked({ repeat }));
  const leave = useCallback(
    (go: () => void) => {
      setReleased(true);
      disable();
      go();
    },
    [disable],
  );
  const dialog = (
    <ConfirmDialog
      visible={!!asked}
      title="还没保存，要离开吗？"
      body="刚才的修改还没保存，离开就不留了。"
      action="不保存，离开"
      cancel="继续改"
      danger
      onDismiss={() => setAsked(null)}
      onConfirm={() => {
        const a = asked;
        setAsked(null);
        setReleased(true);
        a?.repeat();
      }}
    />
  );
  return { dialog, leave };
}

/** A small muted paragraph under a card. */
export function Note({ children }: { children: ReactNode }) {
  const p = usePalette();
  return <Text style={{ color: p.faint, fontSize: 12.5, lineHeight: 18, paddingHorizontal: space.xs }}>{children}</Text>;
}
