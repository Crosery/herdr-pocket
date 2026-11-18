package dev.crosery.pocket.voice

import java.util.concurrent.ConcurrentLinkedQueue

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
 * Streaming call voice pipeline:
 * 1. `HighPass64` cleans DC/wind rumble once at input.
 * 2. Parallel clean HPF path feeds `Silero VAD v4` + `ERes2NetV2-zh` multi-prototype SV (never denoised/TSE audio).
 * 3. VoxLock emits the enrolled speaker's estimated waveform, not the verified input mixture.
 * 4. DPDFNet can clean the extracted waveform; do not boost quiet residual voices in owner-only mode.
 * 5. On extraction failure, owner-only mode emits silence at the same cadence instead of the mixture.
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
      needVad = (o.enrolled != null && m.speaker != null) || (o.ownerSample != null && m.hasTse),
      needSpeaker = o.enrolled != null && m.speaker != null,
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
    val sv: SvScore,
    val embNorm: FloatArray?,
    val cleanAudio: FloatArray?,
    val usedSamples: Int,
    val ms: Long,
  )

  private class TseRawResult(
    val gen: Int,
    val kFrames: Int,
    val frames: FloatArray,
    val rawRms: Float,
    val ms: Double,
  )

  companion object {
    const val HOP = Denoiser.HOP // 160 samples = 10 ms
    private const val START_PROB = 0.45f
    private const val SPEECH_PROB = 0.35f
    private const val START_WINDOWS = 2 // 64 ms
    private const val END_WINDOWS = 14 // 448 ms
    private const val EARLY_SPEECH_SAMPLES = 7_680 // 480 ms
    private const val RECHECK_STEP_SAMPLES = 7_680 // 480 ms
    private const val SHORT_END_MIN_SAMPLES = 4_096 // 256 ms
    private const val EARLY_WINDOW_SAMPLES = 12_800 // 800 ms
    private const val RECHECK_WINDOW_SAMPLES = 20_480 // 1280 ms
    private const val CLEAN_RING_CAP = 32_000 // 2.0 s
    private const val SESS_MIN_SAMPLES = 14_400 // 900 ms
    // Capture delivers 20 ms packets. Budget for the first full chunk and its inference before playout.
    private const val TSE_PREBUFFER_HOPS = 11
    private const val TSE_RECOVERY_PREBUFFER_HOPS = 15
    private const val TSE_RETRY_DELAY_HOPS = 8
    private const val TSE_K5_BUDGET_MS = 38.0
    private const val TSE_K8_BUDGET_MS = 60.0
    private const val TSE_MAX_BACKLOG_SAMPLES = 3_840 // 240 ms
    private const val TSE_NON_OWNER_ATTEN_DB = -9.0f
    private const val SEND_MAX = 3200
  }

  private val svEnabled = o.enrolled != null && backend.hasSpeaker
  private val tseEnabled = backend.hasTse
  private val enrolledNorm = o.enrolled?.let { normalizeEmbedding(it) }
  private val prototypesNorm = o.prototypes?.map { normalizeEmbedding(it) }

  private val hpf = if (o.denoise || svEnabled || tseEnabled) HighPass64() else null
  private val vadBoost = if (svEnabled || tseEnabled) QuietVadBoost() else null
  private val enhancer = if (o.denoise && !o.requireIsolation) VocalEnhancer() else null
  private val gainRamp = CosineRamp(rampSamples = 256) // 16 ms cosine ramp

  // Per-hop working buffers (single-threaded on mic thread).
  private val inBuf = FloatArray(HOP)
  private var inLen = 0
  private val hpfBuf = FloatArray(HOP)
  private val stageIn = FloatArray(HOP)
  private val denBuf = FloatArray(HOP)
  private val enhBuf = FloatArray(HOP)
  private val silentHop = FloatArray(HOP)

  // Clean HPF path for Silero VAD + ERes2NetV2-zh.
  private val cleanVadFifo = FloatArray(Vad.WINDOW + HOP * 2)
  private var cleanVadLen = 0
  private val cleanWin512 = FloatArray(Vad.WINDOW)
  private val vadProbe512 = FloatArray(Vad.WINDOW)
  private val cleanVoicedRing = FloatArray(CLEAN_RING_CAP)
  private var cleanVoicedLen = 0

  // VoxLock streaming rings & state (single-threaded on mic thread except ONNX run).
  private val voxStreamer = VoxLockStreamer()
  private val tseSynthScratch = FloatArray(VoxLockStreamer.MAX_K * VoxLockStreamer.HOP)
  private var tseOutRing = FloatArray(VOICE_RATE)
  private var tseOutRead = 0
  private var tseOutLen = 0
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

  // Utterance & SV state.
  private var resetGen = 0
  private var speaking = false
  private var startRun = 0
  private var silRun = 0
  private var uttVoicedSamples = 0
  private var sinceLastSvSamples = 0
  private var earlyChecked = false
  private var svJobSeq = 0
  private var svJobId = 0
  private var svConfirmedNonOwner = false
  private var sessionEmb: FloatArray? = null
  private val svResults = ConcurrentLinkedQueue<SvResult>()

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
    if (tseEnabled && !tseBypassed) {
      val hops = if (tseK == VoxLockStreamer.DEFAULT_K) TSE_PREBUFFER_HOPS else TSE_RECOVERY_PREBUFFER_HOPS
      appendTseOutZeros(hops * HOP)
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

  private fun popTseOut(dst: FloatArray) {
    val take = minOf(HOP, tseOutLen)
    if (take > 0) {
      System.arraycopy(tseOutRing, tseOutRead, dst, 0, take)
      tseOutRead += take
      tseOutLen -= take
      if (tseOutLen == 0) tseOutRead = 0
    }
    if (take < HOP) {
      dst.fill(0f, take, HOP)
    }
  }

  /** Resets streaming buffers after mute/unmute while keeping session adaptation and VoxLock enrollment. */
  fun reset() {
    resetGen++
    backend.reset()
    hpf?.reset()
    vadBoost?.reset()
    enhancer?.reset()
    gainRamp.reset(1f)
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
    uttVoicedSamples = 0
    sinceLastSvSamples = 0
    earlyChecked = false
    svJobId = 0
    svConfirmedNonOwner = false
    svResults.clear()
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

    // 1. Clean HPF stage.
    if (hpf != null) {
      hpf.process(inBuf, 0, hpfBuf, 0, HOP)
    } else {
      System.arraycopy(inBuf, 0, hpfBuf, 0, HOP)
    }

    // 2. Drain any completed SV verdicts before processing VAD/gating.
    drainSvResults()

    // 3. Clean HPF path -> Silero VAD + ERes2NetV2-zh (never denoised or TSE-processed).
    if (svEnabled || tseEnabled) {
      System.arraycopy(hpfBuf, 0, cleanVadFifo, cleanVadLen, HOP)
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

    // 4. Only the extractor can populate the owner-only uplink.
    maybeRetryTse()
    if (tseEnabled && !tseBypassed) {
      drainTseResults()
      if (!tseBypassed) {
        voxStreamer.pushInput(hpfBuf, 0, HOP)
        if (voxStreamer.bufferedInputSamples > TSE_MAX_BACKLOG_SAMPLES && tseJobInFlight) {
          suspendTse("bypass_backlog", voxStreamer.bufferedInputSamples * 1000.0 / VOICE_RATE, retry = true)
        }
        dispatchTseIfReady()
        drainTseResults()
      }
    }
    if (isTseActive) {
      popTseOut(stageIn)
    } else {
      lastRawDbfs = rmsToDbfs(rawHopRms)
      if (o.requireIsolation) {
        lastTseDbfs = -90f
        lastEnhDbfs = -90f
        lastTseAttenDb = attenDb(0f, rawHopRms)
        if (speaking) {
          voicedOutHops++
          gatedOutHops++
        }
        sendHop(silentHop)
        return
      }
      System.arraycopy(hpfBuf, 0, stageIn, 0, HOP)
      lastTseDbfs = lastRawDbfs
      lastTseAttenDb = 0f
    }

    // 5. Streaming Speech Enhancement (`DPDFNet-baseline`) + `VocalEnhancer`.
    if (o.denoise) {
      val t0 = System.nanoTime()
      backend.denoise(stageIn, 0, denBuf, 0)
      val ns = System.nanoTime() - t0
      denoiseNs += ns
      if (ns > denoiseMaxNs) denoiseMaxNs = ns
      if (enhancer != null) enhancer.process(denBuf, enhBuf, HOP)
      else System.arraycopy(denBuf, 0, enhBuf, 0, HOP)
    } else {
      System.arraycopy(stageIn, 0, enhBuf, 0, HOP)
    }
    lastEnhDbfs = rmsToDbfs(rmsFloat(enhBuf, 0, HOP))

    // 6. Smooth 16 ms cosine residual gate ONLY on confirmed solo non-owner speech.
    val muteResidual = if (svEnabled) {
      if (tseEnabled && !tseBypassed) {
        speaking && svConfirmedNonOwner && lastTseAttenDb < TSE_NON_OWNER_ATTEN_DB
      } else {
        speaking && svConfirmedNonOwner
      }
    } else {
      false
    }
    gainRamp.setTarget(if (muteResidual) 0f else 1f)
    gainRamp.applyInPlace(enhBuf, 0, HOP)

    if (speaking) {
      voicedOutHops++
      if (gainRamp.currentGain < 0.15f) gatedOutHops++
    }

    sendHop(enhBuf)
  }

  private fun onCleanVadWindow() {
    vadBoost!!.prepare(cleanWin512, vadProbe512)
    val p = backend.vadProb(vadProbe512, 0)
    lastVadProb = p
    vadWindowsTotal++
    if (p >= SPEECH_PROB) vadSpeechWindows++

    if (!speaking) {
      startRun = if (p >= START_PROB) startRun + 1 else 0
      if (startRun >= START_WINDOWS) {
        speaking = true
        silRun = 0
        uttVoicedSamples = 0
        sinceLastSvSamples = 0
        earlyChecked = false
        svConfirmedNonOwner = false
      }
    } else {
      silRun = if (p < SPEECH_PROB) silRun + 1 else 0
      if (silRun >= END_WINDOWS) {
        speaking = false
        startRun = 0
        svConfirmedNonOwner = false
        if (svEnabled && svJobId == 0 && !earlyChecked && uttVoicedSamples >= SHORT_END_MIN_SAMPLES) {
          launchSvCheck("end", minOf(cleanVoicedLen, uttVoicedSamples))
        }
        cleanVoicedLen = 0
        uttVoicedSamples = 0
        sinceLastSvSamples = 0
        earlyChecked = false
        return
      }
    }

    if (p >= SPEECH_PROB) {
      appendCleanVoiced(cleanWin512)
      uttVoicedSamples += Vad.WINDOW
      sinceLastSvSamples += Vad.WINDOW
      if (svEnabled && svJobId == 0) {
        if (!earlyChecked && uttVoicedSamples >= EARLY_SPEECH_SAMPLES) {
          earlyChecked = true
          launchSvCheck("early", minOf(cleanVoicedLen, EARLY_WINDOW_SAMPLES))
        } else if (earlyChecked && sinceLastSvSamples >= RECHECK_STEP_SAMPLES) {
          launchSvCheck("recheck", minOf(cleanVoicedLen, RECHECK_WINDOW_SAMPLES))
        }
      }
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

  private fun launchSvCheck(kind: String, sampleCount: Int) {
    val enrolled = enrolledNorm ?: return
    if (sampleCount <= 0 || cleanVoicedLen < sampleCount) return
    val slice = FloatArray(sampleCount)
    System.arraycopy(cleanVoicedRing, cleanVoicedLen - sampleCount, slice, 0, sampleCount)
    val id = ++svJobSeq
    svJobId = id
    sinceLastSvSamples = 0
    val gen = resetGen
    val protos = prototypesNorm
    val sess = sessionEmb
    val th = o.threshold
    val keepForSample = captureOwnerBuf != null && !ownerSampleDelivered
    worker(Runnable {
      val t0 = System.nanoTime()
      var sv = SvScore(-1f, -1f, -1f, -1f, -1f)
      var norm: FloatArray? = null
      try {
        val raw = backend.embed(slice, 0, slice.size)
        norm = normalizeEmbedding(raw)
        sv = scoreVoiceprint(norm, enrolled, protos, sess, th)
      } catch (_: Throwable) {
      }
      val ms = (System.nanoTime() - t0) / 1_000_000
      svResults.add(
        SvResult(
          gen = gen,
          job = id,
          kind = kind,
          sv = sv,
          embNorm = norm,
          cleanAudio = if (keepForSample) slice else null,
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
      if (r.embNorm == null) continue
      checks++
      checkMsSum += r.ms
      if (r.ms > checkMsMax) checkMsMax = r.ms

      val pass = r.sv.effective >= o.threshold
      if (pass) {
        passed++
        svConfirmedNonOwner = false
        // Safe session adaptation on clean, non-overlapping high-confidence owner speech.
        val cleanNonOverlap = !(tseEnabled && !tseBypassed && lastTseAttenDb < -5.0f)
        if (cleanNonOverlap && r.usedSamples >= SESS_MIN_SAMPLES && r.sv.combined >= maxOf(o.threshold + 0.08f, 0.46f)) {
          val cur = sessionEmb
          sessionEmb = if (cur == null) {
            r.embNorm
          } else {
            normalizeEmbedding(FloatArray(cur.size) { 0.80f * cur[it] + 0.20f * r.embNorm[it] })
          }
        }
        // Backfill missing `owner_sample.pcm` once >= 3.0s of high-confidence clean speech is verified.
        val capBuf = captureOwnerBuf
        if (capBuf != null && !ownerSampleDelivered && r.cleanAudio != null && r.sv.combined >= o.threshold + 0.10f) {
          val copyN = minOf(r.cleanAudio.size, capBuf.size - captureOwnerLen)
          if (copyN > 0) {
            System.arraycopy(r.cleanAudio, r.cleanAudio.size - copyN, capBuf, captureOwnerLen, copyN)
            captureOwnerLen += copyN
          }
          if (captureOwnerLen >= capBuf.size) {
            ownerSampleDelivered = true
            onOwnerSampleCaptured(capBuf.copyOf())
          }
        }
      } else {
        blocked++
        if (speaking) svConfirmedNonOwner = true
      }

      onUtterance(
        UtteranceTelemetry(
          kind = r.kind,
          pass = pass,
          svScore = r.sv.effective,
          svRaw = r.sv.rawMean,
          svProto = r.sv.maxProto,
          svSess = r.sv.sessionCos,
          svMs = r.ms,
          usedMs = r.usedSamples * 1000L / VOICE_RATE,
          vadProb = lastVadProb,
          rawDbfs = lastRawDbfs,
          tseDbfs = lastTseDbfs,
          enhDbfs = lastEnhDbfs,
          tseAttenDb = lastTseAttenDb,
          enhGainDb = enhancer?.lastGainDb ?: 0f,
        ),
      )
    }
  }

  private fun suspendTse(action: String, ms: Double, retry: Boolean) {
    if (tseBypassed) return
    tseOverruns++
    tseBypassed = true
    tseGen++
    tseNeedsReset = true
    voxStreamer.reset()
    primeTsePrebuffer()
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
    gainRamp.reset(1f)
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
            tseResults.add(TseRawResult(gen = gen, kFrames = kRun, frames = framesOut, rawRms = prep.rawRms, ms = ms))
          } catch (_: Throwable) {
            val ms = (System.nanoTime() - t0) / 1_000_000.0
            tseResults.add(TseRawResult(gen = gen, kFrames = kRun, frames = FloatArray(0), rawRms = prep.rawRms, ms = ms))
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
      val tseRms = rmsFloat(tseSynthScratch, 0, count)
      val audioMs = r.kFrames * VoxLockStreamer.HOP * 1000.0 / VOICE_RATE
      tseChunks++
      tseMsSum += r.ms
      if (r.ms > tseMsMax) tseMsMax = r.ms
      tseAudioMsSum += audioMs
      lastRawDbfs = rmsToDbfs(r.rawRms)
      lastTseDbfs = rmsToDbfs(tseRms)
      lastTseAttenDb = attenDb(tseRms, r.rawRms)

      val budget = if (r.kFrames <= VoxLockStreamer.DEFAULT_K) TSE_K5_BUDGET_MS else TSE_K8_BUDGET_MS
      if (r.ms > budget) {
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
