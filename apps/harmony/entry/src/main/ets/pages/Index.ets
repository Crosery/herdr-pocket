import { webview } from '@kit.ArkWeb';
import { PocketHarmonyBridge } from '../bridge/PocketHarmonyBridge';

const LOCAL_ORIGIN: string = 'https://app.herdrpocket.local';

interface MimeMeta {
  mime: string;
  isText: boolean;
}

function mimeForPath(path: string): MimeMeta {
  const lower: string = path.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    return { mime: 'text/html', isText: true };
  }
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) {
    return { mime: 'text/javascript', isText: true };
  }
  if (lower.endsWith('.css')) {
    return { mime: 'text/css', isText: true };
  }
  if (lower.endsWith('.json')) {
    return { mime: 'application/json', isText: true };
  }
  if (lower.endsWith('.svg')) {
    return { mime: 'image/svg+xml', isText: true };
  }
  if (lower.endsWith('.woff2')) {
    return { mime: 'font/woff2', isText: false };
  }
  if (lower.endsWith('.woff')) {
    return { mime: 'font/woff', isText: false };
  }
  if (lower.endsWith('.ttf')) {
    return { mime: 'font/ttf', isText: false };
  }
  if (lower.endsWith('.webp')) {
    return { mime: 'image/webp', isText: false };
  }
  if (lower.endsWith('.png')) {
    return { mime: 'image/png', isText: false };
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return { mime: 'image/jpeg', isText: false };
  }
  if (lower.endsWith('.ico')) {
    return { mime: 'image/x-icon', isText: false };
  }
  return { mime: 'application/octet-stream', isText: false };
}

function resolveRawPath(requestUrl: string): string | null {
  if (!requestUrl.startsWith(LOCAL_ORIGIN)) {
    return null;
  }
  let tail: string = requestUrl.slice(LOCAL_ORIGIN.length);
  const qIdx: number = tail.indexOf('?');
  if (qIdx >= 0) {
    tail = tail.slice(0, qIdx);
  }
  const hIdx: number = tail.indexOf('#');
  if (hIdx >= 0) {
    tail = tail.slice(0, hIdx);
  }
  tail = tail.replace(/^\/+/, '');
  if (tail.length === 0) {
    return 'index.html';
  }
  try {
    tail = decodeURIComponent(tail);
  } catch (_err) {
    // keep raw path if percent encoding is malformed
  }
  if (tail.includes('..')) {
    return null;
  }
  return tail;
}

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
      Web({ src: `${LOCAL_ORIGIN}/index.html`, controller: this.controller })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .fileAccess(true)
        .mediaPlayGestureAccess(false)
        .mixedMode(MixedMode.All)
        .onInterceptRequest((event) => {
          if (!event) {
            return null;
          }
          const reqUrl: string = event.request.getRequestUrl();
          if (!reqUrl.startsWith(LOCAL_ORIGIN)) {
            return null;
          }
          const relPath: string | null = resolveRawPath(reqUrl);
          const response: WebResourceResponse = new WebResourceResponse();
          const corsHeader: Header = { headerKey: 'Access-Control-Allow-Origin', headerValue: '*' };
          const cacheHeader: Header = { headerKey: 'Cache-Control', headerValue: 'no-cache' };
          const headers: Array<Header> = [corsHeader, cacheHeader];

          if (relPath) {
            const payload: ArrayBuffer | null = this.bridge.readRawFile(relPath);
            if (payload) {
              const meta: MimeMeta = mimeForPath(relPath);
              response.setResponseData(payload);
              response.setResponseMimeType(meta.mime);
              if (meta.isText) {
                response.setResponseEncoding('utf-8');
              }
              response.setResponseCode(200);
              response.setReasonMessage('OK');
              response.setResponseHeader(headers);
              response.setResponseIsReady(true);
              return response;
            }
          }

          response.setResponseData('Not Found');
          response.setResponseMimeType('text/plain');
          response.setResponseEncoding('utf-8');
          response.setResponseCode(404);
          response.setReasonMessage('Not Found');
          response.setResponseHeader(headers);
          response.setResponseIsReady(true);
          return response;
        })
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
