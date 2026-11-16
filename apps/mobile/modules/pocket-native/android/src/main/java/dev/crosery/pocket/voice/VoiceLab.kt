package dev.crosery.pocket.voice

import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AudioEffect
import android.media.audiofx.AutomaticGainControl
import android.os.Process
import dev.crosery.pocket.PocketBus
import dev.crosery.pocket.Prefs
import dev.crosery.pocket.VoiceCall
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Local voiceprint enrolment and live verification test (runs outside calls, using the exact same
 * VOICE_COMMUNICATION mic path + GTCRN + Silero + CAM++ pipeline as calls).
 */
object VoiceLab {
  private const val FRAME_BYTES = 640 // 20 ms at 16 kHz mono PCM16
  private const val MAX_ENROLL_SEC = 20f
  private const val MIN_ENROLL_SEC = 3.5f

  private val lock = Any()
  private var session: Session? = null

  private class Session(
    val kind: String,
    val models: VoiceModels,
    val record: AudioRecord,
    val effects: List<AudioEffect>,
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
    if (!VoiceModelManager.isSpeakerReady(ctx)) throw IllegalStateException("声纹模型还没准备好")
    val models = VoiceModelManager.openModels(ctx, needSpeaker = true)
    if (models.speaker == null) {
      models.close()
      throw IllegalStateException("声纹模型打不开")
    }
    val (rec, effects) = try {
      openMic()
    } catch (e: Throwable) {
      models.close()
      throw e
    }
    val s = Session("enroll", models, rec, effects)
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
    stopMic(s)
    try {
      val col = s.collector!!
      val vp = col.voiceprint(MIN_ENROLL_SEC)
        ?: throw IllegalStateException("录到的有效说话只有 ${"%.1f".format(col.seconds)} 秒，再多说几句试试")
      val p = Prefs(ctx)
      p.voiceEmbedding = vp.embedding
      p.voiceFilter = true
      return mapOf(
        "embedding" to vp.embedding.map { it.toDouble() },
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
    val enrolled = Prefs(ctx).voiceEmbedding ?: throw IllegalStateException("还没有录入声纹")
    if (!VoiceModelManager.isSpeakerReady(ctx)) throw IllegalStateException("声纹模型还没准备好")
    val models = VoiceModelManager.openModels(ctx, needSpeaker = true)
    val (rec, effects) = try {
      openMic()
    } catch (e: Throwable) {
      models.close()
      throw e
    }
    val s = Session("test", models, rec, effects)
    synchronized(lock) { session = s }
    rec.startRecording()
    s.worker = Thread({
      Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
      val den = Denoiser(models)
      val vad = Vad(models)
      val sp = Speaker(models)
      val buf = ByteArray(FRAME_BYTES)
      val hopIn = FloatArray(Denoiser.HOP)
      var hopLen = 0
      val win = FloatArray(Vad.WINDOW)
      var winLen = 0
      val speechBuf = FloatArray(VOICE_RATE * 2) // up to 2 s
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
              val score = cosine(sp.embed(copy, 0, copy.size), enrolled)
              if (!s.stopped) {
                PocketBus.emit("onVoiceTest", mapOf("level" to level.toDouble(), "speaking" to true, "score" to score.toDouble(), "pass" to (score >= threshold)))
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
          val take = minOf((n - i) / 2, Denoiser.HOP - hopLen)
          pcm16ToFloat(buf, i, take * 2, hopIn, hopLen)
          hopLen += take
          i += take * 2
          if (hopLen < Denoiser.HOP) continue
          hopLen = 0
          if (!den.hop(hopIn, 0, win, winLen)) continue
          winLen += Denoiser.HOP
          if (winLen < Vad.WINDOW) continue
          winLen = 0
          var e = 0.0
          for (v in win) e += v * v
          level = minOf(1f, (kotlin.math.sqrt(e / Vad.WINDOW) * 4).toFloat())
          val p = vad.prob(win, 0)
          if (p >= 0.35f) {
            speaking = true
            silRun = 0
            if (speechLen + Vad.WINDOW > speechBuf.size) {
              System.arraycopy(speechBuf, Vad.WINDOW, speechBuf, 0, speechBuf.size - Vad.WINDOW)
              speechLen = speechBuf.size - Vad.WINDOW
            }
            System.arraycopy(win, 0, speechBuf, speechLen, Vad.WINDOW)
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
            PocketBus.emit("onVoiceTest", mapOf("level" to level.toDouble(), "speaking" to speaking))
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
  }

  private fun openMic(): Pair<AudioRecord, List<AudioEffect>> {
    val minIn = AudioRecord.getMinBufferSize(VOICE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    @Suppress("MissingPermission")
    val rec = AudioRecord(
      MediaRecorder.AudioSource.VOICE_COMMUNICATION,
      VOICE_RATE,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
      maxOf(minIn * 2, FRAME_BYTES * 25),
    )
    if (rec.state != AudioRecord.STATE_INITIALIZED) {
      rec.release()
      throw IllegalStateException("没有麦克风权限")
    }
    val effects = ArrayList<AudioEffect>()
    if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(rec.audioSessionId)?.let { it.enabled = true; effects.add(it) }
    if (AutomaticGainControl.isAvailable()) AutomaticGainControl.create(rec.audioSessionId)?.let { it.enabled = true; effects.add(it) }
    return rec to effects
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
