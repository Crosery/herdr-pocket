package dev.crosery.pocket.voice

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sqrt

/**
 * The voice models on ONNX Runtime: GTCRN (denoising, MIT), Silero VAD (speech or not, MIT) and
 * 3D-Speaker CAM++ (voiceprints, Apache-2.0; only once one is wanted, it is a download). One thread per
 * session: a call is a steady trickle of tiny runs, where more threads only add wake-ups.
 * Sessions are safe to run from two threads at once (the mic and the voiceprint worker).
 */
class VoiceModels private constructor(
  internal val env: OrtEnvironment,
  internal val gtcrn: OrtSession,
  internal val vad: OrtSession,
  internal val speaker: OrtSession?,
) : AutoCloseable {
  companion object {
    private fun options() = OrtSession.SessionOptions().apply {
      setIntraOpNumThreads(1)
      setInterOpNumThreads(1)
      setExecutionMode(OrtSession.SessionOptions.ExecutionMode.SEQUENTIAL)
      setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
      // No busy-waiting between runs: the audio threads must not spin a core.
      addConfigEntry("session.intra_op.allow_spinning", "0")
      addConfigEntry("session.inter_op.allow_spinning", "0")
    }

    /** `speakerPath` null: denoising and speech detection only. */
    fun load(gtcrn: ByteArray, vad: ByteArray, speakerPath: String?): VoiceModels {
      val env = OrtEnvironment.getEnvironment()
      val opened = ArrayList<OrtSession>()
      try {
        options().use { o ->
          val g = env.createSession(gtcrn, o).also { opened.add(it) }
          val v = env.createSession(vad, o).also { opened.add(it) }
          val s = speakerPath?.let { env.createSession(it, o).also { x -> opened.add(x) } }
          return VoiceModels(env, g, v, s)
        }
      } catch (e: Throwable) {
        for (s in opened) try { s.close() } catch (_: Throwable) {}
        throw e
      }
    }
  }

  override fun close() {
    try { speaker?.close() } catch (_: Throwable) {}
    try { vad.close() } catch (_: Throwable) {}
    try { gtcrn.close() } catch (_: Throwable) {}
  }
}

/** A native-order direct buffer: ONNX Runtime reads it in place, without a copy per run. */
private fun direct(n: Int): FloatBuffer = ByteBuffer.allocateDirect(n * 4).order(ByteOrder.nativeOrder()).asFloatBuffer()

private fun FloatBuffer.zero(): FloatBuffer {
  for (i in 0 until capacity()) put(i, 0f)
  return this
}

private fun OrtSession.Result.floats(name: String): FloatBuffer = (get(name).get() as OnnxTensor).floatBuffer

/** Copies all of `src` into `dst` from index 0. */
private fun copyInto(src: FloatBuffer, dst: FloatBuffer) {
  src.rewind()
  dst.rewind()
  dst.put(src)
  dst.rewind()
}

/**
 * Streaming GTCRN (gtcrn_simple.onnx) with the STFT sherpa-onnx's online denoiser uses: n_fft 512,
 * hop 256, sqrt of a periodic Hann window for analysis and synthesis. The first hop gives nothing, so
 * the output is sample-aligned with the input and lags it by buffering only: 16-32 ms.
 */
class Denoiser(private val m: VoiceModels) {
  companion object {
    const val HOP = 256
    private const val N = 512
    private const val BINS = 257
    private val WIN = DoubleArray(N) { sqrt(0.5 - 0.5 * cos(2 * PI * it / N)) }
    private val MIX = longArrayOf(1, BINS.toLong(), 1, 2)
    private val CONV = longArrayOf(2, 1, 16, 16, 33)
    private val TRA = longArrayOf(2, 3, 1, 1, 16)
    private val INTER = longArrayOf(2, 1, 33, 16)
  }

  private val mix = direct(BINS * 2)
  private val conv = direct(2 * 1 * 16 * 16 * 33)
  private val tra = direct(2 * 3 * 1 * 1 * 16)
  private val inter = direct(2 * 1 * 33 * 16)
  private val ana = FloatArray(N)
  private val ola = DoubleArray(N)
  private val re = DoubleArray(N)
  private val im = DoubleArray(N)
  private var started = false

  fun reset() {
    conv.zero(); tra.zero(); inter.zero()
    ana.fill(0f)
    ola.fill(0.0)
    started = false
  }

  /** Takes HOP samples of `x` at `off`; writes the HOP denoised samples now final to `out` at `outOff`. False for the very first hop. */
  fun hop(x: FloatArray, off: Int, out: FloatArray, outOff: Int): Boolean {
    System.arraycopy(ana, HOP, ana, 0, N - HOP)
    System.arraycopy(x, off, ana, N - HOP, HOP)
    for (i in 0 until N) {
      re[i] = ana[i] * WIN[i]
      im[i] = 0.0
    }
    Fft512.run(re, im)
    for (k in 0 until BINS) {
      mix.put(2 * k, re[k].toFloat())
      mix.put(2 * k + 1, im[k].toFloat())
    }
    val env = m.env
    OnnxTensor.createTensor(env, mix, MIX).use { tMix ->
      OnnxTensor.createTensor(env, conv, CONV).use { tConv ->
        OnnxTensor.createTensor(env, tra, TRA).use { tTra ->
          OnnxTensor.createTensor(env, inter, INTER).use { tInter ->
            m.gtcrn.run(mapOf("mix" to tMix, "conv_cache" to tConv, "tra_cache" to tTra, "inter_cache" to tInter)).use { r ->
              copyInto(r.floats("conv_cache_out"), conv)
              copyInto(r.floats("tra_cache_out"), tra)
              copyInto(r.floats("inter_cache_out"), inter)
              val e = r.floats("enh")
              // Inverse real DFT through a forward FFT of the conjugate; DC and Nyquist keep their real parts only.
              re[0] = e.get(0).toDouble(); im[0] = 0.0
              re[N / 2] = e.get(2 * (BINS - 1)).toDouble(); im[N / 2] = 0.0
              for (k in 1 until BINS - 1) {
                val a = e.get(2 * k).toDouble()
                val b = e.get(2 * k + 1).toDouble()
                re[k] = a; im[k] = -b
                re[N - k] = a; im[N - k] = b
              }
            }
          }
        }
      }
    }
    Fft512.run(re, im)
    System.arraycopy(ola, HOP, ola, 0, N - HOP)
    ola.fill(0.0, N - HOP, N)
    for (i in 0 until N) ola[i] += re[i] / N * WIN[i]
    if (!started) {
      started = true
      return false
    }
    for (i in 0 until HOP) out[outOff + i] = ola[i].toFloat()
    return true
  }
}

/** Silero VAD v4 (16 kHz, 512-sample windows): the probability that a window is speech. */
class Vad(private val m: VoiceModels) {
  companion object {
    const val WINDOW = 512
    private val X = longArrayOf(1, WINDOW.toLong())
    private val STATE = longArrayOf(2, 1, 64)
  }

  private val x = direct(WINDOW)
  private val h = direct(128)
  private val c = direct(128)

  fun reset() {
    h.zero(); c.zero()
  }

  fun prob(w: FloatArray, off: Int): Float {
    for (i in 0 until WINDOW) x.put(i, w[off + i])
    val env = m.env
    OnnxTensor.createTensor(env, x, X).use { tx ->
      OnnxTensor.createTensor(env, h, STATE).use { th ->
        OnnxTensor.createTensor(env, c, STATE).use { tc ->
          m.vad.run(mapOf("x" to tx, "h" to th, "c" to tc)).use { r ->
            copyInto(r.floats("new_h"), h)
            copyInto(r.floats("new_c"), c)
            return r.floats("prob").get(0)
          }
        }
      }
    }
  }
}

/** CAM++ speaker embeddings (192 values) of 16 kHz samples in [-1, 1]. */
class Speaker(private val m: VoiceModels) {
  private val session = requireNotNull(m.speaker) { "no voiceprint model" }
  private val input = session.inputNames.first()

  fun embed(x: FloatArray, off: Int, len: Int): FloatArray {
    val feats = Fbank.compute(x, off, len)
    val frames = feats.size / Fbank.BINS
    OnnxTensor.createTensor(m.env, FloatBuffer.wrap(feats), longArrayOf(1, frames.toLong(), Fbank.BINS.toLong())).use { t ->
      session.run(mapOf(input to t)).use { r ->
        val b = (r.get(0) as OnnxTensor).floatBuffer
        return FloatArray(b.remaining()).also { b.get(it) }
      }
    }
  }
}
