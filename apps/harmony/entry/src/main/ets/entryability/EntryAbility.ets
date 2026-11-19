import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { display, window } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { PocketHarmonyBridge } from '../bridge/PocketHarmonyBridge';

export default class EntryAbility extends UIAbility {
  private mainWin: window.Window | null = null;

  private updateSafeArea(win: window.Window): void {
    try {
      const density: number = Math.max(1, display.getDefaultDisplaySync().densityPixels);
      const sysArea: window.AvoidArea = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
      const navArea: window.AvoidArea = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);
      const topDip: number = sysArea.topRect.height / density;
      const bottomDip: number = navArea.bottomRect.height / density;
      PocketHarmonyBridge.getInstance().setSafeArea(topDip, bottomDip);
    } catch (_err) {
      // ignore display metric read errors
    }
  }

  private forwardWantUrl(want: Want): void {
    if (want.uri && want.uri.length > 0) {
      PocketHarmonyBridge.getInstance().setPendingOpenUrl(want.uri);
    }
  }

  onCreate(want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    const bridge: PocketHarmonyBridge = PocketHarmonyBridge.getInstance();
    bridge.init(this.context);
    this.forwardWantUrl(want);
  }

  onNewWant(want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    this.forwardWantUrl(want);
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err: BusinessError) => {
      if (err.code) {
        return;
      }
      try {
        const win: window.Window = windowStage.getMainWindowSync();
        this.mainWin = win;
        win.setWindowLayoutFullScreen(true).catch((_e: BusinessError) => {});
        this.updateSafeArea(win);
        win.on('avoidAreaChange', (_data: window.AvoidAreaOptions) => {
          if (this.mainWin) {
            this.updateSafeArea(this.mainWin);
          }
        });
      } catch (_e) {
        // ignore window setup failure
      }
    });
  }

  onWindowStageDestroy(): void {
    if (this.mainWin) {
      try {
        this.mainWin.off('avoidAreaChange');
      } catch (_e) {
        // ignore
      }
      this.mainWin = null;
    }
  }
}
