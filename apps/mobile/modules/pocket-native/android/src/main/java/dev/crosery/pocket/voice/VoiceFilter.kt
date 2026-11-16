package dev.crosery.pocket.voice

import java.util.concurrent.ConcurrentLinkedQueue

/**
 * What the microphone sends during a call. Every frame read goes in; out comes the denoised audio and,
 * with a voiceprint, only the owner's speech: anyone else (the TV, a colleague, the assistant's own
 * voice leaking back) becomes silence, so the stream to the service stays continuous.
 *
 * Latency. Denoising releases each 16 ms hop one hop later (16-32 ms behind the microphone). A voice
 * has to be heard before it can be recognised: the start of an utterance is held back until the
 * voiceprint says whose it is (0.5 s of speech when it is clearly the owner, 1 s otherwise), then sent
 * at once, and the rest goes out as it is spoken. So when the owner stops talking, the service hears
 * the end as early as it would without the check; what moves is only when it hears the start. A new
 * utterance soon after one of the owner's goes out at once and is checked as it runs.
 *
 * Not thread-safe: one thread (the microphone's) calls [push] and [reset]. Voiceprints are computed by
 * `worker` off that thread; their verdicts are taken up at the next hop.
 */
class VoiceFilter(
  private val m: VoiceModels,
  private val o: Options,
  /** Runs a voiceprint check away from the microphone thread (or inline, in tests). */
  private val worker: (Runnable) -> Unit,
  /** PCM16 ready to send, in order. */
  private val emit: (ByteArray, Int, Int) -> Unit,
  /** A held utterance was judged: whether it went out and its score; for captions and logs. */
  private val onVerdict: (pass: Boolean, score: Float, kind: String) -> Unit = { _, _, _ -> },
) {
  class Options(
    val denoise: Boolean,
    /** The owner's voiceprint; null lets every voice through. */
    val enrolled: FloatArray?,
    /** Cosine score from which a full second of speech counts as the owner's. */
    val threshold: Float = 0.38f,
    /** Clearly the owner after half a second: no need to wait for the full second. */
    val early: Float = threshold + 0.10f,
    /** An utterance too short for a full second (a word or two) must score this. */
    val short: Float = threshold + 0.07f,
  )

  private class Chunk(val a: FloatArray) {
    var prob = 0f
  }

  private enum class State { IDLE, HOLD, OPEN, BLOCKED }
  private enum class Kind { EARLY, FULL, END, RECHECK }
  private class Verdict(val job: Int, val score: Float, val ms: Long)

  companion object {
    private const val HOP = Denoiser.HOP
    /** VAD windows are two hops (32 ms). */
    private const val W_MS = 32
    private fun windows(ms: Int) = (ms + W_MS - 1) / W_MS
    private fun hops(ms: Int) = (ms * VOICE_RATE / 1000 + HOP - 1) / HOP

    private const val START_PROB = 0.5f
    private const val SPEECH_PROB = 0.35f
    /** Speech starts after ~0.1 s at START_PROB (a click does not), ends after 0.5 s below SPEECH_PROB. */
    private val START_W = windows(96)
    private val END_W = windows(500)
    private val EARLY_W = windows(500)
    private val FULL_W = windows(1000)
    private val SHORT_W = windows(300)
    private val OPEN_RECHECK_W = windows(1500)
    private val TRUSTED_RECHECK_W = windows(500)
    private val BLOCKED_RECHECK_W = windows(500)
    /** Audio from before speech was detected, kept so the first syllable is not lost. */
    private val PRE_ROLL = hops(300)
    /** Rechecks look at the last second. */
    private val RECENT = hops(1000)
    /** A check uses only the speech in what it is given, when there is at least this much of it. */
    private val MIN_SPEECH = hops(250)
    /** A new utterance within this of the owner's last one goes out at once. */
    private val TRUST = hops(1000)
    /** Never hold longer than this (a phone too slow for the check): what is held becomes silence. */
    private val MAX_HOLD = hops(4000)
    /** Silence skipped to make up for pre-roll sent twice, only after this long in idle (plus END_W). */
    private val REPAY_AFTER = hops(300)
    private const val SEND_MAX = 3200
  }

  private val gate = o.enrolled != null && m.speaker != null
  private val denoiser = if (o.denoise) Denoiser(m) else null
  private val vad = if (gate) Vad(m) else null
  private val speaker = if (gate) Speaker(m) else null

  // Input not yet a whole hop.
  private val inBuf = FloatArray(HOP * 4)
  private var inLen = 0
  private var window: Chunk? = null
  private val winBuf = FloatArray(Vad.WINDOW)

  // Output not yet sent.
  private var out = ByteArray(SEND_MAX * 2)
  private var outLen = 0

  private var state = State.IDLE
  private var t = 0L
  private val ring = ArrayDeque<Chunk>()
  private val held = ArrayList<Chunk>()
  private var heldPre = 0
  private var holdStart = 0L
  private val recent = ArrayDeque<Chunk>()
  private var speaking = false
  private var startRun = 0
  private var silRun = 0
  private var speechW = 0
  private var sinceCheckW = 0
  private var recheckW = OPEN_RECHECK_W
  /** Open without a check yet (right after the owner): the first check has no slack. */
  private var trusted = false
  private var earlyTried = false
  private var fullTried = false
  private var lastOwner = Long.MIN_VALUE / 2
  private var idleHops = 0
  private var debt = 0

  private var jobSeq = 0
  private var job = 0
  private var jobKind = Kind.FULL
  private var jobSpeechW = 0
  private val verdicts = ConcurrentLinkedQueue<Verdict>()

  // Stats for the call's log.
  var hopsIn = 0L; private set
  var denoiseNs = 0L; private set
  var denoiseMaxNs = 0L; private set
  var checks = 0; private set
  var checkMsMax = 0L; private set
  var checkMsSum = 0L; private set
  var passed = 0; private set
  var blocked = 0; private set
  var holdMsMax = 0L; private set
  var holdMsSum = 0L; private set
  var holds = 0; private set
  /** Pre-roll sent twice and not yet made up for, in hops. */
  val owed: Int get() = debt

  /** Back to the start (after mute): nothing held, nothing pending. */
  fun reset() {
    denoiser?.reset()
    vad?.reset()
    inLen = 0
    window = null
    state = State.IDLE
    ring.clear(); held.clear(); recent.clear()
    heldPre = 0
    speaking = false; startRun = 0; silRun = 0; speechW = 0; sinceCheckW = 0
    job = 0
    verdicts.clear()
    idleHops = 0
    debt = 0
  }

  /** `bytes` of PCM16 from the microphone. */
  fun push(pcm: ByteArray, off: Int, bytes: Int) {
    var i = 0
    while (i < bytes) {
      val n = minOf((bytes - i) / 2, HOP - inLen)
      pcm16ToFloat(pcm, off + i, n * 2, inBuf, inLen)
      inLen += n
      i += n * 2
      if (inLen == HOP) {
        inLen = 0
        hop()
      }
    }
    flushOut()
  }

  private fun hop() {
    hopsIn++
    val a = FloatArray(HOP)
    if (denoiser != null) {
      val t0 = System.nanoTime()
      val ok = denoiser.hop(inBuf, 0, a, 0)
      val ns = System.nanoTime() - t0
      denoiseNs += ns
      if (ns > denoiseMaxNs) denoiseMaxNs = ns
      if (!ok) return
    } else {
      System.arraycopy(inBuf, 0, a, 0, HOP)
    }
    if (!gate) {
      send(a)
      return
    }
    t++
    take()
    val c = Chunk(a)
    place(c)
    val w = window
    if (w == null) {
      window = c
      return
    }
    window = null
    System.arraycopy(w.a, 0, winBuf, 0, HOP)
    System.arraycopy(c.a, 0, winBuf, HOP, HOP)
    val p = vad!!.prob(winBuf, 0)
    w.prob = p
    c.prob = p
    onWindow(p)
    take()
  }

  /** Where a new chunk of audio goes, by state. */
  private fun place(c: Chunk) {
    when (state) {
      State.IDLE -> {
        ring.addLast(c)
        if (ring.size > PRE_ROLL) ring.removeFirst()
        idleHops++
        // Silence goes out as it comes; some of it is skipped to repay pre-roll that went out twice.
        if (debt > 0 && idleHops >= REPAY_AFTER && t % 2 == 0L) debt-- else send(null)
      }
      State.HOLD -> {
        held.add(c)
        keep(c)
        if (held.size - heldPre >= MAX_HOLD) {
          // The check is taking too long (a slow phone): what is held goes out as silence.
          job = 0
          reject()
        }
      }
      State.BLOCKED -> {
        held.add(c)
        keep(c)
        if (held.size >= MAX_HOLD) {
          job = 0
          flushHeld(false)
        }
      }
      State.OPEN -> {
        send(c.a)
        keep(c)
      }
    }
  }

  /** The last second, whatever became of it: what rechecks listen to. */
  private fun keep(c: Chunk) {
    recent.addLast(c)
    if (recent.size > RECENT) recent.removeFirst()
  }

  private fun onWindow(p: Float) {
    // Speech segments, with Silero's hysteresis.
    var started = false
    var ended = false
    if (!speaking) {
      startRun = if (p >= START_PROB) startRun + 1 else 0
      if (startRun >= START_W) {
        speaking = true
        silRun = 0
        started = true
      }
    } else {
      silRun = if (p < SPEECH_PROB) silRun + 1 else 0
      if (silRun >= END_W) {
        speaking = false
        startRun = 0
        ended = true
      }
    }
    if (p >= SPEECH_PROB) {
      speechW++
      sinceCheckW++
    }
    if (started) onStart()
    when (state) {
      State.IDLE -> {}
      State.HOLD -> {
        if (job != 0) return
        when {
          !speaking -> if (speechW >= SHORT_W) check(Kind.END, held) else reject()
          speechW >= FULL_W && !fullTried -> { fullTried = true; check(Kind.FULL, held) }
          speechW >= EARLY_W && !earlyTried -> { earlyTried = true; check(Kind.EARLY, held) }
        }
      }
      State.OPEN -> {
        if (ended) {
          lastOwner = t
          toIdle()
        } else if (job == 0 && sinceCheckW >= recheckW) {
          check(Kind.RECHECK, recent)
        }
      }
      State.BLOCKED -> {
        if (job != 0) return
        // What is held waits for a check of the last second: held audio is the owner's after all
        // when that says so (a second of the owner's that scored low), silence otherwise.
        if (ended) {
          if (sinceCheckW > 0) check(Kind.END, recent) else { flushHeld(false); toIdle() }
        } else if (sinceCheckW >= BLOCKED_RECHECK_W) {
          check(Kind.RECHECK, recent)
        }
      }
    }
  }

  private fun onStart() {
    if (state != State.IDLE) return
    speechW = 0
    sinceCheckW = 0
    earlyTried = false
    fullTried = false
    if (t - lastOwner <= TRUST) {
      // Right after the owner spoke: most likely the owner again. Out at once, checked after a second.
      recent.clear()
      recent.addAll(ring)
      flushRing(true)
      state = State.OPEN
      recheckW = TRUSTED_RECHECK_W
      trusted = true
      return
    }
    recent.clear()
    recent.addAll(ring)
    held.clear()
    held.addAll(ring)
    heldPre = ring.size
    ring.clear()
    holdStart = t
    state = State.HOLD
  }

  /** Runs a voiceprint check on the speech in `chunks` (all of them when there is too little speech). */
  private fun check(kind: Kind, chunks: List<Chunk>) {
    val speech = chunks.filter { it.prob >= SPEECH_PROB }.let { if (it.size >= MIN_SPEECH) it else chunks }
    val x = FloatArray(speech.size * HOP)
    for ((i, c) in speech.withIndex()) System.arraycopy(c.a, 0, x, i * HOP, HOP)
    val id = ++jobSeq
    job = id
    jobKind = kind
    jobSpeechW = if (kind == Kind.RECHECK || state == State.BLOCKED) sinceCheckW else speechW
    sinceCheckW = 0
    val enrolled = o.enrolled!!
    val sp = speaker!!
    worker(Runnable {
      val t0 = System.nanoTime()
      val score = try {
        cosine(sp.embed(x, 0, x.size), enrolled)
      } catch (_: Throwable) {
        -1f
      }
      verdicts.add(Verdict(id, score, (System.nanoTime() - t0) / 1_000_000))
    })
  }

  /** Takes up a finished check, if there is one for the current job. */
  private fun take() {
    var v: Verdict? = null
    while (true) {
      val x = verdicts.poll() ?: break
      // Checks of audio no longer held (the utterance ended, the call was muted) are dropped.
      if (x.job == job) v = x
    }
    if (v == null) return
    job = 0
    checks++
    checkMsSum += v.ms
    if (v.ms > checkMsMax) checkMsMax = v.ms
    val s = v.score
    when (state) {
      State.HOLD -> {
        val pass = when (jobKind) {
          Kind.EARLY -> if (s >= o.early) true else null
          Kind.FULL -> s >= o.threshold
          else -> s >= (if (jobSpeechW >= EARLY_W) o.threshold else o.short)
        }
        when (pass) {
          null -> {}
          true -> { onVerdict(true, s, jobKind.name.lowercase()); accept() }
          false -> { onVerdict(false, s, jobKind.name.lowercase()); reject() }
        }
      }
      State.OPEN -> {
        // A little slack once checked: the same voice scores lower on some seconds than on others.
        // Blocking costs the owner nothing but time: what follows is held until the next check.
        if (s < o.threshold - (if (trusted) 0f else 0.05f)) {
          onVerdict(false, s, if (trusted) "trusted" else "recheck")
          blocked++
          state = State.BLOCKED
          held.clear()
          heldPre = 0
        } else {
          lastOwner = t
          recheckW = OPEN_RECHECK_W
        }
        trusted = false
      }
      State.BLOCKED -> {
        if (s >= o.threshold) {
          onVerdict(true, s, "recheck")
          passed++
          flushHeld(true)
          lastOwner = t
          if (speaking) { state = State.OPEN; recheckW = OPEN_RECHECK_W; trusted = false } else toIdle()
        } else {
          flushHeld(false)
          if (!speaking) toIdle()
        }
      }
      State.IDLE -> {}
    }
  }

  private fun accept() {
    passed++
    noteHold()
    flushHeld(true)
    lastOwner = t
    if (speaking) {
      state = State.OPEN
      recheckW = OPEN_RECHECK_W
      trusted = false
    } else {
      toIdle()
    }
  }

  private fun reject() {
    blocked++
    noteHold()
    flushHeld(false)
    if (speaking) state = State.BLOCKED else toIdle()
  }

  private fun noteHold() {
    val ms = (t - holdStart) * HOP * 1000 / VOICE_RATE
    holds++
    holdMsSum += ms
    if (ms > holdMsMax) holdMsMax = ms
  }

  /** Sends what is held: as it was, or as silence. Pre-roll went out once already (as silence), so silence skips it. */
  private fun flushHeld(audio: Boolean) {
    if (audio) {
      for (c in held) send(c.a)
      debt += heldPre
    } else {
      for (i in heldPre until held.size) {
        if (debt > 0 && i % 2 == 0) debt-- else send(null)
      }
    }
    held.clear()
    heldPre = 0
  }

  private fun flushRing(audio: Boolean) {
    if (audio) {
      for (c in ring) send(c.a)
      debt += ring.size
    }
    ring.clear()
  }

  private fun toIdle() {
    state = State.IDLE
    // A check still running is about audio already sent or dropped.
    job = 0
    idleHops = 0
    held.clear()
    heldPre = 0
    recent.clear()
  }

  private fun send(a: FloatArray?) {
    val need = outLen + HOP * 2
    if (need > out.size) out = out.copyOf(maxOf(need, out.size * 2))
    if (a == null) out.fill(0, outLen, need) else floatToPcm16(a, 0, HOP, out, outLen)
    outLen = need
  }

  private fun flushOut() {
    var i = 0
    while (i < outLen) {
      val n = minOf(SEND_MAX, outLen - i)
      emit(out, i, n)
      i += n
    }
    outLen = 0
  }
}
