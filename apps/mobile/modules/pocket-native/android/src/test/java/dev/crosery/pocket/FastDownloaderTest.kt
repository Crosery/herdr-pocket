package dev.crosery.pocket

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.BufferedReader
import java.io.File
import java.io.IOException
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class FastDownloaderTest {

  private fun deterministicPayload(bytes: Int): Pair<ByteArray, String> {
    val data = ByteArray(bytes) { i -> ((i * 131 + i / 251) and 0xff).toByte() }
    val hex = MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
    return data to hex
  }

  private fun serveRangeServer(
    payload: ByteArray,
    delayMs: Long = 0L,
    failFirstChunkAt: Long? = null,
    rangeCapable: Boolean = true,
    always500: Boolean = false,
  ): Pair<ServerSocket, AtomicInteger> {
    val hits = AtomicInteger(0)
    val injectedFaultUsed = AtomicBoolean(false)
    val exec = Executors.newCachedThreadPool { r -> Thread(r, "test-http").apply { isDaemon = true } }
    val srv = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    Thread({
      while (!srv.isClosed) {
        val sock = try {
          srv.accept()
        } catch (_: Throwable) {
          break
        }
        exec.execute {
          sock.use { s ->
            try {
              val reader = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.US_ASCII))
              val reqLine = reader.readLine() ?: return@execute
              if (reqLine.isEmpty()) return@execute
              var rangeHdr: String? = null
              while (true) {
                val line = reader.readLine() ?: break
                if (line.isEmpty()) break
                val colon = line.indexOf(':')
                if (colon > 0 && line.substring(0, colon).trim().equals("Range", ignoreCase = true)) {
                  rangeHdr = line.substring(colon + 1).trim()
                }
              }
              hits.incrementAndGet()
              val out = s.getOutputStream()
              if (always500) {
                out.write("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                out.flush()
                return@execute
              }
              if (delayMs > 0) Thread.sleep(delayMs)
              if (rangeCapable && rangeHdr != null && rangeHdr.startsWith("bytes=")) {
                val spec = rangeHdr.removePrefix("bytes=").split("-")
                val start = spec[0].toLong()
                val end = minOf(payload.size.toLong() - 1L, spec[1].toLong())
                if (failFirstChunkAt != null && start == failFirstChunkAt && injectedFaultUsed.compareAndSet(false, true)) {
                  out.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                  out.flush()
                  return@execute
                }
                val len = (end - start + 1).toInt()
                val hdr = "HTTP/1.1 206 Partial Content\r\nContent-Length: $len\r\nContent-Range: bytes $start-$end/${payload.size}\r\nConnection: close\r\n\r\n"
                out.write(hdr.toByteArray())
                out.write(payload, start.toInt(), len)
                out.flush()
              } else {
                val hdr = "HTTP/1.1 200 OK\r\nContent-Length: ${payload.size}\r\nConnection: close\r\n\r\n"
                out.write(hdr.toByteArray())
                out.write(payload)
                out.flush()
              }
            } catch (_: Throwable) {
              /* ignore socket close during test teardown */
            }
          }
        }
      }
    }, "test-accept").apply {
      isDaemon = true
      start()
    }
    return srv to hits
  }

  @Test
  fun regionTimezoneAndMirrorOrdering() {
    assertTrue(FastDownloader.isMainlandChina("Asia/Shanghai", 8 * 3_600_000, "US"))
    assertTrue(FastDownloader.isMainlandChina("Asia/Beijing", 8 * 3_600_000, "US"))
    assertTrue(FastDownloader.isMainlandChina("GMT+08:00", 8 * 3_600_000, "CN"))
    assertFalse(FastDownloader.isMainlandChina("GMT+08:00", 8 * 3_600_000, "TW"))
    assertFalse(FastDownloader.isMainlandChina("America/New_York", -5 * 3_600_000, "US"))

    val raw = listOf(
      "https://github.com/o/r/releases/download/v1/a.apk",
      "https://ghproxy.net/https://github.com/o/r/releases/download/v1/a.apk",
    )
    val cn = FastDownloader.expandGithubUrls(raw, china = true)
    assertFalse(cn.any { it.contains("ghproxy.net") })
    assertTrue(cn.first().startsWith("https://ghfast.top/"))
    assertTrue(cn.last() == "https://github.com/o/r/releases/download/v1/a.apk")

    val us = FastDownloader.expandGithubUrls(raw, china = false)
    assertEquals("https://github.com/o/r/releases/download/v1/a.apk", us.first())

    val modelUrls = listOf(
      "https://huggingface.co/m/resolve/main/a.onnx",
      "https://hf-mirror.com/m/resolve/main/a.onnx",
    )
    assertEquals("https://hf-mirror.com/m/resolve/main/a.onnx", FastDownloader.orderByRegion(modelUrls, china = true).first())
    assertEquals("https://huggingface.co/m/resolve/main/a.onnx", FastDownloader.orderByRegion(modelUrls, china = false).first())
  }

  @Test
  fun multiMirrorProbeRacingAndParallelStripingRecoversFromFault() {
    val (payload, sha) = deterministicPayload(512 * 1024)
    val (deadSrv, _) = serveRangeServer(payload, always500 = true)
    val (slowSrv, _) = serveRangeServer(payload, delayMs = 200L)
    val (fast1, fast1Hits) = serveRangeServer(payload, failFirstChunkAt = 64L * 1024L)
    val (fast2, fast2Hits) = serveRangeServer(payload)
    val out = File.createTempFile("fastdl-multi-", ".part")
    out.delete()
    try {
      val urls = listOf(
        "http://127.0.0.1:${deadSrv.localPort}/file.bin",
        "http://127.0.0.1:${slowSrv.localPort}/file.bin",
        "http://127.0.0.1:${fast1.localPort}/file.bin",
        "http://127.0.0.1:${fast2.localPort}/file.bin",
      )
      var lastProgress = -1L
      FastDownloader.download(
        urls = urls,
        partFile = out,
        expectedSize = payload.size.toLong(),
        expectedSha256 = sha,
        minParallelBytes = 64L * 1024L,
        chunkBytes = 64L * 1024L,
        maxWorkers = 4,
      ) { got, total ->
        assertEquals(payload.size.toLong(), total)
        assertTrue(got >= lastProgress)
        lastProgress = got
      }
      assertEquals(payload.size.toLong(), lastProgress)
      assertArrayEquals(payload, out.readBytes())
      assertTrue("expected both fast mirrors to serve chunks: fast1=${fast1Hits.get()} fast2=${fast2Hits.get()}", fast1Hits.get() >= 2 && fast2Hits.get() >= 2)
    } finally {
      out.delete()
      deadSrv.close()
      slowSrv.close()
      fast1.close()
      fast2.close()
    }
  }

  @Test
  fun singleStreamFallbackAndBadSha256DeletesPartFile() {
    val (payload, sha) = deterministicPayload(128 * 1024)
    val (srv, _) = serveRangeServer(payload, rangeCapable = false)
    val out = File.createTempFile("fastdl-single-", ".part")
    out.delete()
    try {
      val u = listOf("http://127.0.0.1:${srv.localPort}/file.bin")
      FastDownloader.download(
        urls = u,
        partFile = out,
        expectedSize = payload.size.toLong(),
        expectedSha256 = sha,
        minParallelBytes = 64L * 1024L,
      )
      assertArrayEquals(payload, out.readBytes())

      out.delete()
      try {
        FastDownloader.download(
          urls = u,
          partFile = out,
          expectedSize = payload.size.toLong(),
          expectedSha256 = "0".repeat(64),
        )
        fail("expected checksum failure")
      } catch (_: IOException) {
        assertFalse(out.exists())
      }
    } finally {
      out.delete()
      srv.close()
    }
  }
}
