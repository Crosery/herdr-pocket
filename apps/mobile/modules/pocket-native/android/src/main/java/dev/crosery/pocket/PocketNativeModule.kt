package dev.crosery.pocket

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import dev.crosery.pocket.voice.VoiceLab
import dev.crosery.pocket.voice.VoiceModelManager
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PocketNativeModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React context is not ready" }

  override fun definition() = ModuleDefinition {
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
      "onVoiceTest",
    )

    OnCreate {
      PocketBus.listener = { name, body -> sendEvent(name, body) }
    }

    OnDestroy {
      PocketBus.listener = null
    }

    /** Starts a voice call (needs RECORD_AUDIO granted first). */
    Function("startCall") { server: String, token: String ->
      PocketService.startCall(context, server, token)
    }

    Function("hangup") {
      PocketService.hangup(context)
    }

    Function("setMuted") { muted: Boolean ->
      VoiceCall.current?.setMuted(muted)
    }

    Function("callState") {
      val c = VoiceCall.current
      mapOf("active" to (c != null), "muted" to (c?.muted ?: false))
    }

    /** Background alerts: stores what the service needs and starts or stops it. */
    Function("configureNotifier") { server: String?, token: String?, enabled: Boolean, kinds: List<String>, name: String? ->
      val p = Prefs(context)
      val changed = p.server != server || p.token != token
      p.server = server
      p.token = token
      if (changed) {
        p.lastTs = 0L
        p.recentIds = emptyList()
      }
      p.notify = enabled && !server.isNullOrEmpty() && !token.isNullOrEmpty()
      p.kinds = kinds.toSet()
      if (!name.isNullOrEmpty()) p.assistantName = name
      PocketService.sync(context)
    }

    Function("notifierState") {
      val p = Prefs(context)
      mapOf(
        "enabled" to p.notify,
        "connected" to (PocketService.notifier?.connected ?: false),
        "notificationsAllowed" to NotificationManagerCompat.from(context).areNotificationsEnabled(),
        "batteryUnrestricted" to (context.getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(context.packageName),
      )
    }

    /** Asks the system to let the service run in the background without being killed. */
    Function("requestBatteryExemption") {
      val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        context.startActivity(i)
      } catch (_: Throwable) {
        context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      }
    }

    Function("openNotificationSettings") {
      val i = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
        .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(i)
    }

    /** The installed versionName, e.g. "0.1.0". */
    Function("appVersion") {
      Updater.installedVersion(context)
    }

    /**
     * Downloads a release APK into the cache; progress arrives as onUpdateProgress.
     * Runs on its own thread so a long download never holds up other native calls.
     */
    AsyncFunction("downloadUpdate") { url: String, name: String, size: Double, sha256: String, promise: Promise ->
      val ctx = context
      Thread {
        try {
          val path = Updater.download(ctx, url, name, size.toLong(), sha256) { got, total ->
            PocketBus.emit("onUpdateProgress", mapOf("received" to got.toDouble(), "total" to total.toDouble()))
          }
          promise.resolve(path)
        } catch (e: Throwable) {
          promise.reject("E_UPDATE_DOWNLOAD", e.message ?: "download failed", e)
        }
      }.start()
    }

    Function("cancelUpdate") {
      Updater.cancel()
    }

    /** "started" | "permission" | "missing" (see Updater.install). */
    Function("installUpdate") { path: String ->
      Updater.install(context, appContext.currentActivity, path)
    }

    Function("canInstallUpdates") {
      Updater.canInstall(context)
    }

    /**
     * Lets the person pick up to `max` pictures; each comes back as
     * {name, mime, data (base64 JPEG), width, height, bytes}, its longest side at
     * most `maxSide`. Cancelled: an empty list.
     */
    AsyncFunction("pickImages") { max: Int, maxSide: Int, quality: Int, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) promise.reject("E_NO_ACTIVITY", "the app is not in front", null)
      else ImagePick.start(activity, promise, max, maxSide, quality)
    }.runOnQueue(Queues.MAIN)

    OnActivityResult { _, payload ->
      if (payload.requestCode == ImagePick.REQUEST) ImagePick.onResult(context, payload.resultCode, payload.data)
    }

    /** A local test notification, to check that alerts really show up. */
    Function("testNotice") { title: String, body: String ->
      post(context, "test-${System.currentTimeMillis()}", title, body)
    }

    Function("voiceState") {
      val p = Prefs(context)
      mapOf(
        "denoise" to p.voiceDenoise,
        "filter" to p.voiceFilter,
        "threshold" to p.voiceThreshold.toDouble(),
        "enrolled" to (p.voiceEmbedding != null),
        "modelReady" to VoiceModelManager.isSpeakerReady(context),
        "modelDownloading" to VoiceModelManager.downloading,
        "modelSize" to VoiceModelManager.SPEAKER_SIZE.toDouble(),
      )
    }

    Function("setVoiceSettings") { denoise: Boolean, filter: Boolean, threshold: Double ->
      val p = Prefs(context)
      p.voiceDenoise = denoise
      p.voiceFilter = filter
      p.voiceThreshold = threshold.toFloat().coerceIn(0.15f, 0.80f)
    }

    Function("setVoiceprint") { embedding: List<Double>? ->
      val p = Prefs(context)
      p.voiceEmbedding = embedding?.takeIf { it.isNotEmpty() }?.map { it.toFloat() }?.toFloatArray()
    }

    AsyncFunction("prepareVoiceModel") { promise: Promise ->
      val ctx = context
      Thread {
        try {
          VoiceModelManager.downloadSpeaker(ctx) { got, total ->
            PocketBus.emit("onVoiceModelProgress", mapOf("received" to got.toDouble(), "total" to total.toDouble()))
          }
          promise.resolve(true)
        } catch (e: Throwable) {
          promise.reject("E_VOICE_MODEL", e.message ?: "模型下载失败", e)
        }
      }.apply { isDaemon = true; start() }
    }

    Function("cancelVoiceModel") {
      VoiceModelManager.cancelDownload()
    }

    AsyncFunction("startVoiceEnroll") { promise: Promise ->
      val ctx = context
      Thread {
        try {
          VoiceLab.startEnroll(ctx)
          promise.resolve(true)
        } catch (e: Throwable) {
          promise.reject("E_VOICE_ENROLL", e.message ?: "打不开麦克风", e)
        }
      }.apply { isDaemon = true; start() }
    }

    AsyncFunction("finishVoiceEnroll") { promise: Promise ->
      val ctx = context
      Thread {
        try {
          promise.resolve(VoiceLab.finishEnroll(ctx))
        } catch (e: Throwable) {
          promise.reject("E_VOICE_ENROLL", e.message ?: "声纹录入失败", e)
        }
      }.apply { isDaemon = true; start() }
    }

    Function("cancelVoiceEnroll") {
      VoiceLab.stop()
    }

    AsyncFunction("startVoiceTest") { threshold: Double, promise: Promise ->
      val ctx = context
      Thread {
        try {
          VoiceLab.startTest(ctx, threshold.toFloat().coerceIn(0.15f, 0.80f))
          promise.resolve(true)
        } catch (e: Throwable) {
          promise.reject("E_VOICE_TEST", e.message ?: "打不开麦克风", e)
        }
      }.apply { isDaemon = true; start() }
    }

    Function("stopVoiceTest") {
      VoiceLab.stop()
    }
  }
}
