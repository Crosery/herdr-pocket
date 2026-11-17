package dev.crosery.pocket.voice

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer

/**
 * On-device voice models on ONNX Runtime:
 * - DPDFNet-baseline (`dpdfnet_baseline.onnx`, Apache-2.0): 16 kHz streaming speech enhancement (10 ms hop)
 * - Silero VAD v4 (`silero_vad.onnx`, MIT): 32 ms speech probability
 * - 3D-Speaker ERes2NetV2-zh (`speaker.onnx`, Apache-2.0): 192-dim speaker verification embeddings
 * - VoxLock v2 (`voxlock_enroll.onnx` + `voxlock_chunk_int8.onnx`, Apache-2.0): streaming target speaker extraction
 */
class VoiceModels private constructor(
  internal val env: OrtEnvironment,
  internal val dpdfnet: OrtSession,
  internal val vad: OrtSession,
  internal val speaker: OrtSession?,
  internal val voxlockEnroll: OrtSession?,
  internal val voxlockChunk: OrtSession?,
) : AutoCloseable {
  companion object {
    private fun options(intraThreads: Int = 1) = OrtSession.SessionOptions().apply {
      setIntraOpNumThreads(intraThreads)
      setInterOpNumThreads(1)
      setExecutionMode(OrtSession.SessionOptions.ExecutionMode.SEQUENTIAL)
      setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
      // No busy-waiting between runs: the audio threads must not spin a core.
      addConfigEntry("session.intra_op.allow_spinning", "0")
      addConfigEntry("session.inter_op.allow_spinning", "0")
    }

    fun load(
      dpdfnet: ByteArray,
      vad: ByteArray,
      speakerPath: String?,
      voxlockEnrollPath: String? = null,
      voxlockChunkPath: String? = null,
    ): VoiceModels {
      val env = OrtEnvironment.getEnvironment()
      val opened = ArrayList<OrtSession>()
      try {
        val d = options(1).use { o -> env.createSession(dpdfnet, o).also { opened.add(it) } }
        val v = options(1).use { o -> env.createSession(vad, o).also { opened.add(it) } }
        val workerThreads = minOf(2, Runtime.getRuntime().availableProcessors()).coerceAtLeast(1)
        val s = speakerPath?.let { path -> options(workerThreads).use { o -> env.createSession(path, o).also { x -> opened.add(x) } } }
        val vlEnr = if (voxlockEnrollPath != null && voxlockChunkPath != null) {
          options(workerThreads).use { o -> env.createSession(voxlockEnrollPath, o).also { x -> opened.add(x) } }
        } else null
        val vlChk = if (voxlockEnrollPath != null && voxlockChunkPath != null) {
          options(workerThreads).use { o -> env.createSession(voxlockChunkPath, o).also { x -> opened.add(x) } }
        } else null
        return VoiceModels(env, d, v, s, vlEnr, vlChk)
      } catch (e: Throwable) {
        for (s in opened) try { s.close() } catch (_: Throwable) {}
        throw e
      }
    }
  }

  val hasTse: Boolean get() = voxlockEnroll != null && voxlockChunk != null

  override fun close() {
    try { voxlockChunk?.close() } catch (_: Throwable) {}
    try { voxlockEnroll?.close() } catch (_: Throwable) {}
    try { speaker?.close() } catch (_: Throwable) {}
    try { vad.close() } catch (_: Throwable) {}
    try { dpdfnet.close() } catch (_: Throwable) {}
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
 * Streaming DPDFNet-baseline (`dpdfnet_baseline.onnx`) speech enhancement at 16 kHz:
 * window_length = 320 (20 ms), hop_length = 160 (10 ms), Vorbis COLA window, 161 bins,
 * `state_in` initialized from ONNX custom metadata (`state_size`, `erb_norm_state_size`,
 * `spec_norm_state_size`, `erb_norm_init`, `spec_norm_init`), plus ~4% phase-aligned dry floor.
 */
class Denoiser(private val m: VoiceModels) {
  companion object {
    const val HOP = DpdfNetStft.HOP // 160 samples = 10 ms
    const val WIN_LEN = DpdfNetStft.WIN_LEN // 320 samples = 20 ms
    const val BINS = DpdfNetStft.BINS // 161
    private val SPEC_SHAPE = longArrayOf(1, 1, BINS.toLong(), 2)
  }

  private val stateSize: Int
  private val initState: FloatArray
  private val stateShape: LongArray
  private val specIn = direct(BINS * 2)
  private val stateBuf: FloatBuffer
  private val stft = DpdfNetStft()

  init {
    val meta = try { m.dpdfnet.metadata.customMetadata } catch (_: Throwable) { emptyMap() }
    stateSize = meta["state_size"]?.toIntOrNull() ?: 38_256
    val erbSz = meta["erb_norm_state_size"]?.toIntOrNull() ?: 32
    val specSz = meta["spec_norm_state_size"]?.toIntOrNull() ?: 96
    initState = FloatArray(stateSize)
    meta["erb_norm_init"]?.split(",")?.forEachIndexed { i, v ->
      if (i < erbSz && i < stateSize) initState[i] = v.trim().toFloatOrNull() ?: 0f
    }
    meta["spec_norm_init"]?.split(",")?.forEachIndexed { i, v ->
      if (i < specSz && erbSz + i < stateSize) initState[erbSz + i] = v.trim().toFloatOrNull() ?: 0f
    }
    stateShape = longArrayOf(stateSize.toLong())
    stateBuf = direct(stateSize)
    restoreInitialState()
  }

  private fun restoreInitialState() {
    stateBuf.rewind()
    stateBuf.put(initState)
    stateBuf.rewind()
  }

  fun reset() {
    restoreInitialState()
    stft.reset()
  }

  /** Takes 160 samples (`HOP`) of `x` at `off` and writes 160 enhanced samples to `out` at `outOff`. */
  fun hop(x: FloatArray, off: Int, out: FloatArray, outOff: Int): Boolean {
    stft.analyze(x, off, specIn)
    specIn.rewind()
    stateBuf.rewind()
    val env = m.env
    OnnxTensor.createTensor(env, specIn, SPEC_SHAPE).use { tSpec ->
      OnnxTensor.createTensor(env, stateBuf, stateShape).use { tState ->
        m.dpdfnet.run(mapOf("spec" to tSpec, "state_in" to tState)).use { r ->
          copyInto(r.floats("state_out"), stateBuf)
          val specEnh = r.floats("spec_e")
          stft.synthesize(specEnh, out, outOff)
        }
      }
    }
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
    x.rewind(); h.rewind(); c.rewind()
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

/** 3D-Speaker ERes2NetV2-zh speaker embeddings (192 values) from clean HPF 16 kHz samples in [-1, 1]. */
class Speaker(private val m: VoiceModels) {
  private val session = requireNotNull(m.speaker) { "no voiceprint model" }
  private val input = session.inputNames.first()
  private val ws = Fbank.Workspace()

  fun embed(x: FloatArray, off: Int, len: Int): FloatArray {
    val feats = Fbank.compute(x, off, len, ws)
    val frames = feats.size / Fbank.BINS
    OnnxTensor.createTensor(m.env, FloatBuffer.wrap(feats), longArrayOf(1, frames.toLong(), Fbank.BINS.toLong())).use { t ->
      session.run(mapOf(input to t)).use { r ->
        val b = (r.get(0) as OnnxTensor).floatBuffer
        return FloatArray(b.remaining()).also { b.get(it) }
      }
    }
  }
}

/**
 * Streaming Target Speaker Extraction (`VoxLock` v2):
 * - Runs `voxlock_enroll.onnx` ONCE on 3.0 s (`48_000` samples) -> persistent `enroll_n`, `k`, `v` tensors.
 * - Streams `voxlock_chunk_int8.onnx` with `K = 5` (40 ms, `wav [1, 1024]`) or `K = 8` (64 ms, `wav [1, 1408]`).
 */
class VoxLock(private val m: VoiceModels) : AutoCloseable {
  companion object {
    const val ENROLL_SAMPLES = 48_000
    private val ENROLL_SHAPE = longArrayOf(1, ENROLL_SAMPLES.toLong())
    private val ENROLL_N_SHAPE = longArrayOf(257, 376)
    private const val ENROLL_N_FLOATS = 257 * 376
    private val KV_SHAPE = longArrayOf(32, 2, 64, 298)
    private val VK_SHAPE = longArrayOf(32, 2, 298, 64)
    private const val KV_FLOATS = 32 * 2 * 64 * 298
    private val HC_SHAPE = longArrayOf(6, 32, 256)
    private const val HC_FLOATS = 6 * 32 * 256
    private const val MAX_WAV = VoxLockStreamer.MAX_K * VoxLockStreamer.HOP + VoxLockStreamer.OVERLAP // 1408
  }

  private val enrollSession = requireNotNull(m.voxlockEnroll) { "no voxlock enroll model" }
  private val chunkSession = requireNotNull(m.voxlockChunk) { "no voxlock chunk model" }

  private val wavBuf = direct(MAX_WAV)
  private val hBuf = direct(HC_FLOATS)
  private val cBuf = direct(HC_FLOATS)

  private var enrollNBuf: FloatBuffer? = null
  private var kBuf: FloatBuffer? = null
  private var vBuf: FloatBuffer? = null
  private var tEnrollN: OnnxTensor? = null
  private var tK: OnnxTensor? = null
  private var tV: OnnxTensor? = null

  val isEnrolled: Boolean get() = tEnrollN != null && tK != null && tV != null

  /** Runs `voxlock_enroll.onnx` once at call start and pins `enroll_n`, `k`, `v` in direct buffers. */
  fun enroll(sample48k: FloatArray) {
    closeEnrolledTensors()
    val inBuf = direct(ENROLL_SAMPLES)
    for (i in 0 until ENROLL_SAMPLES) {
      inBuf.put(i, if (sample48k.isNotEmpty()) sample48k[i % sample48k.size] else 0f)
    }
    inBuf.rewind()
    OnnxTensor.createTensor(m.env, inBuf, ENROLL_SHAPE).use { tIn ->
      enrollSession.run(mapOf("enroll" to tIn)).use { r ->
        val en = direct(ENROLL_N_FLOATS).also { copyInto(r.floats("enroll_n"), it) }
        val kb = direct(KV_FLOATS).also { copyInto(r.floats("k"), it) }
        val vb = direct(KV_FLOATS).also { copyInto(r.floats("v"), it) }
        enrollNBuf = en
        kBuf = kb
        vBuf = vb
        tEnrollN = OnnxTensor.createTensor(m.env, en, ENROLL_N_SHAPE)
        tK = OnnxTensor.createTensor(m.env, kb, KV_SHAPE)
        tV = OnnxTensor.createTensor(m.env, vb, VK_SHAPE)
      }
    }
    resetState()
  }

  fun resetState() {
    hBuf.zero()
    cBuf.zero()
  }

  /** Runs one chunk (`wavLen = kFrames * 128 + 384`) and writes `kFrames * 512` floats to `framesOut`. */
  fun chunk(wav: FloatArray, wavLen: Int, kFrames: Int, framesOut: FloatArray) {
    val ten = requireNotNull(tEnrollN) { "VoxLock.enroll not called" }
    val tk = requireNotNull(tK) { "VoxLock.enroll not called" }
    val tv = requireNotNull(tV) { "VoxLock.enroll not called" }
    wavBuf.clear()
    wavBuf.put(wav, 0, wavLen)
    wavBuf.flip()
    hBuf.rewind()
    cBuf.rewind()
    val env = m.env
    OnnxTensor.createTensor(env, wavBuf, longArrayOf(1, wavLen.toLong())).use { tWav ->
      OnnxTensor.createTensor(env, hBuf, HC_SHAPE).use { tH ->
        OnnxTensor.createTensor(env, cBuf, HC_SHAPE).use { tC ->
          val inputs = mapOf(
            "wav" to tWav,
            "enroll_n" to ten,
            "k" to tk,
            "v" to tv,
            "h" to tH,
            "c" to tC,
          )
          chunkSession.run(inputs).use { r ->
            copyInto(r.floats("h_out"), hBuf)
            copyInto(r.floats("c_out"), cBuf)
            val fb = r.floats("frames")
            fb.rewind()
            fb.get(framesOut, 0, kFrames * VoxLockStreamer.N_FFT)
          }
        }
      }
    }
  }

  private fun closeEnrolledTensors() {
    try { tEnrollN?.close() } catch (_: Throwable) {}
    try { tK?.close() } catch (_: Throwable) {}
    try { tV?.close() } catch (_: Throwable) {}
    tEnrollN = null
    tK = null
    tV = null
    enrollNBuf = null
    kBuf = null
    vBuf = null
  }

  override fun close() {
    closeEnrolledTensors()
  }
}
