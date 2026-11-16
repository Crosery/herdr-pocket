package dev.crosery.pocket.voice

/**
 * Collects a person's speech for a voiceprint: denoised the way calls are, only what the VAD calls
 * speech. [voiceprint] averages the embeddings of 1.5 s pieces (enrolment); [embedAll] embeds what was
 * said as one piece (the "try it" check).
 */
class SpeechCollector(private val m: VoiceModels) {
  companion object {
    private const val KEEP_PROB = 0.35f
    private const val PIECE = VOICE_RATE * 3 / 2
    private const val PIECE_HOP = VOICE_RATE * 3 / 4
  }

  class Voiceprint(
    val embedding: FloatArray,
    /** Seconds of speech it was made from. */
    val seconds: Float,
    /** How alike its pieces are (mean and lowest cosine to the average): low means noise or several voices. */
    val consistency: Float,
    val lowest: Float,
  )

  private val denoiser = Denoiser(m)
  private val vad = Vad(m)
  private val inBuf = FloatArray(Denoiser.HOP)
  private var inLen = 0
  private val win = FloatArray(Vad.WINDOW)
  private var winLen = 0
  private var speech = FloatArray(VOICE_RATE * 30)
  private var speechLen = 0

  /** Level of the last window, 0..1, for a meter. */
  @Volatile var level = 0f
    private set

  val seconds: Float get() = speechLen.toFloat() / VOICE_RATE

  fun push(pcm: ByteArray, off: Int, bytes: Int) {
    var i = 0
    while (i < bytes) {
      val n = minOf((bytes - i) / 2, Denoiser.HOP - inLen)
      pcm16ToFloat(pcm, off + i, n * 2, inBuf, inLen)
      inLen += n
      i += n * 2
      if (inLen < Denoiser.HOP) continue
      inLen = 0
      if (!denoiser.hop(inBuf, 0, win, winLen)) continue
      winLen += Denoiser.HOP
      if (winLen < Vad.WINDOW) continue
      winLen = 0
      var e = 0.0
      for (v in win) e += v * v
      level = minOf(1f, (kotlin.math.sqrt(e / Vad.WINDOW) * 4).toFloat())
      if (vad.prob(win, 0) < KEEP_PROB) continue
      if (speechLen + Vad.WINDOW > speech.size) speech = speech.copyOf(speech.size * 2)
      System.arraycopy(win, 0, speech, speechLen, Vad.WINDOW)
      speechLen += Vad.WINDOW
    }
  }

  /** Enrolment: null when there is less than `minSeconds` of speech. */
  fun voiceprint(minSeconds: Float): Voiceprint? {
    if (seconds < minSeconds) return null
    val sp = Speaker(m)
    val pieces = ArrayList<FloatArray>()
    var s = 0
    while (s + PIECE <= speechLen) {
      pieces.add(sp.embed(speech, s, PIECE))
      s += PIECE_HOP
    }
    if (pieces.isEmpty()) pieces.add(sp.embed(speech, 0, speechLen))
    val mean = meanEmbedding(pieces)
    val scores = pieces.map { cosine(it, mean) }
    return Voiceprint(mean, seconds, scores.average().toFloat(), scores.min())
  }

  /** The last `maxSeconds` of speech as one embedding; null when there is less than `minSeconds`. */
  fun embedAll(minSeconds: Float, maxSeconds: Float): FloatArray? {
    if (seconds < minSeconds) return null
    val n = minOf(speechLen, (maxSeconds * VOICE_RATE).toInt())
    return Speaker(m).embed(speech, speechLen - n, n)
  }
}
