package dev.crosery.pocket

import okhttp3.Call
import okhttp3.ConnectionPool
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.net.URI
import java.security.MessageDigest
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * Region-aware, multi-mirror parallel Range downloader for APKs and voice models.
 *
 * Strategy:
 * 1. Detect region by IANA timezone (including Asia/Beijing and CN GMT+8 fallback) and place
 *    nearby mirrors ahead of GitHub/HuggingFace (or origin first outside mainland China).
 * 2. Concurrently probe up to 5 candidate mirrors with a 64 KiB Range request to drop dead/slow
 *    proxies within ~3.5s and rank live endpoints by measured bytes/sec.
 * 3. For files >= 2 MiB on Range-capable (HTTP 206) mirrors, stripe 2 MiB chunks across up to
 *    4 fast healthy mirrors simultaneously into a single pre-allocated `.part` file, falling back
 *    to single-stream download on non-Range servers or total parallel failure, then verifying size & SHA-256.
 */
object FastDownloader {
  private val CHINA_TIME_ZONES = setOf(
    "Asia/Shanghai",
    "Asia/Beijing",
    "Asia/Chongqing",
    "Asia/Chungking",
    "Asia/Harbin",
    "Asia/Urumqi",
    "Asia/Kashgar",
    "PRC",
  )

  private val CHINA_MIRRORS = listOf(
    "https://ghfast.top/",
    "https://gh-proxy.com/",
    "https://cdn.gh-proxy.com/",
    "https://edgeone.gh-proxy.com/",
  )

  private val CHINA_MIRROR_HOSTS = setOf(
    "ghfast.top",
    "gh-proxy.com",
    "cdn.gh-proxy.com",
    "edgeone.gh-proxy.com",
    "hf-mirror.com",
  )

  private val ORIGIN_HOSTS = setOf(
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "huggingface.co",
  )

  private val DEAD_MIRROR_HOSTS = setOf("ghproxy.net")

  private val CONTENT_RANGE_TOTAL = Regex("""^bytes\s+\d+-\d+/(\d+)$""", RegexOption.IGNORE_CASE)

  val sharedClient: OkHttpClient = OkHttpClient.Builder()
    .connectionPool(ConnectionPool(10, 30, TimeUnit.SECONDS))
    .connectTimeout(15, TimeUnit.SECONDS)
    .readTimeout(25, TimeUnit.SECONDS)
    .build()

  class CancelToken {
    @Volatile var cancelled = false
      private set
    private val calls = CopyOnWriteArrayList<Call>()

    internal fun track(call: Call) {
      calls.add(call)
      if (cancelled) call.cancel()
    }

    internal fun untrack(call: Call) {
      calls.remove(call)
    }

    fun cancel() {
      cancelled = true
      for (c in calls) {
        try {
          c.cancel()
        } catch (_: Throwable) {}
      }
      calls.clear()
    }
  }

  data class ProbedSource(
    val url: String,
    val bytesPerSec: Double,
    val supportsRange: Boolean,
    val totalSize: Long,
  )

  private data class Chunk(
    val index: Int,
    val start: Long,
    val end: Long,
  )

  fun isMainlandChina(
    tzId: String = TimeZone.getDefault().id,
    rawOffsetMs: Int = TimeZone.getDefault().rawOffset,
    country: String = Locale.getDefault().country,
  ): Boolean {
    if (CHINA_TIME_ZONES.contains(tzId)) return true
    val offsetZone = tzId.isEmpty() ||
      tzId.startsWith("GMT+08", ignoreCase = true) ||
      tzId.startsWith("UTC+08", ignoreCase = true) ||
      tzId.equals("Etc/GMT-8", ignoreCase = true)
    return offsetZone && rawOffsetMs == 8 * 3_600_000 && country.equals("CN", ignoreCase = true)
  }

  fun expandGithubUrls(urls: List<String>, china: Boolean = isMainlandChina()): List<String> {
    val clean = ArrayList<String>(urls.size + CHINA_MIRRORS.size)
    var githubUrl: String? = null
    for (raw in urls) {
      val host = hostOf(raw) ?: continue
      if (DEAD_MIRROR_HOSTS.contains(host)) continue
      if (host == "github.com" && githubUrl == null) githubUrl = raw
      if (!clean.contains(raw)) clean.add(raw)
    }
    if (githubUrl != null) {
      for (prefix in CHINA_MIRRORS) {
        val candidate = prefix + githubUrl
        if (!clean.contains(candidate)) clean.add(candidate)
      }
    }
    return orderByRegion(clean, china)
  }

  fun orderByRegion(urls: List<String>, china: Boolean = isMainlandChina()): List<String> {
    val domestic = ArrayList<String>()
    val neutral = ArrayList<String>()
    val global = ArrayList<String>()
    val seen = LinkedHashSet<String>()
    for (raw in urls) {
      if (!seen.add(raw)) continue
      val host = hostOf(raw)
      when {
        host != null && DEAD_MIRROR_HOSTS.contains(host) -> Unit
        host != null && CHINA_MIRROR_HOSTS.contains(host) -> domestic.add(raw)
        host != null && ORIGIN_HOSTS.contains(host) -> global.add(raw)
        else -> neutral.add(raw)
      }
    }
    val ordered = ArrayList<String>(seen.size)
    if (china) {
      ordered.addAll(domestic)
      ordered.addAll(neutral)
      ordered.addAll(global)
    } else {
      ordered.addAll(global)
      ordered.addAll(neutral)
      ordered.addAll(domestic)
    }
    return ordered
  }

  /**
   * Concurrently probes up to 5 candidate URLs with a tiny Range fetch to measure real latency
   * and throughput, filtering out dead or timed-out mirrors.
   */
  fun probeSources(
    client: OkHttpClient,
    urls: List<String>,
    token: CancelToken,
    probeBytes: Int = 65_536,
    probeTimeoutMs: Long = 3_500L,
  ): List<ProbedSource> {
    val candidates = urls.distinct().take(5)
    if (candidates.isEmpty()) return emptyList()
    val probeClient = client.newBuilder()
      .connectTimeout(probeTimeoutMs, TimeUnit.MILLISECONDS)
      .readTimeout(probeTimeoutMs, TimeUnit.MILLISECONDS)
      .callTimeout(probeTimeoutMs + 1_500L, TimeUnit.MILLISECONDS)
      .build()
    val exec = Executors.newFixedThreadPool(candidates.size)
    try {
      val futures = candidates.map { u ->
        exec.submit<ProbedSource?> {
          if (token.cancelled) return@submit null
          val req = Request.Builder()
            .url(u)
            .header("Range", "bytes=0-${probeBytes - 1}")
            .header("Accept", "application/octet-stream")
            .header("Accept-Encoding", "identity")
            .build()
          val call = probeClient.newCall(req)
          token.track(call)
          val t0 = System.nanoTime()
          try {
            call.execute().use { res ->
              if (res.code != 206 && res.code != 200) return@submit null
              val supportsRange = res.code == 206
              val totalSize = if (supportsRange) {
                parseContentRangeTotal(res.header("Content-Range"))
              } else {
                res.body?.contentLength()?.takeIf { it > 0 } ?: -1L
              }
              val body = res.body ?: return@submit null
              val buf = ByteArray(16 * 1024)
              var read = 0L
              body.byteStream().use { input ->
                while (read < probeBytes && !token.cancelled) {
                  val want = minOf(buf.size.toLong(), probeBytes - read).toInt()
                  val n = input.read(buf, 0, want)
                  if (n < 0) break
                  read += n
                }
              }
              if (token.cancelled || read <= 0L) return@submit null
              val elapsedSec = maxOf(0.001, (System.nanoTime() - t0) / 1_000_000_000.0)
              ProbedSource(
                url = u,
                bytesPerSec = read / elapsedSec,
                supportsRange = supportsRange,
                totalSize = totalSize,
              )
            }
          } catch (_: Throwable) {
            null
          } finally {
            token.untrack(call)
          }
        }
      }
      val out = ArrayList<ProbedSource>(candidates.size)
      for (f in futures) {
        val hit = try {
          f.get()
        } catch (_: Throwable) {
          null
        }
        if (hit != null) out.add(hit)
      }
      out.sortByDescending { it.bytesPerSec }
      return out
    } finally {
      exec.shutdownNow()
    }
  }

  /**
   * Downloads from [urls] into [partFile], racing candidate mirrors and striping Range chunks
   * across healthy mirrors when possible, then verifies exact size (when > 0) and SHA-256 (when non-empty).
   */
  fun download(
    urls: List<String>,
    partFile: File,
    expectedSize: Long = -1L,
    expectedSha256: String = "",
    token: CancelToken = CancelToken(),
    client: OkHttpClient = sharedClient,
    minParallelBytes: Long = 2L * 1024 * 1024,
    chunkBytes: Long = 2L * 1024 * 1024,
    maxWorkers: Int = 6,
    china: Boolean = isMainlandChina(),
    onProgress: (Long, Long) -> Unit = { _, _ -> },
  ) {
    if (token.cancelled) throw IOException("已取消下载")
    val candidates = expandGithubUrls(urls, china)
    if (candidates.isEmpty()) throw IOException("没有可用的下载地址")

    val probed = probeSources(client, candidates, token)
    if (token.cancelled) throw IOException("已取消下载")

    val total = expectedSize.takeIf { it > 0 } ?: probed.firstOrNull { it.totalSize > 0 }?.totalSize ?: -1L
    val rangeSources = probed.filter { it.supportsRange }

    var finished = false
    if (total >= minParallelBytes && rangeSources.isNotEmpty()) {
      val topSpeed = rangeSources[0].bytesPerSec
      val pool = rangeSources.filter { it.bytesPerSec >= topSpeed * 0.30 }.take(4).ifEmpty { listOf(rangeSources[0]) }
      val allRangeUrls = (pool.map { it.url } + rangeSources.drop(pool.size).map { it.url }).distinct()
      finished = downloadParallel(
        client = client,
        poolUrls = pool.map { it.url },
        fallbackUrls = allRangeUrls,
        partFile = partFile,
        totalSize = total,
        chunkBytes = chunkBytes,
        maxWorkers = maxWorkers,
        token = token,
        onProgress = onProgress,
      )
    }

    if (token.cancelled) {
      partFile.delete()
      throw IOException("已取消下载")
    }

    if (!finished) {
      val singleOrder = (probed.map { it.url } + candidates).distinct()
      var lastErr: Throwable? = null
      for (u in singleOrder) {
        if (token.cancelled) {
          partFile.delete()
          throw IOException("已取消下载")
        }
        partFile.delete()
        try {
          downloadSingle(client, u, partFile, expectedSize, token, onProgress)
          finished = true
          break
        } catch (e: Throwable) {
          partFile.delete()
          lastErr = e
          if (token.cancelled) throw IOException("已取消下载", e)
        }
      }
      if (!finished) {
        throw IOException("下载失败：${lastErr?.message ?: "网络异常"}", lastErr)
      }
    }

    if (token.cancelled) {
      partFile.delete()
      throw IOException("已取消下载")
    }
    if (expectedSize > 0 && partFile.length() != expectedSize) {
      val got = partFile.length()
      partFile.delete()
      throw IOException("文件大小不完整 ($got != $expectedSize)")
    }
    val wantSha = expectedSha256.trim().lowercase(Locale.ROOT)
    if (wantSha.isNotEmpty()) {
      val gotSha = sha256Of(partFile)
      if (gotSha != wantSha) {
        partFile.delete()
        throw IOException("文件校验不一致")
      }
    }
  }

  private fun downloadParallel(
    client: OkHttpClient,
    poolUrls: List<String>,
    fallbackUrls: List<String>,
    partFile: File,
    totalSize: Long,
    chunkBytes: Long,
    maxWorkers: Int,
    token: CancelToken,
    onProgress: (Long, Long) -> Unit,
  ): Boolean {
    val queue = ConcurrentLinkedQueue<Chunk>()
    var pos = 0L
    var idx = 0
    while (pos < totalSize) {
      val end = minOf(totalSize - 1, pos + chunkBytes - 1)
      queue.add(Chunk(idx++, pos, end))
      pos = end + 1
    }
    if (queue.isEmpty()) return false

    try {
      RandomAccessFile(partFile, "rw").use { it.setLength(totalSize) }
    } catch (_: Throwable) {
      return false
    }

    val workerCount = minOf(maxWorkers, idx)
    val doneBytes = AtomicLong(0L)
    val maxReported = AtomicLong(0L)
    val progressLock = Any()
    val failed = AtomicReference<Throwable?>(null)
    val aborted = AtomicInteger(0)

    fun report(force: Boolean = false) {
      val cur = minOf(totalSize, maxOf(0L, doneBytes.get()))
      synchronized(progressLock) {
        val prev = maxReported.get()
        if (cur > prev && (force || cur - prev >= 128 * 1024 || cur >= totalSize)) {
          maxReported.set(cur)
          onProgress(cur, totalSize)
        }
      }
    }

    val threads = ArrayList<Thread>(workerCount)
    for (w in 0 until workerCount) {
      val t = Thread({
        val raf = try {
          RandomAccessFile(partFile, "rw")
        } catch (e: Throwable) {
          failed.compareAndSet(null, e)
          aborted.set(1)
          return@Thread
        }
        val buf = ByteArray(64 * 1024)
        try {
          while (!token.cancelled && aborted.get() == 0) {
            val chunk = queue.poll() ?: break
            val expectedLen = chunk.end - chunk.start + 1
            var chunkDone = false
            var lastChunkErr: Throwable? = null

            val candidateOrder = ArrayList<String>(poolUrls.size + fallbackUrls.size)
            for (i in poolUrls.indices) candidateOrder.add(poolUrls[(chunk.index + i) % poolUrls.size])
            for (u in fallbackUrls) if (!candidateOrder.contains(u)) candidateOrder.add(u)

            val maxAttempts = maxOf(3, candidateOrder.size)
            for (attempt in 0 until maxAttempts) {
              if (token.cancelled || aborted.get() != 0) break
              val url = candidateOrder[attempt % candidateOrder.size]
              var attemptWritten = 0L
              val req = Request.Builder()
                .url(url)
                .header("Range", "bytes=${chunk.start}-${chunk.end}")
                .header("Accept", "application/octet-stream")
                .header("Accept-Encoding", "identity")
                .build()
              val call = client.newCall(req)
              token.track(call)
              try {
                call.execute().use { res ->
                  if (res.code != 206) throw IOException("HTTP ${res.code}")
                  val body = res.body ?: throw IOException("empty response")
                  body.byteStream().use { input ->
                    var off = 0L
                    while (off < expectedLen) {
                      if (token.cancelled || aborted.get() != 0) throw IOException("aborted")
                      val toRead = minOf(buf.size.toLong(), expectedLen - off).toInt()
                      val n = input.read(buf, 0, toRead)
                      if (n < 0) break
                      if (n > 0) {
                        raf.seek(chunk.start + off)
                        raf.write(buf, 0, n)
                        off += n
                        attemptWritten += n
                        doneBytes.addAndGet(n.toLong())
                        report()
                      }
                    }
                    if (off != expectedLen) throw IOException("short range ($off/$expectedLen)")
                  }
                }
                chunkDone = true
                break
              } catch (e: Throwable) {
                if (attemptWritten > 0L) doneBytes.addAndGet(-attemptWritten)
                lastChunkErr = e
              } finally {
                token.untrack(call)
              }
            }
            if (!chunkDone) {
              failed.compareAndSet(null, lastChunkErr ?: IOException("chunk ${chunk.index} failed"))
              aborted.set(1)
              break
            }
          }
        } finally {
          try {
            raf.close()
          } catch (_: Throwable) {}
        }
      }, "pocket-dl-$w")
      t.isDaemon = true
      t.start()
      threads.add(t)
    }

    for (t in threads) {
      try {
        t.join()
      } catch (e: InterruptedException) {
        token.cancel()
        Thread.currentThread().interrupt()
        return false
      }
    }

    if (token.cancelled || aborted.get() != 0 || failed.get() != null) return false
    report(force = true)
    return true
  }

  private fun downloadSingle(
    client: OkHttpClient,
    url: String,
    partFile: File,
    expectedSize: Long,
    token: CancelToken,
    onProgress: (Long, Long) -> Unit,
  ) {
    val req = Request.Builder()
      .url(url)
      .header("Accept", "application/octet-stream")
      .header("Accept-Encoding", "identity")
      .build()
    val call = client.newCall(req)
    token.track(call)
    try {
      call.execute().use { res ->
        if (!res.isSuccessful) throw IOException("HTTP ${res.code}")
        val body = res.body ?: throw IOException("empty response")
        val total = body.contentLength().takeIf { it > 0 } ?: expectedSize
        body.byteStream().use { input ->
          partFile.outputStream().use { out ->
            val buf = ByteArray(64 * 1024)
            var got = 0L
            var shown = 0L
            while (true) {
              if (token.cancelled) throw IOException("已取消下载")
              val n = input.read(buf)
              if (n < 0) break
              if (n > 0) {
                out.write(buf, 0, n)
                got += n
                if (got - shown >= 128 * 1024) {
                  shown = got
                  onProgress(got, total)
                }
              }
            }
            onProgress(got, total)
          }
        }
      }
    } finally {
      token.untrack(call)
    }
  }

  internal fun parseContentRangeTotal(header: String?): Long {
    if (header.isNullOrBlank()) return -1L
    val m = CONTENT_RANGE_TOTAL.find(header.trim()) ?: return -1L
    return m.groupValues[1].toLongOrNull() ?: -1L
  }

  internal fun hostOf(rawUrl: String): String? =
    try {
      URI(rawUrl).host?.lowercase(Locale.ROOT)
    } catch (_: Throwable) {
      null
    }

  internal fun sha256Of(file: File): String {
    val md = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buf = ByteArray(64 * 1024)
      while (true) {
        val n = input.read(buf)
        if (n < 0) break
        md.update(buf, 0, n)
      }
    }
    return md.digest().joinToString("") { "%02x".format(it) }
  }
}
