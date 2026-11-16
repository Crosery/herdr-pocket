package dev.crosery.pocket.voice

import java.util.concurrent.ConcurrentLinkedQueue

/**
 * What the microphone sends during a call. Every frame read goes in; out comes the denoised audio and,
 * with a voiceprint, only the owner's speech: anyone else (at the start of an utterance or cutting in
 * mid-sentence, or TV/background chatter) becomes silence, so the stream to the service stays continuous.
 *
 * Latency & mid-call blocking. Denoising releases each 16 ms hop one hop later (16-32 ms behind the mic).
 * An utterance start is held until verified (0.51 s when clearly the owner, 0.70-0.96 s otherwise). While
 * open, the stream keeps a ~576 ms rolling verification cushion (`tail`) and checks the newest ~480 ms of
 * voiced speech every 96 ms at full threshold. On any dip below threshold, emission freezes immediately and
 * only resumes if the next check (or 640 ms borderline confirm) passes; otherwise the cushion is silenced
 * before non-owner speech leaves the phone. Blocked audio is discarded immediately and never replayed.
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
  /** A held or mid-call segment was judged: whether it passed and its score; for captions and logs. */
  private val onVerdict: (pass: Boolean, score: Float, kind: String) -> Unit = { _, _, _ -> },
) {
  class Options(
    val denoise: Boolean,
    /** The owner's voiceprint; null lets every voice through. */
    val enrolled: FloatArray?,
    /** Cosine score from which speech counts as the owner's. */
    val threshold: Float = 0.38f,
    /** Clearly the owner after ~0.5 s: no need to hold longer at utterance start. */
    val early: Float = threshold + 0.07f,
    /** An utterance too short for 0.5 s (a word or two) must score this. */
    val short: Float = threshold + 0.05f,
  )

  private class Chunk(val a: FloatArray) {
    var prob = 0f
  }

  private enum class State { IDLE, HOLD, OPEN, BLOCKED }
  private enum class Kind { EARLY, MID, FULL, END, RECHECK, CONFIRM }
  private class Verdict(val job: Int, val score: Float, val ms: Long)

  companion object {
    private const val HOP = Denoiser.HOP
    /** VAD windows are two hops (32 ms). */
    private const val W_MS = 32
    private fun windows(ms: Int) = (ms + W_MS - 1) / W_MS
    private fun hops(ms: Int) = (ms * VOICE_RATE / 1000 + HOP - 1) / HOP

    private const val START_PROB = 0.5f
    private const val SPEECH_PROB = 0.35f
    /** Speech starts after ~0.1 s at START_PROB (a click does not), ends after ~0.38 s below SPEECH_PROB. */
    private val START_W = windows(96)
    private val END_W = windows(384)
    private val EARLY_W = windows(512)
    private val MID_W = windows(704)
    private val FULL_W = windows(960)
    private val SHORT_W = windows(320)
    private val RECHECK_STEP_W = windows(96)
    private val BLOCKED_STEP_W = windows(160)
    private val END_CHECK_MIN_W = windows(256)
    /** Audio from before speech was detected, kept so the first consonant is not lost. */
    private val PRE_ROLL = hops(160)
    /** Rolling lookahead cushion held in OPEN (net lookahead = 736 - 160 = 576 ms). */
    private val TAIL_HOPS = hops(736)
    private val TAIL_MAX_SUSPECT = hops(1024)
    private val PREFIX_KEEP_HOPS = hops(480)
    /** Voiced-only speech window for fast mid-call switch checks vs borderline owner confirmation. */
    private val FAST_SPEECH_HOPS = hops(480)
    private val CONFIRM_SPEECH_HOPS = hops(640)
    private val RECENT_SPEECH_HOPS = hops(800)
    /** A check uses only the speech in what it is given, when there is at least this much of it. */
    private val MIN_SPEECH = hops(250)
    /** Never hold longer than this (a phone too slow for the check): what is held becomes silence. */
    private val MAX_HOLD = hops(4000)
    /** Silence skipped to make up for pre-roll sent twice, only after this long in idle. */
    private val REPAY_AFTER = hops(200)
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
  private val tail = ArrayDeque<Chunk>()
  private val recentSpeech = ArrayDeque<Chunk>()
  private var speaking = false
  private var startRun = 0
  private var silRun = 0
  private var speechW = 0
  private var sinceCheckW = 0
  private var earlyTried = false
  private var midTried = false
  private var fullTried = false
  private var earlyScore = 1f
  private var suspect = false
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
    ring.clear(); held.clear(); tail.clear(); recentSpeech.clear()
    heldPre = 0
    speaking = false; startRun = 0; silRun = 0; speechW = 0; sinceCheckW = 0
    earlyTried = false; midTried = false; fullTried = false; earlyScore = 1f; suspect = false
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
    if (p >= SPEECH_PROB) {
      keepSpeech(w)
      keepSpeech(c)
    }
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
        if (debt > 0 && idleHops >= REPAY_AFTER && t % 2 == 0L) debt-- else send(null)
      }
      State.HOLD -> {
        held.add(c)
        if (held.size - heldPre >= MAX_HOLD) {
          // The check is taking too long (a slow phone): what is held goes out as silence.
          job = 0
          reject()
        }
      }
      State.BLOCKED -> {
        // Blocked non-owner speech is silenced immediately and never retained for replay.
        if (debt > 0 && t % 2 == 0L) debt-- else send(null)
      }
      State.OPEN -> {
        tail.addLast(c)
        if (!suspect) {
          while (tail.size > TAIL_HOPS) send(tail.removeFirst().a)
        } else if (tail.size > TAIL_MAX_SUSPECT) {
          send(tail.removeFirst().a)
        }
      }
    }
  }

  private fun keepSpeech(c: Chunk) {
    recentSpeech.addLast(c)
    while (recentSpeech.size > RECENT_SPEECH_HOPS) recentSpeech.removeFirst()
  }

  private fun tailSpeech(maxHops: Int): List<Chunk> {
    val list = recentSpeech.toList()
    return if (list.size <= maxHops) list else list.subList(list.size - maxHops, list.size)
  }

  private fun onWindow(p: Float) {
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
          speechW >= MID_W && !midTried -> { midTried = true; check(Kind.MID, held) }
          speechW >= EARLY_W && !earlyTried -> { earlyTried = true; check(Kind.EARLY, held) }
        }
      }
      State.OPEN -> {
        if (ended) {
          if ((suspect || sinceCheckW >= END_CHECK_MIN_W) && recentSpeech.size >= MIN_SPEECH && job == 0) {
            check(Kind.END, recentSpeech.toList())
          } else {
            toIdleFromOpen()
          }
        } else if (job == 0 && sinceCheckW >= RECHECK_STEP_W && recentSpeech.size >= MIN_SPEECH) {
          check(Kind.RECHECK, tailSpeech(FAST_SPEECH_HOPS))
        }
      }
      State.BLOCKED -> {
        if (job != 0) return
        if (ended) toIdle()
        else if (sinceCheckW >= BLOCKED_STEP_W && recentSpeech.size >= MIN_SPEECH) {
          check(Kind.RECHECK, tailSpeech(FAST_SPEECH_HOPS))
        }
      }
    }
  }

  private fun onStart() {
    if (state != State.IDLE) return
    speechW = 0
    sinceCheckW = 0
    earlyTried = false
    midTried = false
    fullTried = false
    earlyScore = 1f
    suspect = false
    recentSpeech.clear()
    for (c in ring) if (c.prob >= SPEECH_PROB) keepSpeech(c)
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
    jobSpeechW = if (kind == Kind.RECHECK || kind == Kind.CONFIRM || state == State.BLOCKED) sinceCheckW else speechW
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
          Kind.EARLY -> {
            earlyScore = s
            if (s >= o.early) true else if (s < o.threshold - 0.10f) false else null
          }
          Kind.MID -> if (s >= o.threshold + 0.03f) true else null
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
        if (jobKind == Kind.END) {
          if (s >= o.threshold - 0.06f) {
            onVerdict(true, s, "end")
            toIdleFromOpen()
          } else {
            onVerdict(false, s, "end")
            blocked++
            dropTailAsSilence()
            toIdle()
          }
          return
        }
        if (jobKind == Kind.CONFIRM) {
          if (s >= o.threshold) {
            suspect = false
            while (tail.size > TAIL_HOPS) send(tail.removeFirst().a)
            if (!speaking) toIdleFromOpen()
          } else {
            onVerdict(false, s, "confirm")
            blocked++
            suspect = false
            dropTailAsSilence()
            if (speaking) { state = State.BLOCKED; sinceCheckW = 0 } else toIdle()
          }
          return
        }
        // Kind.RECHECK on newest 480 ms voiced speech:
        if (s >= o.threshold) {
          suspect = false
          while (tail.size > TAIL_HOPS) send(tail.removeFirst().a)
          if (!speaking) toIdleFromOpen()
        } else if (!suspect) {
          // Freeze `tail` on first dip below threshold so unverified speech cannot leave the phone.
          suspect = true
          if (!speaking) check(Kind.END, recentSpeech.toList())
        } else if (s >= o.threshold - 0.05f && recentSpeech.size > FAST_SPEECH_HOPS) {
          check(Kind.CONFIRM, tailSpeech(CONFIRM_SPEECH_HOPS))
        } else {
          onVerdict(false, s, "recheck")
          blocked++
          suspect = false
          dropTailAsSilence()
          if (speaking) { state = State.BLOCKED; sinceCheckW = 0 } else toIdle()
        }
      }
      State.BLOCKED -> {
        if (s >= o.threshold + 0.04f) {
          onVerdict(true, s, "resume")
          passed++
          tail.clear()
          suspect = false
          if (speaking) { state = State.OPEN; sinceCheckW = 0 } else toIdle()
        } else if (!speaking) {
          toIdle()
        }
      }
      State.IDLE -> {}
    }
  }

  private fun accept() {
    passed++
    noteHold()
    recentSpeech.clear()
    for (c in held) if (c.prob >= SPEECH_PROB) keepSpeech(c)
    tail.clear()
    if (earlyScore < o.threshold - 0.08f) {
      // Opening 0.5 s scored low (another speaker may have preceded the owner): mute prefix, keep verified tail.
      val keep = minOf(held.size, PREFIX_KEEP_HOPS)
      val cut = held.size - keep
      for (i in heldPre until cut) {
        if (debt > 0 && i % 2 == 0) debt-- else send(null)
      }
      for (i in cut until held.size) tail.addLast(held[i])
      if (cut < heldPre) debt += heldPre - cut
    } else {
      val cut = maxOf(0, held.size - TAIL_HOPS)
      for (i in 0 until cut) send(held[i].a)
      for (i in cut until held.size) tail.addLast(held[i])
      debt += heldPre
    }
    held.clear()
    heldPre = 0
    suspect = false
    if (speaking) { state = State.OPEN; sinceCheckW = 0 } else toIdleFromOpen()
  }

  private fun reject() {
    blocked++
    noteHold()
    for (i in heldPre until held.size) {
      if (debt > 0 && i % 2 == 0) debt-- else send(null)
    }
    held.clear()
    heldPre = 0
    if (speaking) { state = State.BLOCKED; sinceCheckW = 0 } else toIdle()
  }

  private fun dropTailAsSilence() {
    while (tail.isNotEmpty()) {
      tail.removeFirst()
      if (debt > 0) debt-- else send(null)
    }
  }

  private fun noteHold() {
    val ms = (t - holdStart) * HOP * 1000 / VOICE_RATE
    holds++
    holdMsSum += ms
    if (ms > holdMsMax) holdMsMax = ms
  }

  private fun toIdleFromOpen() {
    while (tail.isNotEmpty()) {
      val d = tail.removeFirst()
      if (debt > 0 && d.prob < SPEECH_PROB) debt-- else send(d.a)
    }
    toIdle()
  }

  private fun toIdle() {
    state = State.IDLE
    job = 0
    idleHops = 0
    suspect = false
    held.clear()
    heldPre = 0
    recentSpeech.clear()
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
