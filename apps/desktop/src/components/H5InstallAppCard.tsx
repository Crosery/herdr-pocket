import { useMemo, useState } from "react";
import { Download, Share, Smartphone } from "lucide-react";
import { isH5Web } from "../lib/bridge";
import { recognizeWebDevice } from "../lib/h5Identity";
import { promptNativePwaInstall, pwaStore } from "../lib/pwa";
import { PocketBadge, PocketButton, PocketModal, useToast } from "./PocketUI";
import { SetRow } from "../views/settings/rows";

function useInstallSteps() {
  return useMemo(() => {
    const dev = recognizeWebDevice();
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    const inAppBrowser = /micromessenger|lark|feishu|dingtalk/i.test(ua);
    const isIosLike = dev.platform === "h5-ios" || dev.platform === "h5-ipados";
    if (inAppBrowser) {
      return {
        label: "先在系统浏览器中打开再安装",
        steps: [
          "点右上角菜单，选择「在默认浏览器中打开」（iPhone/iPad 请选 Safari）。",
          "打开系统浏览器页面后，点击底部的「添加到主屏幕」或浏览器菜单里的「安装应用」。",
          "以后直接从手机桌面图标全屏启动，点「通行密钥登录」即可无缝回到当前身份。",
        ],
      };
    }
    if (isIosLike) {
      return {
        label: "iPhone / iPad 添加到主屏幕",
        steps: [
          "点击 Safari 底部（或顶部）的「分享」图标（方框加向上箭头）。",
          "在弹出菜单中向下滑动，点击「添加到主屏幕」，再点右上角「添加」。",
          "回到手机桌面点击 Herdr Pocket 粉色图标打开，即可无地址栏全屏运行，并通过通行密钥一键恢复原身份。",
        ],
      };
    }
    return {
      label: "在手机浏览器里安装为桌面应用",
      steps: [
        "点浏览器右上角（或底部）菜单按钮。",
        "选择「安装应用」「安装 Herdr Pocket」或「添加到主屏幕」。",
        "添加到手机桌面后即可全屏独立运行，打开后点击「通行密钥登录」即可直连原身份。",
      ],
    };
  }, []);
}

/** Shows a native WebAPK install CTA or Add-to-Home-Screen guide so H5 runs like a standalone phone app. */
export function H5InstallAppCard({ compact = false }: { compact?: boolean }) {
  const toast = useToast();
  const { standalone, canPromptInstall } = pwaStore.use((s) => s);
  const [guideOpen, setGuideOpen] = useState(false);
  const guide = useInstallSteps();

  if (!isH5Web()) return null;

  const triggerInstall = async () => {
    if (canPromptInstall) {
      const outcome = await promptNativePwaInstall();
      if (outcome === "accepted") {
        toast("已将 Herdr Pocket 添加到桌面");
        return;
      }
      if (outcome === "dismissed") return;
    }
    setGuideOpen(true);
  };

  if (standalone) {
    if (compact) return null;
    return (
      <SetRow title="手机桌面应用" about="当前正从主屏幕独立全屏窗口运行 Herdr Pocket">
        <PocketBadge tone="mint">独立桌面应用已启用</PocketBadge>
      </SetRow>
    );
  }

  return (
    <>
      {compact ? (
        <div className="h5-install-strip">
          <div className="grow min-w-0">
            <div className="h5-install-title">装成手机桌面应用（无地址栏全屏）</div>
            <div className="faint">添加到主屏幕后像原生 App 一样启动，不占浏览器标签页。</div>
          </div>
          <PocketButton size="sm" variant={canPromptInstall ? "primary" : "soft"} onClick={() => void triggerInstall()}>
            {canPromptInstall ? <Download size={14} /> : <Share size={14} />}
            <span>{canPromptInstall ? "安装到桌面" : "添加到主屏幕"}</span>
          </PocketButton>
        </div>
      ) : (
        <SetRow title="装成手机桌面应用" about="添加到手机主屏幕后可全屏独立打开，直接通过通行密钥恢复原身份">
          <PocketButton size="sm" variant={canPromptInstall ? "primary" : "soft"} onClick={() => void triggerInstall()}>
            <Smartphone size={14} />
            <span>{canPromptInstall ? "安装到桌面" : "添加到主屏幕"}</span>
          </PocketButton>
        </SetRow>
      )}

      <PocketModal
        open={guideOpen}
        onOpenChange={setGuideOpen}
        title="把 Herdr Pocket 加到手机桌面"
        subtitle={guide.label}
        width={420}
      >
        <div className="stack" style={{ gap: 12 }}>
          <ol className="steps-list h5-install-steps">
            {guide.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <PocketButton size="sm" variant="primary" onClick={() => setGuideOpen(false)}>
              知道了
            </PocketButton>
          </div>
        </div>
      </PocketModal>
    </>
  );
}
