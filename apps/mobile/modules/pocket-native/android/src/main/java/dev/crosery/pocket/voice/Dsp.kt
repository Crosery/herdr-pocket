package dev.crosery.pocket.voice

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.sin

/** 16 kHz mono throughout. */
const val VOICE_RATE = 16_000

/** In-place iterative radix-2 complex FFT of size 512: the denoiser's STFT and the filterbank share it. */
internal object Fft512 {
  const val N = 512
  private val rev = IntArray(N)
  private val cosT = DoubleArray(N / 2)
  private val sinT = DoubleArray(N / 2)

  init {
    var j = 0
    for (i in 0 until N) {
      rev[i] = j
      var bit = N shr 1
      while ((j and bit) != 0) {
        j = j xor bit
        bit = bit shr 1
      }
      j = j or bit
    }
    for (i in 0 until N / 2) {
      cosT[i] = cos(2 * PI * i / N)
      sinT[i] = -sin(2 * PI * i / N)
    }
  }

  fun run(re: DoubleArray, im: DoubleArray) {
    for (i in 0 until N) {
      val j = rev[i]
      if (j > i) {
        var t = re[i]; re[i] = re[j]; re[j] = t
        t = im[i]; im[i] = im[j]; im[j] = t
      }
    }
    var size = 2
    while (size <= N) {
      val half = size shr 1
      val step = N / size
      var s = 0
      while (s < N) {
        for (k in 0 until half) {
          val wr = cosT[k * step]
          val wi = sinT[k * step]
          val a = s + k
          val b = a + half
          val xr = re[b] * wr - im[b] * wi
          val xi = re[b] * wi + im[b] * wr
          re[b] = re[a] - xr
          im[b] = im[a] - xi
          re[a] += xr
          im[a] += xi
        }
        s += size
      }
      size = size shl 1
    }
  }
}

/**
 * Kaldi-compatible log-mel filterbank, the speaker model's front end (as kaldi-native-fbank and
 * sherpa-onnx compute it): 25 ms frames every 10 ms, povey window, pre-emphasis 0.97, DC removed,
 * no dither, snip_edges false, power spectrum, 80 mel bins 20..7600 Hz, natural log.
 */
internal object Fbank {
  const val BINS = 80
  private const val FLEN = 400
  private const val SHIFT = 160
  private const val NFFT = 512
  private const val FLT_EPS = 1.1920928955078125e-7

  private val povey = DoubleArray(FLEN) { (0.5 - 0.5 * cos(2 * PI * it / (FLEN - 1))).pow(0.85) }
  private val bankFirst = IntArray(BINS)
  private val bankWeights = arrayOfNulls<DoubleArray>(BINS)

  private fun mel(f: Double) = 1127.0 * ln(1.0 + f / 700.0)

  init {
    val width = VOICE_RATE.toDouble() / NFFT
    val lo = mel(20.0)
    val hi = mel(VOICE_RATE / 2.0 - 400)
    val delta = (hi - lo) / (BINS + 1)
    for (b in 0 until BINS) {
      val l = lo + b * delta
      val c = lo + (b + 1) * delta
      val r = lo + (b + 2) * delta
      var first = -1
      val w = ArrayList<Double>()
      for (i in 0 until NFFT / 2) {
        val m = mel(width * i)
        if (m > l && m < r) {
          if (first < 0) first = i
          w.add(if (m <= c) (m - l) / (c - l) else (r - m) / (r - c))
        }
      }
      bankFirst[b] = first
      bankWeights[b] = w.toDoubleArray()
    }
  }

  /** Frames for `len` samples. */
  fun frames(len: Int) = (len + SHIFT / 2) / SHIFT

  /** [frames x 80] features of samples in [-1, 1], each bin's mean over the utterance subtracted. */
  fun compute(wave: FloatArray, off: Int, len: Int): FloatArray {
    val n = frames(len)
    val feats = FloatArray(n * BINS)
    val re = DoubleArray(NFFT)
    val im = DoubleArray(NFFT)
    val win = DoubleArray(FLEN)
    for (f in 0 until n) {
      val start = f * SHIFT + SHIFT / 2 - FLEN / 2
      var mean = 0.0
      for (i in 0 until FLEN) {
        var s = start + i
        // Reflect at both ends (snip_edges false).
        while (s < 0 || s >= len) s = if (s < 0) -s - 1 else 2 * len - 1 - s
        win[i] = wave[off + s].toDouble()
        mean += win[i]
      }
      mean /= FLEN
      for (i in 0 until FLEN) win[i] -= mean
      for (i in FLEN - 1 downTo 1) win[i] -= 0.97 * win[i - 1]
      win[0] -= 0.97 * win[0]
      for (i in 0 until FLEN) re[i] = win[i] * povey[i]
      re.fill(0.0, FLEN, NFFT)
      im.fill(0.0)
      Fft512.run(re, im)
      for (b in 0 until BINS) {
        val first = bankFirst[b]
        val w = bankWeights[b]!!
        var e = 0.0
        for (k in w.indices) {
          val i = first + k
          e += w[k] * (re[i] * re[i] + im[i] * im[i])
        }
        feats[f * BINS + b] = ln(max(e, FLT_EPS)).toFloat()
      }
    }
    if (n > 0) {
      for (b in 0 until BINS) {
        var m = 0.0
        for (f in 0 until n) m += feats[f * BINS + b]
        m /= n
        for (f in 0 until n) feats[f * BINS + b] = (feats[f * BINS + b] - m).toFloat()
      }
    }
    return feats
  }
}

fun cosine(a: FloatArray, b: FloatArray): Float {
  var d = 0.0
  var na = 0.0
  var nb = 0.0
  for (i in a.indices) {
    d += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return if (na == 0.0 || nb == 0.0) 0f else (d / kotlin.math.sqrt(na * nb)).toFloat()
}

/** Mean of L2-normalised embeddings (the enrolled voice). */
fun meanEmbedding(list: List<FloatArray>): FloatArray {
  val out = FloatArray(list[0].size)
  for (e in list) {
    var n = 0.0
    for (v in e) n += v * v
    val s = kotlin.math.sqrt(n)
    if (s == 0.0) continue
    for (i in e.indices) out[i] += (e[i] / s / list.size).toFloat()
  }
  return out
}

/** PCM16 little-endian to [-1, 1]. */
fun pcm16ToFloat(pcm: ByteArray, off: Int, bytes: Int, out: FloatArray, outOff: Int) {
  var i = 0
  while (i + 1 < bytes) {
    val s = ((pcm[off + i + 1].toInt() shl 8) or (pcm[off + i].toInt() and 0xFF)).toShort()
    out[outOff + i / 2] = s / 32768f
    i += 2
  }
}

/** [-1, 1] to PCM16 little-endian, clipped. */
fun floatToPcm16(x: FloatArray, off: Int, n: Int, out: ByteArray, outOff: Int) {
  for (i in 0 until n) {
    val v = Math.round(x[off + i] * 32768f).coerceIn(-32768, 32767)
    out[outOff + 2 * i] = (v and 0xFF).toByte()
    out[outOff + 2 * i + 1] = ((v shr 8) and 0xFF).toByte()
  }
}
