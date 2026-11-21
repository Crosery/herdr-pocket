import { useEffect, useMemo, useState } from "react";
import { OPENAI_REALTIME_VOICES, type PromptId, type VoiceProviderId } from "@herdr-pocket/protocol";
import {
  PocketBadge,
  PocketButton,
  PocketCard,
  PocketInput,
  PocketSelect,
  PocketTextarea,
  fs,
  useToast,
} from "../../components/PocketUI";
import { assistantConfigStore, loadAssistantConfig, saveAssistantConfig, saveAssistantPrompt } from "../../lib/assistant";
import { SOTA_VOICE_PRESETS, matchVoicePresetId } from "../../lib/voicePresets";
import { ModelsSection } from "./ModelsSection";
import { ProvidersSection, ResetSection } from "./ProvidersSection";
import "../../styles/models.css";

export type AssistantTab = "models" | "voice" | "prompts";

const TABS: Array<{ id: AssistantTab; label: string }> = [
  { id: "models", label: "文字模型" },
  { id: "voice", label: "名字与语音" },
  { id: "prompts", label: "提示词" },
];

/** 小羊助理 settings: text models and providers, realtime voice and prompts (stored on the relay). */
export function AssistantSettings({ subTab, onSubTab }: { subTab: AssistantTab; onSubTab: (t: AssistantTab) => void }) {
  const toast = useToast();
  const cfg = assistantConfigStore.use((v) => v.config);
  const loading = assistantConfigStore.use((v) => v.loading);
  const prompts = assistantConfigStore.use((v) => v.prompts);

  const [assistantName, setAssistantName] = useState("小羊");
  const [voiceProvider, setVoiceProvider] = useState<VoiceProviderId | "off">("openai-realtime");
  const [voiceUrl, setVoiceUrl] = useState("");
  const [voiceModel, setVoiceModel] = useState("gpt-realtime");
  const [voiceId, setVoiceId] = useState("marin");
  const [voiceKey, setVoiceKey] = useState("");
  const [customVoiceMode, setCustomVoiceMode] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<{ id: PromptId; text: string } | null>(null);

  const matchedVoicePreset = useMemo(
    () => (customVoiceMode ? "custom" : matchVoicePresetId(voiceProvider, voiceUrl, voiceModel)),
    [customVoiceMode, voiceModel, voiceProvider, voiceUrl],
  );
  const activeVoicePreset = useMemo(
    () => SOTA_VOICE_PRESETS.find((p) => p.id === matchedVoicePreset) ?? SOTA_VOICE_PRESETS[SOTA_VOICE_PRESETS.length - 1]!,
    [matchedVoicePreset],
  );

  useEffect(() => {
    void loadAssistantConfig();
  }, []);

  useEffect(() => {
    if (!cfg) return;
    setAssistantName(cfg.name || "小羊");
    setVoiceProvider(cfg.voice.provider ?? "off");
    setVoiceUrl(cfg.voice.url ?? "");
    setVoiceModel(cfg.voice.model ?? "gpt-realtime");
    setVoiceId(cfg.voice.voice ?? "marin");
    setCustomVoiceMode(false);
  }, [cfg]);

  const applyVoicePreset = (presetId: string) => {
    const preset = SOTA_VOICE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    if (preset.id === "custom") {
      setCustomVoiceMode(true);
      if (voiceProvider === "off") setVoiceProvider("openai-realtime");
      return;
    }
    setCustomVoiceMode(false);
    setVoiceProvider(preset.provider);
    setVoiceUrl(preset.url);
    setVoiceModel(preset.model);
    if (preset.defaultVoice) {
      setVoiceId(preset.defaultVoice);
    } else if (preset.provider === "moss-live" && OPENAI_REALTIME_VOICES.some((v) => v.id === voiceId)) {
      setVoiceId("");
    }
  };

  const saveVoice = async () => {
    if (!cfg) return;
    try {
      await saveAssistantConfig({
        rev: cfg.rev,
        name: assistantName.trim() || "小羊",
        voice:
          voiceProvider === "off"
            ? { provider: null }
            : {
                provider: voiceProvider,
                url: voiceUrl.trim() || undefined,
                model: voiceModel.trim() || undefined,
                voice: voiceId.trim() || undefined,
                ...(voiceKey.trim() ? { apiKey: voiceKey.trim() } : {}),
              },
      });
      setVoiceKey("");
      toast("小羊设置已保存");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <div className="stack">
      <div className="stack">
        {/* One line per label at every width; a narrow window scrolls the bar sideways (QA U1). */}
        <div className="segmented assistant-tabs" role="tablist" aria-label="小羊助理设置">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={subTab === t.id} className={subTab === t.id ? "active" : ""} onClick={() => onSubTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="faint">
          {subTab === "models"
            ? "存在中转服务器上，所有手机和电脑共用；改了马上生效。"
            : "这些设置保存在中转服务器上，所有手机和电脑共用；改完要点“保存”。"}
        </div>

        {subTab === "models" ? (
          cfg ? (
            <div className="mm-stack">
              <ModelsSection cfg={cfg} />
              <ProvidersSection cfg={cfg} />
              <ResetSection cfg={cfg} />
            </div>
          ) : (
            <div className="mm-card mm-empty">
              <strong>{loading ? "正在读取小羊的设置…" : "暂未加载到小羊配置"}</strong>
              {loading ? null : (
                <PocketButton size="sm" variant="soft" onClick={() => void loadAssistantConfig()}>
                  再试一次
                </PocketButton>
              )}
            </div>
          )
        ) : null}

        {subTab === "voice" ? (
          <PocketCard>
            <div className="stack">
              <div style={{ fontWeight: 800, fontSize: fs(15) }}>小羊名字与实时语音服务</div>
              <div className="stack" style={{ gap: 6 }}>
                <label className="faint">助理名称</label>
                <PocketInput value={assistantName} onChange={(e) => setAssistantName(e.target.value)} />
              </div>
              <div className="stack" style={{ gap: 6 }}>
                <label className="faint">SOTA 实时语音模型预设</label>
                <PocketSelect
                  ariaLabel="SOTA 实时语音模型预设"
                  value={matchedVoicePreset}
                  onValueChange={applyVoicePreset}
                  options={SOTA_VOICE_PRESETS.map((p) => ({
                    value: p.id,
                    label: p.label,
                    badge: p.badge,
                    tone: p.local ? "accent" : "default",
                  }))}
                />
                <div className="faint" style={{ fontSize: fs(12), lineHeight: 1.5 }}>
                  {activeVoicePreset.hint}（保存后与手机端实时同步；下方所有参数仍可自由微调。）
                </div>
              </div>
              <div className="stack" style={{ gap: 6 }}>
                <label className="faint">实时语音协议</label>
                <PocketSelect
                  ariaLabel="实时语音协议"
                  value={voiceProvider}
                  onValueChange={(v) => setVoiceProvider(v as VoiceProviderId | "off")}
                  options={[
                    { value: "openai-realtime", label: "OpenAI Realtime 兼容" },
                    { value: "moss-live", label: "MOSS-Live" },
                    { value: "off", label: "关闭语音通话" },
                  ]}
                />
              </div>
              {voiceProvider !== "off" ? (
                <>
                  <div className="stack" style={{ gap: 6 }}>
                    <label className="faint">WebSocket 接入地址</label>
                    <PocketInput
                      mono
                      value={voiceUrl}
                      onChange={(e) => {
                        setCustomVoiceMode(false);
                        setVoiceUrl(e.target.value);
                      }}
                      placeholder="wss://api.example.com/v1/realtime"
                    />
                  </div>
                  <div className="stack" style={{ gap: 6 }}>
                    <label className="faint">模型名称</label>
                    <PocketInput
                      mono
                      value={voiceModel}
                      onChange={(e) => {
                        setCustomVoiceMode(false);
                        setVoiceModel(e.target.value);
                      }}
                    />
                  </div>
                  {voiceProvider === "openai-realtime" ? (
                    <div className="stack" style={{ gap: 6 }}>
                      <label className="faint">音色（默认 marin）</label>
                      <div className="row wrap" style={{ gap: 6 }}>
                        {OPENAI_REALTIME_VOICES.map((v) => (
                          <PocketButton
                            key={v.id}
                            size="sm"
                            variant={voiceId === v.id ? "primary" : "ghost"}
                            onClick={() => setVoiceId(v.id)}
                          >
                            {v.label}
                          </PocketButton>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <div className="stack" style={{ gap: 6 }}>
                    <label className="faint">覆盖语音服务密钥（留空保持当前配置）</label>
                    <PocketInput mono type="password" value={voiceKey} onChange={(e) => setVoiceKey(e.target.value)} placeholder={cfg?.voice.key.set ? `已配密钥 ···${cfg.voice.key.hint || ""}` : "输入新 API Key"} />
                  </div>
                </>
              ) : null}
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <PocketButton onClick={() => void saveVoice()}>保存语音配置</PocketButton>
              </div>
            </div>
          </PocketCard>
        ) : null}

        {subTab === "prompts" ? (
          <PocketCard>
            <div className="stack">
              <div style={{ fontWeight: 800, fontSize: fs(15) }}>提示词工作台</div>
              {editingPrompt ? (
                <div className="stack">
                  <div className="between">
                    <strong>编辑：{editingPrompt.id}</strong>
                    <div className="row" style={{ gap: 6 }}>
                      <PocketButton size="sm" variant="ghost" onClick={() => setEditingPrompt(null)}>返回</PocketButton>
                      <PocketButton
                        size="sm"
                        variant="soft"
                        onClick={async () => {
                          try {
                            await saveAssistantPrompt(editingPrompt.id, { reset: true });
                            setEditingPrompt(null);
                            toast("已恢复默认提示词");
                          } catch (e) {
                            toast((e as Error).message, true);
                          }
                        }}
                      >
                        恢复默认
                      </PocketButton>
                      <PocketButton
                        size="sm"
                        variant="primary"
                        onClick={async () => {
                          try {
                            await saveAssistantPrompt(editingPrompt.id, { text: editingPrompt.text });
                            setEditingPrompt(null);
                            toast("提示词已保存");
                          } catch (e) {
                            toast((e as Error).message, true);
                          }
                        }}
                      >
                        保存
                      </PocketButton>
                    </div>
                  </div>
                  <PocketTextarea rows={10} mono value={editingPrompt.text} onChange={(e) => setEditingPrompt({ ...editingPrompt, text: e.target.value })} />
                </div>
              ) : (
                <div className="stack" style={{ gap: 8 }}>
                  {prompts.map((p) => (
                    <PocketCard key={p.id} soft>
                      <div className="between wrap">
                        <div>
                          <div className="row" style={{ gap: 8 }}>
                            <strong>{p.title}</strong>
                            {p.edited ? <PocketBadge tone="pink">已改写</PocketBadge> : null}
                          </div>
                          <div className="faint">{p.about}</div>
                        </div>
                        <PocketButton size="sm" variant="soft" onClick={() => setEditingPrompt({ id: p.id, text: p.text })}>
                          编辑
                        </PocketButton>
                      </div>
                    </PocketCard>
                  ))}
                </div>
              )}
            </div>
          </PocketCard>
        ) : null}
      </div>
    </div>
  );
}
