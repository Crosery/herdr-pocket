import { useState, type FormEvent } from "react";
import { ArrowRight, Link2, Sparkles } from "lucide-react";
import { parsePairInput } from "@herdr-pocket/protocol";
import { PocketButton, PocketCard, PocketInput, useToast } from "../components/PocketUI";
import { XiaoyangOrb } from "../components/MascotAndVendor";
import { defaultDeviceName, detectPlatform } from "../lib/bridge";
import { completePairing } from "../lib/relay";
import { DEMO_URL } from "../lib/mock";
import { settingsStore } from "../lib/store";

export function ConnectView() {
  const toast = useToast();
  const lastServer = settingsStore.use((s) => s.lastServer);
  const [server, setServer] = useState(lastServer ?? "");
  const [code, setCode] = useState("");
  const [name, setName] = useState(() => defaultDeviceName());
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);

  const handlePaste = (val: string) => {
    setPaste(val);
    const parsed = parsePairInput(val);
    if (parsed) {
      if (parsed.server) setServer(parsed.server);
      setCode(parsed.code);
      toast("已识别配对信息");
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await completePairing(server, code, name);
      toast("配对成功，欢迎回来");
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const enterDemo = async () => {
    setBusy(true);
    try {
      await completePairing(DEMO_URL, "DEMO-0000", name);
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const platformLabel: Record<string, string> = {
    macos: "macOS 桌面端",
    windows: "Windows 桌面端",
    linux: "Linux 桌面端",
    openharmony: "鸿蒙 NEXT 客户端",
    web: "网页客户端",
  };

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "28px 18px", display: "grid", placeItems: "center" }}>
      <div style={{ width: "100%", maxWidth: 440 }} className="stack">
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, textAlign: "center" }}>
          <XiaoyangOrb mood="hello" size={88} />
          <h1 className="cute-font" style={{ fontSize: 30, margin: "4px 0 0" }}>Herdr Pocket</h1>
          <div className="muted">
            {platformLabel[detectPlatform()] ?? "客户端"} · 输入中转服务器与配对码即可接入所有电脑上的 Agent
          </div>
        </div>

        <PocketCard>
          <form className="stack" onSubmit={submit}>
            <div className="stack" style={{ gap: 6 }}>
              <label className="faint" htmlFor="pair-paste">快速粘贴配对链接或邀请文本（可选）</label>
              <PocketInput
                id="pair-paste"
                placeholder="https://pocket.example.com/p/MEOW-4821"
                value={paste}
                onChange={(e) => handlePaste(e.target.value)}
              />
            </div>

            <div className="stack" style={{ gap: 6 }}>
              <label className="faint" htmlFor="pair-server">服务器地址</label>
              <PocketInput
                id="pair-server"
                placeholder="https://pocket.example.com"
                value={server}
                onChange={(e) => setServer(e.target.value)}
              />
            </div>

            <div className="stack" style={{ gap: 6 }}>
              <label className="faint" htmlFor="pair-code">配对码</label>
              <PocketInput
                id="pair-code"
                mono
                placeholder="MEOW-4821"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
            </div>

            <div className="stack" style={{ gap: 6 }}>
              <label className="faint" htmlFor="pair-name">设备名称</label>
              <PocketInput
                id="pair-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <PocketButton variant="primary" size="lg" type="submit" disabled={busy || !server.trim() || !code.trim()}>
              <Link2 size={16} />
              <span>{busy ? "正在连接…" : "连接并配对"}</span>
              <ArrowRight size={16} />
            </PocketButton>
          </form>
        </PocketCard>

        <PocketButton variant="ghost" size="lg" disabled={busy} onClick={() => void enterDemo()}>
          <Sparkles size={16} />
          <span>先随便看看（演示模式）</span>
        </PocketButton>
      </div>
    </div>
  );
}
