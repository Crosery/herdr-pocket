package dev.crosery.pocket.voice

import java.nio.FloatBuffer
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tanh

/** 16 kHz mono throughout. */
const val VOICE_RATE = 16_000

/** In-place iterative radix-2 complex FFT of size 512: Kaldi Fbank front end uses it. */
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
 * Zero-allocation mixed-radix (5 * 64) 320-point complex and real DFT/IDFT for 16 kHz DPDFNet
 * (20 ms window = 320 samples, 10 ms hop = 160 samples, 161 complex frequency bins).
 */
internal object Fft320 {
  const val N = 320
  const val BINS = 161
  private const val N2 = 64

  private val rev64 = IntArray(N2)
  private val cos64 = DoubleArray(N2 / 2)
  private val sin64 = DoubleArray(N2 / 2)
  private val twRe = Array(5) { DoubleArray(N2) }
  private val twIm = Array(5) { DoubleArray(N2) }

  private val C1 = cos(2.0 * PI / 5.0)
  private val S1 = sin(2.0 * PI / 5.0)
  private val C2 = cos(4.0 * PI / 5.0)
  private val S2 = sin(4.0 * PI / 5.0)

  class Workspace {
    val uRe = Array(5) { DoubleArray(N2) }
    val uIm = Array(5) { DoubleArray(N2) }
    val re = DoubleArray(N)
    val im = DoubleArray(N)
  }

  init {
    var j = 0
    for (i in 0 until N2) {
      rev64[i] = j
      var bit = N2 shr 1
      while ((j and bit) != 0) {
        j = j xor bit
        bit = bit shr 1
      }
      j = j or bit
    }
    for (i in 0 until N2 / 2) {
      cos64[i] = cos(2.0 * PI * i / N2)
      sin64[i] = -sin(2.0 * PI * i / N2)
    }
    for (n1 in 0 until 5) {
      for (k2 in 0 until N2) {
        val ang = -2.0 * PI * (n1 * k2) / N
        twRe[n1][k2] = cos(ang)
        twIm[n1][k2] = sin(ang)
      }
    }
  }

  private fun fft64(re: DoubleArray, im: DoubleArray) {
    for (i in 0 until N2) {
      val j = rev64[i]
      if (j > i) {
        var t = re[i]; re[i] = re[j]; re[j] = t
        t = im[i]; im[i] = im[j]; im[j] = t
      }
    }
    var size = 2
    while (size <= N2) {
      val half = size shr 1
      val step = N2 / size
      var s = 0
      while (s < N2) {
        for (k in 0 until half) {
          val wr = cos64[k * step]
          val wi = sin64[k * step]
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

  /** In-place 320-point forward complex DFT: X[k] = sum_{n=0..319} x[n] * exp(-i*2*pi*k*n/320). */
  fun fft(re: DoubleArray, im: DoubleArray, ws: Workspace = Workspace()) {
    for (n1 in 0 until 5) {
      val ur = ws.uRe[n1]
      val ui = ws.uIm[n1]
      for (n2 in 0 until N2) {
        val idx = 5 * n2 + n1
        ur[n2] = re[idx]
        ui[n2] = im[idx]
      }
      fft64(ur, ui)
    }
    for (k2 in 0 until N2) {
      val v0r = ws.uRe[0][k2]
      val v0i = ws.uIm[0][k2]

      val u1r = ws.uRe[1][k2]; val u1i = ws.uIm[1][k2]
      val w1r = twRe[1][k2]; val w1i = twIm[1][k2]
      val v1r = u1r * w1r - u1i * w1i
      val v1i = u1r * w1i + u1i * w1r

      val u2r = ws.uRe[2][k2]; val u2i = ws.uIm[2][k2]
      val w2r = twRe[2][k2]; val w2i = twIm[2][k2]
      val v2r = u2r * w2r - u2i * w2i
      val v2i = u2r * w2i + u2i * w2r

      val u3r = ws.uRe[3][k2]; val u3i = ws.uIm[3][k2]
      val w3r = twRe[3][k2]; val w3i = twIm[3][k2]
      val v3r = u3r * w3r - u3i * w3i
      val v3i = u3r * w3i + u3i * w3r

      val u4r = ws.uRe[4][k2]; val u4i = ws.uIm[4][k2]
      val w4r = twRe[4][k2]; val w4i = twIm[4][k2]
      val v4r = u4r * w4r - u4i * w4i
      val v4i = u4r * w4i + u4i * w4r

      val a1r = v1r + v4r; val a1i = v1i + v4i
      val b1r = v1r - v4r; val b1i = v1i - v4i
      val a2r = v2r + v3r; val a2i = v2i + v3i
      val b2r = v2r - v3r; val b2i = v2i - v3i

      re[k2] = v0r + a1r + a2r
      im[k2] = v0i + a1i + a2i

      val tr1 = v0r + C1 * a1r + C2 * a2r
      val ti1 = v0i + C1 * a1i + C2 * a2i
      val ur1 = S1 * b1r + S2 * b2r
      val ui1 = S1 * b1i + S2 * b2i
      re[k2 + N2] = tr1 + ui1
      im[k2 + N2] = ti1 - ur1
      re[k2 + 4 * N2] = tr1 - ui1
      im[k2 + 4 * N2] = ti1 + ur1

      val tr2 = v0r + C2 * a1r + C1 * a2r
      val ti2 = v0i + C2 * a1i + C1 * a2i
      val ur2 = S2 * b1r - S1 * b2r
      val ui2 = S2 * b1i - S1 * b2i
      re[k2 + 2 * N2] = tr2 + ui2
      im[k2 + 2 * N2] = ti2 - ur2
      re[k2 + 3 * N2] = tr2 - ui2
      im[k2 + 3 * N2] = ti2 + ur2
    }
  }

  /** Real 320-point DFT -> 161 interleaved [re, im] bins (`specOut` length >= 322). */
  fun rfft(time: FloatArray, specOut: FloatArray, ws: Workspace) {
    val re = ws.re
    val im = ws.im
    for (i in 0 until N) {
      re[i] = time[i].toDouble()
      im[i] = 0.0
    }
    fft(re, im, ws)
    for (k in 0 until BINS) {
      specOut[2 * k] = re[k].toFloat()
      specOut[2 * k + 1] = im[k].toFloat()
    }
  }

  /** Real 320-point windowed DFT -> direct FloatBuffer of 161 interleaved [re, im] bins. */
  fun rfftWindowed(time: FloatArray, win: FloatArray, specOut: FloatBuffer, ws: Workspace) {
    val re = ws.re
    val im = ws.im
    for (i in 0 until N) {
      re[i] = (time[i] * win[i]).toDouble()
      im[i] = 0.0
    }
    fft(re, im, ws)
    for (k in 0 until BINS) {
      specOut.put(2 * k, re[k].toFloat())
      specOut.put(2 * k + 1, im[k].toFloat())
    }
  }

  /** Inverse real 320-point DFT from 161 interleaved [re, im] bins -> 320 time samples. */
  fun irfft(specIn: FloatArray, timeOut: FloatArray, ws: Workspace) {
    val re = ws.re
    val im = ws.im
    re[0] = specIn[0].toDouble(); im[0] = 0.0
    re[N / 2] = specIn[2 * (BINS - 1)].toDouble(); im[N / 2] = 0.0
    for (k in 1 until BINS - 1) {
      val a = specIn[2 * k].toDouble()
      val b = specIn[2 * k + 1].toDouble()
      re[k] = a; im[k] = -b
      re[N - k] = a; im[N - k] = b
    }
    fft(re, im, ws)
    val scale = 1.0 / N
    for (i in 0 until N) timeOut[i] = (re[i] * scale).toFloat()
  }

  /** Inverse real 320-point DFT from direct FloatBuffer of 161 interleaved [re, im] bins. */
  fun irfft(specIn: FloatBuffer, timeOut: FloatArray, ws: Workspace) {
    val re = ws.re
    val im = ws.im
    re[0] = specIn.get(0).toDouble(); im[0] = 0.0
    re[N / 2] = specIn.get(2 * (BINS - 1)).toDouble(); im[N / 2] = 0.0
    for (k in 1 until BINS - 1) {
      val a = specIn.get(2 * k).toDouble()
      val b = specIn.get(2 * k + 1).toDouble()
      re[k] = a; im[k] = -b
      re[N - k] = a; im[N - k] = b
    }
    fft(re, im, ws)
    val scale = 1.0 / N
    for (i in 0 until N) timeOut[i] = (re[i] * scale).toFloat()
  }
}

/**
 * DPDFNet 16 kHz streaming Vorbis STFT + overlap-add synthesis + phase-aligned dry-floor protection.
 * Separated from OrtSession so unit tests verify exact COLA reconstruction and dry-floor behavior.
 */
internal class DpdfNetStft(
  private val dryDelayHops: Int = DEFAULT_DRY_DELAY_HOPS,
  private val maxDryBlend: Float = DEFAULT_DRY_BLEND,
) {
  companion object {
    const val WIN_LEN = 320
    const val HOP = 160
    const val BINS = 161
    /** DPDFNet-baseline has 5 hops (800 samples = 50 ms) total sample delay (1 STFT OLA + 4 DF lookahead). */
    const val DEFAULT_DRY_DELAY_HOPS = 5
    const val DEFAULT_DRY_BLEND = 0.04f

    val VORBIS_WIN = FloatArray(WIN_LEN) { n ->
      val s = sin(0.5 * PI * (n + 0.5) / 160.0)
      sin(0.5 * PI * s * s).toFloat()
    }
  }

  private val ws = Fft320.Workspace()
  private val ana = FloatArray(WIN_LEN)
  private val ola = FloatArray(WIN_LEN)
  private val rec = FloatArray(WIN_LEN)
  private val dryRing = if (dryDelayHops > 0) FloatArray(dryDelayHops * HOP) else FloatArray(HOP)
  private val dryDelayed = FloatArray(HOP)
  private var dryCursor = 0
  private var dryGain = 0f

  fun reset() {
    ana.fill(0f)
    ola.fill(0f)
    rec.fill(0f)
    dryRing.fill(0f)
    dryDelayed.fill(0f)
    dryCursor = 0
    dryGain = 0f
  }

  /** Shifts analysis window by 160 samples, records delayed dry reference, and writes windowed RFFT into [specOut]. */
  fun analyze(hopIn: FloatArray, off: Int, specOut: FloatBuffer) {
    pushDryAndShiftAna(hopIn, off)
    Fft320.rfftWindowed(ana, VORBIS_WIN, specOut, ws)
  }

  /** Array overload for deterministic JVM unit tests. */
  fun analyze(hopIn: FloatArray, off: Int, specOut: FloatArray) {
    pushDryAndShiftAna(hopIn, off)
    val windowed = rec
    for (i in 0 until WIN_LEN) windowed[i] = ana[i] * VORBIS_WIN[i]
    Fft320.rfft(windowed, specOut, ws)
  }

  private fun pushDryAndShiftAna(hopIn: FloatArray, off: Int) {
    if (dryDelayHops > 0) {
      System.arraycopy(dryRing, dryCursor, dryDelayed, 0, HOP)
      System.arraycopy(hopIn, off, dryRing, dryCursor, HOP)
      dryCursor += HOP
      if (dryCursor >= dryRing.size) dryCursor = 0
    } else {
      System.arraycopy(hopIn, off, dryDelayed, 0, HOP)
    }
    System.arraycopy(ana, HOP, ana, 0, WIN_LEN - HOP)
    System.arraycopy(hopIn, off, ana, WIN_LEN - HOP, HOP)
  }

  fun synthesize(specEnh: FloatBuffer, out: FloatArray, outOff: Int) {
    Fft320.irfft(specEnh, rec, ws)
    finishOla(out, outOff)
  }

  fun synthesize(specEnh: FloatArray, out: FloatArray, outOff: Int) {
    Fft320.irfft(specEnh, rec, ws)
    finishOla(out, outOff)
  }

  private fun finishOla(out: FloatArray, outOff: Int) {
    // Shift OLA left by 160 BEFORE adding irfft * vorbisWin, then emit ola[0..159].
    System.arraycopy(ola, HOP, ola, 0, WIN_LEN - HOP)
    ola.fill(0f, WIN_LEN - HOP, WIN_LEN)
    for (i in 0 until WIN_LEN) {
      ola[i] += rec[i] * VORBIS_WIN[i]
    }
    if (maxDryBlend <= 0f) {
      System.arraycopy(ola, 0, out, outOff, HOP)
      return
    }
    var e = 0.0
    for (i in 0 until HOP) {
      val v = ola[i]
      e += v * v
    }
    val enhRms = sqrt(e / HOP).toFloat()
    val wantDry = if (enhRms > 0.0025f) maxDryBlend else 0f
    dryGain = if (wantDry > dryGain) 0.65f * dryGain + 0.35f * wantDry else 0.85f * dryGain + 0.15f * wantDry
    val wet = 1f - dryGain
    for (i in 0 until HOP) {
      out[outOff + i] = wet * ola[i] + dryGain * dryDelayed[i]
    }
  }
}

/**
 * Exact causal streaming framer and squared-periodic-Hann overlap-add synthesizer for VoxLock v2
 * (`n_fft = 512`, `hop = 128`, `overlap = 384`, initial reflect-pad `256`).
 * Supports dynamic step sizes (`K = 5` = 40 ms default, `K = 8` = 64 ms under CPU overload).
 */
internal class VoxLockStreamer {
  companion object {
    const val N_FFT = 512
    const val HOP = 128
    const val OVERLAP = N_FFT - HOP // 384
    const val PAD = 256
    const val DEFAULT_K = 5 // 640 samples = 40 ms
    const val FALLBACK_K = 8 // 1024 samples = 64 ms
    const val MAX_K = 8

    val WIN_SQ = FloatArray(N_FFT) { i ->
      val w = (0.5 - 0.5 * cos(2.0 * PI * i / N_FFT)).toFloat()
      w * w
    }
  }

  private var inBuf = FloatArray(VOICE_RATE)
  private var inLen = 0
  private val prevTail = FloatArray(OVERLAP)
  private val olaTail = FloatArray(OVERLAP)
  private val wsumTail = FloatArray(OVERLAP)
  private val olaWork = FloatArray(MAX_K * HOP + OVERLAP)
  private val wsumWork = FloatArray(MAX_K * HOP + OVERLAP)
  private var primed = false
  private var emittedFirst = false

  val bufferedInputSamples: Int get() = inLen

  fun reset() {
    inLen = 0
    prevTail.fill(0f)
    olaTail.fill(0f)
    wsumTail.fill(0f)
    primed = false
    emittedFirst = false
  }

  fun pushInput(src: FloatArray, off: Int, len: Int) {
    if (len <= 0) return
    if (inLen + len > inBuf.size) {
      inBuf = inBuf.copyOf(maxOf(inBuf.size * 2, inLen + len))
    }
    System.arraycopy(src, off, inBuf, inLen, len)
    inLen += len
  }

  /** Number of new input samples needed before a `kFrames` step can run. */
  fun neededInput(kFrames: Int): Int = if (!primed) kFrames * HOP + HOP else kFrames * HOP

  fun canStep(kFrames: Int): Boolean = inLen >= neededInput(kFrames)

  class PreparedStep(
    val wavLen: Int,
    val rawRms: Float,
  )

  /**
   * Builds `wavOut[0 until kFrames*128 + 384]` (reflect-padding 256 samples on the very first step
   * and overlapping 384 samples from the previous step thereafter) and consumes input samples.
   */
  fun prepareWav(kFrames: Int, wavOut: FloatArray): PreparedStep {
    val stepAdvance = kFrames * HOP
    val wavLen = stepAdvance + OVERLAP
    val need = neededInput(kFrames)
    require(inLen >= need) { "need $need samples, have $inLen" }

    var sumSq = 0.0
    for (i in 0 until need) {
      val v = inBuf[i]
      sumSq += v * v
    }
    val rawRms = sqrt(sumSq / need).toFloat()

    if (!primed) {
      for (j in 0 until PAD) {
        wavOut[j] = inBuf[PAD - j]
      }
      System.arraycopy(inBuf, 0, wavOut, PAD, need)
      primed = true
    } else {
      System.arraycopy(prevTail, 0, wavOut, 0, OVERLAP)
      System.arraycopy(inBuf, 0, wavOut, OVERLAP, need)
    }

    System.arraycopy(wavOut, stepAdvance, prevTail, 0, OVERLAP)
    val rem = inLen - need
    if (rem > 0) System.arraycopy(inBuf, need, inBuf, 0, rem)
    inLen = rem
    return PreparedStep(wavLen = wavLen, rawRms = rawRms)
  }

  /**
   * Overlap-adds `frames` (`[kFrames * 512]`) with `WIN_SQ` at hop 128, divides by `max(wsum, 1e-8)`,
   * drops initial 256 reflect-pad samples on step 0, and writes finalized samples to `out`.
   * Returns number of finalized samples written (`384` on step 0 for K=5, `kFrames * 128` thereafter).
   */
  fun completeStep(frames: FloatArray, kFrames: Int, out: FloatArray): Int {
    val stepAdvance = kFrames * HOP
    val workLen = stepAdvance + OVERLAP
    System.arraycopy(olaTail, 0, olaWork, 0, OVERLAP)
    olaWork.fill(0f, OVERLAP, workLen)
    System.arraycopy(wsumTail, 0, wsumWork, 0, OVERLAP)
    wsumWork.fill(0f, OVERLAP, workLen)

    for (fi in 0 until kFrames) {
      val pos = fi * HOP
      val fBase = fi * N_FFT
      for (j in 0 until N_FFT) {
        olaWork[pos + j] += frames[fBase + j]
        wsumWork[pos + j] += WIN_SQ[j]
      }
    }

    System.arraycopy(olaWork, stepAdvance, olaTail, 0, OVERLAP)
    System.arraycopy(wsumWork, stepAdvance, wsumTail, 0, OVERLAP)

    return if (!emittedFirst) {
      emittedFirst = true
      val count = stepAdvance - PAD
      for (i in 0 until count) {
        out[i] = olaWork[PAD + i] / max(wsumWork[PAD + i], 1e-8f)
      }
      count
    } else {
      for (i in 0 until stepAdvance) {
        out[i] = olaWork[i] / max(wsumWork[i], 1e-8f)
      }
      stepAdvance
    }
  }
}

/**
 * Kaldi-compatible log-mel filterbank, the speaker model's front end (as kaldi-native-fbank and
 * sherpa-onnx compute it): 25 ms frames every 10 ms, povey window, pre-emphasis 0.97, DC removed,
 * no dither, snip_edges false, power spectrum, 80 mel bins 20..7600 Hz, natural log, CMN.
 */
internal object Fbank {
  const val BINS = 80
  private const val FLEN = 400
  private const val SHIFT = 160
  private const val NFFT = 512
  private const val FLT_EPS = 1.1920928955078125e-7
  private const val PCM16_SCALE = 32768.0

  private val povey = DoubleArray(FLEN) { (0.5 - 0.5 * cos(2 * PI * it / (FLEN - 1))).pow(0.85) }
  private val bankFirst = IntArray(BINS)
  private val bankWeights = arrayOfNulls<DoubleArray>(BINS)

  class Workspace {
    val re = DoubleArray(NFFT)
    val im = DoubleArray(NFFT)
    val win = DoubleArray(FLEN)
  }

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
  fun compute(wave: FloatArray, off: Int, len: Int, ws: Workspace = Workspace()): FloatArray {
    if (len <= 0) return FloatArray(BINS)
    val n = maxOf(1, frames(len))
    val feats = FloatArray(n * BINS)
    val re = ws.re
    val im = ws.im
    val win = ws.win
    for (f in 0 until n) {
      val start = f * SHIFT + SHIFT / 2 - FLEN / 2
      var mean = 0.0
      for (i in 0 until FLEN) {
        var s = start + i
        if (len == 1) {
          s = 0
        } else {
          while (s < 0 || s >= len) s = if (s < 0) -s - 1 else 2 * len - 1 - s
        }
        win[i] = wave[off + s].toDouble() * PCM16_SCALE
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

/**
 * 1-pole ~64 Hz high-pass filter removing DC offset, wind, and handling rumble.
 */
internal class HighPass64 {
  private var x1 = 0f
  private var y1 = 0f

  fun reset() {
    x1 = 0f
    y1 = 0f
  }

  fun process(src: FloatArray, srcOff: Int, dst: FloatArray, dstOff: Int, n: Int) {
    var px = x1
    var py = y1
    for (i in 0 until n) {
      val x = src[srcOff + i]
      val y = 0.975f * (py + x - px)
      px = x
      py = y
      dst[dstOff + i] = y
    }
    x1 = px
    y1 = py
  }
}

/**
 * Tracks the noise floor so soft speech can be gently lifted ONLY on a temporary probe buffer for
 * Silero VAD (never warping the clean HPF audio handed to ERes2NetV2).
 */
internal class QuietVadBoost {
  private var noiseRms = 0.002f

  val estimatedNoiseRms: Float get() = noiseRms

  fun reset() {
    noiseRms = 0.002f
  }

  fun prepare(src: FloatArray, dst: FloatArray) {
    var sum = 0.0
    for (v in src) sum += v * v
    val rms = sqrt(sum / src.size).toFloat()
    noiseRms = when {
      rms < noiseRms -> 0.88f * noiseRms + 0.12f * rms
      rms < noiseRms * 1.8f -> 0.992f * noiseRms + 0.008f * rms
      else -> noiseRms
    }.coerceIn(0.0003f, 0.012f)
    val gain = if (rms > maxOf(0.0015f, noiseRms * 2.5f) && rms < 0.03f) {
      minOf(4.0f, 0.04f / rms)
    } else {
      1.0f
    }
    if (gain == 1.0f) System.arraycopy(src, 0, dst, 0, src.size)
    else for (i in src.indices) dst[i] = src[i] * gain
  }
}

/**
 * Subtle vocal presence shelf (~3-6 kHz consonant clarity) + smooth noise-gated vocal leveler +
 * soft limiter applied ONLY to enhanced audio emitted to MOSS-Live.
 */
internal class VocalEnhancer {
  private var noiseRms = 0.002f
  private var gain = 1.0f
  private var prevX = 0f

  val lastGainDb: Float get() = (20.0 * log10(maxOf(gain.toDouble(), 1e-4))).toFloat()

  fun reset() {
    noiseRms = 0.002f
    gain = 1.0f
    prevX = 0f
  }

  fun relaxSilence() {
    gain = 0.94f * gain + 0.06f * 1.0f
    prevX = 0f
  }

  fun process(src: FloatArray, dst: FloatArray, n: Int = src.size) {
    var sum = 0.0
    var peak = 0f
    for (i in 0 until n) {
      val v = src[i]
      sum += v * v
      val av = abs(v)
      if (av > peak) peak = av
    }
    val rms = sqrt(sum / maxOf(1, n)).toFloat()
    noiseRms = when {
      rms < noiseRms -> 0.88f * noiseRms + 0.12f * rms
      rms < noiseRms * 1.8f -> 0.992f * noiseRms + 0.008f * rms
      else -> noiseRms
    }.coerceIn(0.0004f, 0.012f)

    val voiced = rms > maxOf(0.002f, noiseRms * 2.2f)
    var want = if (voiced) {
      (0.11f / maxOf(rms, 0.002f)).coerceIn(1.0f, 3.5f)
    } else {
      1.0f
    }
    if (peak > 1e-4f) want = minOf(want, maxOf(1.0f, 0.85f / peak))

    gain = when {
      want < gain -> 0.45f * gain + 0.55f * want
      want > gain && want > 1.05f -> 0.72f * gain + 0.28f * want
      else -> 0.94f * gain + 0.06f * want
    }
    val presence = if (voiced) 0.12f else 0f
    var px = prevX
    for (i in 0 until n) {
      val raw = src[i]
      val shaped = raw + presence * (raw - px)
      px = raw
      val x = shaped * gain
      val ax = abs(x)
      dst[i] = if (ax <= 0.88f) x else {
        val sign = if (x >= 0f) 1f else -1f
        sign * (0.88f + 0.11f * tanh(((ax - 0.88f) / 0.11f).toDouble()).toFloat())
      }
    }
    prevX = px
  }
}

/** 16 ms (256-sample at 16 kHz) smooth half-cosine residual gain ramp for zero-click gating. */
internal class CosineRamp(private val rampSamples: Int = 256) {
  var currentGain = 1f
    private set
  private var startGain = 1f
  private var targetGain = 1f
  private var pos = rampSamples

  fun reset(initial: Float = 1f) {
    currentGain = initial
    startGain = initial
    targetGain = initial
    pos = rampSamples
  }

  fun setTarget(target: Float) {
    val clamped = target.coerceIn(0f, 1f)
    if (abs(clamped - targetGain) < 1e-4f) return
    startGain = currentGain
    targetGain = clamped
    pos = 0
  }

  fun applyInPlace(buf: FloatArray, off: Int, len: Int) {
    if (pos >= rampSamples && currentGain == 1f) return
    if (pos >= rampSamples && currentGain == 0f) {
      buf.fill(0f, off, off + len)
      return
    }
    for (i in 0 until len) {
      if (pos < rampSamples) {
        pos++
        val w = (0.5 - 0.5 * cos(PI * pos / rampSamples)).toFloat()
        currentGain = startGain + (targetGain - startGain) * w
      } else {
        currentGain = targetGain
      }
      buf[off + i] *= currentGain
    }
  }
}

data class SvScore(
  val rawMean: Float,
  val maxProto: Float,
  val combined: Float,
  val sessionCos: Float,
  val effective: Float,
)

/**
 * Multi-prototype + centroid speaker verification scoring:
 * `0.65f * cosine(e, mean) + 0.35f * maxProtoCosine(e, prototypes)` plus guarded session adaptation.
 */
fun scoreVoiceprint(
  embNorm: FloatArray,
  meanNorm: FloatArray,
  prototypesNorm: List<FloatArray>?,
  sessionNorm: FloatArray? = null,
  threshold: Float = 0.38f,
): SvScore {
  val rawMean = cosine(embNorm, meanNorm)
  val validProtos = prototypesNorm?.filter { it.size == embNorm.size }
  val maxProto = if (!validProtos.isNullOrEmpty()) {
    var best = -1f
    for (p in validProtos) {
      val c = cosine(embNorm, p)
      if (c > best) best = c
    }
    best
  } else {
    rawMean
  }
  val combined = if (!validProtos.isNullOrEmpty()) {
    0.65f * rawMean + 0.35f * maxProto
  } else {
    rawMean
  }
  val sessCos = if (sessionNorm != null && sessionNorm.size == embNorm.size) {
    cosine(embNorm, sessionNorm)
  } else {
    combined
  }
  val effective = if (sessionNorm != null && sessionNorm.size == embNorm.size && combined >= threshold - 0.10f) {
    maxOf(combined, 0.60f * combined + 0.40f * sessCos)
  } else {
    combined
  }
  return SvScore(
    rawMean = rawMean,
    maxProto = maxProto,
    combined = combined,
    sessionCos = sessCos,
    effective = effective,
  )
}

/** Selects up to [maxCount] diverse L2-normalized prototypes from outlier-filtered piece embeddings. */
fun selectDiversePrototypes(keptNorm: List<FloatArray>, meanNorm: FloatArray, maxCount: Int = 6): List<FloatArray> {
  if (keptNorm.isEmpty()) return emptyList()
  if (keptNorm.size <= maxCount) return keptNorm
  val chosen = ArrayList<FloatArray>(maxCount)
  val used = BooleanArray(keptNorm.size)
  // Anchor 0: piece closest to the clean centroid.
  var firstIdx = 0
  var bestToMean = -2f
  for (i in keptNorm.indices) {
    val c = cosine(keptNorm[i], meanNorm)
    if (c > bestToMean) {
      bestToMean = c
      firstIdx = i
    }
  }
  used[firstIdx] = true
  chosen.add(keptNorm[firstIdx])
  // Greedily pick remaining pieces minimizing max similarity to already-chosen prototypes (diverse prosody/formants).
  while (chosen.size < maxCount) {
    var pick = -1
    var lowestMaxSim = Float.MAX_VALUE
    for (i in keptNorm.indices) {
      if (used[i]) continue
      var maxSim = -2f
      for (c in chosen) {
        val sim = cosine(keptNorm[i], c)
        if (sim > maxSim) maxSim = sim
      }
      if (maxSim < lowestMaxSim) {
        lowestMaxSim = maxSim
        pick = i
      }
    }
    if (pick < 0) break
    used[pick] = true
    chosen.add(keptNorm[pick])
  }
  return chosen
}

fun rmsFloat(buf: FloatArray, off: Int = 0, len: Int = buf.size): Float {
  if (len <= 0) return 0f
  var sum = 0.0
  for (i in 0 until len) {
    val v = buf[off + i]
    sum += v * v
  }
  return sqrt(sum / len).toFloat()
}

fun rmsToDbfs(rms: Float): Float = (20.0 * log10(maxOf(rms.toDouble(), 1e-5))).coerceIn(-100.0, 0.0).toFloat()

fun attenDb(outRms: Float, inRms: Float): Float =
  (20.0 * log10(maxOf(outRms.toDouble(), 1e-6) / maxOf(inRms.toDouble(), 1e-6))).coerceIn(-80.0, 40.0).toFloat()

fun cosine(a: FloatArray, b: FloatArray): Float {
  val n = minOf(a.size, b.size)
  if (n == 0) return 0f
  var d = 0.0
  var na = 0.0
  var nb = 0.0
  for (i in 0 until n) {
    d += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return if (na == 0.0 || nb == 0.0) 0f else (d / sqrt(na * nb)).toFloat()
}

fun normalizeEmbedding(e: FloatArray): FloatArray {
  var n = 0.0
  for (v in e) n += v * v
  val s = sqrt(n)
  if (s == 0.0) return e.copyOf()
  return FloatArray(e.size) { (e[it] / s).toFloat() }
}

/** L2-normalised mean of L2-normalised embeddings (the enrolled voice). */
fun meanEmbedding(list: List<FloatArray>): FloatArray {
  val out = FloatArray(list[0].size)
  for (e in list) {
    var n = 0.0
    for (v in e) n += v * v
    val s = sqrt(n)
    if (s == 0.0) continue
    for (i in e.indices) out[i] += (e[i] / s / list.size).toFloat()
  }
  return normalizeEmbedding(out)
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
