import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import * as Select from "@radix-ui/react-select";
import * as Switch from "@radix-ui/react-switch";
import * as Tabs from "@radix-ui/react-tabs";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  Eye,
  EyeOff,
  Hand,
  Sparkles,
  X,
} from "lucide-react";
import type { AgentStatus } from "../../lib/api";
import { PocketBowMark, XiaoyangOrb } from "../MascotAndVendor";

/* ---------------- Toast ---------------- */
interface ToastEntry {
  id: number;
  message: string;
  error?: boolean;
}

const ToastCtx = createContext<(msg: string, err?: boolean) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<ToastEntry[]>([]);

  const push = useCallback((message: string, error = false) => {
    const id = Date.now() + Math.random();
    setList((prev) => [...prev.slice(-3), { id, message, error }]);
    setTimeout(() => {
      setList((prev) => prev.filter((t) => t.id !== id));
    }, 3400);
  }, []);

  return (
    <Tooltip.Provider delayDuration={220}>
      <ToastCtx.Provider value={push}>
        {children}
        <div className="toast-viewport" aria-live="polite">
          {list.map((t) => (
            <div key={t.id} className={`toast-item${t.error ? " error" : ""}`}>
              {t.error ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}
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

/* ---------------- Buttons & Cards ---------------- */
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
    <button
      type={rest.type ?? "button"}
      className={`pk-btn ${variant}${sizeCls}${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function PocketIconButton({
  tooltip,
  size = "md",
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tooltip?: string;
  size?: "sm" | "md";
}) {
  const btn = (
    <button
      type={rest.type ?? "button"}
      aria-label={rest["aria-label"] ?? tooltip}
      className={`pk-icon-btn${size === "sm" ? " sm" : ""}${className ? ` ${className}` : ""}`}
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

/* ---------------- Setting Row (mobile Settings card) ---------------- */
export function SettingRow({
  icon,
  tone = "pink",
  title,
  description,
  right,
}: {
  icon: ReactNode;
  tone?: "pink" | "lavender" | "mint";
  title: string;
  description?: string;
  right: ReactNode;
}) {
  const toneCls = tone === "pink" ? "" : ` ${tone}`;
  return (
    <div className="setting-row">
      <div className={`setting-icon-tile${toneCls}`}>{icon}</div>
      <div className="grow">
        <div style={{ fontWeight: 800, fontSize: 14 }}>{title}</div>
        {description ? <div className="faint">{description}</div> : null}
      </div>
      {right}
    </div>
  );
}

/* ---------------- Radix Switch ---------------- */
export function PocketSwitch({
  checked,
  onCheckedChange,
  disabled,
  label,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
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

/* ---------------- Radix Select ---------------- */
const EMPTY_SENTINEL = "__PK_EMPTY__";

export interface SelectOption {
  value: string;
  label: string;
}

export function PocketSelect({
  value,
  onValueChange,
  options,
  placeholder = "请选择",
  ariaLabel,
  className = "",
}: {
  value: string;
  onValueChange: (val: string) => void;
  options: SelectOption[];
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const safeValue = value === "" ? EMPTY_SENTINEL : value;
  const mapped = useMemo(
    () => options.map((o) => ({ raw: o.value, safe: o.value === "" ? EMPTY_SENTINEL : o.value, label: o.label })),
    [options],
  );
  return (
    <Select.Root
      value={safeValue}
      onValueChange={(v) => onValueChange(v === EMPTY_SENTINEL ? "" : v)}
    >
      <Select.Trigger className={`pk-select-trigger${className ? ` ${className}` : ""}`} aria-label={ariaLabel ?? placeholder}>
        <Select.Value placeholder={placeholder} />
        <Select.Icon>
          <ChevronDown size={15} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="pk-select-content" position="popper" sideOffset={6}>
          <Select.Viewport>
            {mapped.map((item) => (
              <Select.Item key={item.safe} value={item.safe} className="pk-select-item">
                <Select.ItemText>{item.label}</Select.ItemText>
                <Select.ItemIndicator>
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

/* ---------------- Segmented, Chip, StatusPill ---------------- */
export function PocketSegmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (val: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <div className="pk-seg" role="tablist">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={value === opt.value}
          className={`pk-seg-btn${value === opt.value ? " active" : ""}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function PocketChip({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className={`pk-chip${active ? " on" : ""}`} onClick={onClick}>
      {children}
    </button>
  );
}

export function StatusPill({ status, errored }: { status: AgentStatus; errored?: boolean }) {
  if (errored) {
    return (
      <span className="pk-pill blocked">
        <AlertCircle size={12} />
        <span>出错了</span>
      </span>
    );
  }
  if (status === "blocked") {
    return (
      <span className="pk-pill blocked">
        <Hand size={12} />
        <span>需要你</span>
      </span>
    );
  }
  if (status === "working") {
    return (
      <span className="pk-pill working">
        <Sparkles size={12} />
        <span>工作中</span>
      </span>
    );
  }
  if (status === "done") {
    return (
      <span className="pk-pill done">
        <CheckCircle2 size={12} />
        <span>已完成</span>
      </span>
    );
  }
  return (
    <span className="pk-pill">
      <Circle size={10} />
      <span>{status === "idle" ? "空闲" : "未知"}</span>
    </span>
  );
}

/* ---------------- Inputs ---------------- */
export function PocketInput({
  mono = false,
  type = "text",
  className = "",
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  const [reveal, setReveal] = useState(false);
  const isPassword = type === "password";
  const effectiveType = isPassword && reveal ? "text" : type;
  return (
    <div className="pk-input-wrap">
      <input
        type={effectiveType}
        className={`pk-input${mono ? " mono" : ""}${isPassword ? " with-right" : ""}${className ? ` ${className}` : ""}`}
        {...rest}
      />
      {isPassword ? (
        <div className="pk-input-right">
          <PocketIconButton
            size="sm"
            tooltip={reveal ? "隐藏" : "显示"}
            onClick={() => setReveal((v) => !v)}
          >
            {reveal ? <EyeOff size={15} /> : <Eye size={15} />}
          </PocketIconButton>
        </div>
      ) : null}
    </div>
  );
}

export function PocketTextarea({
  mono = false,
  className = "",
  ref,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean; ref?: Ref<HTMLTextAreaElement> }) {
  return (
    <textarea
      ref={ref}
      className={`pk-textarea${mono ? " mono" : ""}${className ? ` ${className}` : ""}`}
      {...rest}
    />
  );
}

/* ---------------- Radix Dialog & Confirm ---------------- */
export function PocketDialog({
  open,
  onOpenChange,
  title,
  description,
  wide = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="pk-dialog-overlay" />
        <Dialog.Content className={`pk-dialog-content${wide ? " wide" : ""}`}>
          <div className="between" style={{ marginBottom: 14 }}>
            <Dialog.Title className="pk-dialog-title">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="pk-icon-btn sm" aria-label="关闭">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>
          {description ? (
            <Dialog.Description className="muted" style={{ margin: "0 0 14px", fontSize: 13.5 }}>
              {description}
            </Dialog.Description>
          ) : (
            <Dialog.Description style={{ display: "none" }}>{title}</Dialog.Description>
          )}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function PocketConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "确认",
  danger = true,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <PocketDialog open={open} onOpenChange={onOpenChange} title={title} description={description}>
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 18 }}>
        <PocketButton variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
          取消
        </PocketButton>
        <PocketButton
          variant={danger ? "danger" : "primary"}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
              onOpenChange(false);
            } finally {
              setBusy(false);
            }
          }}
        >
          {confirmLabel}
        </PocketButton>
      </div>
    </PocketDialog>
  );
}

/* ---------------- Radix Tabs & Popover ---------------- */
export const PocketTabs = Tabs.Root;
export const PocketTabsList = ({ children }: { children: ReactNode }) => (
  <Tabs.List className="pk-tabs-list">{children}</Tabs.List>
);
export const PocketTabsTrigger = ({ value, children }: { value: string; children: ReactNode }) => (
  <Tabs.Trigger className="pk-tab-trigger" value={value}>
    {children}
  </Tabs.Trigger>
);
export const PocketTabsContent = Tabs.Content;

export function PocketPopover({
  trigger,
  children,
}: {
  trigger: ReactNode;
  children: ReactNode;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="pk-popover-content" sideOffset={8} align="end">
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/* ---------------- Empty & Ribbon Footer ---------------- */
export function EmptyState({
  title,
  hint,
  mood = "sleepy",
}: {
  title: string;
  hint?: string;
  mood?: "sleepy" | "waiting" | "hello";
}) {
  return (
    <div style={{ padding: "26px 12px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
      <XiaoyangOrb mood={mood} size={78} />
      <div style={{ fontWeight: 800, fontSize: 14.5 }}>{title}</div>
      {hint ? <div className="faint" style={{ maxWidth: 340 }}>{hint}</div> : null}
    </div>
  );
}

export function PocketRibbonFooter({ version, protocol }: { version?: string; protocol?: number }) {
  return (
    <footer className="ribbon-footer">
      <PocketBowMark size={30} />
      <div className="cute-font" style={{ fontSize: 16, color: "var(--accent-text)" }}>
        Herdr Pocket
      </div>
      <div className="faint">
        {version ? `版本 v${version} · 协议 v${protocol ?? 1}` : "Herdr Pocket Console"}
      </div>
    </footer>
  );
}
