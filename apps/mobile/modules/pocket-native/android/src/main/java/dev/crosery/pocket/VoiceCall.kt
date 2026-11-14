package dev.crosery.pocket

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.TimeUnit
import kotlin.math.sqrt

private const val TAG = "PocketVoice"
private const val MIC_RATE = 16_000
private const val SPEAKER_RATE = 48_000
/** 20 ms of 16 kHz mono PCM16. */
private const val MIC_FRAME_BYTES = 640

/**
 * One voice call to the relay's /v1/assistant/live. Audio never passes through
 * JavaScript: the microphone goes straight to the socket, speech straight to the
 * speaker, and playback receipts follow what was actually heard (MOSS-Live
 * playback.* events). JS only gets the text events for captions and state.
 */
class VoiceCall(
  private val ctx: Context,
  private val server: String,
  private val token: String,
  private val onEnded: () -> Unit,
) {
  companion object {
    @Volatile var current: VoiceCall? = null
  }

  private data class Ref(val chunkId: String, val runId: String, val turnId: String)
  private class Chunk(val ref: Ref, val pcm: ByteArray, val frames: Long, val level: Float)
  private class Scope {
    var turnId = ""
    var finished = false
    var drained = false
    var stopped = false
    var outstanding = 0
    var playedMs = 0.0
  }

  private val client = OkHttpClient.Builder()
    .pingInterval(20, TimeUnit.SECONDS)
    .readTimeout(0, TimeUnit.MILLISECONDS)
    .connectTimeout(15, TimeUnit.SECONDS)
    .build()
  private var ws: WebSocket? = null
  private val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private var focus: AudioFocusRequest? = null
  private var prevMode = AudioManager.MODE_NORMAL
  private var record: AudioRecord? = null
  private var track: AudioTrack? = null
  private val effects = mutableListOf<android.media.audiofx.AudioEffect>()

  @Volatile private var ended = false
  @Volatile private var ready = false
  @Volatile var muted = false
    private set
  @Volatile private var micLevel = 0f

  // Playback ledger; guarded by `lock`.
  private val lock = Any()
  private val contexts = ArrayDeque<Ref>()
  private val queue = LinkedBlockingDeque<Chunk>()
  private val inflight = ArrayDeque<Pair<Chunk, Long>>()
  private var written = 0L
  private var generation = 0
  private val scopes = HashMap<String, Scope>()
  private val stoppedRuns = HashSet<String>()

  private val threads = mutableListOf<Thread>()

  fun start() {
    current = this
    PocketBus.emit("onCall", mapOf("state" to "connecting"))
    try {
      openAudio()
    } catch (e: Throwable) {
      Log.w(TAG, "audio", e)
      end("打不开麦克风：${e.message ?: "未知原因"}")
      return
    }
    // The token rides in a header: a URL ends up in reverse-proxy access logs.
    val req = Request.Builder().url(wsUrl(server, "/v1/assistant/live")).header("Authorization", "Bearer $token").build()
    ws = client.newWebSocket(req, Listener())
    thread("pocket-mic") { micLoop() }
    thread("pocket-play") { playLoop() }
    thread("pocket-ack") { ackLoop() }
  }

  private fun thread(name: String, body: () -> Unit) {
    val t = Thread({
      try {
        body()
      } catch (e: Throwable) {
        if (!ended) Log.w(TAG, name, e)
      }
    }, name)
    t.isDaemon = true
    threads.add(t)
    t.start()
  }

  // ----------------------------------------------------------------------- audio setup

  private fun openAudio() {
    prevMode = am.mode
    val attrs = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN).setAudioAttributes(attrs).build()
      am.requestAudioFocus(focus!!)
    }
    am.mode = AudioManager.MODE_IN_COMMUNICATION
    routeOutput()

    val minIn = AudioRecord.getMinBufferSize(MIC_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    @Suppress("MissingPermission")
    val rec = AudioRecord(
      MediaRecorder.AudioSource.VOICE_COMMUNICATION,
      MIC_RATE,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
      maxOf(minIn, MIC_FRAME_BYTES * 8),
    )
    if (rec.state != AudioRecord.STATE_INITIALIZED) {
      rec.release()
      throw IllegalStateException("没有麦克风权限")
    }
    // Hear the person, not our own voice coming out of the speaker.
    if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(rec.audioSessionId)?.let { it.enabled = true; effects.add(it) }
    if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(rec.audioSessionId)?.let { it.enabled = true; effects.add(it) }
    if (AutomaticGainControl.isAvailable()) AutomaticGainControl.create(rec.audioSessionId)?.let { it.enabled = true; effects.add(it) }
    record = rec

    val minOut = AudioTrack.getMinBufferSize(SPEAKER_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
    val tr = AudioTrack.Builder()
      .setAudioAttributes(attrs)
      .setAudioFormat(
        AudioFormat.Builder()
          .setSampleRate(SPEAKER_RATE)
          .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .build(),
      )
      .setTransferMode(AudioTrack.MODE_STREAM)
      .setBufferSizeInBytes(maxOf(minOut, SPEAKER_RATE * 2 / 5))
      .build()
    track = tr
    rec.startRecording()
    tr.play()
  }

  /** Headset when one is plugged in, otherwise the loudspeaker (a hands-free call). */
  private fun routeOutput() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val devices = am.availableCommunicationDevices
      val headset = devices.firstOrNull {
        it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_BLE_HEADSET ||
          it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET || it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
          it.type == AudioDeviceInfo.TYPE_USB_HEADSET
      }
      val target = headset ?: devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
      if (target != null) am.setCommunicationDevice(target)
    } else {
      @Suppress("DEPRECATION")
      am.isSpeakerphoneOn = !am.isWiredHeadsetOn && !am.isBluetoothScoOn
    }
  }

  private fun closeAudio() {
    try { record?.stop() } catch (_: Throwable) {}
    try { record?.release() } catch (_: Throwable) {}
    for (e in effects) try { e.release() } catch (_: Throwable) {}
    effects.clear()
    try { track?.pause(); track?.flush() } catch (_: Throwable) {}
    try { track?.release() } catch (_: Throwable) {}
    record = null
    track = null
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.clearCommunicationDevice()
      else {
        @Suppress("DEPRECATION")
        am.isSpeakerphoneOn = false
      }
      am.mode = prevMode
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) focus?.let { am.abandonAudioFocusRequest(it) }
    } catch (_: Throwable) {}
  }

  // ----------------------------------------------------------------------- loops

  private fun micLoop() {
    val rec = record ?: return
    val frame = ByteArray(MIC_FRAME_BYTES)
    val silence = ByteArray(MIC_FRAME_BYTES)
    while (!ended) {
      var off = 0
      while (off < frame.size && !ended) {
        val n = rec.read(frame, off, frame.size - off)
        if (n <= 0) {
          if (n < 0) return
          continue
        }
        off += n
      }
      micLevel = if (muted) 0f else rms(frame, frame.size)
      // Silence keeps flowing while muted: the model expects a continuous realtime stream.
      if (ready) ws?.send((if (muted) silence else frame).toByteString(0, frame.size))
    }
  }

  private fun playLoop() {
    val tr = track ?: return
    while (!ended) {
      val chunk = queue.poll(50, TimeUnit.MILLISECONDS) ?: continue
      val gen = synchronized(lock) {
        if (stoppedRuns.contains(chunk.ref.runId)) {
          -1
        } else {
          inflight.addLast(chunk to (written + chunk.frames))
          written += chunk.frames
          generation
        }
      }
      if (gen < 0) continue
      var off = 0
      // A flush (interruption) bumps the generation: the rest of this chunk is dropped.
      while (off < chunk.pcm.size && !ended && gen == synchronized(lock) { generation }) {
        val n = tr.write(chunk.pcm, off, chunk.pcm.size - off, AudioTrack.WRITE_NON_BLOCKING)
        if (n < 0) break
        off += n
        if (n == 0) Thread.sleep(8)
      }
    }
  }

  /** Acknowledges chunks once the speaker has really played them, and reports levels for the UI. */
  private fun ackLoop() {
    var lastLevel = 0L
    while (!ended) {
      Thread.sleep(20)
      val tr = track ?: continue
      val head = try { tr.playbackHeadPosition.toLong() and 0xFFFFFFFFL } catch (_: Throwable) { continue }
      val out = mutableListOf<JSONObject>()
      var outLevel = 0f
      synchronized(lock) {
        while (inflight.isNotEmpty() && inflight.first().second <= head) {
          val (chunk, _) = inflight.removeFirst()
          out.add(JSONObject().put("action", "playback.chunk.completed").put("chunk_id", chunk.ref.chunkId).put("run_id", chunk.ref.runId).put("turn_id", chunk.ref.turnId))
          val s = scope(chunk.ref.runId, chunk.ref.turnId)
          s.playedMs += chunk.frames * 1000.0 / SPEAKER_RATE
          if (s.outstanding > 0) s.outstanding--
          drained(chunk.ref.runId, s)?.let { out.add(it) }
        }
        inflight.firstOrNull()?.let { outLevel = it.first.level }
      }
      for (m in out) ws?.send(m.toString())
      val now = System.currentTimeMillis()
      if (now - lastLevel >= 100) {
        lastLevel = now
        PocketBus.emit("onLevel", mapOf("mic" to micLevel.toDouble(), "out" to outLevel.toDouble()))
      }
    }
  }

  private fun scope(runId: String, turnId: String): Scope {
    val s = scopes.getOrPut(runId) { Scope() }
    if (turnId.isNotEmpty()) s.turnId = turnId
    return s
  }

  private fun drained(runId: String, s: Scope): JSONObject? {
    if (!s.finished || s.drained || s.stopped || s.outstanding > 0) return null
    s.drained = true
    return JSONObject().put("action", "playback.completed").put("run_id", runId).put("turn_id", s.turnId)
  }

  /** The model was interrupted: stop its speech now and report how much was heard. */
  private fun stopRun(runId: String, turnId: String, reason: String) {
    val msg: JSONObject
    synchronized(lock) {
      stoppedRuns.add(runId)
      queue.removeAll { it.ref.runId == runId }
      val s = scope(runId, turnId)
      val tr = track
      if (inflight.any { it.first.ref.runId == runId } && tr != null) {
        val head = try { tr.playbackHeadPosition.toLong() and 0xFFFFFFFFL } catch (_: Throwable) { written }
        val cur = inflight.firstOrNull()
        if (cur != null && cur.first.ref.runId == runId) {
          val start = cur.second - cur.first.frames
          if (head > start) s.playedMs += (head - start) * 1000.0 / SPEAKER_RATE
        }
        try {
          tr.pause()
          tr.flush()
          tr.play()
        } catch (_: Throwable) {}
        inflight.clear()
        generation++
        written = try { tr.playbackHeadPosition.toLong() and 0xFFFFFFFFL } catch (_: Throwable) { 0L }
      }
      s.outstanding = 0
      s.finished = true
      s.stopped = true
      s.drained = true
      msg = JSONObject().put("action", "playback.stopped").put("run_id", runId).put("turn_id", s.turnId)
        .put("played_audio_ms", s.playedMs.toLong()).put("reason", reason)
      s.playedMs = 0.0
    }
    ws?.send(msg.toString())
  }

  // ----------------------------------------------------------------------- socket

  private inner class Listener : WebSocketListener() {
    override fun onMessage(webSocket: WebSocket, text: String) {
      if (ended) return
      val o = try { JSONObject(text) } catch (_: Throwable) { return }
      val action = o.optString("action")
      val d = o.optJSONObject("data") ?: JSONObject()
      when (action) {
        "relay.state" -> {
          when (d.optString("state")) {
            "ready" -> {
              ready = true
              webSocket.send(JSONObject().put("action", "mic_state").put("enabled", !muted).toString())
              PocketBus.emit("onCall", mapOf("state" to "ready"))
            }
            "error", "closed" -> {
              end(d.optString("message").ifEmpty { "通话结束了" })
              return
            }
          }
        }
        "response.audio.context" -> synchronized(lock) {
          contexts.addLast(Ref(d.optString("chunk_id"), d.optString("run_id"), d.optString("turn_id")))
          if (contexts.size > 512) contexts.removeFirst()
        }
        "response.audio.started" -> synchronized(lock) {
          val run = d.optString("run_id")
          if (!stoppedRuns.contains(run)) {
            val s = scope(run, d.optString("turn_id"))
            s.finished = false; s.drained = false; s.stopped = false; s.playedMs = 0.0
          }
        }
        "response.audio.done" -> {
          val m = synchronized(lock) {
            val run = d.optString("run_id")
            if (stoppedRuns.contains(run)) null
            else scope(run, d.optString("turn_id")).let { s -> s.finished = true; drained(run, s) }
          }
          m?.let { webSocket.send(it.toString()) }
        }
        "response.audio.stop" -> stopRun(d.optString("run_id"), d.optString("turn_id"), d.optString("reason").ifEmpty { "interrupted" })
      }
      // Captions and state for the UI; audio contexts are only plumbing.
      if (action != "response.audio.context") PocketBus.emit("onCallEvent", mapOf("json" to text))
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
      if (ended) return
      val pcm = bytes.toByteArray()
      synchronized(lock) {
        val ref = contexts.removeFirstOrNull() ?: return
        if (stoppedRuns.contains(ref.runId)) return
        scope(ref.runId, ref.turnId).outstanding++
        queue.add(Chunk(ref, pcm, (pcm.size / 2).toLong(), rms(pcm, pcm.size)))
      }
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      val why = when (response?.code) {
        401 -> "授权失效，请重新配对"
        403 -> "只有手机可以打语音"
        503 -> "服务器还没开语音功能"
        else -> "连接断了"
      }
      end(why)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      end("通话结束了")
    }
  }

  // ----------------------------------------------------------------------- controls

  fun setMuted(value: Boolean) {
    muted = value
    if (ready) ws?.send(JSONObject().put("action", "mic_state").put("enabled", !value).toString())
    PocketBus.emit("onCall", mapOf("state" to "ready", "muted" to value))
  }

  fun hangup() {
    try { ws?.send(JSONObject().put("action", "relay.hangup").toString()) } catch (_: Throwable) {}
    end("挂断了")
  }

  @Synchronized
  fun end(message: String) {
    if (ended) return
    ended = true
    ready = false
    if (current === this) current = null
    try { ws?.close(1000, "bye") } catch (_: Throwable) {}
    closeAudio()
    queue.clear()
    client.dispatcher.executorService.shutdown()
    PocketBus.emit("onCall", mapOf("state" to "ended", "message" to message))
    onEnded()
  }
}

private fun rms(pcm: ByteArray, len: Int): Float {
  var sum = 0.0
  var n = 0
  var i = 0
  while (i + 1 < len) {
    val s = ((pcm[i + 1].toInt() shl 8) or (pcm[i].toInt() and 0xFF)).toShort().toInt()
    sum += (s * s).toDouble()
    n++
    i += 2
  }
  if (n == 0) return 0f
  return minOf(1f, (sqrt(sum / n) / 32768.0 * 4).toFloat())
}
