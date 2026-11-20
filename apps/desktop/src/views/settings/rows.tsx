import type { ReactNode } from "react";
import { configKeySpec, getConfigValue, type ConfigValue } from "@herdr-pocket/protocol";
import { PocketSelect, PocketSwitch, useToast } from "../../components/PocketUI";
import { setConfig, useClientConfig } from "../../lib/config";

/** One setting: what it is on the left, its control on the right (after Herdr's settings). */
export function SetRow({ title, about, children, stack = false }: { title: ReactNode; about?: ReactNode; children?: ReactNode; stack?: boolean }) {
  return (
    <div className={`set-row${stack ? " stack-row" : ""}`}>
      <div className="set-text">
        <div className="set-title">{title}</div>
        {about ? <div className="set-about">{about}</div> : null}
      </div>
      {children !== undefined ? <div className="set-control">{children}</div> : null}
    </div>
  );
}

export function SetHeading({ children }: { children: ReactNode }) {
  return <div className="set-heading">{children}</div>;
}

export function PaneTitle({ title, about }: { title: string; about?: ReactNode }) {
  return (
    <header className="pane-head">
      <h2 className="cute-font">{title}</h2>
      {about ? <div className="faint">{about}</div> : null}
    </header>
  );
}

function useSetter() {
  const toast = useToast();
  return async (key: string, value: ConfigValue) => {
    try {
      await setConfig(key, value);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
}

/** A boolean key of config.json, labelled from the protocol's key table. */
export function ConfigSwitch({ k, about, disabled, onChanged }: { k: string; about?: ReactNode; disabled?: boolean; onChanged?: (v: boolean) => void }) {
  const cfg = useClientConfig();
  const set = useSetter();
  const spec = configKeySpec(k);
  const value = Boolean(getConfigValue(cfg, k));
  return (
    <SetRow title={spec?.label ?? k} about={about}>
      <PocketSwitch
        checked={value}
        disabled={disabled}
        label={spec?.label}
        onCheckedChange={(v) => {
          void set(k, v).then(() => onChanged?.(v));
        }}
      />
    </SetRow>
  );
}

/** An enum or number key of config.json with Chinese option labels. */
export function ConfigSelect({
  k,
  about,
  options,
}: {
  k: string;
  about?: ReactNode;
  options: Array<{ value: string; label: string }>;
}) {
  const cfg = useClientConfig();
  const set = useSetter();
  const spec = configKeySpec(k);
  const raw = getConfigValue(cfg, k);
  const value = String(raw ?? "");
  const numeric = spec?.type === "integer";
  const opts = options.some((o) => o.value === value) ? options : [...options, { value, label: value }];
  return (
    <SetRow title={spec?.label ?? k} about={about}>
      <PocketSelect value={value} options={opts} onValueChange={(v) => void set(k, numeric ? Number(v) : v)} />
    </SetRow>
  );
}
