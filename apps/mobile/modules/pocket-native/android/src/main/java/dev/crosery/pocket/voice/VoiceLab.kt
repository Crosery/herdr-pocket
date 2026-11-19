package dev.crosery.pocket.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AudioEffect
import android.media.audiofx.AutomaticGainControl
import android.os.Build
import android.os.Process
import dev.crosery.pocket.PocketBus
import dev.crosery.pocket.Prefs
import dev.crosery.pocket.VoiceCall
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.sqrt

/**
 * Shared communication audio focus + `MODE_IN_COMMUNICATION` + headset/speakerphone routing used
 * identically by [VoiceCall] and [VoiceLab], eliminating acoustic channel mismatch between enrollment,
 * live voiceprint testing, and real MOSS-Live calls.
 */
internal object CommAudioRoute {
  class Handle(
    private val am: AudioManager,
    private val prevMode: Int,
    private val prevSpeakerphone: Boolean,
    private val focus: AudioFocusRequest?,
    val attrs: AudioAttributes,
    val route: String,
  ) {
    private var restored = false

    @Synchronized
    fun restore() {
      if (restored) return
      restored = true
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          am.clearCommunicationDevice()
        } else {
          @Suppress("DEPRECATION")
          am.isSpeakerphoneOn = prevSpeakerphone
        }
      } catch (_: Throwable) {}
      try { am.mode = prevMode } catch (_: Throwable) {}
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focus != null) {
          am.abandonAudioFocusRequest(focus)
        }
      } catch (_: Throwable) {}
    }
  }

  fun open(ctx: Context): Handle {
    val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val prevMode = am.mode
    @Suppress("DEPRECATION")
    val prevSpeakerphone = am.isSpeakerphoneOn
    val attrs = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .build()
    val focus = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN).setAudioAttributes(attrs).build().also {
        try { am.requestAudioFocus(it) } catch (_: Throwable) {}
      }
    } else null
    am.mode = AudioManager.MODE_IN_COMMUNICATION
    val route = routeCommunicationDevice(am)
    return Handle(am, prevMode, prevSpeakerphone, focus, attrs, route)
  }

  private fun routeCommunicationDevice(am: AudioManager): String {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val devices = try { am.availableCommunicationDevices } catch (_: Throwable) { emptyList() }
      val headset = devices.firstOrNull {
        it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_BLE_HEADSET ||
          it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET || it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
          it.type == AudioDeviceInfo.TYPE_USB_HEADSET
      }
      val target = headset ?: devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
      if (target != null) {
        try { am.setCommunicationDevice(target) } catch (_: Throwable) {}
        return classifyType(target.type)
      }
      val cur = try { am.communicationDevice } catch (_: Throwable) { null }
      return if (cur != null) classifyType(cur.type) else "builtin"
    }
    @Suppress("DEPRECATION")
    return when {
      am.isBluetoothScoOn -> {
        am.isSpeakerphoneOn = false
        "bt"
      }
      am.isWiredHeadsetOn -> {
        am.isSpeakerphoneOn = false
        "wired"
      }
      else -> {
        am.isSpeakerphoneOn = true
        "speaker"
      }
    }
  }

  private fun classifyType(type: Int): String = when (type) {
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
    AudioDeviceInfo.TYPE_BLE_HEADSET,
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
    AudioDeviceInfo.TYPE_BLE_SPEAKER,
    -> "bt"
    AudioDeviceInfo.TYPE_WIRED_HEADSET,
    AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
    AudioDeviceInfo.TYPE_USB_HEADSET,
    AudioDeviceInfo.TYPE_USB_DEVICE,
    -> "wired"
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
    else -> "builtin"
  }
}

/**
 * Local voiceprint enrolment and live verification test (runs outside calls, using the exact same
 * `MODE_IN_COMMUNICATION` + communication device route + `VOICE_COMMUNICATION` mic + clean `HighPass64`
 * + Silero VAD + ERes2NetV2-zh pipeline as calls).
 */
object VoiceLab {
  private const val FRAME_BYTES = 640 // 20 ms at 16 kHz mono PCM16 (320 samples)
  private const val MAX_ENROLL_SEC = 20f
  private const val MIN_ENROLL_SEC = 3.5f

  private val lock = Any()
  private var session: Session? = null

  private class Session(
    val kind: String,
    val models: VoiceModels,
    val record: AudioRecord,
    val effects: List<AudioEffect>,
    val routeHandle: CommAudioRoute.Handle,
  ) {
    @Volatile var stopped = false
    @Volatile var checkPending = false
    var collector: SpeechCollector? = null
    var worker: Thread? = null
    val embedExec = Executors.newSingleThreadExecutor { r -> Thread(r, "pocket-vlab-spk").apply { isDaemon = true } }
  }

  fun startEnroll(ctx: Context) {
    stop()
    if (VoiceCall.current != null) throw IllegalStateException("正在通话中，挂断后再录声纹")
    if (!VoiceModelManager.isSvModelReady(ctx)) throw IllegalStateException("声纹模型还没准备好")
    val models = VoiceModelManager.openModels(ctx, needSpeaker = true, needTse = false)
    if (models.speaker == null) {
      models.close()
      throw IllegalStateException("声纹模型打不开")
    }
    val (rec, effects, routeHandle) = try {
      openMic(ctx)
    } catch (e: Throwable) {
      models.close()
      throw e
    }
    val s = Session("enroll", models, rec, effects, routeHandle)
    val col = SpeechCollector(models)
    s.collector = col
    synchronized(lock) { session = s }
    rec.startRecording()
    s.worker = Thread({
      Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
      val buf = ByteArray(FRAME_BYTES)
      var lastEmit = 0L
      while (!s.stopped) {
        val n = readFull(rec, buf)
        if (n < 0) break
        if (col.seconds < MAX_ENROLL_SEC) col.push(buf, 0, n)
        val now = System.currentTimeMillis()
        if (now - lastEmit >= 100) {
          lastEmit = now
          PocketBus.emit(
            "onEnrollProgress",
            mapOf("level" to col.level.toDouble(), "seconds" to col.seconds.toDouble(), "full" to (col.seconds >= MAX_ENROLL_SEC)),
          )
        }
      }
    }, "pocket-enroll").apply { isDaemon = true; start() }
  }

  fun finishEnroll(ctx: Context): Map<String, Any> {
    val s = synchronized(lock) {
      val cur = session
      if (cur == null || cur.kind != "enroll") throw IllegalStateException("没有正在进行的录音")
      session = null
      cur
    }
    val route = s.routeHandle.route
    stopMic(s)
    try {
      val col = s.collector!!
      val vp = col.voiceprint(MIN_ENROLL_SEC)
        ?: throw IllegalStateException("录到的有效说话只有 ${"%.1f".format(col.seconds)} 秒，再多说几句试试")
      val hasSample = VoiceModelManager.saveOwnerSample(ctx, vp.ownerSample)
      val p = Prefs(ctx)
      p.voiceEmbedding = vp.embedding
      p.voicePrototypes = vp.prototypes
      p.voiceModelVersion = VoiceModelManager.VOICEPRINT_MODEL_VERSION
      p.voiceFilter = true
      return mapOf(
        "embedding" to vp.embedding.map { it.toDouble() },
        "prototypes" to vp.prototypes.map { arr -> arr.map { it.toDouble() } },
        "modelVersion" to VoiceModelManager.VOICEPRINT_MODEL_VERSION,
        "hasSample" to hasSample,
        "route" to route,
        "snrDb" to vp.snrDb.toDouble(),
        "seconds" to vp.seconds.toDouble(),
        "consistency" to vp.consistency.toDouble(),
        "lowest" to vp.lowest.toDouble(),
      )
    } finally {
      s.embedExec.shutdownNow()
      s.models.close()
    }
  }

  fun startTest(ctx: Context, threshold: Float) {
    stop()
    if (VoiceCall.current != null) throw IllegalStateException("正在通话中，挂断后再测试")
    val p = Prefs(ctx)
    val enrolledRaw = p.voiceEmbedding ?: throw IllegalStateException("还没有录入声纹")
    if (p.voiceModelVersion != VoiceModelManager.VOICEPRINT_MODEL_VERSION) {
      throw IllegalStateException("声纹引擎已升级，请重录一次")
    }
    if (!VoiceModelManager.isSvModelReady(ctx)) throw IllegalStateException("声纹模型还没准备好")
    val enrolledNorm = normalizeEmbedding(enrolledRaw)
    val protosNorm = p.voicePrototypes?.map { normalizeEmbedding(it) }
    val models = VoiceModelManager.openModels(ctx, needSpeaker = true, needTse = false)
    val (rec, effects, routeHandle) = try {
      openMic(ctx)
    } catch (e: Throwable) {
      models.close()
      throw e
    }
    val route = routeHandle.route
    val s = Session("test", models, rec, effects, routeHandle)
    synchronized(lock) { session = s }
    rec.startRecording()
    s.worker = Thread({
      Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
      val hpf = HighPass64()
      val vad = Vad(models)
      val vadBoost = QuietVadBoost()
      val sp = Speaker(models)
      val buf = ByteArray(FRAME_BYTES)
      val rawWin = FloatArray(Vad.WINDOW)
      val hpfWin = FloatArray(Vad.WINDOW)
      val vadWin = FloatArray(Vad.WINDOW)
      var winLen = 0
      val speechBuf = FloatArray(VOICE_RATE * 2) // up to 2 s of clean HPF speech
      var speechLen = 0
      var speaking = false
      var silRun = 0
      var lastEmit = 0L
      var level = 0f

      fun runCheck(len: Int) {
        if (s.checkPending || len < VOICE_RATE * 2 / 5) return
        val copy = speechBuf.copyOf(len)
        s.checkPending = true
        try {
          s.embedExec.execute {
            try {
              val t0 = System.nanoTime()
              val emb = normalizeEmbedding(sp.embed(copy, 0, copy.size))
              val inferMs = (System.nanoTime() - t0) / 1_000_000.0
              val sv = scoreVoiceprint(emb, enrolledNorm, protosNorm, sessionNorm = null, threshold = threshold)
              if (!s.stopped) {
                PocketBus.emit(
                  "onVoiceTest",
                  mapOf(
                    "level" to level.toDouble(),
                    "speaking" to true,
                    "score" to sv.combined.toDouble(),
                    "rawScore" to sv.rawMean.toDouble(),
                    "protoScore" to sv.maxProto.toDouble(),
                    "pass" to (sv.combined >= threshold),
                    "inferMs" to inferMs,
                    "route" to route,
                  ),
                )
              }
            } catch (_: Throwable) {
            } finally {
              s.checkPending = false
            }
          }
        } catch (_: Throwable) {
          s.checkPending = false
        }
      }

      while (!s.stopped) {
        val n = readFull(rec, buf)
        if (n < 0) break
        var i = 0
        while (i < n && !s.stopped) {
          val take = minOf((n - i) / 2, Vad.WINDOW - winLen)
          if (take <= 0) break
          pcm16ToFloat(buf, i, take * 2, rawWin, winLen)
          winLen += take
          i += take * 2
          if (winLen < Vad.WINDOW) continue
          winLen = 0
          // Clean HPF path ONLY — never feed denoised audio into ERes2NetV2!
          hpf.process(rawWin, 0, hpfWin, 0, Vad.WINDOW)
          var e = 0.0
          for (v in hpfWin) e += v * v
          level = minOf(1f, (sqrt(e / Vad.WINDOW) * 4).toFloat())
          vadBoost.prepare(hpfWin, vadWin)
          val prob = vad.prob(vadWin, 0)
          if (prob >= 0.35f) {
            speaking = true
            silRun = 0
            if (speechLen + Vad.WINDOW > speechBuf.size) {
              System.arraycopy(speechBuf, Vad.WINDOW, speechBuf, 0, speechBuf.size - Vad.WINDOW)
              speechLen = speechBuf.size - Vad.WINDOW
            }
            System.arraycopy(hpfWin, 0, speechBuf, speechLen, Vad.WINDOW)
            speechLen += Vad.WINDOW
            if (speechLen >= VOICE_RATE * 4 / 5) runCheck(speechLen)
          } else if (speaking) {
            silRun++
            if (silRun >= 15) { // ~0.48 s silence
              speaking = false
              silRun = 0
              if (speechLen >= VOICE_RATE * 2 / 5) runCheck(speechLen)
              speechLen = 0
            }
          }
          val now = System.currentTimeMillis()
          if (now - lastEmit >= 100) {
            lastEmit = now
            PocketBus.emit("onVoiceTest", mapOf("level" to level.toDouble(), "speaking" to speaking, "route" to route))
          }
        }
      }
    }, "pocket-vtest").apply { isDaemon = true; start() }
  }

  private fun closeSession(s: Session) {
    stopMic(s)
    s.embedExec.shutdownNow()
    try { s.embedExec.awaitTermination(1500, TimeUnit.MILLISECONDS) } catch (_: Throwable) {}
    s.models.close()
  }

  fun stop() {
    val s = synchronized(lock) {
      val cur = session
      session = null
      cur
    } ?: return
    closeSession(s)
  }

  private fun stopMic(s: Session) {
    s.stopped = true
    try { s.record.stop() } catch (_: Throwable) {}
    try { s.worker?.join(1500) } catch (_: Throwable) {}
    try { s.record.release() } catch (_: Throwable) {}
    for (e in s.effects) try { e.release() } catch (_: Throwable) {}
    s.routeHandle.restore()
  }

  private fun openMic(ctx: Context): Triple<AudioRecord, List<AudioEffect>, CommAudioRoute.Handle> {
    val routeHandle = CommAudioRoute.open(ctx)
    try {
      val minIn = AudioRecord.getMinBufferSize(VOICE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
      @Suppress("MissingPermission")
      val rec = AudioRecord(
        MediaRecorder.AudioSource.VOICE_COMMUNICATION,
        VOICE_RATE,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
        maxOf(minIn * 2, FRAME_BYTES * 30),
      )
      if (rec.state != AudioRecord.STATE_INITIALIZED) {
        rec.release()
        throw IllegalStateException("没有麦克风权限")
      }
      val effects = ArrayList<AudioEffect>()
      if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(rec.audioSessionId)?.let { it.enabled = true; effects.add(it) }
      if (AutomaticGainControl.isAvailable()) AutomaticGainControl.create(rec.audioSessionId)?.let { it.enabled = true; effects.add(it) }
      return Triple(rec, effects, routeHandle)
    } catch (e: Throwable) {
      routeHandle.restore()
      throw e
    }
  }

  private fun readFull(rec: AudioRecord, buf: ByteArray): Int {
    var off = 0
    while (off < buf.size) {
      val n = rec.read(buf, off, buf.size - off)
      if (n < 0) return -1
      if (n == 0) return off
      off += n
    }
    return off
  }
}
