import { useEffect, useState } from "react";
import { compareVersions, type Device, type HostTools } from "@herdr-pocket/protocol";
import { useClientConfig } from "../../lib/config";
import { rpcCall } from "../../lib/relay";
import { liveStore, relTime } from "../../lib/store";
import { ConfigSwitch, SetHeading, SetRow } from "./rows";

type ToolId = "app" | "herdr" | "hc" | "uniflo";

/** The programs host.info reports. The Herdr terminal (TUI) has no upstream source to compare with. */
const TOOLS: Array<{ id: ToolId; label: string }> = [
  { id: "app", label: "Herdr 桌面版" },
  { id: "herdr", label: "Herdr 终端" },
  { id: "hc", label: "hc" },
  { id: "uniflo", label: "uniflo" },
];

/** "hc 0.9.1 (abc)" -> "0.9.1", so a label around the number doesn't break the comparison. */
function bare(v: string): string {
  return v.match(/\d+(?:\.\d+)+(?:-[\w.]+)?/)?.[0] ?? v;
}

/** The newer upstream version of a tool, or null when it is current or nothing is known. */
function newerOf(tools: HostTools, id: ToolId): string | null {
  const have = tools[id];
  const latest = id === "herdr" ? undefined : tools.latest?.[id];
  return have && latest && compareVersions(bare(latest), bare(have)) > 0 ? bare(latest) : null;
}

type Answer = HostTools | "loading" | "error";

function useHostTools(hosts: Device[]): Record<string, Answer> {
  const [byHost, setByHost] = useState<Record<string, Answer>>({});
  const ids = hosts.map((h) => h.id).join(",");
  useEffect(() => {
    let alive = true;
    for (const id of ids ? ids.split(",") : []) {
      setByHost((p) => ({ ...p, [id]: p[id] && p[id] !== "error" ? p[id] : "loading" }));
      rpcCall(id, "host.info", {}, 8_000).then(
        (r) => alive && setByHost((p) => ({ ...p, [id]: r.tools ?? {} })),
        () => alive && setByHost((p) => ({ ...p, [id]: "error" })),
      );
    }
    return () => {
      alive = false;
    };
  }, [ids]);
  return byHost;
}

function HostToolRows({ tools }: { tools: Answer | undefined }) {
  if (tools === undefined || tools === "loading") return <SetRow title="正在读取…" />;
  if (tools === "error") return <SetRow title="读不到" about="这台电脑没回答，可能是它的后台服务版本太旧。" />;
  const installed = TOOLS.filter((t) => tools[t.id]);
  if (!installed.length) return <SetRow title="没有找到" about="这台电脑上没装 hc、Herdr 或 uniflo。" />;
  const checkedAt = tools.latest?.checkedAt;
  const anyNewer = installed.some((t) => newerOf(tools, t.id));
  return (
    <>
      {installed.map((t) => {
        const newer = newerOf(tools, t.id);
        const known = t.id !== "herdr" && tools.latest?.[t.id];
        return (
          <SetRow key={t.id} title={t.label}>
            <span className="tool-version">
              <span className="mono">{tools[t.id]}</span>
              {newer ? <span className="tool-newer">可更新到 {newer}</span> : known ? <span className="faint">最新</span> : null}
            </span>
          </SetRow>
        );
      })}
      <div className="tool-checked faint">
        {checkedAt ? `上次检查 ${relTime(checkedAt)}` : "还没检查"}
        {anyNewer ? "。在它们自己的应用或命令行里更新。" : ""}
      </div>
    </>
  );
}

/**
 * Settings › 更新: what each connected computer has installed of hc, Herdr and uniflo, and what
 * hostd's daily check (`update.checkTools`) found upstream. Report only: nothing installs here.
 */
export function ToolVersionsSection() {
  const devices = liveStore.use((s) => s.devices);
  const autoCheck = useClientConfig().update.autoCheck;
  const hosts = Object.values(devices)
    .filter((d) => d.kind === "host" && d.online)
    .sort((a, b) => a.name.localeCompare(b.name));
  const byHost = useHostTools(hosts);

  return (
    <>
      <SetHeading>hc、Herdr 和 uniflo</SetHeading>
      {hosts.length === 0 ? (
        <SetRow title="没有在线的电脑" about="电脑连上中转服务器后，这里会列出它装的版本。" />
      ) : (
        hosts.map((h) => (
          <div key={h.id} className="tool-host">
            <div className="tool-host-name">{h.name}</div>
            <HostToolRows tools={byHost[h.id]} />
          </div>
        ))
      )}
      <ConfigSwitch
        k="update.checkTools"
        disabled={!autoCheck}
        about={autoCheck ? "这台电脑的后台服务每天查一次，只提示，不会自动安装。" : "要先打开上面的“自动检查更新”。"}
      />
    </>
  );
}
