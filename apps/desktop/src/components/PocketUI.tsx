import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Select from "@radix-ui/react-select";
import * as Switch from "@radix-ui/react-switch";
import * as Tooltip from "@radix-ui/react-tooltip";
import { AlertCircle, Check, CheckCircle2, ChevronDown, PhoneOff, X } from "lucide-react";
import { XiaoyangOrb, type MascotMood } from "./MascotAndVendor";
import { createStore } from "../lib/store";

/** How many dialogs are open: native layers drawn over the page (the embedded browser) hide meanwhile. */
export const overlayStore = createStore<{ open: number }>({ open: 0 });

interface ToastEntry {
  id: number;
  message: string;
  tone: "info" | "error" | "hangup";
}

const ToastCtx = createContext<(msg: string, opts?: { tone?: "info" | "error" | "hangup"; duration?: number } | boolean) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<ToastEntry[]>([]);

  const push = useCallback(
    (message: string, opts?: { tone?: "info" | "error" | "hangup"; duration?: number } | boolean) => {
      const tone: ToastEntry["tone"] =
        typeof opts === "boolean" ? (opts ? "error" : "info") : (opts?.tone ?? "info");
      const ms = typeof opts === "object" && opts?.duration ? opts.duration : tone === "hangup" ? 1100 : tone === "error" ? 2800 : 2100;
      const id = Date.now() + Math.random();
      setList((prev) => [...prev.slice(-2), { id, message, tone }]);
      setTimeout(() => {
        setList((prev) => prev.filter((t) => t.id !== id));
      }, ms);
    },
    [],
  );

  return (
    <Tooltip.Provider delayDuration={240}>
      <ToastCtx.Provider value={push}>
        {children}
        <div className="toast-viewport" aria-live="polite">
          {list.map((t) => (
            <div
              key={t.id}
              className={`toast-item${t.tone === "error" ? " error" : ""}`}
              onClick={() => setList((prev) => prev.filter((x) => x.id !== t.id))}
            >
              <span className={`toast-badge ${t.tone}`}>
                {t.tone === "error" ? <AlertCircle size={14} /> : t.tone === "hangup" ? <PhoneOff size={14} /> : <CheckCircle2 size={14} />}
              </span>
              <span>{t.message}</span>
            </div>
          ))}
        </div>
      </ToastCtx.Provider>
    </Tooltip.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

export function PocketButton({
  variant = "primary",
  size = "md",
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "soft" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
}) {
  const sizeCls = size === "md" ? "" : ` ${size}`;
  return (
    <button type={rest.type ?? "button"} className={`pk-btn ${variant}${sizeCls}${className ? ` ${className}` : ""}`} {...rest}>
      {children}
    </button>
  );
}

export function PocketIconButton({
  tooltip,
  size = "md",
  active = false,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tooltip?: string;
  size?: "sm" | "md";
  active?: boolean;
}) {
  const btn = (
    <button
      type={rest.type ?? "button"}
      aria-label={rest["aria-label"] ?? tooltip}
      className={`pk-icon-btn${size === "sm" ? " sm" : ""}${active ? " active" : ""}${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {children}
    </button>
  );
  if (!tooltip) return btn;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{btn}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="pk-tooltip" sideOffset={6}>
          {tooltip}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function PocketCard({
  soft = false,
  className = "",
  children,
}: {
  soft?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return <div className={`pk-card${soft ? " soft" : ""}${className ? ` ${className}` : ""}`}>{children}</div>;
}

export function PocketBadge({
  tone = "neutral",
  pulse = false,
  children,
}: {
  tone?: "pink" | "lav" | "mint" | "blush" | "warn" | "neutral";
  pulse?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`pk-badge ${tone}`}>
      {pulse ? <span className="status-dot breathe" /> : null}
      {children}
    </span>
  );
}

/** A font size that follows the text-size setting (--ts, set by App). */
export const fs = (px: number): string => `calc(${px}px * var(--ts, 1))`;

export function PocketInput({
  mono = false,
  className = "",
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return <input className={`pk-input${mono ? " mono" : ""}${className ? ` ${className}` : ""}`} {...rest} />;
}

export function PocketTextarea({
  mono = false,
  className = "",
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  return <textarea className={`pk-textarea${mono ? " mono" : ""}${className ? ` ${className}` : ""}`} {...rest} />;
}

export function PocketSwitch({
  checked,
  onCheckedChange,
  disabled,
  label,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <Switch.Root
      className="pk-switch"
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
    >
      <Switch.Thumb className="pk-switch-thumb" />
    </Switch.Root>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

const EMPTY_SENTINEL = "__pk_empty__";

export function PocketSelect({
  value,
  onValueChange,
  options,
  placeholder = "请选择…",
  className,
  ariaLabel,
  disabled,
  onCloseAutoFocus,
}: {
  value: string;
  onValueChange: (v: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  disabled?: boolean;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const safeValue = value === "" ? EMPTY_SENTINEL : value;
  const safeOptions = useMemo(
    () => options.map((o) => ({ value: o.value === "" ? EMPTY_SENTINEL : o.value, raw: o.value, label: o.label })),
    [options],
  );
  return (
    <Select.Root
      value={safeValue}
      disabled={disabled}
      onValueChange={(v) => {
        const hit = safeOptions.find((o) => o.value === v);
        onValueChange(hit ? hit.raw : v === EMPTY_SENTINEL ? "" : v);
      }}
    >
      <Select.Trigger
        className={`pk-select-trigger${className ? ` ${className}` : ""}`}
        aria-label={ariaLabel}
        disabled={disabled}
      >
        <span className="pk-select-value">
          <Select.Value placeholder={placeholder} />
        </span>
        <Select.Icon className="pk-select-icon">
          <ChevronDown size={15} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className="pk-select-content"
          position="popper"
          sideOffset={6}
          collisionPadding={12}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <Select.Viewport className="pk-select-viewport">
            {safeOptions.map((o) => (
              <Select.Item key={o.value} value={o.value} className="pk-select-item">
                <span className="pk-select-item-text">
                  <Select.ItemText>{o.label}</Select.ItemText>
                </span>
                <Select.ItemIndicator className="pk-select-item-check">
                  <Check size={14} />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

export function PocketModal({
  open,
  onOpenChange,
  title,
  subtitle,
  width = 520,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  subtitle?: string;
  width?: number;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    overlayStore.set((p) => ({ open: p.open + 1 }));
    return () => overlayStore.set((p) => ({ open: Math.max(0, p.open - 1) }));
  }, [open]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="pk-overlay" />
        <Dialog.Content className="pk-dialog" style={{ maxWidth: width }}>
          <div className="between" style={{ marginBottom: 12 }}>
            <div>
              <Dialog.Title className="pk-dialog-title">{title}</Dialog.Title>
              {subtitle ? <Dialog.Description className="faint">{subtitle}</Dialog.Description> : null}
            </div>
            <Dialog.Close asChild>
              <PocketIconButton size="sm" aria-label="关闭">
                <X size={16} />
              </PocketIconButton>
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function EmptyState({
  mood = "sleepy",
  title,
  body,
  action,
}: {
  mood?: MascotMood;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <XiaoyangOrb mood={mood} size={96} />
      <h3 className="cute-font">{title}</h3>
      {body ? <p className="muted">{body}</p> : null}
      {action}
    </div>
  );
}
