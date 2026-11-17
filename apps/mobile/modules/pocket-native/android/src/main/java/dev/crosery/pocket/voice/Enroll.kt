package dev.crosery.pocket.voice

import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.sqrt

/**
 * Collects clean HPF-filtered speech (`HighPass64` ONLY — never denoised/TSE audio, preserving full
 * speaker formant detail for ERes2NetV2-zh and VoxLock v2).
 *
 * [voiceprint] extracts up to 6 diverse L2-normalized 1.5 s prototypes + outlier-filtered L2 mean,
 * plus the cleanest/loudest 3.0 s (`48_000` samples) unclipped HPF speech reference for VoxLock TSE.
 */
class SpeechCollector internal constructor(
  private val embedder: (FloatArray, Int, Int) -> FloatArray,
  private val vadFn: (FloatArray, Int) -> Float,
) {
  constructor(m: VoiceModels) : this(
    embedder = spkClosure(m),
    vadFn = vadClosure(m),
  )

  companion object {
    private fun spkClosure(m: VoiceModels): (FloatArray, Int, Int) -> FloatArray {
      val sp = Speaker(m)
      return { x, off, len -> sp.embed(x, off, len) }
    }

    private fun vadClosure(m: VoiceModels): (FloatArray, Int) -> Float {
      val vad = Vad(m)
      return { w, off -> vad.prob(w, off) }
    }
    private const val KEEP_PROB = 0.42f
    private const val NOISE_PROB_MAX = 0.22f
    private const val PIECE = VOICE_RATE * 3 / 2 // 24_000 samples (1.5 s)
    private const val PIECE_HOP = VOICE_RATE * 3 / 4 // 12_000 samples (0.75 s)
    private const val OWNER_SAMPLE_LEN = VoiceModelManager.OWNER_SAMPLE_SAMPLES // 48_000 samples (3.0 s)
    private const val SAMPLE_STRIDE = VOICE_RATE / 4 // 4_000 samples (0.25 s)
    private const val MAX_PROTOTYPES = 6

    /**
     * Picks the loudest, cleanest (unclipped) 3.0 s (`48_000` samples) contiguous HPF speech window
     * for `voxlock_enroll.onnx`. Tiles cleanly if `len < 48_000` (e.g. in synthetic short tests).
     */
    internal fun selectCleanestOwnerSample(buf: FloatArray, len: Int): FloatArray {
      val out = FloatArray(OWNER_SAMPLE_LEN)
      if (len <= 0) return out
      if (len <= OWNER_SAMPLE_LEN) {
        for (i in 0 until OWNER_SAMPLE_LEN) out[i] = buf[i % len]
        return out
      }
      var bestStart = 0
      var bestQuality = -1.0
      var off = 0
      while (off + OWNER_SAMPLE_LEN <= len) {
        var sumSq = 0.0
        var clipped = 0
        for (i in 0 until OWNER_SAMPLE_LEN) {
          val v = buf[off + i]
          sumSq += v * v
          if (abs(v) >= 0.985f) clipped++
        }
        val rms = sqrt(sumSq / OWNER_SAMPLE_LEN)
        val clipPenalty = 1.0 / (1.0 + clipped * 0.05)
        val quality = rms * clipPenalty
        if (quality > bestQuality) {
          bestQuality = quality
          bestStart = off
        }
        if (off + OWNER_SAMPLE_LEN == len) break
        off = minOf(off + SAMPLE_STRIDE, len - OWNER_SAMPLE_LEN)
      }
      System.arraycopy(buf, bestStart, out, 0, OWNER_SAMPLE_LEN)
      return out
    }
  }

  class Voiceprint(
    val embedding: FloatArray,
    val prototypes: List<FloatArray>,
    val ownerSample: FloatArray,
    val snrDb: Float,
    /** Seconds of voiced speech collected. */
    val seconds: Float,
    /** Mean and lowest cosine of kept 1.5 s pieces to the clean centroid. */
    val consistency: Float,
    val lowest: Float,
  )

  private val hpf = HighPass64()
  private val vadBoost = QuietVadBoost()
  private val win = FloatArray(Vad.WINDOW)
  private val hpfWin = FloatArray(Vad.WINDOW)
  private val vadWin = FloatArray(Vad.WINDOW)
  private var winLen = 0
  private var speech = FloatArray(VOICE_RATE * 30)
  private var speechLen = 0

  private var speechSqSum = 0.0
  private var speechSamplesCount = 0L
  private var bgNoiseRms = 0.002f
  private var bgFrames = 0

  /** Level of the last window, 0..1, for a meter. */
  @Volatile var level = 0f
    private set

  val seconds: Float get() = speechLen.toFloat() / VOICE_RATE

  fun push(pcm: ByteArray, off: Int, bytes: Int) {
    var i = 0
    while (i < bytes) {
      val n = minOf((bytes - i) / 2, Vad.WINDOW - winLen)
      if (n <= 0) break
      pcm16ToFloat(pcm, off + i, n * 2, win, winLen)
      winLen += n
      i += n * 2
      if (winLen < Vad.WINDOW) continue
      winLen = 0
      hpf.process(win, 0, hpfWin, 0, Vad.WINDOW)
      var e = 0.0
      for (v in hpfWin) e += v * v
      val rms = sqrt(e / Vad.WINDOW).toFloat()
      level = minOf(1f, rms * 4f)
      vadBoost.prepare(hpfWin, vadWin)
      val prob = vadFn(vadWin, 0)
      if (prob <= NOISE_PROB_MAX) {
        bgNoiseRms = if (bgFrames == 0) rms.coerceIn(0.0003f, 0.03f)
        else (0.85f * bgNoiseRms + 0.15f * rms).coerceIn(0.0003f, 0.03f)
        bgFrames++
        continue
      }
      if (prob < KEEP_PROB) continue
      speechSqSum += e
      speechSamplesCount += Vad.WINDOW
      if (speechLen + Vad.WINDOW > speech.size) speech = speech.copyOf(speech.size * 2)
      System.arraycopy(hpfWin, 0, speech, speechLen, Vad.WINDOW)
      speechLen += Vad.WINDOW
    }
  }

  /** Enrolment: null when there is less than `minSeconds` of clean voiced speech. */
  fun voiceprint(minSeconds: Float): Voiceprint? {
    if (seconds < minSeconds || speechLen <= 0) return null
    val pieces = ArrayList<FloatArray>()
    var s = 0
    while (s + PIECE <= speechLen) {
      pieces.add(normalizeEmbedding(embedder(speech, s, PIECE)))
      s += PIECE_HOP
    }
    if (pieces.isEmpty()) {
      pieces.add(normalizeEmbedding(embedder(speech, 0, speechLen)))
    }
    var kept: List<FloatArray> = pieces
    var mean = meanEmbedding(kept)
    var scores = kept.map { cosine(it, mean) }
    if (pieces.size >= 4) {
      val sorted = scores.sorted()
      val median = sorted[sorted.size / 2]
      val floor = maxOf(0.35f, median - 0.22f)
      val filtered = pieces.indices.filter { scores[it] >= floor }.map { pieces[it] }
      if (filtered.size >= 3 && filtered.size < pieces.size) {
        kept = filtered
        mean = meanEmbedding(kept)
        scores = kept.map { cosine(it, mean) }
      }
    }
    val protos = selectDiversePrototypes(kept, mean, MAX_PROTOTYPES)
    val bestSample = selectCleanestOwnerSample(speech, speechLen)
    val speechRms = if (speechSamplesCount > 0) sqrt(speechSqSum / speechSamplesCount).toFloat() else 0.02f
    val noiseFloor = if (bgFrames > 0) bgNoiseRms else vadBoost.estimatedNoiseRms
    val snrDb = (20.0 * log10(maxOf(speechRms.toDouble(), 1e-5) / maxOf(noiseFloor.toDouble(), 1e-5)))
      .coerceIn(0.0, 55.0)
      .toFloat()

    return Voiceprint(
      embedding = mean,
      prototypes = protos,
      ownerSample = bestSample,
      snrDb = snrDb,
      seconds = seconds,
      consistency = scores.average().toFloat(),
      lowest = scores.min(),
    )
  }

  /** The last `maxSeconds` of clean HPF speech as one embedding; null when less than `minSeconds`. */
  fun embedAll(minSeconds: Float, maxSeconds: Float): FloatArray? {
    if (seconds < minSeconds) return null
    val n = minOf(speechLen, (maxSeconds * VOICE_RATE).toInt())
    return embedder(speech, speechLen - n, n)
  }
}
