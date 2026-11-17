package dev.crosery.pocket.voice

import android.content.Context
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

object VoiceModelManager {
  const val VOICEPRINT_MODEL_VERSION = "eres2netv2-voxlock-v2"

  const val SPEAKER_SIZE = 71_441_526L
  const val SPEAKER_SHA256 = "bf1a75b9930474cf3389ef415e6e5d38ca96fea4a3a00f7e301d080a58ee2239"

  const val VOXLOCK_ENROLL_SIZE = 21_023_799L
  const val VOXLOCK_ENROLL_SHA256 = "81f305c9b7a32f13d1401f53bb4c6301826a607c9e807e60912f36ef1b9fae29"

  const val VOXLOCK_CHUNK_SIZE = 56_560_589L
  const val VOXLOCK_CHUNK_SHA256 = "c50ffdc8d723fd4f91cb08889f3d0143491f95967b705f35c444a0b4afe88172"

  const val MODEL_PACK_SIZE = SPEAKER_SIZE + VOXLOCK_ENROLL_SIZE + VOXLOCK_CHUNK_SIZE // 149_025_914L

  const val OWNER_SAMPLE_SAMPLES = 48_000
  const val OWNER_SAMPLE_BYTES = OWNER_SAMPLE_SAMPLES * 2

  private data class ModelSpec(
    val fileName: String,
    val stampName: String,
    val size: Long,
    val sha256: String,
    val urls: List<String>,
  ) {
    val stampText: String get() = "$size:$sha256"
  }

  private val SPEAKER_SPEC = ModelSpec(
    fileName = "speaker.onnx",
    stampName = "speaker.ok",
    size = SPEAKER_SIZE,
    sha256 = SPEAKER_SHA256,
    urls = listOf(
      "https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
      "https://ghproxy.net/https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
      "https://hf-mirror.com/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
    ),
  )

  private val VOXLOCK_ENROLL_SPEC = ModelSpec(
    fileName = "voxlock_enroll.onnx",
    stampName = "voxlock_enroll.ok",
    size = VOXLOCK_ENROLL_SIZE,
    sha256 = VOXLOCK_ENROLL_SHA256,
    urls = listOf(
      "https://hf-mirror.com/arbazsiddiqui/voxlock/resolve/main/onnx/v2/enroll.onnx",
      "https://huggingface.co/arbazsiddiqui/voxlock/resolve/main/onnx/v2/enroll.onnx",
    ),
  )

  private val VOXLOCK_CHUNK_SPEC = ModelSpec(
    fileName = "voxlock_chunk_int8.onnx",
    stampName = "voxlock_chunk_int8.ok",
    size = VOXLOCK_CHUNK_SIZE,
    sha256 = VOXLOCK_CHUNK_SHA256,
    urls = listOf(
      "https://hf-mirror.com/arbazsiddiqui/voxlock/resolve/main/onnx/v2/chunk_int8.onnx",
      "https://huggingface.co/arbazsiddiqui/voxlock/resolve/main/onnx/v2/chunk_int8.onnx",
    ),
  )

  private val PACK_SPECS = listOf(SPEAKER_SPEC, VOXLOCK_ENROLL_SPEC, VOXLOCK_CHUNK_SPEC)

  private val client = OkHttpClient.Builder()
    .connectTimeout(20, TimeUnit.SECONDS)
    .readTimeout(90, TimeUnit.SECONDS)
    .build()

  @Volatile private var activeCall: Call? = null
  @Volatile private var cancelled = false
  @Volatile var downloading = false
    private set

  private fun dir(ctx: Context) = File(ctx.applicationContext.filesDir, "voice").apply { mkdirs() }
  fun speakerFile(ctx: Context) = File(dir(ctx), SPEAKER_SPEC.fileName)
  fun voxlockEnrollFile(ctx: Context) = File(dir(ctx), VOXLOCK_ENROLL_SPEC.fileName)
  fun voxlockChunkFile(ctx: Context) = File(dir(ctx), VOXLOCK_CHUNK_SPEC.fileName)
  fun ownerSampleFile(ctx: Context) = File(dir(ctx), "owner_sample.pcm")

  private fun isSpecReady(ctx: Context, spec: ModelSpec): Boolean {
    val d = dir(ctx)
    val f = File(d, spec.fileName)
    if (!f.exists() || f.length() != spec.size) return false
    val ok = File(d, spec.stampName)
    if (ok.exists() && runCatching { ok.readText() }.getOrNull() == spec.stampText) return true
    if (sha256(f) == spec.sha256) {
      try { ok.writeText(spec.stampText) } catch (_: Throwable) {}
      return true
    }
    return false
  }

  /** True when the full SOTA pack (ERes2NetV2-zh + VoxLock enroll + VoxLock chunk_int8) is verified. */
  fun isSpeakerReady(ctx: Context): Boolean = PACK_SPECS.all { isSpecReady(ctx, it) }

  fun isSvModelReady(ctx: Context): Boolean = isSpecReady(ctx, SPEAKER_SPEC)

  fun isTseModelsReady(ctx: Context): Boolean =
    isSpecReady(ctx, VOXLOCK_ENROLL_SPEC) && isSpecReady(ctx, VOXLOCK_CHUNK_SPEC)

  fun hasOwnerSample(ctx: Context): Boolean {
    val f = ownerSampleFile(ctx)
    return f.exists() && f.length() == OWNER_SAMPLE_BYTES.toLong()
  }

  fun saveOwnerSample(ctx: Context, samples: FloatArray): Boolean {
    if (samples.isEmpty()) return false
    val d = dir(ctx)
    val target = ownerSampleFile(ctx)
    val tmp = File(d, "owner_sample.pcm.part")
    val norm = FloatArray(OWNER_SAMPLE_SAMPLES) { i -> samples[i % samples.size] }
    val pcm = ByteArray(OWNER_SAMPLE_BYTES)
    floatToPcm16(norm, 0, OWNER_SAMPLE_SAMPLES, pcm, 0)
    return try {
      tmp.writeBytes(pcm)
      target.delete()
      tmp.renameTo(target)
    } catch (_: Throwable) {
      tmp.delete()
      false
    }
  }

  fun loadOwnerSample(ctx: Context): FloatArray? {
    val f = ownerSampleFile(ctx)
    if (!f.exists() || f.length() != OWNER_SAMPLE_BYTES.toLong()) return null
    return try {
      val bytes = f.readBytes()
      if (bytes.size != OWNER_SAMPLE_BYTES) return null
      FloatArray(OWNER_SAMPLE_SAMPLES).also { pcm16ToFloat(bytes, 0, OWNER_SAMPLE_BYTES, it, 0) }
    } catch (_: Throwable) {
      null
    }
  }

  fun deleteOwnerSample(ctx: Context) {
    try { ownerSampleFile(ctx).delete() } catch (_: Throwable) {}
  }

  fun deleteSpeaker(ctx: Context) {
    val d = dir(ctx)
    for (spec in PACK_SPECS) {
      File(d, spec.fileName).delete()
      File(d, spec.stampName).delete()
    }
  }

  fun openModels(ctx: Context, needSpeaker: Boolean, needTse: Boolean = false): VoiceModels {
    val assets = ctx.applicationContext.assets
    val dpdf = assets.open("voice/dpdfnet_baseline.onnx").use { it.readBytes() }
    val vad = assets.open("voice/silero_vad.onnx").use { it.readBytes() }
    val spk = if (needSpeaker && isSvModelReady(ctx)) speakerFile(ctx).absolutePath else null
    val vlEnroll = if (needTse && isTseModelsReady(ctx)) voxlockEnrollFile(ctx).absolutePath else null
    val vlChunk = if (needTse && isTseModelsReady(ctx)) voxlockChunkFile(ctx).absolutePath else null
    return VoiceModels.load(dpdf, vad, spk, vlEnroll, vlChunk)
  }

  /**
   * Downloads and SHA-256 verifies ERes2NetV2-zh + VoxLock v2 (enroll + chunk_int8), reporting
   * cumulative progress across all 3 files against [MODEL_PACK_SIZE] (`149_025_914L` bytes). Blocking.
   */
  fun downloadSpeaker(ctx: Context, onProgress: (Long, Long) -> Unit) {
    if (isSpeakerReady(ctx)) {
      onProgress(MODEL_PACK_SIZE, MODEL_PACK_SIZE)
      return
    }
    synchronized(this) {
      if (isSpeakerReady(ctx)) {
        onProgress(MODEL_PACK_SIZE, MODEL_PACK_SIZE)
        return
      }
      cancelled = false
      downloading = true
      val d = dir(ctx)
      var completedBytes = 0L
      try {
        for (spec in PACK_SPECS) {
          if (cancelled) throw IOException("已取消下载")
          if (isSpecReady(ctx, spec)) {
            completedBytes += spec.size
            onProgress(completedBytes, MODEL_PACK_SIZE)
            continue
          }
          val target = File(d, spec.fileName)
          val stamp = File(d, spec.stampName)
          val part = File(d, "${spec.fileName}.part")
          var lastErr: Throwable? = null
          var ok = false
          for (url in spec.urls) {
            if (cancelled) throw IOException("已取消下载")
            part.delete()
            try {
              fetchAndVerify(url, part, spec) { got ->
                onProgress(minOf(MODEL_PACK_SIZE, completedBytes + got), MODEL_PACK_SIZE)
              }
              stamp.delete()
              target.delete()
              if (!part.renameTo(target)) throw IOException("无法保存声纹模型 (${spec.fileName})")
              stamp.writeText(spec.stampText)
              completedBytes += spec.size
              onProgress(completedBytes, MODEL_PACK_SIZE)
              ok = true
              break
            } catch (e: Throwable) {
              part.delete()
              lastErr = e
              if (cancelled || e is InterruptedException) throw e
            }
          }
          if (!ok) {
            throw IOException("下载声纹模型失败：${lastErr?.message ?: "网络异常"}", lastErr)
          }
        }
      } finally {
        activeCall = null
        downloading = false
      }
    }
  }

  fun cancelDownload() {
    cancelled = true
    activeCall?.cancel()
  }

  private fun fetchAndVerify(url: String, part: File, spec: ModelSpec, onFileProgress: (Long) -> Unit) {
    val c = client.newCall(Request.Builder().url(url).header("Accept", "application/octet-stream").build())
    activeCall = c
    val md = MessageDigest.getInstance("SHA-256")
    c.execute().use { res ->
      if (!res.isSuccessful) throw IOException("HTTP ${res.code}")
      val body = res.body ?: throw IOException("空响应")
      body.byteStream().use { input ->
        part.outputStream().use { out ->
          val buf = ByteArray(64 * 1024)
          var got = 0L
          var shown = 0L
          while (true) {
            if (cancelled) throw IOException("已取消下载")
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
            md.update(buf, 0, n)
            got += n
            if (got - shown >= 256 * 1024) {
              shown = got
              onFileProgress(got)
            }
          }
          onFileProgress(got)
        }
      }
    }
    if (part.length() != spec.size) throw IOException("模型大小不对 (${part.length()} != ${spec.size})")
    if (hex(md.digest()) != spec.sha256) throw IOException("模型校验失败 (${spec.fileName})")
  }

  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

  private fun sha256(file: File): String {
    val md = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buf = ByteArray(64 * 1024)
      while (true) {
        val n = input.read(buf)
        if (n < 0) break
        md.update(buf, 0, n)
      }
    }
    return hex(md.digest())
  }
}
