import { webview } from '@kit.ArkWeb';
import { PocketHarmonyBridge } from '../bridge/PocketHarmonyBridge';

const PROXY_SYNC_METHODS: Array<string> = [
  'platform',
  'deviceName',
  'appVersion',
  'getPref',
  'setPref',
  'deletePref',
  'notify',
  'openExternal',
  'getSafeArea',
];

const PROXY_ASYNC_METHODS: Array<string> = ['requestMicrophone'];

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private bridge: PocketHarmonyBridge = PocketHarmonyBridge.getInstance();
  private pageReady: boolean = false;

  private pushSafeArea(top: number, bottom: number): void {
    if (!this.pageReady) {
      return;
    }
    try {
      this.controller.runJavaScript(`window.__POCKET_SET_SAFE_AREA__&&window.__POCKET_SET_SAFE_AREA__(${top},${bottom})`);
    } catch (_err) {
      // ignore script bridge errors before load
    }
  }

  private pushOpenUrl(url: string): void {
    if (!this.pageReady) {
      return;
    }
    try {
      const encoded: string = JSON.stringify(url);
      this.controller.runJavaScript(`window.__POCKET_OPEN_URL__&&window.__POCKET_OPEN_URL__(${encoded})`);
    } catch (_err) {
      // ignore script bridge errors
    }
  }

  aboutToDisappear(): void {
    this.bridge.setSafeAreaListener(null);
    this.bridge.setOpenUrlListener(null);
    try {
      this.controller.deleteJavaScriptRegister('PocketHarmony');
    } catch (_err) {
      // ignore
    }
  }

  onBackPress(): boolean {
    try {
      if (this.controller.accessBackward()) {
        this.controller.backward();
        return true;
      }
    } catch (_err) {
      // ignore
    }
    return false;
  }

  build() {
    Column() {
      Web({ src: $rawfile('index.html'), controller: this.controller })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .fileAccess(true)
        .mediaPlayGestureAccess(false)
        .mixedMode(MixedMode.All)
        .onControllerAttached(() => {
          try {
            this.controller.registerJavaScriptProxy(
              this.bridge,
              'PocketHarmony',
              PROXY_SYNC_METHODS,
              PROXY_ASYNC_METHODS,
            );
          } catch (_err) {
            // ignore duplicate registration
          }
        })
        .onPageEnd(() => {
          this.pageReady = true;
          this.bridge.setSafeAreaListener((top: number, bottom: number) => {
            this.pushSafeArea(top, bottom);
          });
          this.bridge.setOpenUrlListener((url: string) => {
            this.pushOpenUrl(url);
          });
        })
        .onPermissionRequest((event) => {
          if (event) {
            this.bridge.requestMicrophone().then((ok: boolean) => {
              if (ok) {
                event.request.grant(event.request.getAccessibleResource());
              } else {
                event.request.deny();
              }
            });
          }
        })
        .width('100%')
        .height('100%')
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#FFF6FA')
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
  }
}
