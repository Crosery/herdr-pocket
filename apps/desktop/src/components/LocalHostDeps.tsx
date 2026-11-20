import { Copy, RefreshCw } from "lucide-react";
import { RELEASE_REPO } from "@herdr-pocket/protocol";
import { copyToClipboard, detectPlatform, type HostdLocalStatus, type LocalDep } from "../lib/bridge";
import { PocketBadge, PocketButton, useToast } from "./PocketUI";

const DEPS: Record<LocalDep["id"], { what: string; missing: string }> = {
  herdr: { what: "在终端里运行和管理 Agent", missing: "先安装 herdr，这台电脑的 Agent 才会出现" },
  hc: { what: "herdr 的命令行，用来读取和操作 Agent", missing: "随 herdr 一起安装，装好后终端里应能运行 hc" },
  "herdr-pocket": { what: "把这台电脑接入 Pocket 的后台服务", missing: "用下面的命令安装，它会登录并在后台常驻" },
  uniflo: { what: "提供 Agent 的完整对话记录", missing: "可选：装好并启动后能看到完整对话记录" },
};

/** The one-line host installer from the README, for this computer's platform. */
export function installHostCommand(server?: string): string {
  const relay = server || "https://pocket.example.com";
  const raw = `https://raw.githubusercontent.com/${RELEASE_REPO}/main/scripts`;
  return detectPlatform() === "windows"
    ? `& ([scriptblock]::Create((irm ${raw}/install-host.ps1))) -Server ${relay}`
    : `curl -fsSL ${raw}/install-host.sh | bash -s -- --server ${relay}`;
}

function depState(dep: LocalDep, status: HostdLocalStatus): { tone: "mint" | "warn" | "blush" | "neutral"; label: string; note: string } {
  const info = DEPS[dep.id];
  if (!dep.found) return { tone: dep.optional ? "neutral" : "blush", label: dep.optional ? "可选" : "未安装", note: info.missing };
  if (dep.id === "herdr-pocket") {
    if (!status.configured) return { tone: "warn", label: "未登录", note: "已安装，还没登录：在终端运行 herdr-pocket up --server <服务器地址>" };
    if (status.running === false) return { tone: "warn", label: "未运行", note: "已登录，但后台服务没在运行：在终端运行 herdr-pocket up" };
    if (status.running) return { tone: "mint", label: "运行中", note: info.what };
  }
  return { tone: "mint", label: "已安装", note: info.what };
}

/** Whether this computer still misses something it needs before its agents show up. */
export function missingRequiredDeps(status: HostdLocalStatus | null): boolean {
  return Boolean(status?.deps?.some((d) => !d.found && !d.optional));
}

/** Checklist of the programs this computer needs (herdr, hc, herdr-pocket, optional Uniflo). */
export function LocalHostDeps({
  status,
  server,
  checking,
  onRecheck,
}: {
  status: HostdLocalStatus;
  server?: string;
  checking?: boolean;
  onRecheck: () => void;
}) {
  const toast = useToast();
  const needsHostd = status.deps.some((d) => d.id === "herdr-pocket" && !d.found);
  const command = installHostCommand(server || status.server);

  const copy = async () => {
    const ok = await copyToClipboard(command);
    toast(ok ? "安装命令已复制" : "复制失败，请手动选中命令", !ok);
  };

  return (
    <div className="stack" style={{ gap: 10 }}>
      {(status.deps ?? []).map((dep) => {
        const state = depState(dep, status);
        return (
          <div key={dep.id} className="between" style={{ gap: 12, alignItems: "flex-start" }}>
            <div style={{ minWidth: 0 }}>
              <div className="mono" style={{ fontWeight: 700 }}>{dep.id === "uniflo" ? "Uniflo" : dep.id}</div>
              <div className="faint">{state.note}</div>
            </div>
            <PocketBadge tone={state.tone}>{state.label}</PocketBadge>
          </div>
        );
      })}

      {needsHostd ? (
        <div className="local-deps-cmd">
          <code className="mono">{command}</code>
          <PocketButton size="sm" variant="soft" onClick={() => void copy()} aria-label="复制安装命令">
            <Copy size={14} />
            <span>复制</span>
          </PocketButton>
        </div>
      ) : null}

      <div className="row">
        <PocketButton size="sm" variant="ghost" disabled={checking} onClick={onRecheck}>
          <RefreshCw size={14} />
          <span>{checking ? "检测中…" : "装好后重新检测"}</span>
        </PocketButton>
      </div>
    </div>
  );
}
