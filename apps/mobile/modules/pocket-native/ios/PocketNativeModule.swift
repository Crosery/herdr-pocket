import AVFoundation
import ExpoModulesCore
import UIKit
import UserNotifications

/**
 * The iOS side of PocketNative: voice call audio, alerts as local notifications
 * while the app is open, and picking pictures. What iOS does not allow says so
 * instead of pretending: no background alert service (notifierState.background
 * is false), no battery exemption, no in-app install of an update
 * (canInstallUpdates is false; downloadUpdate / installUpdate are absent).
 */
public class PocketNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PocketNative")

    Events(
      "onCall",
      "onCallEvent",
      "onLevel",
      "onNotice",
      "onNotifier",
      "onUpdateProgress",
      "onVoiceModelProgress",
      "onEnrollProgress",
      "onVoiceTest"
    )

    OnCreate {
      PocketBus.listener = { [weak self] name, body in self?.sendEvent(name, body) }
    }

    OnDestroy {
      PocketBus.listener = nil
    }

    /// Starts a voice call (needs the microphone allowed first: requestMicrophone).
    Function("startCall") { (server: String, token: String) in
      VoiceCall.start(server: server, token: token)
    }

    Function("hangup") {
      VoiceCall.current?.hangup()
    }

    Function("setMuted") { (muted: Bool) in
      VoiceCall.current?.setMuted(muted)
    }

    Function("callState") { () -> [String: Bool] in
      let call = VoiceCall.current
      return ["active": call != nil, "muted": call?.muted ?? false]
    }

    /// Asks for the microphone; resolves whether it may be used.
    AsyncFunction("requestMicrophone") { (promise: Promise) in
      if #available(iOS 17.0, *) {
        AVAudioApplication.requestRecordPermission { promise.resolve($0) }
      } else {
        AVAudioSession.sharedInstance().requestRecordPermission { promise.resolve($0) }
      }
    }

    /// Alerts: keeps /v1/notify open while the app runs (see Notifier).
    Function("configureNotifier") { (server: String?, token: String?, enabled: Bool, kinds: [String], _: String?) in
      Notifier.shared.configure(server: server, token: token, enabled: enabled, kinds: kinds)
    }

    Function("notifierState") { () -> [String: Any] in
      Notifier.shared.state()
    }

    /// Android only: iOS has no battery exemption to ask for.
    Function("requestBatteryExemption") {}

    /// Asks to show notifications; resolves whether they may show.
    AsyncFunction("requestNotificationPermission") { (promise: Promise) in
      UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
        Notifier.shared.refreshPermission()
        promise.resolve(granted)
      }
    }

    Function("openNotificationSettings") {
      DispatchQueue.main.async {
        let page: String
        if #available(iOS 16.0, *) {
          page = UIApplication.openNotificationSettingsURLString
        } else {
          page = UIApplication.openSettingsURLString
        }
        if let url = URL(string: page) { UIApplication.shared.open(url) }
      }
    }

    /// The installed version, e.g. "0.1.5".
    Function("appVersion") { () -> String? in
      Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    }

    /// iOS apps are not installed from inside an app.
    Function("canInstallUpdates") { false }

    /**
     * Lets the person pick up to `max` pictures; each comes back as
     * {name, mime, data (base64 JPEG), width, height, bytes}, its longest side at
     * most `maxSide`. Cancelled: an empty list.
     */
    AsyncFunction("pickImages") { (max: Int, maxSide: Int, quality: Int, promise: Promise) in
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.reject("E_NO_ACTIVITY", "the app is not in front")
        return
      }
      ImagePick.start(from: presenter, promise: promise, max: max, maxSide: maxSide, quality: quality)
    }.runOnQueue(.main)

    /// A local test notification, to check that alerts really show up.
    Function("testNotice") { (title: String, body: String) in
      NoticeCenter.post(id: "test-\(wallMs())", title: title, body: body)
    }

    Function("voiceState") { () -> [String: Any] in
      let enrolled = VoicePrefs.isCurrentEnrolled
      let legacyEnrolled = VoicePrefs.isLegacyEnrolled
      let svReady = VoiceModelManager.isSvOnlyReady()
      let tseModelsReady = VoiceModelManager.isTseModelsReady()
      let modelReady = svReady && tseModelsReady
      let tseReady = enrolled && modelReady && VoiceModelManager.hasOwnerSample()
      let realRtf = VoicePrefs.lastCallTseRtf > 0 ? VoicePrefs.lastCallTseRtf : VoicePrefs.benchTseRtf
      var state: [String: Any] = [
        "denoise": VoicePrefs.denoise,
        "filter": VoicePrefs.filter,
        "threshold": Double(VoicePrefs.threshold),
        "voiceTier": VoicePrefs.voiceTier,
        "firstSpeaker": VoicePrefs.firstSpeaker,
        "enrolled": enrolled,
        "legacyEnrolled": legacyEnrolled,
        "svReady": svReady,
        "tseModelsReady": tseModelsReady,
        "tseReady": tseReady,
        "modelVersion": VOICEPRINT_MODEL_VERSION,
        "modelReady": modelReady,
        "modelDownloading": VoiceModelManager.downloading,
        "svSize": Double(VoiceModelManager.svSize),
        "modelSize": Double(VoiceModelManager.speakerSize),
        "benchAt": Double(VoicePrefs.benchAt),
        "ios_mic_mode": currentIosMicMode(),
      ]
      if let rec = VoicePrefs.benchRecommendedTier { state["recommendedTier"] = rec }
      if let reason = VoicePrefs.benchReason { state["recommendReason"] = reason }
      if VoicePrefs.benchDpdfUs > 0 { state["benchDpdfUs"] = VoicePrefs.benchDpdfUs }
      if realRtf > 0 { state["benchTseRtf"] = realRtf }
      return state
    }

    Function("setVoiceSettings") { (denoise: Bool, filter: Bool, threshold: Double) in
      VoicePrefs.denoise = denoise
      VoicePrefs.filter = filter
      VoicePrefs.threshold = Float(min(0.80, max(0.15, threshold)))
    }

    Function("setVoiceMode") { (tier: String, firstSpeaker: Bool) in
      VoicePrefs.voiceTier = tier
      VoicePrefs.firstSpeaker = firstSpeaker
    }

    Function("setVoiceprint") { (embedding: [Double]?) in
      if let emb = embedding, !emb.isEmpty {
        VoicePrefs.embedding = emb.map { Float($0) }
      } else {
        VoicePrefs.clearVoiceprint()
      }
    }

    Function("setVoiceprintMeta") { (prototypes: [[Double]]?, modelVersion: String?) in
      if let protos = prototypes, !protos.isEmpty {
        VoicePrefs.prototypes = protos.map { $0.map { Float($0) } }
      } else {
        VoicePrefs.prototypes = nil
      }
      if let ver = modelVersion, !ver.isEmpty {
        VoicePrefs.modelVersion = ver
      } else {
        VoicePrefs.modelVersion = nil
      }
    }

    AsyncFunction("prepareVoiceModel") { (promise: Promise) in
      VoiceModelManager.downloadModels(
        tier: "tse",
        onProgress: { got, total in
          PocketBus.emit("onVoiceModelProgress", ["received": Double(got), "total": Double(total)])
        },
        done: { err in
          if let err {
            promise.reject("E_VOICE_MODEL", err.localizedDescription)
          } else {
            promise.resolve(true)
          }
        }
      )
    }

    AsyncFunction("prepareVoiceTier") { (tier: String, promise: Promise) in
      let cleanTier = (tier == "sv") ? "sv" : "tse"
      VoiceModelManager.downloadModels(
        tier: cleanTier,
        onProgress: { got, total in
          PocketBus.emit("onVoiceModelProgress", ["received": Double(got), "total": Double(total)])
        },
        done: { err in
          if let err {
            promise.reject("E_VOICE_MODEL", err.localizedDescription)
          } else {
            promise.resolve(true)
          }
        }
      )
    }

    AsyncFunction("benchmarkVoiceDevice") { (promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          promise.resolve(try VoiceModelManager.benchmarkDevice())
        } catch {
          promise.reject("E_VOICE_BENCH", error.localizedDescription)
        }
      }
    }

    Function("cancelVoiceModel") {
      VoiceModelManager.cancelDownload()
    }

    AsyncFunction("startVoiceEnroll") { (promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          try VoiceLab.startEnroll()
          promise.resolve(true)
        } catch {
          promise.reject("E_VOICE_ENROLL", error.localizedDescription)
        }
      }
    }

    AsyncFunction("finishVoiceEnroll") { (promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          promise.resolve(try VoiceLab.finishEnroll())
        } catch {
          promise.reject("E_VOICE_ENROLL", error.localizedDescription)
        }
      }
    }

    Function("cancelVoiceEnroll") {
      VoiceLab.stop()
    }

    AsyncFunction("startVoiceTest") { (threshold: Double, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          try VoiceLab.startTest(threshold: Float(min(0.80, max(0.15, threshold))))
          promise.resolve(true)
        } catch {
          promise.reject("E_VOICE_TEST", error.localizedDescription)
        }
      }
    }

    Function("stopVoiceTest") {
      VoiceLab.stop()
    }

    /// Presents the iOS 15+ Control Center microphone mode picker when Voice Isolation
    /// is not currently active. Returns true if the system picker was requested.
    Function("showMicrophoneModePicker") { () -> Bool in
      if #available(iOS 15.0, *) {
        guard AVCaptureDevice.activeMicrophoneMode != .voiceIsolation else {
          return false
        }
        DispatchQueue.main.async {
          AVCaptureDevice.showSystemUserInterface(.microphoneModes)
        }
        return true
      }
      return false
    }
  }
}

/// Sets up notifications at launch, so tapping one that starts the app still opens the assistant.
public class PocketAppDelegate: ExpoAppDelegateSubscriber {
  public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    NoticeCenter.install()
    return true
  }
}
