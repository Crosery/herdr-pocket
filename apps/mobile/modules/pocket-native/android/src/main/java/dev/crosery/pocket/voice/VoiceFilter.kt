package dev.crosery.pocket.voice

import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.log10

/**
 * Abstraction over the ONNX models so [VoiceFilter] runs identically on real ONNX sessions and in
 * deterministic JVM unit tests.
 */
internal interface VoiceBackend : AutoCloseable {
  val hasSpeaker: Boolean
  val hasTse: Boolean
  val enrollMs: Long get() = 0L
  fun reset()
  /** The recurrent extraction state is owned by the TSE worker. */
  fun resetTse() {}
  fun denoise(x: FloatArray, off: Int, out: FloatArray, outOff: Int): Boolean
  fun vadProb(win: FloatArray, off: Int): Float
  fun embed(x: FloatArray, off: Int, len: Int): FloatArray
  fun tseChunk(wav: FloatArray, wavLen: Int, kFrames: Int, framesOut: FloatArray)
  override fun close() {}
}

internal class ModelsBackend(
  private val m: VoiceModels,
  denoise: Boolean,
  needVad: Boolean,
  needSpeaker: Boolean,
  ownerSample48k: FloatArray?,
) : VoiceBackend {
  private val denoiser = if (denoise) Denoiser(m) else null
  private val vad = if (needVad) Vad(m) else null
  private val speaker = if (needSpeaker && m.speaker != null) Speaker(m) else null
  private var voxlock: VoxLock? = null
  override var enrollMs: Long = 0L
    private set

  init {
    if (ownerSample48k != null && ownerSample48k.isNotEmpty() && m.hasTse) {
      val vl = VoxLock(m)
      try {
        val t0 = System.nanoTime()
        vl.enroll(ownerSample48k)
        enrollMs = (System.nanoTime() - t0) / 1_000_000
        vl.warmUp()
        voxlock = vl
      } catch (_: Throwable) {
        vl.close()
      }
    }
  }

  override val hasSpeaker: Boolean get() = speaker != null
  override val hasTse: Boolean get() = voxlock?.isEnrolled == true

  override fun reset() {
    denoiser?.reset()
    vad?.reset()
  }

  override fun resetTse() { voxlock?.resetState() }

  override fun denoise(x: FloatArray, off: Int, out: FloatArray, outOff: Int): Boolean =
    denoiser?.hop(x, off, out, outOff) ?: run {
      System.arraycopy(x, off, out, outOff, Denoiser.HOP)
      true
    }

  override fun vadProb(win: FloatArray, off: Int): Float = vad?.prob(win, off) ?: 0f

  override fun embed(x: FloatArray, off: Int, len: Int): FloatArray = speaker!!.embed(x, off, len)

  override fun tseChunk(wav: FloatArray, wavLen: Int, kFrames: Int, framesOut: FloatArray) {
    voxlock!!.chunk(wav, wavLen, kFrames, framesOut)
  }

  override fun close() {
    voxlock?.close()
    voxlock = null
  }
}

/**
 * Streaming call voice pipeline (Stage 1/2 parity with desktop `LiveCallProcessor`):
 * 1. `HighPass64` cleans DC/wind rumble once at input (retained as clean fallback when neural stages are off).
 * 2. `DPDFNet-baseline` denoise runs FIRST so stationary noise is stripped before TSE and SV.
 * 3. `VoxLock` v2 TSE target extraction runs BEFORE VAD/SV so overlapping speech is separated first.
 * 4. `Silero VAD v4` + `ERes2NetV2-zh` multi-prototype SV evaluate the TSE-separated stream
 *    (or DPDFNet-denoised stream when TSE is off/bypassed; HPF fallback when neither runs).
 * 5. Residual suppression gate updates BEFORE `VocalEnhancer` using hysteresis (`-2.5 dB` close / `-1.2 dB` open,
 *    2-frame release hold) decoupled from the old `-9.0 dB` deadlock via strong/consecutive non-owner SV margins.
 * 6. `VocalEnhancer` boosts strictly owner-verified active speech (`allowVocalBoost`).
 * 7. Smooth 16 ms raised-cosine residual gate + per-sample onset attenuation (16 ms release, 6 ms attack on owner confirm).
 * 8. On extraction failure with no SV, owner-only mode emits silence at the same cadence instead of the mixture.
 */
class VoiceFilter internal constructor(
  internal val backend: VoiceBackend,
  private val o: Options,
  /** Runs speaker verification embeddings off the microphone thread (or inline in tests). */
  private val worker: (Runnable) -> Unit,
  /** Runs VoxLock TSE chunks off the microphone thread (defaults to [worker] for inline tests). */
  private val tseWorker: (Runnable) -> Unit = worker,
  /** Continuous PCM16 output ready to send, never stalled. */
  private val emit: (ByteArray, Int, Int) -> Unit,
  /** Structured utterance evaluation callback for logs and AI telemetry. */
  private val onUtterance: (UtteranceTelemetry) -> Unit = {},
  /** Overload callback when a slow CPU steps up to K=8 or bypasses TSE. */
  private val onOverload: (action: String, tseMs: Double) -> Unit = { _, _ -> },
  /** Invoked once when 3.0 s (`48_000` samples) of high-confidence clean owner speech is captured. */
  private val onOwnerSampleCaptured: (FloatArray) -> Unit = {},
) : AutoCloseable {

  constructor(
    m: VoiceModels,
    o: Options,
    worker: (Runnable) -> Unit,
    tseWorker: (Runnable) -> Unit = worker,
    emit: (ByteArray, Int, Int) -> Unit,
    onUtterance: (UtteranceTelemetry) -> Unit = {},
    onOverload: (action: String, tseMs: Double) -> Unit = { _, _ -> },
    onOwnerSampleCaptured: (FloatArray) -> Unit = {},
  ) : this(
    backend = ModelsBackend(
      m = m,
      denoise = o.denoise,
      needVad = ((o.enrolled != null || o.lockFirstSpeaker) && m.speaker != null) || (o.ownerSample != null && m.hasTse),
      needSpeaker = (o.enrolled != null || o.lockFirstSpeaker) && m.speaker != null,
      ownerSample48k = o.ownerSample,
    ),
    o = o,
    worker = worker,
    tseWorker = tseWorker,
    emit = emit,
    onUtterance = onUtterance,
    onOverload = onOverload,
    onOwnerSampleCaptured = onOwnerSampleCaptured,
  )

  class Options(
    val denoise: Boolean,
    val enrolled: FloatArray?,
    val prototypes: List<FloatArray>? = null,
    val ownerSample: FloatArray? = null,
    val threshold: Float = 0.38f,
    val captureMissingSample: Boolean = false,
    val requireIsolation: Boolean = enrolled != null,
    val lockFirstSpeaker: Boolean = false,
    val route: String = "speaker",
    val enhanceVocal: Boolean = denoise,
  )

  data class UtteranceTelemetry(
    val kind: String,
    val pass: Boolean,
    val svScore: Float,
    val svRaw: Float,
    val svProto: Float,
    val svSess: Float,
    val svMs: Long,
    val usedMs: Long,
    val vadProb: Float,
    val rawDbfs: Float,
    val tseDbfs: Float,
    val enhDbfs: Float,
    val tseAttenDb: Float,
    val enhGainDb: Float,
  )

  private class SvResult(
    val gen: Int,
    val job: Int,
    val kind: String,
    val embNorm: FloatArray?,
    val cleanAudio: FloatArray?,
    val usedSamples: Int,
    val ms: Long,
  )

  private class TseRawResult(
    val gen: Int,
    val kFrames: Int,
    val frames: FloatArray,
    val ms: Double,
  )

  companion object {
    const val HOP = Denoiser.HOP // 160 samples = 10 ms
    internal const val START_PROB = 0.45f
    internal const val SPEECH_PROB = 0.35f
    internal const val START_WINDOWS = 3 // 96 ms
    internal const val END_WINDOWS = 12 // 384 ms
    internal const val EARLY_VOICED_W = 8 // 256 ms (tightened from 13)
    internal const val FULL_VOICED_W = 22 // 704 ms (tightened from 26)
    internal const val RECHECK_STEP_W = 16 // 512 ms (tightened from 20)
    internal const val MIN_END_VOICED_W = 8 // 256 ms
    private const val EARLY_WINDOW_SAMPLES = VOICE_RATE * 3 / 5 // 9_600 (600 ms)
    internal const val RECHECK_WINDOW_SAMPLES = VOICE_RATE // 16_000 (1.0 s for faster speaker handoff)
    private const val MIN_SV_SAMPLES = VOICE_RATE / 5 // 3_200 (200 ms)
    private const val CLEAN_RING_CAP = VOICE_RATE * 3 / 2 // 24_000 (1.5 s)
    private const val SESS_MIN_SAMPLES = VOICE_RATE * 3 / 5 // 9_600 (600 ms)

    // Residual gate hysteresis & strong non-owner SV margin (matching desktop Stage 1).
    internal const val STRONG_NON_OWNER_MARGIN = 0.06f
    internal const val TSE_GATE_CLOSE_DB = -2.5f
    internal const val TSE_GATE_OPEN_DB = -1.2f
    internal const val GATE_RELEASE_HOLD_FRAMES = 2
    internal const val RAMP_SAMPLES = 256 // 16 ms raised-cosine residual gate

    // Per-sample unverified onset attenuation (16 ms smooth release, fast 6 ms attack on owner confirm).
    internal const val ONSET_SV_UNCERTAIN_GAIN = 0.45f
    internal const val ONSET_TSE_UNCERTAIN_GAIN = 0.78f
    internal const val ONSET_TSE_ATTEN_GAIN = 0.25f
    internal const val ONSET_ATTACK_SAMPLES = 96f // 6 ms
    internal const val ONSET_RELEASE_SAMPLES = 256f // 16 ms

    // Capture delivers 20 ms packets. Budget for the first full chunk and jittered mobile CPU scheduling.
    private const val TSE_PREBUFFER_HOPS = 16
    private const val TSE_RECOVERY_PREBUFFER_HOPS = 20
    private const val TSE_RETRY_DELAY_HOPS = 8
    private const val TSE_K5_BUDGET_MS = 38.0
    private const val TSE_K8_BUDGET_MS = 60.0
    private const val TSE_MAX_BACKLOG_SAMPLES = 3_840 // 240 ms
    private const val SEND_MAX = 3200
  }

  private val svEnabled = (o.enrolled != null || o.lockFirstSpeaker) && backend.hasSpeaker
  private val tseEnabled = backend.hasTse
  private val enrolledNorm = o.enrolled?.let { normalizeEmbedding(it) }
  private val prototypesNorm = o.prototypes?.map { normalizeEmbedding(it) }

  private val hpf = if (o.denoise || o.enhanceVocal || svEnabled || tseEnabled) HighPass64() else null
  private val vadBoost = if (svEnabled || tseEnabled) QuietVadBoost() else null
  internal val enhancer = if (o.enhanceVocal) VocalEnhancer() else null

  // Per-hop working buffers (single-threaded on mic thread).
  private val inBuf = FloatArray(HOP)
  private var inLen = 0
  private val hpfBuf = FloatArray(HOP)
  private val denBuf = FloatArray(HOP)
  private val stageIn = FloatArray(HOP)
  private val tsePreBuf = FloatArray(HOP)
  private val enhBuf = FloatArray(HOP)
  private val silentHop = FloatArray(HOP)

  // VAD + ERes2NetV2-zh ring fed from TSE-separated (or DPDFNet-denoised, or HPF fallback) stream.
  private val cleanVadFifo = FloatArray(Vad.WINDOW + HOP * 2)
  private var cleanVadLen = 0
  private val cleanWin512 = FloatArray(Vad.WINDOW)
  private val vadProbe512 = FloatArray(Vad.WINDOW)
  private val cleanVoicedRing = FloatArray(CLEAN_RING_CAP)
  private var cleanVoicedLen = 0

  // VoxLock streaming rings & sample-aligned pre-TSE reference ring (single-threaded on mic thread except ONNX run).
  private val voxStreamer = VoxLockStreamer()
  private val tseSynthScratch = FloatArray(VoxLockStreamer.MAX_K * VoxLockStreamer.HOP)
  private var tseOutRing = FloatArray(VOICE_RATE)
  private var tseOutRead = 0
  private var tseOutLen = 0
  private var tsePreRing = FloatArray(VOICE_RATE)
  private var tsePreRead = 0
  private var tsePreLen = 0
  private var tsePendingPre = FloatArray(VOICE_RATE)
  private var tsePendingPreRead = 0
  private var tsePendingPreLen = 0
  private val tseResults = ConcurrentLinkedQueue<TseRawResult>()
  @Volatile private var tseJobInFlight = false
  private var slowTseStreak = 0
  private var tseGen = 0
  private var tseNeedsReset = false
  private var tseRetryAtHop = 0L
  private var tseRetried = false

  @Volatile
  var tseK = VoxLockStreamer.DEFAULT_K
    private set
  @Volatile
  var tseBypassed = false
    private set

  // Utterance, SV tracker & residual/onset gate state.
  private var resetGen = 0
  internal var speaking = false
  private var startRun = 0
  private var silRun = 0
  private var uttVoicedW = 0
  private var sinceCheckW = 0
  private var earlyChecked = false
  private var fullChecked = false
  private var svJobSeq = 0
  private var svJobId = 0
  internal var svConfirmedNonOwner = false
  internal var svConfirmedOwner = false
  internal var lastSvScore: Float? = null
  internal var nonOwnerStreak = 0
  private var sessionEmb: FloatArray? = null
  private val svResults = ConcurrentLinkedQueue<SvResult>()

  internal var smoothedTseAttenDb = 0f
  internal var suppressingResidual = false
  internal var gateReleaseHold = 0
  private var gatePhase = RAMP_SAMPLES
  private var lastResidualGain = 1.0f
  internal var onsetGain = 1.0f

  // Auto-backfill `owner_sample.pcm` for enrolled users missing local PCM sample.
  private val captureOwnerBuf = if (o.captureMissingSample && svEnabled) FloatArray(VoiceModelManager.OWNER_SAMPLE_SAMPLES) else null
  private var captureOwnerLen = 0
  private var ownerSampleDelivered = false

  // Output PCM16 staging.
  private var out = ByteArray(SEND_MAX * 2)
  private var outLen = 0

  // Telemetry & stats.
  val enrollMs: Long get() = backend.enrollMs
  val isTseActive: Boolean get() = tseEnabled && !tseBypassed
  val isSvActive: Boolean get() = svEnabled

  var hopsIn = 0L; private set
  var hopsOut = 0L; private set
  var denoiseNs = 0L; private set
  var denoiseMaxNs = 0L; private set
  var checks = 0; private set
  var checkMsMax = 0L; private set
  var checkMsSum = 0L; private set
  var passed = 0; private set
  var blocked = 0; private set

  var tseChunks = 0L; private set
  var tseMsSum = 0.0; private set
  var tseMsMax = 0.0; private set
  var tseAudioMsSum = 0.0; private set
  var tseOverruns = 0; private set

  var vadWindowsTotal = 0L; private set
  var vadSpeechWindows = 0L; private set
  var voicedOutHops = 0L; private set
  var gatedOutHops = 0L; private set

  var lastVadProb = 0f; private set
  var lastRawDbfs = -90f; private set
  var lastTseDbfs = -90f; private set
  var lastEnhDbfs = -90f; private set
  var lastTseAttenDb = 0f; private set

  init {
    primeTsePrebuffer()
  }

  private fun primeTsePrebuffer() {
    tseOutRead = 0
    tseOutLen = 0
    tsePreRead = 0
    tsePreLen = 0
    tsePendingPreRead = 0
    tsePendingPreLen = 0
    if (tseEnabled && !tseBypassed) {
      val hops = if (tseK == VoxLockStreamer.DEFAULT_K) TSE_PREBUFFER_HOPS else TSE_RECOVERY_PREBUFFER_HOPS
      appendTseOutZeros(hops * HOP)
      appendTsePreZeros(hops * HOP)
    }
  }

  private fun appendTseOut(src: FloatArray, count: Int) {
    if (count <= 0) return
    ensureTseOutCapacity(count)
    System.arraycopy(src, 0, tseOutRing, tseOutRead + tseOutLen, count)
    tseOutLen += count
  }

  private fun appendTseOutZeros(count: Int) {
    if (count <= 0) return
    ensureTseOutCapacity(count)
    tseOutRing.fill(0f, tseOutRead + tseOutLen, tseOutRead + tseOutLen + count)
    tseOutLen += count
  }

  private fun ensureTseOutCapacity(extra: Int) {
    if (tseOutRead > 0 && tseOutRead + tseOutLen + extra > tseOutRing.size) {
      System.arraycopy(tseOutRing, tseOutRead, tseOutRing, 0, tseOutLen)
      tseOutRead = 0
    }
    if (tseOutLen + extra > tseOutRing.size) {
      tseOutRing = tseOutRing.copyOf(maxOf(tseOutRing.size * 2, tseOutLen + extra))
    }
  }

  private fun appendTsePreZeros(count: Int) {
    if (count <= 0) return
    ensureTsePreCapacity(count)
    tsePreRing.fill(0f, tsePreRead + tsePreLen, tsePreRead + tsePreLen + count)
    tsePreLen += count
  }

  private fun ensureTsePreCapacity(extra: Int) {
    if (tsePreRead > 0 && tsePreRead + tsePreLen + extra > tsePreRing.size) {
      System.arraycopy(tsePreRing, tsePreRead, tsePreRing, 0, tsePreLen)
      tsePreRead = 0
    }
    if (tsePreLen + extra > tsePreRing.size) {
      tsePreRing = tsePreRing.copyOf(maxOf(tsePreRing.size * 2, tsePreLen + extra))
    }
  }

  private fun pushTsePendingPre(src: FloatArray, off: Int, count: Int) {
    if (count <= 0) return
    if (tsePendingPreRead > 0 && tsePendingPreRead + tsePendingPreLen + count > tsePendingPre.size) {
      System.arraycopy(tsePendingPre, tsePendingPreRead, tsePendingPre, 0, tsePendingPreLen)
      tsePendingPreRead = 0
    }
    if (tsePendingPreLen + count > tsePendingPre.size) {
      tsePendingPre = tsePendingPre.copyOf(maxOf(tsePendingPre.size * 2, tsePendingPreLen + count))
    }
    System.arraycopy(src, off, tsePendingPre, tsePendingPreRead + tsePendingPreLen, count)
    tsePendingPreLen += count
  }

  private fun transferPendingPreToTsePre(count: Int) {
    if (count <= 0) return
    ensureTsePreCapacity(count)
    val take = minOf(count, tsePendingPreLen)
    if (take > 0) {
      System.arraycopy(tsePendingPre, tsePendingPreRead, tsePreRing, tsePreRead + tsePreLen, take)
      tsePendingPreRead += take
      tsePendingPreLen -= take
      if (tsePendingPreLen == 0) tsePendingPreRead = 0
    }
    if (take < count) {
      tsePreRing.fill(0f, tsePreRead + tsePreLen + take, tsePreRead + tsePreLen + count)
    }
    tsePreLen += count
  }

  private fun popTseOut(dst: FloatArray, preDst: FloatArray) {
    val take = minOf(HOP, tseOutLen)
    if (take > 0) {
      System.arraycopy(tseOutRing, tseOutRead, dst, 0, take)
      tseOutRead += take
      tseOutLen -= take
      if (tseOutLen == 0) tseOutRead = 0
    }
    val preTake = minOf(take, tsePreLen)
    if (preTake > 0) {
      System.arraycopy(tsePreRing, tsePreRead, preDst, 0, preTake)
      tsePreRead += preTake
      tsePreLen -= preTake
      if (tsePreLen == 0) tsePreRead = 0
    }
    if (preTake < HOP) preDst.fill(0f, preTake, HOP)
    if (take < HOP) {
      dst.fill(0f, take, HOP)
      tseOverruns++
      if (tseChunks > 0 && tseOverruns >= 8 && !tseBypassed) {
        suspendTse("bypass_overrun", 0.0, retry = false)
      }
    }
  }

  internal fun hasIdentityReference(): Boolean = enrolledNorm != null || sessionEmb != null

  internal fun resetUtteranceSv() {
    svConfirmedNonOwner = false
    svConfirmedOwner = false
    lastSvScore = null
    nonOwnerStreak = 0
  }

  private fun effectiveThreshold(usedTse: Boolean = isTseActive): Float {
    val speakerMargin = if (o.route == "speaker" && !usedTse) 0.05f else 0f
    return maxOf(0.24f, o.threshold - speakerMargin)
  }

  internal fun hasStrongNonOwnerMargin(usedTse: Boolean = isTseActive): Boolean {
    if (!svConfirmedNonOwner) return false
    val th = effectiveThreshold(usedTse)
    val sc = lastSvScore
    return (sc != null && sc < th - STRONG_NON_OWNER_MARGIN) || nonOwnerStreak >= 2
  }

  internal fun allowVocalBoost(): Boolean {
    if (!svEnabled) return !o.requireIsolation
    if (suppressingResidual || svConfirmedNonOwner) return false
    // Only boost speech confirmed as the owner (or while acquiring the very first
    // speaker in first-speaker lock mode before any identity reference exists).
    return svConfirmedOwner || !hasIdentityReference()
  }

  internal fun targetOnsetGain(usedTse: Boolean): Float {
    if (!svEnabled || !hasIdentityReference()) return 1.0f
    if (suppressingResidual) {
      // Residual gate owns the smooth raised-cosine fade to 0.0; hold onsetGain
      // steady so sample 0 of suppression stays continuous with the previous hop.
      return onsetGain
    }
    if (svConfirmedOwner) return 1.0f
    // Unverified onset / pre-roll before SV confirms owner: apply gentle attenuation
    // (stronger if VoxLock TSE already reports non-target attenuation) and snap back
    // with fast 6 ms attack as soon as owner is confirmed.
    return if (usedTse) {
      if (smoothedTseAttenDb < TSE_GATE_CLOSE_DB) ONSET_TSE_ATTEN_GAIN else ONSET_TSE_UNCERTAIN_GAIN
    } else {
      ONSET_SV_UNCERTAIN_GAIN
    }
  }

  /** Resets streaming buffers after mute/unmute while keeping session adaptation and VoxLock enrollment. */
  fun reset() {
    resetGen++
    backend.reset()
    hpf?.reset()
    vadBoost?.reset()
    enhancer?.reset()
    inLen = 0
    cleanVadLen = 0
    cleanVoicedLen = 0
    voxStreamer.reset()
    tseGen++
    tseNeedsReset = tseEnabled
    tseResults.clear()
    slowTseStreak = 0
    primeTsePrebuffer()
    speaking = false
    startRun = 0
    silRun = 0
    uttVoicedW = 0
    sinceCheckW = 0
    earlyChecked = false
    fullChecked = false
    svJobId = 0
    resetUtteranceSv()
    svResults.clear()
    smoothedTseAttenDb = 0f
    lastTseAttenDb = 0f
    suppressingResidual = false
    gateReleaseHold = 0
    gatePhase = RAMP_SAMPLES
    lastResidualGain = 1.0f
    onsetGain = 1.0f
  }

  /** Pushes `bytes` of 16 kHz mono PCM16 LE and immediately emits continuous processed PCM16 LE. */
  fun push(pcm: ByteArray, off: Int, bytes: Int) {
    var i = 0
    while (i < bytes) {
      val n = minOf((bytes - i) / 2, HOP - inLen)
      if (n <= 0) break
      pcm16ToFloat(pcm, off + i, n * 2, inBuf, inLen)
      inLen += n
      i += n * 2
      if (inLen == HOP) {
        inLen = 0
        hop()
      }
    }
    flushOut()
  }

  private fun hop() {
    hopsIn++
    val rawHopRms = rmsFloat(inBuf, 0, HOP)

    // Drain any completed SV verdicts before processing.
    drainSvResults()

    // Keep clean HPF64 as fallback SV/VAD path when both neural denoise and TSE are off/bypassed.
    if (hpf != null) {
      hpf.process(inBuf, 0, hpfBuf, 0, HOP)
    } else {
      System.arraycopy(inBuf, 0, hpfBuf, 0, HOP)
    }

    // Stage 1: Run DPDFNet denoise FIRST so background noise is stripped before VoxLock TSE and SV.
    var usedDpdf = false
    if (o.denoise) {
      val t0 = System.nanoTime()
      usedDpdf = backend.denoise(hpfBuf, 0, denBuf, 0)
      val ns = System.nanoTime() - t0
      denoiseNs += ns
      if (ns > denoiseMaxNs) denoiseMaxNs = ns
      if (!usedDpdf) System.arraycopy(hpfBuf, 0, denBuf, 0, HOP)
    } else {
      System.arraycopy(hpfBuf, 0, denBuf, 0, HOP)
    }

    // Stage 2: Run VoxLock TSE target extraction BEFORE VAD + ERes2NetV2 SV so overlapping
    // speech is separated into the target stream before speaker verification scores it.
    maybeRetryTse()
    if (tseEnabled && !tseBypassed) {
      drainTseResults()
      if (!tseBypassed) {
        voxStreamer.pushInput(denBuf, 0, HOP)
        pushTsePendingPre(denBuf, 0, HOP)
        if (voxStreamer.bufferedInputSamples > TSE_MAX_BACKLOG_SAMPLES && tseJobInFlight) {
          suspendTse("bypass_backlog", voxStreamer.bufferedInputSamples * 1000.0 / VOICE_RATE, retry = true)
        }
        dispatchTseIfReady()
        drainTseResults()
      }
    }
    val usedTse = isTseActive
    if (usedTse) {
      popTseOut(stageIn, tsePreBuf)
    } else {
      lastRawDbfs = rmsToDbfs(rawHopRms)
      if (o.requireIsolation && !svEnabled) {
        lastTseDbfs = -90f
        lastEnhDbfs = -90f
        smoothedTseAttenDb = 0f
        lastTseAttenDb = attenDb(0f, rawHopRms)
        if (speaking) {
          voicedOutHops++
          gatedOutHops++
        }
        sendHop(silentHop)
        return
      }
      System.arraycopy(denBuf, 0, stageIn, 0, HOP)
      lastTseDbfs = rmsToDbfs(rmsFloat(stageIn, 0, HOP))
      smoothedTseAttenDb = 0f
      lastTseAttenDb = 0f
    }

    // Stage 3: Feed the TSE-separated stream (or DPDFNet-denoised stream when TSE is off/bypassed,
    // falling back to clean HPF64 when neither ran) into Silero VAD + ERes2NetV2 SV.
    if (svEnabled || tseEnabled) {
      val svInput = if (usedTse || usedDpdf) stageIn else hpfBuf
      System.arraycopy(svInput, 0, cleanVadFifo, cleanVadLen, HOP)
      cleanVadLen += HOP
      while (cleanVadLen >= Vad.WINDOW) {
        System.arraycopy(cleanVadFifo, 0, cleanWin512, 0, Vad.WINDOW)
        val rem = cleanVadLen - Vad.WINDOW
        if (rem > 0) System.arraycopy(cleanVadFifo, Vad.WINDOW, cleanVadFifo, 0, rem)
        cleanVadLen = rem
        onCleanVadWindow()
      }
      drainSvResults()
    }

    if (usedTse) {
      val rawRms = rmsFloat(tsePreBuf, 0, HOP)
      val tseRms = rmsFloat(stageIn, 0, HOP)
      if (rawRms > 0f || tseRms > 0f) {
        lastRawDbfs = rmsToDbfs(rawRms)
        lastTseDbfs = rmsToDbfs(tseRms)
      }
      if (rawRms > 0.012f && (lastVadProb >= SPEECH_PROB || (rawRms > 0.025f && tseRms < rawRms * 0.5f))) {
        val hopAtten = (20.0 * log10(maxOf(tseRms.toDouble(), 1e-5) / maxOf(rawRms.toDouble(), 1e-5))).toFloat()
        smoothedTseAttenDb = 0.78f * smoothedTseAttenDb + 0.22f * hopAtten
      }
      lastTseAttenDb = smoothedTseAttenDb
    } else {
      smoothedTseAttenDb = 0f
      lastTseAttenDb = 0f
    }

    // Stage 4: Update residual suppression gate BEFORE vocal enhancement so unverified or
    // confirmed non-owner frames are never boosted by the presence enhancer.
    updateResidualGate(usedTse)

    // Stage 5: Owner-gated VocalEnhancer.
    if (enhancer != null) {
      val speechActive = if (svEnabled || tseEnabled) lastVadProb >= SPEECH_PROB else true
      val allowBoost = speechActive && allowVocalBoost()
      enhancer.process(stageIn, enhBuf, HOP, allowBoost = allowBoost)
    } else {
      System.arraycopy(stageIn, 0, enhBuf, 0, HOP)
    }
    lastEnhDbfs = rmsToDbfs(rmsFloat(enhBuf, 0, HOP))

    // Stage 6: Smooth 16 ms raised-cosine residual gate + per-sample onset attenuation.
    applyResidualGate(enhBuf, 0, HOP, usedTse)

    if (speaking) {
      voicedOutHops++
      if (lastResidualGain < 0.15f) gatedOutHops++
    }

    sendHop(enhBuf)
  }

  internal fun updateResidualGate(usedTse: Boolean) {
    if (!svEnabled) {
      suppressingResidual = false
      gateReleaseHold = 0
      return
    }
    if (!speaking || !svConfirmedNonOwner) {
      suppressingResidual = false
      gateReleaseHold = 0
      return
    }
    if (usedTse) {
      // Decouple the old `-9.0 dB` AND deadlock:
      // SV now scores the TSE-separated target stream, so confirmed non-owner closes
      // the residual gate on moderate TSE attenuation (`< -2.5 dB`) OR a clear low-cosine
      // / consecutive non-owner SV verdict, while keeping hysteresis + release hold to
      // avoid chatter and a dual-talk safety margin for single borderline scores when
      // TSE is not attenuating.
      val strongSvReject = hasStrongNonOwnerMargin(usedTse = true)
      if (suppressingResidual) {
        val wantOpen = !strongSvReject && smoothedTseAttenDb >= TSE_GATE_OPEN_DB
        if (wantOpen) {
          gateReleaseHold++
          if (gateReleaseHold >= GATE_RELEASE_HOLD_FRAMES) {
            suppressingResidual = false
            gateReleaseHold = 0
          }
        } else {
          gateReleaseHold = 0
        }
      } else if (strongSvReject || smoothedTseAttenDb < TSE_GATE_CLOSE_DB) {
        suppressingResidual = true
        gateReleaseHold = 0
      }
    } else {
      suppressingResidual = true
      gateReleaseHold = 0
    }
  }

  private fun applyResidualGate(buf: FloatArray, off: Int, len: Int, usedTse: Boolean) {
    val targetOnset = targetOnsetGain(usedTse)
    val onsetActive = abs(onsetGain - 1.0f) > 1e-4f || abs(targetOnset - 1.0f) > 1e-4f
    if (!suppressingResidual && gatePhase >= RAMP_SAMPLES && !onsetActive) {
      onsetGain = 1.0f
      lastResidualGain = 1.0f
      return
    }
    val attackStep = 1.0f / ONSET_ATTACK_SAMPLES
    val releaseStep = 1.0f / ONSET_RELEASE_SAMPLES
    var residualGain = lastResidualGain
    for (i in 0 until len) {
      if (suppressingResidual) {
        if (gatePhase > 0) gatePhase--
      } else if (gatePhase < RAMP_SAMPLES) {
        gatePhase++
      }
      residualGain = when {
        gatePhase >= RAMP_SAMPLES -> 1.0f
        gatePhase == 0 -> 0.0f
        else -> (0.5 - 0.5 * cos(PI * gatePhase / RAMP_SAMPLES)).toFloat()
      }
      if (onsetGain < targetOnset) {
        onsetGain = minOf(onsetGain + attackStep, targetOnset)
      } else if (onsetGain > targetOnset) {
        onsetGain = maxOf(onsetGain - releaseStep, targetOnset)
      }
      buf[off + i] *= residualGain * onsetGain
    }
    lastResidualGain = residualGain
  }

  private fun onCleanVadWindow() {
    vadBoost!!.prepare(cleanWin512, vadProbe512)
    val p = backend.vadProb(vadProbe512, 0)
    lastVadProb = p
    vadWindowsTotal++
    val isVoiced = p >= SPEECH_PROB
    if (isVoiced) {
      vadSpeechWindows++
      appendCleanVoiced(cleanWin512)
    }

    var justEnded = false
    if (!speaking) {
      startRun = if (p >= START_PROB) startRun + 1 else 0
      if (startRun >= START_WINDOWS) {
        speaking = true
        silRun = 0
        uttVoicedW = if (isVoiced) 1 else 0
        sinceCheckW = 0
        earlyChecked = false
        fullChecked = false
        gateReleaseHold = 0
        resetUtteranceSv()
      }
    } else if (isVoiced) {
      silRun = 0
      uttVoicedW++
      sinceCheckW++
    } else {
      silRun++
      if (silRun >= END_WINDOWS) {
        speaking = false
        startRun = 0
        justEnded = true
      }
    }

    if (!svEnabled) {
      if (justEnded) {
        cleanVoicedLen = 0
        smoothedTseAttenDb = 0f
        lastTseAttenDb = 0f
      }
      return
    }

    if (speaking && svJobId == 0) {
      if (!earlyChecked && uttVoicedW >= EARLY_VOICED_W) {
        earlyChecked = true
        launchSvCheck("early", EARLY_WINDOW_SAMPLES)
      } else if (!fullChecked && uttVoicedW >= FULL_VOICED_W) {
        fullChecked = true
        launchSvCheck("full", RECHECK_WINDOW_SAMPLES)
      } else if (fullChecked && sinceCheckW >= RECHECK_STEP_W) {
        launchSvCheck("recheck", RECHECK_WINDOW_SAMPLES)
      }
    } else if (justEnded) {
      if (svJobId == 0 && !fullChecked && uttVoicedW >= MIN_END_VOICED_W) {
        launchSvCheck("end", RECHECK_WINDOW_SAMPLES)
      }
      suppressingResidual = false
      gateReleaseHold = 0
      smoothedTseAttenDb = 0f
      lastTseAttenDb = 0f
      resetUtteranceSv()
      cleanVoicedLen = 0
      uttVoicedW = 0
      sinceCheckW = 0
      earlyChecked = false
      fullChecked = false
    }
  }

  private fun appendCleanVoiced(win: FloatArray) {
    if (cleanVoicedLen + Vad.WINDOW > CLEAN_RING_CAP) {
      val drop = cleanVoicedLen + Vad.WINDOW - CLEAN_RING_CAP
      System.arraycopy(cleanVoicedRing, drop, cleanVoicedRing, 0, cleanVoicedLen - drop)
      cleanVoicedLen -= drop
    }
    System.arraycopy(win, 0, cleanVoicedRing, cleanVoicedLen, Vad.WINDOW)
    cleanVoicedLen += Vad.WINDOW
  }

  private fun launchSvCheck(kind: String, maxSamples: Int) {
    if (!svEnabled) return
    val enrolled = enrolledNorm
    val lockFirst = o.lockFirstSpeaker && enrolled == null
    if (enrolled == null && !lockFirst) return
    val sampleCount = minOf(cleanVoicedLen, maxSamples)
    if (sampleCount < MIN_SV_SAMPLES) return
    val slice = FloatArray(sampleCount)
    System.arraycopy(cleanVoicedRing, cleanVoicedLen - sampleCount, slice, 0, sampleCount)
    val id = ++svJobSeq
    svJobId = id
    sinceCheckW = 0
    val gen = resetGen
    val keepForSample = captureOwnerBuf != null && !ownerSampleDelivered
    val sessMissing = sessionEmb == null
    worker(Runnable {
      val t0 = System.nanoTime()
      var norm: FloatArray? = null
      try {
        val raw = backend.embed(slice, 0, slice.size)
        norm = normalizeEmbedding(raw)
      } catch (_: Throwable) {
      }
      val ms = (System.nanoTime() - t0) / 1_000_000
      svResults.add(
        SvResult(
          gen = gen,
          job = id,
          kind = kind,
          embNorm = norm,
          cleanAudio = if (keepForSample && (enrolled != null || sessMissing)) slice else null,
          usedSamples = sampleCount,
          ms = ms,
        ),
      )
    })
  }

  private fun drainSvResults() {
    while (true) {
      val r = svResults.poll() ?: break
      if (r.gen != resetGen) continue
      if (r.job == svJobId) svJobId = 0
      val embNorm = r.embNorm ?: continue
      applySvEmbedding(
        rawEmb = embNorm,
        usedSamples = r.usedSamples,
        kind = r.kind,
        usedTse = isTseActive,
        cleanAudio = r.cleanAudio,
        ms = r.ms,
      )
    }
  }

  internal fun applySvEmbedding(
    rawEmb: FloatArray,
    usedSamples: Int,
    kind: String = "early",
    usedTse: Boolean = isTseActive,
    cleanAudio: FloatArray? = null,
    ms: Long = 0L,
  ) {
    val embNorm = normalizeEmbedding(rawEmb)
    if (embNorm.isEmpty()) return
    checks++
    checkMsSum += ms
    if (ms > checkMsMax) checkMsMax = ms

    val effTh = effectiveThreshold(usedTse)
    val req = if (kind == "end") maxOf(0.24f, effTh - 0.03f) else maxOf(0.24f, effTh - 0.01f)
    val enrolled = enrolledNorm
    val firstLockMode = enrolled == null && o.lockFirstSpeaker

    val sv: SvScore
    val effectiveScore: Float
    var pass: Boolean

    if (enrolled != null) {
      sv = scoreVoiceprint(embNorm, enrolled, prototypesNorm, sessionEmb, effTh)
      effectiveScore = sv.effective
      pass = effectiveScore >= req
    } else if (firstLockMode) {
      val cur = sessionEmb
      if (cur == null) {
        sv = SvScore(1f, 1f, 1f, 1f, 1f)
        effectiveScore = 1f
        pass = true
      } else {
        val sc = cosine(embNorm, cur)
        sv = SvScore(rawMean = sc, maxProto = sc, combined = sc, sessionCos = sc, effective = sc)
        effectiveScore = sc
        pass = effectiveScore >= req
      }
      if (sessionEmb == null && (usedSamples >= SESS_MIN_SAMPLES || kind == "end")) {
        sessionEmb = embNorm
        pass = true
      }
    } else {
      return
    }

    lastSvScore = effectiveScore

    if (pass) {
      passed++
      svConfirmedNonOwner = false
      nonOwnerStreak = 0
      if (speaking) svConfirmedOwner = true
      // Safe session adaptation on clean, non-overlapping high-confidence owner speech.
      val cleanNonOverlap = !usedTse || smoothedTseAttenDb >= -6.0f
      if (!firstLockMode && cleanNonOverlap && usedSamples >= SESS_MIN_SAMPLES && sv.combined >= maxOf(o.threshold + 0.08f, 0.46f)) {
        val cur = sessionEmb
        sessionEmb = if (cur == null) {
          embNorm
        } else {
          normalizeEmbedding(FloatArray(cur.size) { 0.80f * cur[it] + 0.20f * embNorm[it] })
        }
      } else if (firstLockMode && cleanNonOverlap && usedSamples >= SESS_MIN_SAMPLES && sessionEmb != null && effectiveScore >= maxOf(o.threshold + 0.08f, 0.46f)) {
        val cur = sessionEmb!!
        sessionEmb = normalizeEmbedding(FloatArray(cur.size) { 0.80f * cur[it] + 0.20f * embNorm[it] })
      }
      // Backfill missing `owner_sample.pcm` once >= 3.0s of high-confidence clean speech is verified.
      val capBuf = captureOwnerBuf
      if (capBuf != null && !ownerSampleDelivered && cleanAudio != null && sv.combined >= o.threshold + 0.10f) {
        val copyN = minOf(cleanAudio.size, capBuf.size - captureOwnerLen)
        if (copyN > 0) {
          System.arraycopy(cleanAudio, cleanAudio.size - copyN, capBuf, captureOwnerLen, copyN)
          captureOwnerLen += copyN
        }
        if (captureOwnerLen >= capBuf.size) {
          ownerSampleDelivered = true
          onOwnerSampleCaptured(capBuf.copyOf())
        }
      }
    } else {
      blocked++
      if (speaking) {
        svConfirmedNonOwner = true
        svConfirmedOwner = false
        nonOwnerStreak++
      }
    }

    onUtterance(
      UtteranceTelemetry(
        kind = kind,
        pass = pass,
        svScore = effectiveScore,
        svRaw = sv.rawMean,
        svProto = sv.maxProto,
        svSess = sv.sessionCos,
        svMs = ms,
        usedMs = usedSamples * 1000L / VOICE_RATE,
        vadProb = lastVadProb,
        rawDbfs = lastRawDbfs,
        tseDbfs = lastTseDbfs,
        enhDbfs = lastEnhDbfs,
        tseAttenDb = lastTseAttenDb,
        enhGainDb = enhancer?.lastGainDb ?: 0f,
      ),
    )
  }

  private fun suspendTse(action: String, ms: Double, retry: Boolean) {
    if (tseBypassed) return
    tseOverruns++
    tseBypassed = true
    tseGen++
    tseNeedsReset = true
    voxStreamer.reset()
    primeTsePrebuffer()
    smoothedTseAttenDb = 0f
    lastTseAttenDb = 0f
    if (retry && o.requireIsolation && !tseRetried) tseRetryAtHop = hopsIn + TSE_RETRY_DELAY_HOPS
    onOverload(action, ms)
  }

  private fun maybeRetryTse() {
    if (tseRetryAtHop == 0L || hopsIn < tseRetryAtHop || tseJobInFlight) return
    tseRetryAtHop = 0L
    tseRetried = true
    tseK = VoxLockStreamer.FALLBACK_K
    slowTseStreak = 0
    tseBypassed = false
    // Do not replay buffered speech from before the failure.
    backend.reset()
    enhancer?.reset()
    suppressingResidual = false
    gateReleaseHold = 0
    gatePhase = RAMP_SAMPLES
    lastResidualGain = 1.0f
    onsetGain = 1.0f
    smoothedTseAttenDb = 0f
    lastTseAttenDb = 0f
    primeTsePrebuffer()
    onOverload("retry_k8", 0.0)
  }

  private fun dispatchTseIfReady() {
    while (!tseBypassed && !tseJobInFlight && voxStreamer.canStep(tseK)) {
      val kRun = tseK
      val wavLen = kRun * VoxLockStreamer.HOP + VoxLockStreamer.OVERLAP
      val wavCopy = FloatArray(wavLen)
      val prep = voxStreamer.prepareWav(kRun, wavCopy)
      val gen = tseGen
      val resetState = tseNeedsReset
      tseNeedsReset = false
      tseJobInFlight = true
      try {
        tseWorker(Runnable {
          val framesOut = FloatArray(kRun * VoxLockStreamer.N_FFT)
          val t0 = System.nanoTime()
          try {
            if (resetState) backend.resetTse()
            backend.tseChunk(wavCopy, prep.wavLen, kRun, framesOut)
            val ms = (System.nanoTime() - t0) / 1_000_000.0
            tseResults.add(TseRawResult(gen = gen, kFrames = kRun, frames = framesOut, ms = ms))
          } catch (_: Throwable) {
            val ms = (System.nanoTime() - t0) / 1_000_000.0
            tseResults.add(TseRawResult(gen = gen, kFrames = kRun, frames = FloatArray(0), ms = ms))
          } finally {
            tseJobInFlight = false
          }
        })
      } catch (_: Throwable) {
        tseJobInFlight = false
        suspendTse("bypass_dispatch", 0.0, retry = false)
        break
      }
      // If `tseWorker` executed inline (deterministic tests), drain right away so multiple steps in one push succeed.
      if (!tseJobInFlight) drainTseResults()
    }
  }

  private fun drainTseResults() {
    while (true) {
      val r = tseResults.poll() ?: break
      if (r.gen != tseGen) continue
      if (r.frames.isEmpty()) {
        suspendTse("bypass_error", r.ms, retry = false)
        continue
      }
      val count = voxStreamer.completeStep(r.frames, r.kFrames, tseSynthScratch)
      appendTseOut(tseSynthScratch, count)
      transferPendingPreToTsePre(count)
      val audioMs = r.kFrames * VoxLockStreamer.HOP * 1000.0 / VOICE_RATE
      tseChunks++
      tseMsSum += r.ms
      if (r.ms > tseMsMax) tseMsMax = r.ms
      tseAudioMsSum += audioMs

      val budget = if (r.kFrames <= VoxLockStreamer.DEFAULT_K) TSE_K5_BUDGET_MS else TSE_K8_BUDGET_MS
      if (r.ms > 150.0) {
        suspendTse("bypass_tse", r.ms, retry = false)
      } else if (r.ms > budget) {
        slowTseStreak++
        if (slowTseStreak >= 3) {
          slowTseStreak = 0
          if (tseK == VoxLockStreamer.DEFAULT_K) {
            tseOverruns++
            tseK = VoxLockStreamer.FALLBACK_K
            onOverload("step_k8", r.ms)
          } else {
            suspendTse("bypass_tse", r.ms, retry = true)
          }
        }
      } else {
        slowTseStreak = 0
      }
    }
  }

  private fun sendHop(samples: FloatArray) {
    hopsOut++
    val need = outLen + HOP * 2
    if (need > out.size) out = out.copyOf(maxOf(need, out.size * 2))
    floatToPcm16(samples, 0, HOP, out, outLen)
    outLen = need
  }

  private fun flushOut() {
    var i = 0
    while (i < outLen) {
      val n = minOf(SEND_MAX, outLen - i)
      emit(out, i, n)
      i += n
    }
    outLen = 0
  }

  override fun close() {
    backend.close()
  }
}
