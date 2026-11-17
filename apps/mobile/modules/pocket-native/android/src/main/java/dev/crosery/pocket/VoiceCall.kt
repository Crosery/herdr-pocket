package dev.crosery.pocket

import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.util.Log
import dev.crosery.pocket.voice.CommAudioRoute
import dev.crosery.pocket.voice.Denoiser
import dev.crosery.pocket.voice.VoiceFilter
import dev.crosery.pocket.voice.VoiceLab
import dev.crosery.pocket.voice.VoiceModelManager
import dev.crosery.pocket.voice.VoiceModels
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.round
import kotlin.math.sqrt

private const val TAG = "PocketVoice"
private const val MIC_RATE = 16_000
private const val SPEAKER_RATE = 48_000
private const val SPEAKER_PER_MS = SPEAKER_RATE / 1000
/** 20 ms of 16 kHz mono PCM16 (exact 2 * Denoiser.HOP of 160 samples for zero framing jitter). */
private const val MIC_FRAME_BYTES = 640
private const val HOPS_PER_MIC_FRAME = MIC_FRAME_BYTES / (Denoiser.HOP * 2) // 2
/** From Android 12 the track starts once this much is written; before, only once its whole buffer is full. */
private const val START_THRESHOLD_MS = 40
/** A track that holds audio but has not moved for this long is waiting to be filled: top it up with silence. */
private const val STUCK_MS = 150L
/** How often the play thread looks again when it has nothing to write. */
private const val PLAY_LOOP_MS = 5L
private const val PERIODIC_TELEMETRY_MS = 5_000L

/**
 * One voice call to the relay's /v1/assistant/live. Audio never passes through
 * JavaScript: the microphone goes straight to the socket, speech straight to the
 * speaker, and playback receipts follow what was actually heard (MOSS-Live
 * playback.* events). JS gets captions, state, and structured AI telemetry.
 */
class VoiceCall(
  private val ctx: Context,
  private val server: String,
  private val token: String,
  private val onEnded: () -> Unit,
) {
  companion object {
    @Volatile var current: VoiceCall? = null
  }

  private data class Ref(val chunkId: String, val runId: String, val turnId: String)
  private class Chunk(val ref: Ref, val pcm: ByteArray, override val frames: Int, val level: Float) : Playout.Piece {
    override val run: String get() = ref.runId
  }
  private class Scope {
    var turnId = ""
    var finished = false
    var drained = false
    var stopped = false
    var outstanding = 0
    var playedMs = 0.0
  }

  private val client = OkHttpClient.Builder()
    .pingInterval(20, TimeUnit.SECONDS)
    .readTimeout(0, TimeUnit.MILLISECONDS)
    .connectTimeout(15, TimeUnit.SECONDS)
    .build()
  private var ws: WebSocket? = null
  private var routeHandle: CommAudioRoute.Handle? = null
  @Volatile private var activeRoute = "speaker"
  private var record: AudioRecord? = null
  private var track: AudioTrack? = null
  private val effects = mutableListOf<android.media.audiofx.AudioEffect>()

  @Volatile private var ended = false
  @Volatile private var ready = false
  @Volatile var muted = false
    private set
  @Volatile private var filterReset = false
  @Volatile private var micLevel = 0f

  private val useDenoise: Boolean
  private val voiceThreshold: Float
  private val enrolledVoice: FloatArray?
  private val enrolledProtos: List<FloatArray>?
  private val modelsReady = CountDownLatch(1)
  @Volatile private var voiceModels: VoiceModels? = null
  @Volatile private var ownerSample: FloatArray? = null
  @Volatile private var filter: VoiceFilter? = null
  private val spkExec = Executors.newSingleThreadExecutor { r -> Thread(r, "pocket-spk").apply { isDaemon = true } }
  private val tseExec = Executors.newSingleThreadExecutor { r ->
    Thread({
      try { Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO) } catch (_: Throwable) {}
      r.run()
    }, "pocket-tse").apply { isDaemon = true }
  }
  private var micThread: Thread? = null

  private val callStartedElapsed = SystemClock.elapsedRealtime()
  private val telemetryLock = Any()
  private var pendingInitTelemetry: String? = null
  private var lastWsSendElapsed = 0L
  private var windowWsGapMaxMs = 0L
  private var callWsGapMaxMs = 0L
  private var rawFramesIn = 0L
  private var rawFramesOut = 0L

  init {
    val p = Prefs(ctx)
    useDenoise = p.voiceDenoise
    voiceThreshold = p.voiceThreshold
    val versionOk = p.voiceModelVersion == VoiceModelManager.VOICEPRINT_MODEL_VERSION
    enrolledVoice = if (p.voiceFilter && versionOk) p.voiceEmbedding else null
    enrolledProtos = if (enrolledVoice != null) p.voicePrototypes else null
  }

  // Playback ledger; guarded by `lock`.
  private val lock = Any()
  private val contexts = ArrayDeque<Ref>()
  /** Audio received and not yet written to the track: the jitter buffer. */
  private val playout = Playout<Chunk>(SPEAKER_PER_MS)
  /** Chunks written to the track, with the frame position their end reaches. */
  private val inflight = ArrayDeque<Pair<Chunk, Long>>()
  /** Frames written to the track since it was last flushed, silence included. */
  private var written = 0L
  /** Bumped by a flush: the play thread drops what it was writing and primes the track again. */
  private var generation = 0
  /** Replies the service stopped (response.audio.stop), for the call's stats. */
  private var stops = 0
  private val scopes = HashMap<String, Scope>()
  private val stoppedRuns = HashSet<String>()

  private val threads = mutableListOf<Thread>()

  fun start() {
    current = this
    VoiceLab.stop()
    PocketBus.emit("onCall", mapOf("state" to "connecting"))
    val needSv = enrolledVoice != null && VoiceModelManager.isSvModelReady(ctx)
    val hasSample = enrolledVoice != null && VoiceModelManager.hasOwnerSample(ctx)
    val needTse = hasSample && VoiceModelManager.isTseModelsReady(ctx)
    if (useDenoise || needSv || needTse) {
      thread("pocket-models") {
        try {
          if (needTse) ownerSample = VoiceModelManager.loadOwnerSample(ctx)
          voiceModels = VoiceModelManager.openModels(ctx, needSpeaker = needSv, needTse = needTse && ownerSample != null)
        } catch (e: Throwable) {
          Log.w(TAG, "voice models", e)
        } finally {
          modelsReady.countDown()
        }
      }
    } else {
      modelsReady.countDown()
    }
    try {
      openAudio()
    } catch (e: Throwable) {
      Log.w(TAG, "audio", e)
      end("打不开麦克风：${e.message ?: "未知原因"}")
      return
    }
    // The token rides in a header: a URL ends up in reverse-proxy access logs.
    val req = Request.Builder().url(wsUrl(server, "/v1/assistant/live")).header("Authorization", "Bearer $token").build()
    ws = client.newWebSocket(req, Listener())
    micThread = thread("pocket-mic") { micLoop() }
    thread("pocket-play") { playLoop() }
    thread("pocket-ack") { ackLoop() }
  }

  private fun thread(name: String, body: () -> Unit): Thread {
    val t = Thread({
      try {
        body()
      } catch (e: Throwable) {
        if (!ended) Log.w(TAG, name, e)
      }
    }, name)
    t.isDaemon = true
    threads.add(t)
    t.start()
    return t
  }

  // ----------------------------------------------------------------------- audio setup

  private fun openAudio() {
    val rh = CommAudioRoute.open(ctx)
    routeHandle = rh
    activeRoute = rh.route

    val minIn = AudioRecord.getMinBufferSize(MIC_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    @Suppress("MissingPermission")
    val rec = AudioRecord(
      MediaRecorder.AudioSource.VOICE_COMMUNICATION,
      MIC_RATE,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
      // Room for half a second: a busy phone must not lose the person's words.
      maxOf(minIn * 2, MIC_FRAME_BYTES * 30),
    )
    if (rec.state != AudioRecord.STATE_INITIALIZED) {
      rec.release()
      throw IllegalStateException("没有麦克风权限")
    }
    // Hear the person, not our own voice coming out of the speaker. When DPDFNet runs, leave hardware NS off to avoid double-filtering.
    if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(rec.audioSessionId)?.let { it.enabled = true; effects.add(it) }
    if (!useDenoise && NoiseSuppressor.isAvailable()) NoiseSuppressor.create(rec.audioSessionId)?.let { it.enabled = true; effects.add(it) }
    if (AutomaticGainControl.isAvailable()) AutomaticGainControl.create(rec.audioSessionId)?.let { it.enabled = true; effects.add(it) }
    record = rec

    val minOut = AudioTrack.getMinBufferSize(SPEAKER_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
    val tr = AudioTrack.Builder()
      .setAudioAttributes(rh.attrs)
      .setAudioFormat(
        AudioFormat.Builder()
          .setSampleRate(SPEAKER_RATE)
          .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .build(),
      )
      .setTransferMode(AudioTrack.MODE_STREAM)
      .setBufferSizeInBytes(maxOf(minOut, SPEAKER_RATE * 2 / 5))
      .build()
    // The jitter buffer decides when speech starts; the track should not wait for a full buffer on top of it.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      try { tr.setStartThresholdInFrames(START_THRESHOLD_MS * SPEAKER_PER_MS) } catch (_: Throwable) {}
    }
    track = tr
    rec.startRecording()
    tr.play()
  }

  private fun closeAudio() {
    try { record?.stop() } catch (_: Throwable) {}
    try { record?.release() } catch (_: Throwable) {}
    for (e in effects) try { e.release() } catch (_: Throwable) {}
    effects.clear()
    try { track?.pause(); track?.flush() } catch (_: Throwable) {}
    try { track?.release() } catch (_: Throwable) {}
    record = null
    track = null
    routeHandle?.restore()
    routeHandle = null
  }

  // ----------------------------------------------------------------------- AI telemetry

  private fun sendBinaryFrame(buf: ByteArray, off: Int, len: Int) {
    if (!ready) return
    val now = SystemClock.elapsedRealtime()
    synchronized(telemetryLock) {
      if (lastWsSendElapsed > 0L) {
        val gap = now - lastWsSendElapsed
        if (gap > windowWsGapMaxMs) windowWsGapMaxMs = gap
        if (gap > callWsGapMaxMs) callWsGapMaxMs = gap
      }
      lastWsSendElapsed = now
    }
    ws?.send(buf.toByteString(off, len))
  }

  private fun emitAiTelemetry(data: JSONObject, queueIfNotReady: Boolean = false) {
    val json = JSONObject().put("action", "client.ai_telemetry").put("data", data).toString()
    PocketBus.emit("onCallEvent", mapOf("json" to json))
    synchronized(telemetryLock) {
      if (ready) {
        try { ws?.send(json) } catch (_: Throwable) {}
      } else if (queueIfNotReady) {
        pendingInitTelemetry = json
      }
    }
  }

  private fun emitInitTelemetry(models: VoiceModels?, vf: VoiceFilter?) {
    val svActive = vf?.isSvActive == true
    val tseActive = vf?.isTseActive == true
    val d = JSONObject()
      .put("stage", "init")
      .put("route", activeRoute)
      .put("denoise_enabled", useDenoise && models != null)
      .put("denoise_model", if (useDenoise && models != null) "dpdfnet_baseline" else "none")
      .put("vad_enabled", models != null && (svActive || tseActive))
      .put("sv_enabled", svActive)
      .put("sv_model", if (svActive) "eres2netv2_zh" else "none")
      .put("tse_enabled", tseActive)
      .put("tse_model", if (tseActive) "voxlock_v2_int8" else "none")
      .put("model_version", VoiceModelManager.VOICEPRINT_MODEL_VERSION)
      .put("enroll_ms", vf?.enrollMs ?: 0L)
      .put("threshold", safeRound(voiceThreshold.toDouble(), 1000.0))
      .put("prototypes_count", enrolledProtos?.size ?: 0)
      .put("has_owner_sample", ownerSample != null)
    Log.i(TAG, "ai.init $d")
    emitAiTelemetry(d, queueIfNotReady = true)
  }

  private fun emitUtteranceTelemetry(u: VoiceFilter.UtteranceTelemetry, vf: VoiceFilter?) {
    val d = JSONObject()
      .put("stage", "utterance")
      .put("route", activeRoute)
      .put("kind", u.kind)
      .put("pass", u.pass)
      .put("sv_score", safeRound(u.svScore.toDouble(), 1000.0))
      .put("sv_raw", safeRound(u.svRaw.toDouble(), 1000.0))
      .put("sv_proto", safeRound(u.svProto.toDouble(), 1000.0))
      .put("sv_sess", safeRound(u.svSess.toDouble(), 1000.0))
      .put("sv_ms", u.svMs)
      .put("used_ms", u.usedMs)
      .put("vad_prob", safeRound(u.vadProb.toDouble(), 1000.0))
      .put("raw_dbfs", safeRound(u.rawDbfs.toDouble(), 10.0))
      .put("tse_dbfs", safeRound(u.tseDbfs.toDouble(), 10.0))
      .put("enh_dbfs", safeRound(u.enhDbfs.toDouble(), 10.0))
      .put("tse_atten_db", safeRound(u.tseAttenDb.toDouble(), 10.0))
      .put("enh_gain_db", safeRound(u.enhGainDb.toDouble(), 10.0))
      .put("tse_overruns", vf?.tseOverruns ?: 0)
    Log.d(TAG, "ai.utterance $d")
    emitAiTelemetry(d)
  }

  private fun emitPeriodicTelemetry(
    vf: VoiceFilter?,
    prevHopsIn: Long,
    prevHopsOut: Long,
    prevDenoiseNs: Long,
    prevTseChunks: Long,
    prevTseMsSum: Double,
    prevTseAudioMs: Double,
    prevVadTotal: Long,
    prevVadSpeech: Long,
    prevVoicedOut: Long,
    prevGatedOut: Long,
  ) {
    val gapMax = synchronized(telemetryLock) {
      val g = windowWsGapMaxMs
      windowWsGapMaxMs = 0L
      g
    }
    val framesIn = if (vf != null) vf.hopsIn - prevHopsIn else rawFramesIn - prevHopsIn
    val framesOut = if (vf != null) vf.hopsOut - prevHopsOut else rawFramesOut - prevHopsOut
    val dpdfUsAvg = if (vf != null && framesIn > 0) (vf.denoiseNs - prevDenoiseNs) / 1000L / framesIn else 0L
    val dpdfUsMax = if (vf != null) vf.denoiseMaxNs / 1000L else 0L
    val dTseChunks = if (vf != null) vf.tseChunks - prevTseChunks else 0L
    val dTseMs = if (vf != null) vf.tseMsSum - prevTseMsSum else 0.0
    val dTseAudioMs = if (vf != null) vf.tseAudioMsSum - prevTseAudioMs else 0.0
    val tseMsAvg = if (dTseChunks > 0) dTseMs / dTseChunks else 0.0
    val tseRtf = if (dTseAudioMs > 0.0) dTseMs / dTseAudioMs else 0.0
    val dVadTotal = if (vf != null) vf.vadWindowsTotal - prevVadTotal else 0L
    val dVadSpeech = if (vf != null) vf.vadSpeechWindows - prevVadSpeech else 0L
    val vadRatio = if (dVadTotal > 0) dVadSpeech.toDouble() / dVadTotal else 0.0
    val dVoiced = if (vf != null) vf.voicedOutHops - prevVoicedOut else 0L
    val dGated = if (vf != null) vf.gatedOutHops - prevGatedOut else 0L
    val gatedRatio = if (dVoiced > 0) dGated.toDouble() / dVoiced else 0.0

    val d = JSONObject()
      .put("stage", "periodic")
      .put("route", activeRoute)
      .put("frames_in", framesIn)
      .put("frames_out", framesOut)
      .put("ws_gap_max_ms", gapMax)
      .put("dpdf_us_avg", dpdfUsAvg)
      .put("dpdf_us_max", dpdfUsMax)
      .put("tse_ms_avg", safeRound(tseMsAvg, 100.0))
      .put("tse_ms_max", safeRound(vf?.tseMsMax ?: 0.0, 100.0))
      .put("tse_rtf", safeRound(tseRtf, 1000.0))
      .put("tse_overruns", vf?.tseOverruns ?: 0)
      .put("tse_k", if (vf?.isTseActive == true) vf.tseK else 0)
      .put("tse_bypassed", vf?.tseBypassed ?: false)
      .put("vad_speech_ratio", safeRound(vadRatio, 1000.0))
      .put("gated_ratio", safeRound(gatedRatio, 1000.0))
      .put("raw_dbfs", safeRound((vf?.lastRawDbfs ?: -90f).toDouble(), 10.0))
      .put("tse_dbfs", safeRound((vf?.lastTseDbfs ?: -90f).toDouble(), 10.0))
      .put("enh_dbfs", safeRound((vf?.lastEnhDbfs ?: -90f).toDouble(), 10.0))
    emitAiTelemetry(d)
  }

  private fun buildSummaryTelemetry(): JSONObject {
    val vf = filter
    val durationMs = maxOf(0L, SystemClock.elapsedRealtime() - callStartedElapsed)
    val gapMax = synchronized(telemetryLock) { callWsGapMaxMs }
    val underruns = synchronized(lock) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) track?.underrunCount ?: -1 else -1
    }
    val playStalls = synchronized(lock) { playout.stalls }
    val framesIn = vf?.hopsIn ?: rawFramesIn
    val framesOut = vf?.hopsOut ?: rawFramesOut
    val dpdfUsAvg = if (vf != null && vf.hopsIn > 0) vf.denoiseNs / 1000L / vf.hopsIn else 0L
    val dpdfUsMax = if (vf != null) vf.denoiseMaxNs / 1000L else 0L
    val tseMsAvg = if (vf != null && vf.tseChunks > 0) vf.tseMsSum / vf.tseChunks else 0.0
    val tseRtf = if (vf != null && vf.tseAudioMsSum > 0.0) vf.tseMsSum / vf.tseAudioMsSum else 0.0
    val vadRatio = if (vf != null && vf.vadWindowsTotal > 0) vf.vadSpeechWindows.toDouble() / vf.vadWindowsTotal else 0.0
    val gatedRatio = if (vf != null && vf.voicedOutHops > 0) vf.gatedOutHops.toDouble() / vf.voicedOutHops else 0.0

    val d = JSONObject()
      .put("stage", "summary")
      .put("route", activeRoute)
      .put("duration_ms", durationMs)
      .put("frames_in", framesIn)
      .put("frames_out", framesOut)
      .put("ws_gap_max_ms", gapMax)
      .put("dpdf_us_avg", dpdfUsAvg)
      .put("dpdf_us_max", dpdfUsMax)
      .put("tse_enabled", vf?.isTseActive ?: false)
      .put("tse_bypassed", vf?.tseBypassed ?: false)
      .put("tse_ms_avg", safeRound(tseMsAvg, 100.0))
      .put("tse_ms_max", safeRound(vf?.tseMsMax ?: 0.0, 100.0))
      .put("tse_rtf", safeRound(tseRtf, 1000.0))
      .put("tse_overruns", vf?.tseOverruns ?: 0)
      .put("sv_checks", vf?.checks ?: 0)
      .put("sv_passed", vf?.passed ?: 0)
      .put("sv_blocked", vf?.blocked ?: 0)
      .put("utterances", vf?.checks ?: 0)
      .put("pass_count", vf?.passed ?: 0)
      .put("mute_count", vf?.blocked ?: 0)
      .put("sv_ms_avg", if (vf != null && vf.checks > 0) vf.checkMsSum / vf.checks else 0L)
      .put("sv_ms_max", vf?.checkMsMax ?: 0L)
      .put("vad_speech_ratio", safeRound(vadRatio, 1000.0))
      .put("gated_ratio", safeRound(gatedRatio, 1000.0))
      .put("play_stalls", playStalls)
      .put("play_underruns", underruns)
    return JSONObject().put("action", "client.ai_telemetry").put("data", d)
  }

  // ----------------------------------------------------------------------- loops

  private fun micLoop() {
    Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
    val rec = record ?: return
    try { modelsReady.await() } catch (_: InterruptedException) { return }
    val models = voiceModels
    val sample = ownerSample
    val wantFilter = models != null && (
      useDenoise ||
        (enrolledVoice != null && models.speaker != null) ||
        (sample != null && models.hasTse)
      )
    var vfRef: VoiceFilter? = null
    val vf = if (wantFilter) {
      VoiceFilter(
        m = models!!,
        o = VoiceFilter.Options(
          denoise = useDenoise,
          enrolled = enrolledVoice,
          prototypes = enrolledProtos,
          ownerSample = sample,
          threshold = voiceThreshold,
          captureMissingSample = enrolledVoice != null && sample == null,
        ),
        worker = { r -> if (!ended) try { spkExec.execute(r) } catch (_: Throwable) {} },
        tseWorker = { r -> if (!ended) try { tseExec.execute(r) } catch (_: Throwable) {} },
        emit = { buf, off, len ->
          val lv = rms(buf, off, len)
          micLevel = if (muted) 0f else lv
          if (!muted) sendBinaryFrame(buf, off, len)
        },
        onUtterance = { u -> emitUtteranceTelemetry(u, vfRef) },
        onOverload = { action, ms ->
          Log.w(TAG, "VoxLock overload action=$action tse_ms=${"%.1f".format(ms)}")
        },
        onOwnerSampleCaptured = { captured ->
          if (!ended) {
            try {
              spkExec.execute {
                if (VoiceModelManager.saveOwnerSample(ctx, captured)) {
                  Log.i(TAG, "Backfilled missing owner_sample.pcm from verified call speech")
                }
              }
            } catch (_: Throwable) {}
          }
        },
      )
    } else null
    vfRef = vf
    filter = vf
    emitInitTelemetry(models, vf)

    val frame = ByteArray(MIC_FRAME_BYTES)
    val silence = ByteArray(MIC_FRAME_BYTES)
    while (!ended) {
      var off = 0
      while (off < frame.size && !ended) {
        val n = rec.read(frame, off, frame.size - off)
        if (n <= 0) {
          if (n < 0) return
          continue
        }
        off += n
      }
      if (muted) {
        if (filterReset) {
          filterReset = false
          vf?.reset()
        }
        micLevel = 0f
        rawFramesIn += HOPS_PER_MIC_FRAME
        rawFramesOut += HOPS_PER_MIC_FRAME
        // Silence keeps flowing while muted: the model expects a continuous realtime stream.
        sendBinaryFrame(silence, 0, silence.size)
      } else if (vf != null) {
        filterReset = false
        vf.push(frame, 0, frame.size)
      } else {
        rawFramesIn += HOPS_PER_MIC_FRAME
        rawFramesOut += HOPS_PER_MIC_FRAME
        micLevel = rms(frame, 0, frame.size)
        sendBinaryFrame(frame, 0, frame.size)
      }
    }
  }

  /** Frames the track has played since it was last flushed. */
  private fun head(tr: AudioTrack): Long = try { tr.playbackHeadPosition.toLong() and 0xFFFFFFFFL } catch (_: Throwable) { written }

  /** What the track needs before it plays: since Android 12 the threshold set above, before that its whole buffer. */
  private fun startFrames(tr: AudioTrack): Long = try {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) tr.startThresholdInFrames.toLong() else tr.bufferSizeInFrames.toLong()
  } catch (_: Throwable) {
    (SPEAKER_RATE / 5).toLong()
  }

  /** Writes up to [frames] of silence without blocking; returns what went in. */
  private fun writeSilence(tr: AudioTrack, silence: ByteArray, frames: Long): Long {
    var left = frames
    while (left > 0) {
      val n = tr.write(silence, 0, minOf(silence.size.toLong(), left * 2).toInt(), AudioTrack.WRITE_NON_BLOCKING)
      if (n <= 0) break
      written += n / 2
      left -= n / 2
    }
    return frames - left
  }

  /**
   * Feeds the speaker. The jitter buffer (Playout) says when a reply has enough
   * audio in to start, and when one that ran dry may go on.
   */
  private fun playLoop() {
    Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
    val tr = track ?: return
    val silence = ByteArray(SPEAKER_PER_MS * 2 * 20)
    var cur: Chunk? = null
    var off = 0
    var gen = -1
    var lastHead = -1L
    var headSince = 0L
    val leadFrames = if (startFrames(tr) >= tr.bufferSizeInFrames) Playout.LEAD_MS.toLong() * SPEAKER_PER_MS else 0L
    while (!ended) {
      val now = SystemClock.elapsedRealtime()
      synchronized(lock) {
        val head = head(tr)
        if (gen != generation) {
          gen = generation
          cur = null
          off = 0
          writeSilence(tr, silence, startFrames(tr))
        }
        if (head != lastHead) {
          lastHead = head
          headSince = now
        } else if (cur == null && written - head > 0 && now - headSince >= STUCK_MS) {
          writeSilence(tr, silence, tr.bufferSizeInFrames.toLong())
          headSince = now
        }
        while (!ended) {
          if (cur == null) {
            val audio = maxOf(0L, (inflight.lastOrNull()?.second ?: 0L) - head)
            val next = playout.take(now, audio) ?: break
            if (stoppedRuns.contains(next.ref.runId)) continue
            inflight.addLast(next to (written + next.frames))
            written += next.frames
            cur = next
            off = 0
          }
          val c = cur!!
          val n = tr.write(c.pcm, off, c.pcm.size - off, AudioTrack.WRITE_NON_BLOCKING)
          if (n < 0) {
            written -= (c.pcm.size - off) / 2
            cur = null
            break
          }
          off += n
          if (off < c.pcm.size) break
          cur = null
        }
        if (cur == null && written - head < leadFrames) writeSilence(tr, silence, leadFrames - (written - head))
      }
      Thread.sleep(PLAY_LOOP_MS)
    }
  }

  /** Acknowledges chunks once the speaker has really played them, reports levels, and emits 5s periodic AI telemetry. */
  private fun ackLoop() {
    var lastLevel = 0L
    var lastPeriodic = SystemClock.elapsedRealtime()
    var prevHopsIn = 0L
    var prevHopsOut = 0L
    var prevDenoiseNs = 0L
    var prevTseChunks = 0L
    var prevTseMsSum = 0.0
    var prevTseAudioMs = 0.0
    var prevVadTotal = 0L
    var prevVadSpeech = 0L
    var prevVoicedOut = 0L
    var prevGatedOut = 0L

    while (!ended) {
      Thread.sleep(20)
      val tr = track ?: continue
      val out = mutableListOf<JSONObject>()
      var outLevel = 0f
      synchronized(lock) {
        val head = head(tr)
        while (inflight.isNotEmpty() && inflight.first().second <= head) acked(inflight.removeFirst().first, out)
        inflight.firstOrNull()?.let { outLevel = it.first.level }
      }
      for (m in out) ws?.send(m.toString())
      val now = System.currentTimeMillis()
      if (now - lastLevel >= 100) {
        lastLevel = now
        PocketBus.emit("onLevel", mapOf("mic" to micLevel.toDouble(), "out" to outLevel.toDouble()))
      }
      val el = SystemClock.elapsedRealtime()
      if (ready && el - lastPeriodic >= PERIODIC_TELEMETRY_MS) {
        lastPeriodic = el
        val vf = filter
        emitPeriodicTelemetry(
          vf = vf,
          prevHopsIn = prevHopsIn,
          prevHopsOut = prevHopsOut,
          prevDenoiseNs = prevDenoiseNs,
          prevTseChunks = prevTseChunks,
          prevTseMsSum = prevTseMsSum,
          prevTseAudioMs = prevTseAudioMs,
          prevVadTotal = prevVadTotal,
          prevVadSpeech = prevVadSpeech,
          prevVoicedOut = prevVoicedOut,
          prevGatedOut = prevGatedOut,
        )
        if (vf != null) {
          prevHopsIn = vf.hopsIn
          prevHopsOut = vf.hopsOut
          prevDenoiseNs = vf.denoiseNs
          prevTseChunks = vf.tseChunks
          prevTseMsSum = vf.tseMsSum
          prevTseAudioMs = vf.tseAudioMsSum
          prevVadTotal = vf.vadWindowsTotal
          prevVadSpeech = vf.vadSpeechWindows
          prevVoicedOut = vf.voicedOutHops
          prevGatedOut = vf.gatedOutHops
        } else {
          prevHopsIn = rawFramesIn
          prevHopsOut = rawFramesOut
        }
      }
    }
  }

  /** A chunk the speaker has played in full: its receipt, and the reply's when it was the last. Under `lock`. */
  private fun acked(chunk: Chunk, out: MutableList<JSONObject>) {
    out.add(JSONObject().put("action", "playback.chunk.completed").put("chunk_id", chunk.ref.chunkId).put("run_id", chunk.ref.runId).put("turn_id", chunk.ref.turnId))
    val s = scope(chunk.ref.runId, chunk.ref.turnId)
    s.playedMs += chunk.frames * 1000.0 / SPEAKER_RATE
    if (s.outstanding > 0) s.outstanding--
    drained(chunk.ref.runId, s)?.let { out.add(it) }
  }

  private fun scope(runId: String, turnId: String): Scope {
    val s = scopes.getOrPut(runId) { Scope() }
    if (turnId.isNotEmpty()) s.turnId = turnId
    return s
  }

  private fun drained(runId: String, s: Scope): JSONObject? {
    if (!s.finished || s.drained || s.stopped || s.outstanding > 0) return null
    s.drained = true
    return JSONObject().put("action", "playback.completed").put("run_id", runId).put("turn_id", s.turnId)
  }

  /** The model was interrupted: stop its speech now and report how much was heard. */
  private fun stopRun(runId: String, turnId: String, reason: String) {
    val out = mutableListOf<JSONObject>()
    synchronized(lock) {
      stoppedRuns.add(runId)
      stops++
      playout.drop(runId)
      val s = scope(runId, turnId)
      s.stopped = true
      val tr = track
      if (inflight.any { it.first.ref.runId == runId } && tr != null) {
        val head = head(tr)
        val back = mutableListOf<Chunk>()
        for ((c, end) in inflight) {
          val start = end - c.frames
          when {
            end <= head -> acked(c, out)
            c.ref.runId == runId -> if (head > start) s.playedMs += (head - start) * 1000.0 / SPEAKER_RATE
            else -> back.add(c)
          }
        }
        try {
          tr.pause()
          tr.flush()
          tr.play()
        } catch (_: Throwable) {}
        inflight.clear()
        playout.requeue(back)
        generation++
        written = head(tr)
      }
      s.outstanding = 0
      s.finished = true
      s.stopped = true
      s.drained = true
      out.add(
        JSONObject().put("action", "playback.stopped").put("run_id", runId).put("turn_id", s.turnId)
          .put("played_audio_ms", s.playedMs.toLong()).put("reason", reason),
      )
      s.playedMs = 0.0
    }
    for (m in out) ws?.send(m.toString())
  }

  // ----------------------------------------------------------------------- socket

  private inner class Listener : WebSocketListener() {
    override fun onMessage(webSocket: WebSocket, text: String) {
      if (ended) return
      val o = try { JSONObject(text) } catch (_: Throwable) { return }
      val action = o.optString("action")
      val d = o.optJSONObject("data") ?: JSONObject()
      when (action) {
        "relay.state" -> {
          when (d.optString("state")) {
            "ready" -> {
              val initMsg = synchronized(telemetryLock) {
                ready = true
                lastWsSendElapsed = 0L
                val p = pendingInitTelemetry
                pendingInitTelemetry = null
                p
              }
              webSocket.send(JSONObject().put("action", "mic_state").put("enabled", !muted).toString())
              initMsg?.let { try { webSocket.send(it) } catch (_: Throwable) {} }
              PocketBus.emit("onCall", mapOf("state" to "ready"))
            }
            "error", "closed" -> {
              end(d.optString("message").ifEmpty { "通话结束了" })
              return
            }
          }
        }
        "response.audio.context" -> synchronized(lock) {
          contexts.addLast(Ref(d.optString("chunk_id"), d.optString("run_id"), d.optString("turn_id")))
          if (contexts.size > 512) contexts.removeFirst()
        }
        "response.audio.started" -> synchronized(lock) {
          val run = d.optString("run_id")
          if (!stoppedRuns.contains(run)) {
            val s = scope(run, d.optString("turn_id"))
            s.finished = false; s.drained = false; s.stopped = false; s.playedMs = 0.0
          }
        }
        "response.audio.done" -> {
          val m = synchronized(lock) {
            val run = d.optString("run_id")
            if (stoppedRuns.contains(run)) null
            else {
              playout.finish(run)
              scope(run, d.optString("turn_id")).let { s -> s.finished = true; drained(run, s) }
            }
          }
          m?.let { webSocket.send(it.toString()) }
        }
        "response.audio.stop" -> stopRun(d.optString("run_id"), d.optString("turn_id"), d.optString("reason").ifEmpty { "interrupted" })
      }
      // Captions and state for the UI; audio contexts are only plumbing.
      if (action != "response.audio.context") PocketBus.emit("onCallEvent", mapOf("json" to text))
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
      if (ended) return
      val pcm = bytes.toByteArray()
      synchronized(lock) {
        val ref = contexts.removeFirstOrNull() ?: return
        if (stoppedRuns.contains(ref.runId)) return
        scope(ref.runId, ref.turnId).outstanding++
        playout.push(Chunk(ref, pcm, pcm.size / 2, rms(pcm, 0, pcm.size)), SystemClock.elapsedRealtime())
      }
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      val why = when (response?.code) {
        401 -> "授权失效，请重新配对"
        403 -> "只有手机可以打语音"
        503 -> "服务器还没开语音功能"
        else -> "连接断了"
      }
      end(why)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      end("通话结束了")
    }
  }

  // ----------------------------------------------------------------------- controls

  fun setMuted(value: Boolean) {
    muted = value
    if (value) filterReset = true
    if (ready) ws?.send(JSONObject().put("action", "mic_state").put("enabled", !value).toString())
    PocketBus.emit("onCall", mapOf("state" to "ready", "muted" to value))
  }

  fun hangup() {
    try { ws?.send(JSONObject().put("action", "relay.hangup").toString()) } catch (_: Throwable) {}
    end("挂断了")
  }

  /** Mid-reply stalls of the jitter buffer, its cushion, AudioTrack underruns, and voice preprocessing stats. */
  private fun stats(): JSONObject = synchronized(lock) {
    val underruns = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) track?.underrunCount ?: -1 else -1
    val d = JSONObject().put("stalls", playout.stalls).put("target_ms", playout.targetMs.toLong())
      .put("max_target_ms", playout.maxTargetMs.toLong()).put("underruns", underruns).put("stops", stops)
    filter?.let { f ->
      if (f.hopsIn > 0) d.put("denoise_us", f.denoiseNs / 1000 / f.hopsIn).put("denoise_max_ms", f.denoiseMaxNs / 1_000_000)
      if (f.checks > 0) {
        d.put("vp_checks", f.checks).put("vp_max_ms", f.checkMsMax)
          .put("vp_passed", f.passed).put("vp_blocked", f.blocked)
          .put("vp_hold_ms", 0)
      }
    }
    JSONObject().put("action", "call.stats").put("data", d)
  }

  @Synchronized
  fun end(message: String) {
    if (ended) return
    ended = true
    val wasReady = ready
    ready = false
    if (current === this) current = null

    val summary = try { buildSummaryTelemetry() } catch (_: Throwable) { null }
    val stats = try { stats() } catch (_: Throwable) { null }
    if (wasReady && summary != null) {
      try { ws?.send(summary.toString()) } catch (_: Throwable) {}
    }
    try { ws?.close(1000, "bye") } catch (_: Throwable) {}

    closeAudio()
    try { micThread?.join(1500) } catch (_: InterruptedException) {}
    spkExec.shutdownNow()
    tseExec.shutdownNow()
    try { spkExec.awaitTermination(1500, TimeUnit.MILLISECONDS) } catch (_: InterruptedException) {}
    try { tseExec.awaitTermination(1500, TimeUnit.MILLISECONDS) } catch (_: InterruptedException) {}
    try { filter?.close() } catch (_: Throwable) {}
    try { voiceModels?.close() } catch (_: Throwable) {}
    voiceModels = null
    ownerSample = null
    filter = null
    client.dispatcher.executorService.shutdown()

    summary?.let {
      Log.i(TAG, it.toString())
      PocketBus.emit("onCallEvent", mapOf("json" to it.toString()))
    }
    stats?.let {
      Log.i(TAG, it.toString())
      PocketBus.emit("onCallEvent", mapOf("json" to it.toString()))
    }
    PocketBus.emit("onCall", mapOf("state" to "ended", "message" to message))
    onEnded()
  }
}

private fun safeRound(v: Double, scale: Double): Double =
  if (v.isFinite()) round(v * scale) / scale else 0.0

private fun rms(pcm: ByteArray, off: Int, len: Int): Float {
  var sum = 0.0
  var n = 0
  var i = 0
  while (i + 1 < len) {
    val s = ((pcm[off + i + 1].toInt() shl 8) or (pcm[off + i].toInt() and 0xFF)).toShort().toInt()
    sum += (s * s).toDouble()
    n++
    i += 2
  }
  if (n == 0) return 0f
  return minOf(1f, (sqrt(sum / n) / 32768.0 * 4).toFloat())
}
