import { abilityAccessCtrl, bundleManager, common, Permissions, Want } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { BusinessError, deviceInfo } from '@kit.BasicServicesKit';
import { notificationManager } from '@kit.NotificationKit';

const PREFS_NAME: string = 'herdr_pocket_prefs';

export class PocketHarmonyBridge {
  private static instance: PocketHarmonyBridge | null = null;
  private context: common.UIAbilityContext | null = null;
  private pref: preferences.Preferences | null = null;
  private versionName: string = '0.2.60';
  private topDip: number = 0;
  private bottomDip: number = 0;
  private pendingUrl: string = '';
  private safeAreaListener: ((top: number, bottom: number) => void) | null = null;
  private urlListener: ((url: string) => void) | null = null;

  static getInstance(): PocketHarmonyBridge {
    if (!PocketHarmonyBridge.instance) {
      PocketHarmonyBridge.instance = new PocketHarmonyBridge();
    }
    return PocketHarmonyBridge.instance;
  }

  init(ctx: common.UIAbilityContext): void {
    this.context = ctx;
    if (!this.pref) {
      try {
        const opts: preferences.Options = { name: PREFS_NAME };
        this.pref = preferences.getPreferencesSync(ctx, opts);
      } catch (_err) {
        this.pref = null;
      }
    }
    bundleManager
      .getBundleInfoForSelf(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT)
      .then((info: bundleManager.BundleInfo) => {
        if (info.versionName) {
          this.versionName = info.versionName;
        }
      })
      .catch((_err: BusinessError) => {});
  }

  setSafeArea(topDip: number, bottomDip: number): void {
    this.topDip = Math.max(0, Math.round(topDip));
    this.bottomDip = Math.max(0, Math.round(bottomDip));
    if (this.safeAreaListener) {
      this.safeAreaListener(this.topDip, this.bottomDip);
    }
  }

  setSafeAreaListener(listener: ((top: number, bottom: number) => void) | null): void {
    this.safeAreaListener = listener;
  }

  setPendingOpenUrl(url: string): void {
    const clean: string = url.trim();
    if (!clean) {
      return;
    }
    if (this.urlListener) {
      this.urlListener(clean);
    } else {
      this.pendingUrl = clean;
    }
  }

  setOpenUrlListener(listener: ((url: string) => void) | null): void {
    this.urlListener = listener;
    if (listener && this.pendingUrl) {
      const url: string = this.pendingUrl;
      this.pendingUrl = '';
      listener(url);
    }
  }

  platform(): string {
    return 'openharmony';
  }

  deviceName(): string {
    if (deviceInfo.marketName && deviceInfo.marketName.length > 0) {
      return deviceInfo.marketName;
    }
    if (deviceInfo.productModel && deviceInfo.productModel.length > 0) {
      return deviceInfo.productModel;
    }
    return 'HarmonyOS Device';
  }

  appVersion(): string {
    return this.versionName;
  }

  getSafeArea(): string {
    return `{"top":${this.topDip},"bottom":${this.bottomDip}}`;
  }

  readRawFile(relPath: string): ArrayBuffer | null {
    if (!this.context || !relPath || relPath.includes('..')) {
      return null;
    }
    try {
      const raw: Uint8Array = this.context.resourceManager.getRawFileContentSync(relPath);
      return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    } catch (_err) {
      return null;
    }
  }

  getPref(key: string): string {
    if (!this.pref || !key) {
      return '';
    }
    try {
      const value: preferences.ValueType = this.pref.getSync(key, '');
      return typeof value === 'string' ? value : String(value);
    } catch (_err) {
      return '';
    }
  }

  setPref(key: string, val: string): void {
    if (!this.pref || !key) {
      return;
    }
    try {
      this.pref.putSync(key, val);
      this.pref.flush();
    } catch (_err) {
      // ignore storage write failure
    }
  }

  deletePref(key: string): void {
    if (!this.pref || !key) {
      return;
    }
    try {
      this.pref.deleteSync(key);
      this.pref.flush();
    } catch (_err) {
      // ignore storage delete failure
    }
  }

  notify(title: string, body: string): void {
    try {
      const normalContent: notificationManager.NotificationBasicContent = {
        title: title,
        text: body,
      };
      const content: notificationManager.NotificationContent = {
        notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
        normal: normalContent,
      };
      const request: notificationManager.NotificationRequest = {
        id: Math.floor(Date.now() % 100000000),
        content: content,
      };
      notificationManager.publish(request).catch((_err: BusinessError) => {});
    } catch (_err) {
      // ignore notification failure
    }
  }

  openExternal(url: string): void {
    const clean: string = url.trim();
    if (!this.context || (!clean.startsWith('https://') && !clean.startsWith('http://'))) {
      return;
    }
    const want: Want = {
      action: 'ohos.want.action.viewData',
      entities: ['entity.system.browsable'],
      uri: clean,
    };
    this.context.startAbility(want).catch((_err: BusinessError) => {});
  }

  async requestMicrophone(): Promise<boolean> {
    if (!this.context) {
      return false;
    }
    try {
      const atManager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
      const permissions: Array<Permissions> = ['ohos.permission.MICROPHONE'];
      const result = await atManager.requestPermissionsFromUser(this.context, permissions);
      return result.authResults.length > 0 && result.authResults[0] === 0;
    } catch (_err) {
      return false;
    }
  }
}
