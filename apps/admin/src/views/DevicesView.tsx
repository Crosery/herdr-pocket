import { useState } from "react";
import {
  Check,
  Copy,
  Laptop,
  QrCode,
  ShieldAlert,
  Smartphone,
  Trash2,
  UserCheck,
  X,
} from "lucide-react";
import {
  adminApi,
  fmtAgo,
  fmtTime,
  type Device,
  type DeviceKind,
  type JoinRequest,
  type PairCodeResponse,
} from "../lib/api";
import { XiaoyangOrb } from "../components/MascotAndVendor";
import {
  EmptyState,
  PocketButton,
  PocketCard,
  PocketConfirmDialog,
  PocketDialog,
  PocketInput,
  PocketSegmented,
  useToast,
} from "../components/ui/PocketUI";

export function DevicesView({
  devices,
  joins,
  pairModalOpen,
  onPairModalChange,
  onReload,
}: {
  devices: Device[];
  joins: JoinRequest[];
  pairModalOpen: boolean;
  onPairModalChange: (open: boolean) => void;
  onReload: () => Promise<void>;
}) {
  const toast = useToast();
  const [revokeTarget, setRevokeTarget] = useState<Device | null>(null);
  const [pairKind, setPairKind] = useState<"" | DeviceKind>("");
  const [pairRes, setPairRes] = useState<PairCodeResponse | null>(null);
  const [minting, setMinting] = useState(false);

  const mint = async (kindOverride?: "" | DeviceKind) => {
    const k = kindOverride ?? pairKind;
    setMinting(true);
    try {
      const res = await adminApi.mintPairCode(k || undefined);
      setPairRes(res);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setMinting(false);
    }
  };

  const copyText = async (val: string, label: string) => {
    try {
      await navigator.clipboard.writeText(val);
      toast(`已复制${label}`);
    } catch {
      toast("当前浏览器限制了剪贴板读取，请手动全选复制", true);
    }
  };

  const handleJoin = async (id: string, allow: boolean) => {
    try {
      if (allow) await adminApi.approveJoin(id);
      else await adminApi.denyJoin(id);
      await onReload();
      toast(allow ? "已放行该设备加入" : "已拒绝加入请求");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <div className="stack">
      {/* Pending joins */}
      {joins.length ? (
        <PocketCard soft>
          <div className="pk-card-head">
            <h3 className="pk-card-title">
              <UserCheck size={18} style={{ color: "var(--accent-text)" }} />
              <span>待审批的加入请求</span>
              <span className="pk-pill blocked num">{joins.length}</span>
            </h3>
          </div>
          <div className="grid-2">
            {joins.map((j) => (
              <div key={j.id} className="agent-card need">
                <div className="between">
                  <div className="row" style={{ gap: 11 }}>
                    <XiaoyangOrb mood="waiting" size={48} />
                    <div>
                      <div style={{ fontWeight: 800, fontSize: 15 }}>{j.name}</div>
                      <div className="faint">
                        {j.kind === "host" ? "电脑" : "手机"} · {j.platform || "未知系统"} · 过期 {fmtTime(j.expiresAt)}
                      </div>
                    </div>
                  </div>
                  <div className="row">
                    <PocketButton variant="primary" size="sm" onClick={() => handleJoin(j.id, true)}>
                      <Check size={14} />
                      <span>放行</span>
                    </PocketButton>
                    <PocketButton variant="danger" size="sm" onClick={() => handleJoin(j.id, false)}>
                      <X size={14} />
                      <span>拒绝</span>
                    </PocketButton>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </PocketCard>
      ) : null}

      {/* Paired devices */}
      <PocketCard>
        <div className="pk-card-head">
          <div>
            <h3 className="pk-card-title">
              <Laptop size={18} style={{ color: "var(--accent-text)" }} />
              <span>已配对设备</span>
              <span className="pk-pill pink num">{devices.length}</span>
            </h3>
            <div className="faint" style={{ marginTop: 2 }}>
              电脑通过 hostd 主动向外连到 relay，手机端只认配对令牌。
            </div>
          </div>
          <PocketButton
            variant="primary"
            onClick={() => {
              setPairRes(null);
              onPairModalChange(true);
            }}
          >
            <QrCode size={16} />
            <span>生成配对二维码</span>
          </PocketButton>
        </div>

        {devices.length ? (
          <div className="grid-2">
            {devices.map((d) => {
              const isHost = d.kind === "host";
              return (
                <div key={d.id} className="agent-card">
                  <div className="between" style={{ alignItems: "flex-start" }}>
                    <div className="row grow" style={{ gap: 12 }}>
                      <div className={`setting-icon-tile${isHost ? " lavender" : ""}`}>
                        {isHost ? <Laptop size={21} /> : <Smartphone size={21} />}
                      </div>
                      <div className="grow">
                        <div className="row" style={{ gap: 8 }}>
                          <span style={{ fontWeight: 800, fontSize: 15 }}>{d.name}</span>
                          <span className={`pk-pill ${d.online ? "working" : ""}`}>
                            {d.online ? <i className="pk-dot pulse" /> : null}
                            <span>{d.online ? "在线" : "离线"}</span>
                          </span>
                        </div>
                        <div className="faint mono truncate" style={{ marginTop: 2 }}>
                          {d.id}
                        </div>
                      </div>
                    </div>
                    <PocketButton
                      variant="danger"
                      size="sm"
                      onClick={() => setRevokeTarget(d)}
                    >
                      <Trash2 size={13} />
                      <span>吊销</span>
                    </PocketButton>
                  </div>

                  <div className="between wrap" style={{ gap: 6 }}>
                    <div className="row wrap" style={{ gap: 6 }}>
                      <span className={`pk-pill ${isHost ? "lavender" : "pink"}`}>
                        {isHost ? "电脑主机" : "手机端"}
                      </span>
                      {d.platform ? <span className="pk-pill mono">{d.platform}</span> : null}
                      {d.version ? <span className="pk-pill mono">v{d.version}</span> : null}
                      {(d.sources ?? []).map((s) => (
                        <span key={s} className="pk-pill mono">
                          {s}
                        </span>
                      ))}
                    </div>
                    <span className="faint num">最近活跃：{fmtAgo(d.lastSeenAt)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            mood="hello"
            title="还没有已配对的设备"
            hint="点右上角生成一次一码二维码，用手机扫一扫或者在电脑运行 herdr-pocket pair 就能接入。"
          />
        )}
      </PocketCard>

      {/* QR Pairing Modal */}
      <PocketDialog
        open={pairModalOpen}
        onOpenChange={onPairModalChange}
        title={
          <>
            <QrCode size={18} style={{ color: "var(--accent-text)" }} />
            <span>新增设备配对码</span>
          </>
        }
        description="配对码只能使用一次，约 10 分钟后失效。手机相机扫码即可直达授权页。"
      >
        <div className="stack" style={{ gap: 14 }}>
          <div className="between wrap">
            <span className="field-label">限制设备类型</span>
            <PocketSegmented
              value={pairKind}
              onChange={(val) => {
                setPairKind(val);
              }}
              options={[
                { value: "", label: "不限" },
                { value: "viewer", label: "仅限手机" },
                { value: "host", label: "仅限电脑" },
              ]}
            />
          </div>

          <PocketButton variant="primary" size="lg" onClick={() => mint()} disabled={minting}>
            <QrCode size={16} />
            <span>{minting ? "正在生成…" : pairRes ? "重新生成一个新码" : "立即生成一次性配对码"}</span>
          </PocketButton>

          {pairRes ? (
            <div
              className="stack"
              style={{
                padding: 16,
                borderRadius: 20,
                background: "var(--surface-2)",
                border: "1px solid var(--divider)",
                alignItems: "center",
                textAlign: "center",
              }}
            >
              {pairRes.qrSvg ? (
                <div className="qr-frame">
                  <img
                    src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(pairRes.qrSvg)}`}
                    alt="配对二维码"
                  />
                </div>
              ) : null}

              <div className="row" style={{ gap: 8 }}>
                <span className="mono" style={{ fontSize: 24, fontWeight: 700, letterSpacing: 2 }}>
                  {pairRes.code}
                </span>
                <PocketButton variant="soft" size="sm" onClick={() => copyText(pairRes.code, "配对码")}>
                  <Copy size={13} />
                  <span>复制码</span>
                </PocketButton>
              </div>

              <div className="faint">有效期至 {fmtTime(pairRes.expiresAt)}</div>

              <div className="row" style={{ width: "100%" }}>
                <div className="grow">
                  <PocketInput mono readOnly value={pairRes.link} />
                </div>
                <PocketButton variant="ghost" onClick={() => copyText(pairRes.link, "邀请链接")}>
                  <Copy size={14} />
                  <span>复制链接</span>
                </PocketButton>
              </div>
            </div>
          ) : (
            <div className="row" style={{ gap: 12, padding: "10px 4px", justifyContent: "center" }}>
              <XiaoyangOrb mood="yay" size={52} />
              <div className="faint">点上方粉色按钮即可生成二维码和邀请短码</div>
            </div>
          )}
        </div>
      </PocketDialog>

      {/* Revoke confirmation */}
      <PocketConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title="确认吊销设备？"
        description={
          revokeTarget
            ? `吊销「${revokeTarget.name}」后，该设备的长连接会立刻断开，需要重新配对才能再连上来。`
            : ""
        }
        confirmLabel="确认吊销"
        danger
        onConfirm={async () => {
          if (!revokeTarget) return;
          try {
            await adminApi.revokeDevice(revokeTarget.id);
            await onReload();
            toast(`已吊销 ${revokeTarget.name}`);
          } catch (e) {
            toast((e as Error).message, true);
          }
        }}
      />
    </div>
  );
}
