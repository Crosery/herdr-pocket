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
  const val SPEAKER_SIZE = 28_281_164L
  const val SPEAKER_SHA256 = "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2"

  private val SPEAKER_URLS = listOf(
    "https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
    "https://ghproxy.net/https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
    "https://hf-mirror.com/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
  )

  private val client = OkHttpClient.Builder()
    .connectTimeout(20, TimeUnit.SECONDS)
    .readTimeout(60, TimeUnit.SECONDS)
    .build()

  @Volatile private var activeCall: Call? = null
  @Volatile var downloading = false
    private set

  private fun dir(ctx: Context) = File(ctx.applicationContext.filesDir, "voice").apply { mkdirs() }
  fun speakerFile(ctx: Context) = File(dir(ctx), "speaker.onnx")
  private fun stampFile(ctx: Context) = File(dir(ctx), "speaker.ok")
  private fun stampText() = "$SPEAKER_SIZE:$SPEAKER_SHA256"

  fun isSpeakerReady(ctx: Context): Boolean {
    val f = speakerFile(ctx)
    if (!f.exists() || f.length() != SPEAKER_SIZE) return false
    val ok = stampFile(ctx)
    if (ok.exists() && ok.readText() == stampText()) return true
    if (sha256(f) == SPEAKER_SHA256) {
      try { ok.writeText(stampText()) } catch (_: Throwable) {}
      return true
    }
    return false
  }

  fun deleteSpeaker(ctx: Context) {
    speakerFile(ctx).delete()
    stampFile(ctx).delete()
  }

  fun openModels(ctx: Context, needSpeaker: Boolean): VoiceModels {
    val assets = ctx.applicationContext.assets
    val gtcrn = assets.open("voice/gtcrn_simple.onnx").use { it.readBytes() }
    val vad = assets.open("voice/silero_vad.onnx").use { it.readBytes() }
    val spk = if (needSpeaker && isSpeakerReady(ctx)) speakerFile(ctx).absolutePath else null
    return VoiceModels.load(gtcrn, vad, spk)
  }

  /** Downloads and SHA-256 verifies the CAM++ model, trying mirrors in order. Blocking. */
  fun downloadSpeaker(ctx: Context, onProgress: (Long, Long) -> Unit) {
    if (isSpeakerReady(ctx)) {
      onProgress(SPEAKER_SIZE, SPEAKER_SIZE)
      return
    }
    synchronized(this) {
      if (isSpeakerReady(ctx)) {
        onProgress(SPEAKER_SIZE, SPEAKER_SIZE)
        return
      }
      downloading = true
      val d = dir(ctx)
      val target = speakerFile(ctx)
      val stamp = stampFile(ctx)
      val part = File(d, "speaker.onnx.part")
      var lastErr: Throwable? = null
      try {
        for (url in SPEAKER_URLS) {
          part.delete()
          try {
            fetchAndVerify(url, part, onProgress)
            stamp.delete()
            target.delete()
            if (!part.renameTo(target)) throw IOException("无法保存声纹模型")
            stamp.writeText(stampText())
            return
          } catch (e: Throwable) {
            part.delete()
            lastErr = e
            if (activeCall == null && e is InterruptedException) throw e
          }
        }
        throw IOException("下载声纹模型失败：${lastErr?.message ?: "网络异常"}", lastErr)
      } finally {
        activeCall = null
        downloading = false
      }
    }
  }

  fun cancelDownload() {
    activeCall?.cancel()
  }

  private fun fetchAndVerify(url: String, part: File, onProgress: (Long, Long) -> Unit) {
    val c = client.newCall(Request.Builder().url(url).header("Accept", "application/octet-stream").build())
    activeCall = c
    val md = MessageDigest.getInstance("SHA-256")
    c.execute().use { res ->
      if (!res.isSuccessful) throw IOException("HTTP ${res.code}")
      val body = res.body ?: throw IOException("空响应")
      val total = body.contentLength().takeIf { it > 0 } ?: SPEAKER_SIZE
      body.byteStream().use { input ->
        part.outputStream().use { out ->
          val buf = ByteArray(64 * 1024)
          var got = 0L
          var shown = 0L
          while (true) {
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
            md.update(buf, 0, n)
            got += n
            if (got - shown >= 256 * 1024) {
              shown = got
              onProgress(got, total)
            }
          }
          onProgress(got, total)
        }
      }
    }
    if (part.length() != SPEAKER_SIZE) throw IOException("模型大小不对 (${part.length()})")
    if (hex(md.digest()) != SPEAKER_SHA256) throw IOException("模型校验失败")
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
