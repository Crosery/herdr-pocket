package dev.crosery.pocket.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random

class VoicePipelineTest {

  @Test
  fun fft320MatchesNaiveDftAndRoundTripsRealSignals() {
    val rng = Random(20261117)
    val n = Fft320.N
    val reIn = DoubleArray(n) { rng.nextDouble(-1.0, 1.0) }
    val imIn = DoubleArray(n) { rng.nextDouble(-1.0, 1.0) }

    // Naive O(N^2) forward complex DFT reference.
    val refRe = DoubleArray(n)
    val refIm = DoubleArray(n)
    for (k in 0 until n) {
      var sr = 0.0
      var si = 0.0
      for (t in 0 until n) {
        val ang = -2.0 * PI * k * t / n
        val c = cos(ang)
        val s = sin(ang)
        sr += reIn[t] * c - imIn[t] * s
        si += reIn[t] * s + imIn[t] * c
      }
      refRe[k] = sr
      refIm[k] = si
    }

    val gotRe = reIn.copyOf()
    val gotIm = imIn.copyOf()
    val ws = Fft320.Workspace()
    Fft320.fft(gotRe, gotIm, ws)

    for (k in 0 until n) {
      assertEquals("re[$k]", refRe[k], gotRe[k], 1e-10)
      assertEquals("im[$k]", refIm[k], gotIm[k], 1e-10)
    }

    // Real RFFT -> IRFFT round-trip (both FloatArray and direct FloatBuffer).
    val wave = FloatArray(n) { i ->
      (0.45 * sin(2.0 * PI * 310.0 * i / VOICE_RATE) +
        0.25 * cos(2.0 * PI * 1870.0 * i / VOICE_RATE) +
        0.15 * sin(2.0 * PI * 4230.0 * i / VOICE_RATE)).toFloat()
    }
    val specArr = FloatArray(Fft320.BINS * 2)
    val recArr = FloatArray(n)
    Fft320.rfft(wave, specArr, ws)
    Fft320.irfft(specArr, recArr, ws)
    for (i in 0 until n) {
      assertEquals("arr roundtrip[$i]", wave[i], recArr[i], 2e-6f)
    }

    val directSpec = ByteBuffer.allocateDirect(Fft320.BINS * 2 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer()
    val unitWin = FloatArray(n) { 1f }
    val recBuf = FloatArray(n)
    Fft320.rfftWindowed(wave, unitWin, directSpec, ws)
    Fft320.irfft(directSpec, recBuf, ws)
    for (i in 0 until n) {
      assertEquals("buf roundtrip[$i]", wave[i], recBuf[i], 2e-6f)
    }
  }

  @Test
  fun dpdfNetStftColaReconstructsWithExactOneHopDelayAndAlignedDryFloor() {
    // 1. Vorbis window satisfies w[n]^2 + w[n + 160]^2 == 1 everywhere.
    val win = DpdfNetStft.VORBIS_WIN
    for (i in 0 until DpdfNetStft.HOP) {
      val cola = win[i] * win[i] + win[i + DpdfNetStft.HOP] * win[i + DpdfNetStft.HOP]
      assertEquals("vorbis cola[$i]", 1f, cola, 1e-6f)
    }

    // 2. Pure STFT + OLA identity (dry blend off) delays by exact 160 samples with ~0 error.
    val stft = DpdfNetStft(dryDelayHops = 1, maxDryBlend = 0f)
    val hops = 120
    val total = hops * DpdfNetStft.HOP
    val src = FloatArray(total) { i ->
      (0.4 * sin(2.0 * PI * 240.0 * i / VOICE_RATE) + 0.2 * cos(2.0 * PI * 2900.0 * i / VOICE_RATE)).toFloat()
    }
    val dst = FloatArray(total)
    val spec = FloatArray(DpdfNetStft.BINS * 2)
    for (h in 0 until hops) {
      val off = h * DpdfNetStft.HOP
      stft.analyze(src, off, spec)
      stft.synthesize(spec, dst, off)
    }
    // First hop is 0; from hop 2 onward dst[i] == src[i - 160].
    for (i in DpdfNetStft.WIN_LEN until total) {
      assertEquals("cola sample[$i]", src[i - DpdfNetStft.HOP], dst[i], 5e-6f)
    }

    // 3. Dry-floor alignment with 5-hop (800-sample) total model delay (1 STFT OLA + 4 DF lookahead).
    val stftDry = DpdfNetStft(dryDelayHops = 5, maxDryBlend = 0.04f)
    val dfQueue = ArrayDeque<FloatArray>()
    repeat(4) { dfQueue.addLast(FloatArray(DpdfNetStft.BINS * 2)) }
    val outDry = FloatArray(total)
    for (h in 0 until hops) {
      val off = h * DpdfNetStft.HOP
      val sp = FloatArray(DpdfNetStft.BINS * 2)
      stftDry.analyze(src, off, sp)
      dfQueue.addLast(sp)
      val delayedSpec = dfQueue.removeFirst()
      stftDry.synthesize(delayedSpec, outDry, off)
    }
    // After 5 hops (800 samples) + dryGain ramp, wet (96%) + aligned dry (4%) equals 100% of src[i - 800]!
    for (i in 20 * DpdfNetStft.HOP until total) {
      assertEquals("phase-aligned dry+wet[$i]", src[i - 5 * DpdfNetStft.HOP], outDry[i], 1e-4f)
    }
  }

  @Test
  fun voxLockStreamerMatchesReferenceHannSquaredOlaAcrossDynamicKSwitch() {
    val streamer = VoxLockStreamer()
    val totalSamples = 24_000 // 1.5 s at 16 kHz
    val input = FloatArray(totalSamples) { i ->
      (0.5 * sin(2.0 * PI * 410.0 * i / VOICE_RATE) - 0.22 * cos(2.0 * PI * 1650.0 * i / VOICE_RATE)).toFloat()
    }
    val reconstructed = FloatArray(totalSamples)
    var outWrite = 0
    val wavBuf = FloatArray(VoxLockStreamer.MAX_K * VoxLockStreamer.HOP + VoxLockStreamer.OVERLAP)
    val framesBuf = FloatArray(VoxLockStreamer.MAX_K * VoxLockStreamer.N_FFT)
    val stepOut = FloatArray(VoxLockStreamer.MAX_K * VoxLockStreamer.HOP)

    var stepIdx = 0
    var pos = 0
    while (pos < totalSamples) {
      val pushN = minOf(160, totalSamples - pos)
      streamer.pushInput(input, pos, pushN)
      pos += pushN
      // Switch dynamically from K=5 (40ms) to K=8 (64ms) after step 4 to verify seamless transition.
      val k = if (stepIdx < 4) VoxLockStreamer.DEFAULT_K else VoxLockStreamer.FALLBACK_K
      while (streamer.canStep(k)) {
        streamer.prepareWav(k, wavBuf)
        // Identity TSE mask: each frame is simply the windowed input slice `wav[fi*128 + j] * WIN_SQ[j]`.
        for (fi in 0 until k) {
          val wOff = fi * VoxLockStreamer.HOP
          val fOff = fi * VoxLockStreamer.N_FFT
          for (j in 0 until VoxLockStreamer.N_FFT) {
            framesBuf[fOff + j] = wavBuf[wOff + j] * VoxLockStreamer.WIN_SQ[j]
          }
        }
        val got = streamer.completeStep(framesBuf, k, stepOut)
        System.arraycopy(stepOut, 0, reconstructed, outWrite, got)
        outWrite += got
        stepIdx++
      }
    }

    assertTrue("expected multiple K=5 and K=8 steps, got $stepIdx", stepIdx >= 15)
    assertTrue("expected >20000 output samples, got $outWrite", outWrite > 20_000)
    for (i in 0 until outWrite) {
      assertEquals("voxlock OLA[$i]", input[i], reconstructed[i], 2e-6f)
    }
  }

  @Test
  fun voiceFilterEmitsContinuouslyZeroStallDecouplesCleanSvAndGatesConfirmedImposter() {
    val ownerEmb = normalizeEmbedding(FloatArray(192) { if (it == 0) 1f else 0.02f })
    val imposterEmb = normalizeEmbedding(FloatArray(192) { if (it == 1) 1f else -0.02f })

    var currentIsOwner = true
    var currentSpeech = false
    val ownerEmbedRms = ArrayList<Float>()
    val imposterEmbedRms = ArrayList<Float>()
    val utterances = ArrayList<VoiceFilter.UtteranceTelemetry>()
    val capturedSamples = ArrayList<FloatArray>()

    val backend = object : VoiceBackend {
      override val hasSpeaker: Boolean = true
      override val hasTse: Boolean = true
      override fun reset() {}

      override fun denoise(x: FloatArray, off: Int, out: FloatArray, outOff: Int): Boolean {
        // Scale denoiser output by 0.5x so we can verify DPDFNet -> TSE runs BEFORE SV!
        for (i in 0 until Denoiser.HOP) out[outOff + i] = x[off + i] * 0.5f
        return true
      }

      override fun vadProb(win: FloatArray, off: Int): Float = if (currentSpeech) 0.92f else 0.02f

      override fun embed(x: FloatArray, off: Int, len: Int): FloatArray {
        val rms = rmsFloat(x, off, len)
        if (currentIsOwner) ownerEmbedRms.add(rms) else imposterEmbedRms.add(rms)
        return if (currentIsOwner) ownerEmb.copyOf() else imposterEmb.copyOf()
      }

      override fun tseChunk(wav: FloatArray, wavLen: Int, kFrames: Int, framesOut: FloatArray) {
        // Owner passes at 1.0x; solo imposter is attenuated by -26 dB (0.05x -> tseAttenDb ~ -26 dB).
        val gain = if (currentIsOwner) 1.0f else 0.05f
        for (fi in 0 until kFrames) {
          val wOff = fi * VoxLockStreamer.HOP
          val fOff = fi * VoxLockStreamer.N_FFT
          for (j in 0 until VoxLockStreamer.N_FFT) {
            framesOut[fOff + j] = wav[wOff + j] * VoxLockStreamer.WIN_SQ[j] * gain
          }
        }
      }
    }

    val emittedBytes = ByteArrayOutputStream()
    var pushCalls = 0
    var zeroBytePushCalls = 0

    val vf = VoiceFilter(
      backend = backend,
      o = VoiceFilter.Options(
        denoise = true,
        enrolled = ownerEmb,
        prototypes = listOf(ownerEmb),
        ownerSample = FloatArray(VoiceModelManager.OWNER_SAMPLE_SAMPLES) { 0.1f },
        threshold = 0.45f,
        captureMissingSample = true,
      ),
      worker = { it.run() },
      emit = { buf, off, len ->
        if (len > 0) emittedBytes.write(buf, off, len)
      },
      onUtterance = { utterances.add(it) },
      onOwnerSampleCaptured = { capturedSamples.add(it) },
    )

    fun pushSegment(seconds: Float, speech: Boolean, owner: Boolean, frameSamples: Int = 320): ByteArray {
      currentSpeech = speech
      currentIsOwner = owner
      val totalSamples = (seconds * VOICE_RATE).toInt()
      val segOut = ByteArrayOutputStream()
      var idx = 0
      val rawFloats = FloatArray(frameSamples)
      val rawPcm = ByteArray(frameSamples * 2)
      while (idx < totalSamples) {
        val n = minOf(frameSamples, totalSamples - idx)
        for (i in 0 until n) {
          val s = idx + i
          rawFloats[i] = if (speech) (0.35 * sin(2.0 * PI * 320.0 * s / VOICE_RATE)).toFloat() else 0f
        }
        floatToPcm16(rawFloats, 0, n, rawPcm, 0)
        val before = emittedBytes.size()
        vf.push(rawPcm, 0, n * 2)
        val after = emittedBytes.size()
        pushCalls++
        if (n >= VoiceFilter.HOP && after == before) zeroBytePushCalls++
        val all = emittedBytes.toByteArray()
        segOut.write(all, before, after - before)
        idx += n
      }
      return segOut.toByteArray()
    }

    // 1. 0.3 s silence -> 3.6 s owner speech -> 0.6 s silence -> 1.2 s imposter speech -> 1.0 s owner speech.
    pushSegment(0.3f, speech = false, owner = true, frameSamples = 320)
    val ownerPcm = pushSegment(3.6f, speech = true, owner = true, frameSamples = 320)
    pushSegment(0.6f, speech = false, owner = true, frameSamples = 320)
    val imposterPcm = pushSegment(1.2f, speech = true, owner = false, frameSamples = 320)
    pushSegment(0.6f, speech = false, owner = true, frameSamples = 320)
    val ownerRecoveryPcm = pushSegment(1.0f, speech = true, owner = true, frameSamples = 320)

    // ZERO-STALL INVARIANT: every 20ms push emitted exact 20ms of audio, hopsIn == hopsOut!
    assertEquals("zero stalled pushes", 0, zeroBytePushCalls)
    assertEquals("continuous 1:1 hop emission", vf.hopsIn, vf.hopsOut)
    assertEquals("exact total PCM16 byte count", vf.hopsIn * VoiceFilter.HOP * 2, emittedBytes.size().toLong())

    // STAGE 1/2 PIPELINE ORDER INVARIANT: DPDFNet (0.5x) -> VoxLock TSE runs BEFORE Silero VAD + SV.
    // Input 0.35 peak sine has HPF RMS ~ 0.24; post-DPDFNet owner TSE RMS is ~ 0.12 (never raw >0.20),
    // and post-TSE imposter (0.05x) drops below 0.05 before hitting `embed`.
    assertTrue("SV ran multiple owner checks", ownerEmbedRms.isNotEmpty())
    assertTrue("SV ran imposter checks", imposterEmbedRms.isNotEmpty())
    for (rms in ownerEmbedRms) {
      assertTrue("embed received DPDFNet->TSE owner audio (rms=$rms, expected 0.07..0.16)", rms in 0.07f..0.16f)
    }
    assertTrue(
      "embed received TSE-attenuated imposter audio (minRms=${imposterEmbedRms.min()})",
      imposterEmbedRms.min() < 0.05f,
    )

    // Owner audio stayed loud and unclipped; tail of confirmed imposter speech ramped to silence.
    val ownerFloats = FloatArray(ownerPcm.size / 2).also { pcm16ToFloat(ownerPcm, 0, ownerPcm.size, it, 0) }
    val ownerTailRms = rmsFloat(ownerFloats, ownerFloats.size / 2, ownerFloats.size / 2)
    assertTrue("owner speech preserved (rms=$ownerTailRms)", ownerTailRms > 0.05f)

    val impFloats = FloatArray(imposterPcm.size / 2).also { pcm16ToFloat(imposterPcm, 0, imposterPcm.size, it, 0) }
    val impTailRms = rmsFloat(impFloats, impFloats.size * 2 / 3, impFloats.size / 3)
    assertEquals("confirmed imposter residual ramped to 0.0f", 0f, impTailRms, 1e-4f)

    val recFloats = FloatArray(ownerRecoveryPcm.size / 2).also { pcm16ToFloat(ownerRecoveryPcm, 0, ownerRecoveryPcm.size, it, 0) }
    val recTailRms = rmsFloat(recFloats, recFloats.size / 2, recFloats.size / 2)
    assertTrue("owner recovery immediately audible without hold (rms=$recTailRms)", recTailRms > 0.05f)

    // Auto-backfill captured 48_000 clean HPF samples during the 3.6 s high-confidence owner turn!
    assertEquals("owner sample captured once", 1, capturedSamples.size)
    assertEquals("owner sample is 48_000 samples", VoiceModelManager.OWNER_SAMPLE_SAMPLES, capturedSamples[0].size)
    assertTrue("utterance telemetry recorded pass and block", utterances.any { it.pass } && utterances.any { !it.pass })
  }

  @Test
  fun overloadGuardStepsUpToK8AndBypassesWithoutDroppingFrames() {
    val overloads = ArrayList<String>()
    val slowBackend = object : VoiceBackend {
      override val hasSpeaker: Boolean = false
      override val hasTse: Boolean = true
      override fun reset() {}
      override fun denoise(x: FloatArray, off: Int, out: FloatArray, outOff: Int): Boolean {
        System.arraycopy(x, off, out, outOff, Denoiser.HOP)
        return true
      }
      override fun vadProb(win: FloatArray, off: Int): Float = 0.8f
      override fun embed(x: FloatArray, off: Int, len: Int): FloatArray = FloatArray(192)
      override fun tseChunk(wav: FloatArray, wavLen: Int, kFrames: Int, framesOut: FloatArray) {
        // Sleep >38ms on K=5 and >60ms on K=8 to deterministically trigger step_k8 then bypass_tse.
        Thread.sleep(if (kFrames <= 5) 42L else 64L)
      }
    }

    val vf = VoiceFilter(
      backend = slowBackend,
      o = VoiceFilter.Options(
        denoise = false,
        enrolled = null,
        ownerSample = FloatArray(VoiceModelManager.OWNER_SAMPLE_SAMPLES) { 0.05f },
      ),
      worker = { it.run() },
      emit = { _, _, _ -> },
      onOverload = { action, _ -> overloads.add(action) },
    )

    val hopBytes = ByteArray(VoiceFilter.HOP * 2)
    // Feed 60 hops (600 ms): enough for 3 slow K=5 chunks -> step_k8, then 3 slow K=8 chunks -> bypass_tse.
    repeat(60) { vf.push(hopBytes, 0, hopBytes.size) }

    assertEquals("step_k8 then bypass_tse", listOf("step_k8", "bypass_tse"), overloads)
    assertTrue("tseBypassed active after persistent overload", vf.tseBypassed)
    assertEquals("100% continuous frames emitted despite overload", 60L, vf.hopsOut)
  }

  @Test
  fun ownerOnlyWithoutAnySpeakerOrTseEmitsSilenceAndDegradesToSvWhenAvailable() {
    val noModels = isolationBackend(hasTse = false, hasSpeaker = false)
    val input = loudHop()
    val out = ByteArrayOutputStream()
    val strict = VoiceFilter(
      backend = noModels,
      o = VoiceFilter.Options(denoise = true, enrolled = floatArrayOf(1f)),
      worker = { it.run() },
      emit = { b, off, n -> out.write(b, off, n) },
    )
    repeat(70) { strict.push(input, 0, input.size) }
    assertEquals(70 * input.size, out.size())
    assertTrue("no TSE and no SV admits zero mixture PCM", out.toByteArray().all { it == 0.toByte() })

    out.reset()
    val ordinary = VoiceFilter(
      backend = noModels,
      o = VoiceFilter.Options(denoise = false, enrolled = null),
      worker = { it.run() },
      emit = { b, off, n -> out.write(b, off, n) },
    )
    ordinary.push(input, 0, input.size)
    assertTrue("disabling voiceprint filtering still sends ordinary mic audio", input.contentEquals(out.toByteArray()))
  }

  @Test
  fun tseBypassWithSpeakerVerificationDegradesGracefullyInsteadOfMutingOwner() {
    val ownerEmb = normalizeEmbedding(FloatArray(192) { if (it == 0) 1f else 0f })
    val otherEmb = normalizeEmbedding(FloatArray(192) { if (it == 1) 1f else 0f })
    var currentIsOwner = true
    val backend = object : VoiceBackend {
      override val hasSpeaker = true
      override val hasTse = false
      override fun reset() {}
      override fun denoise(x: FloatArray, off: Int, out: FloatArray, outOff: Int): Boolean {
        System.arraycopy(x, off, out, outOff, Denoiser.HOP)
        return true
      }
      override fun vadProb(win: FloatArray, off: Int) = 0.95f
      override fun embed(x: FloatArray, off: Int, len: Int) = if (currentIsOwner) ownerEmb else otherEmb
      override fun tseChunk(wav: FloatArray, wavLen: Int, kFrames: Int, framesOut: FloatArray) {}
    }

    val ownerOut = ByteArrayOutputStream()
    val otherOut = ByteArrayOutputStream()
    var activeOut = ownerOut
    val vf = VoiceFilter(
      backend = backend,
      o = VoiceFilter.Options(denoise = true, enrolled = ownerEmb, threshold = 0.40f, requireIsolation = true),
      worker = { it.run() },
      emit = { b, off, n -> activeOut.write(b, off, n) },
    )
    val hop = loudHop()
    repeat(80) { vf.push(hop, 0, hop.size) } // 800 ms owner speech
    currentIsOwner = false
    activeOut = otherOut
    repeat(120) { vf.push(hop, 0, hop.size) } // 1200 ms non-owner speech

    val ownerBytes = ownerOut.toByteArray()
    val ownerFloats = FloatArray(ownerBytes.size / 2).also { pcm16ToFloat(ownerBytes, 0, ownerBytes.size, it, 0) }
    assertTrue("owner speech preserved in SV-only tier (rms=${rmsFloat(ownerFloats)})", rmsFloat(ownerFloats) > 0.10f)

    val otherBytes = otherOut.toByteArray()
    val otherFloats = FloatArray(otherBytes.size / 2).also { pcm16ToFloat(otherBytes, 0, otherBytes.size, it, 0) }
    assertEquals("imposter tail ramped to 0 in SV-only tier", 0f, rmsFloat(otherFloats, otherFloats.size * 2 / 3, otherFloats.size / 3), 1e-4f)
  }

  @Test
  fun lockFirstSpeakerCapturesSessionSpeakerAndGatesSecondSpeaker() {
    val firstEmb = normalizeEmbedding(FloatArray(192) { if (it == 0) 1f else 0f })
    val secondEmb = normalizeEmbedding(FloatArray(192) { if (it == 2) 1f else 0f })
    var speakerOne = true
    var speechOn = true
    val verdicts = ArrayList<Boolean>()
    val backend = object : VoiceBackend {
      override val hasSpeaker = true
      override val hasTse = false
      override fun reset() {}
      override fun denoise(x: FloatArray, off: Int, out: FloatArray, outOff: Int): Boolean {
        System.arraycopy(x, off, out, outOff, Denoiser.HOP)
        return true
      }
      override fun vadProb(win: FloatArray, off: Int) = if (speechOn) 0.95f else 0.01f
      override fun embed(x: FloatArray, off: Int, len: Int) = if (speakerOne) firstEmb else secondEmb
      override fun tseChunk(wav: FloatArray, wavLen: Int, kFrames: Int, framesOut: FloatArray) {}
    }

    val secondOut = ByteArrayOutputStream()
    var recordSecond = false
    val vf = VoiceFilter(
      backend = backend,
      o = VoiceFilter.Options(denoise = true, enrolled = null, threshold = 0.40f, requireIsolation = false, lockFirstSpeaker = true),
      worker = { it.run() },
      emit = { b, off, n -> if (recordSecond) secondOut.write(b, off, n) },
      onUtterance = { verdicts.add(it.pass) },
    )
    val hop = loudHop()
    val silence = ByteArray(hop.size)
    // 1.2s first speaker -> pause -> 1.2s second speaker
    repeat(120) { vf.push(hop, 0, hop.size) }
    speechOn = false
    repeat(60) { vf.push(silence, 0, silence.size) }
    speechOn = true
    speakerOne = false
    recordSecond = true
    repeat(120) { vf.push(hop, 0, hop.size) }

    assertTrue("first speaker passed and second speaker blocked ($verdicts)", verdicts.any { it } && verdicts.any { !it })
    val sBytes = secondOut.toByteArray()
    val sFloats = FloatArray(sBytes.size / 2).also { pcm16ToFloat(sBytes, 0, sBytes.size, it, 0) }
    assertEquals("second speaker tail gated to 0", 0f, rmsFloat(sFloats, sFloats.size * 2 / 3, sFloats.size / 3), 1e-4f)
  }

  @Test
  fun ownerOnlyOverloadEmitsSilenceWhenSvMissingThenResumesFromFreshTseState() {
    val out = ByteArrayOutputStream()
    val tasks = ArrayDeque<Runnable>()
    val actions = ArrayList<String>()
    var resets = 0
    val vf = VoiceFilter(
      backend = isolationBackend(hasTse = true, hasSpeaker = false, onReset = { resets++ }),
      o = VoiceFilter.Options(denoise = false, enrolled = floatArrayOf(1f)),
      worker = { it.run() },
      tseWorker = { tasks.addLast(it) },
      emit = { b, off, n -> out.write(b, off, n) },
      onOverload = { reason, _ -> actions.add(reason) },
    )
    val input = loudHop()
    repeat(40) { vf.push(input, 0, input.size) }
    assertTrue(vf.tseBypassed)
    assertEquals(listOf("bypass_backlog"), actions)
    assertEquals(1, tasks.size)
    assertEquals(input.size * 40, out.size())
    assertTrue(out.toByteArray().all { it == 0.toByte() })

    tasks.removeFirst().run() // Stale result must not be played after recovery.
    repeat(45) {
      vf.push(input, 0, input.size)
      while (tasks.isNotEmpty()) tasks.removeFirst().run()
    }
    assertEquals(listOf("bypass_backlog", "retry_k8"), actions)
    assertEquals(1, resets)
    assertTrue(vf.isTseActive)
    assertEquals(input.size * 85, out.size())
    assertTrue("fresh extraction resumes without releasing the dry mic path", out.toByteArray().drop(input.size * 40).any { it != 0.toByte() })
  }

  private fun loudHop(): ByteArray {
    val samples = FloatArray(VoiceFilter.HOP) { i -> (0.35 * sin(2.0 * PI * 320 * i / VOICE_RATE)).toFloat() }
    return ByteArray(VoiceFilter.HOP * 2).also { floatToPcm16(samples, 0, samples.size, it, 0) }
  }

  private fun isolationBackend(hasTse: Boolean, hasSpeaker: Boolean = true, onReset: () -> Unit = {}): VoiceBackend = object : VoiceBackend {
    override val hasSpeaker = hasSpeaker
    override val hasTse = hasTse
    override fun reset() {}
    override fun resetTse() = onReset()
    override fun denoise(x: FloatArray, off: Int, out: FloatArray, outOff: Int): Boolean {
      System.arraycopy(x, off, out, outOff, Denoiser.HOP)
      return true
    }
    override fun vadProb(win: FloatArray, off: Int) = 0.95f
    override fun embed(x: FloatArray, off: Int, len: Int) = floatArrayOf(1f)
    override fun tseChunk(wav: FloatArray, wavLen: Int, kFrames: Int, framesOut: FloatArray) {
      for (f in 0 until kFrames) {
        for (i in 0 until VoxLockStreamer.N_FFT) {
          framesOut[f * VoxLockStreamer.N_FFT + i] = wav[f * VoxLockStreamer.HOP + i] * VoxLockStreamer.WIN_SQ[i]
        }
      }
    }
  }

  @Test
  fun multiPrototypeScoringAndSpeechCollectorEnrollment() {
    // 1. Multi-prototype scoring formula: 0.65 * cosine(e, mean) + 0.35 * maxProtoCosine(e, protos).
    val protoNormal = normalizeEmbedding(FloatArray(192) { if (it == 0) 1f else 0f })
    val protoWhisper = normalizeEmbedding(FloatArray(192) { if (it == 0) 0.45f else if (it == 1) 0.89f else 0f })
    val mean = meanEmbedding(listOf(protoNormal, protoWhisper))
    val protos = listOf(protoNormal, protoWhisper)

    // Probe closely matching `protoWhisper`:
    val probe = normalizeEmbedding(FloatArray(192) { if (it == 0) 0.40f else if (it == 1) 0.91f else 0f })
    val sv = scoreVoiceprint(probe, mean, protos, sessionNorm = null, threshold = 0.45f)
    val expected = 0.65f * cosine(probe, mean) + 0.35f * maxOf(cosine(probe, protoNormal), cosine(probe, protoWhisper))
    assertEquals(expected, sv.combined, 1e-5f)
    assertTrue("multi-prototype lifts prosody variant above raw centroid cosine", sv.combined > sv.rawMean)

    // Imposter orthogonal to all prototypes stays near 0.
    val imposter = normalizeEmbedding(FloatArray(192) { if (it == 5) 1f else 0f })
    val impSv = scoreVoiceprint(imposter, mean, protos, sessionNorm = null, threshold = 0.45f)
    assertEquals(0f, impSv.combined, 1e-5f)
    assertFalse(impSv.effective >= 0.45f)

    // 2. SpeechCollector selects up to 6 diverse prototypes, filters outliers, and picks loudest unclipped 3.0s sample.
    var pieceCall = 0
    val collector = SpeechCollector(
      embedder = { _, _, _ ->
        val idx = pieceCall++
        if (idx == 2) {
          // Inject 1 noise/cough outlier piece orthogonal to owner!
          FloatArray(192) { if (it == 50) 1f else 0f }
        } else {
          FloatArray(192) { d ->
            when (d) {
              0 -> 1.0f
              (idx % 8) + 1 -> 0.25f
              else -> 0f
            }
          }
        }
      },
      vadFn = { w, off -> if (rmsFloat(w, off, Vad.WINDOW) > 0.02f) 0.90f else 0.05f },
    )

    fun feedTone(sec: Float, amp: Float) {
      val n = (sec * VOICE_RATE).toInt()
      val f = FloatArray(n) { i -> (amp * sin(2.0 * PI * 300.0 * i / VOICE_RATE)).toFloat() }
      val pcm = ByteArray(n * 2)
      floatToPcm16(f, 0, n, pcm, 0)
      collector.push(pcm, 0, pcm.size)
    }

    feedTone(0.5f, 0.002f) // background room noise for SNR floor
    feedTone(3.2f, 0.12f) // quieter speech first
    feedTone(3.5f, 0.42f) // cleaner louder speech second (should be chosen as ownerSample!)

    val vp = collector.voiceprint(minSeconds = 3.5f)
    assertNotNull(vp)
    assertEquals("capped at 6 diverse prototypes", 6, vp!!.prototypes.size)
    assertEquals("ownerSample exact 48_000 samples", VoiceModelManager.OWNER_SAMPLE_SAMPLES, vp.ownerSample.size)
    assertTrue("chose louder 0.42 amp speech slice (rms > 0.24)", rmsFloat(vp.ownerSample) > 0.24f)
    assertTrue("SNR > 20 dB (got ${vp.snrDb})", vp.snrDb > 20f)
    assertTrue("outlier filtered so lowest consistency stays high (${vp.lowest})", vp.lowest > 0.90f)
  }

  private fun enrolledStage2Filter(
    enhanceVocal: Boolean = false,
    hasTse: Boolean = false,
    vadProbFn: () -> Float = { 0.92f },
    embedFn: () -> FloatArray = { floatArrayOf(1f, 0f, 0f, 0f) },
    emit: (ByteArray, Int, Int) -> Unit = { _, _, _ -> },
  ): VoiceFilter {
    val ownerEmb = normalizeEmbedding(floatArrayOf(1f, 0f, 0f, 0f))
    val backend = object : VoiceBackend {
      override val hasSpeaker = true
      override val hasTse = hasTse
      override fun reset() {}
      override fun denoise(x: FloatArray, off: Int, out: FloatArray, outOff: Int): Boolean {
        System.arraycopy(x, off, out, outOff, Denoiser.HOP)
        return true
      }
      override fun vadProb(win: FloatArray, off: Int): Float = vadProbFn()
      override fun embed(x: FloatArray, off: Int, len: Int): FloatArray = embedFn()
      override fun tseChunk(wav: FloatArray, wavLen: Int, kFrames: Int, framesOut: FloatArray) {
        for (f in 0 until kFrames) {
          for (i in 0 until VoxLockStreamer.N_FFT) {
            framesOut[f * VoxLockStreamer.N_FFT + i] = wav[f * VoxLockStreamer.HOP + i] * VoxLockStreamer.WIN_SQ[i]
          }
        }
      }
    }
    return VoiceFilter(
      backend = backend,
      o = VoiceFilter.Options(
        denoise = false,
        enrolled = ownerEmb,
        prototypes = listOf(ownerEmb),
        threshold = 0.40f,
        requireIsolation = true,
        route = "headset",
        enhanceVocal = enhanceVocal,
      ),
      worker = { it.run() },
      emit = emit,
    )
  }

  private fun toneFrame320(frameIdx: Int, amp: Double, freqHz: Double): ByteArray {
    val samples = FloatArray(320) { i ->
      val idx = frameIdx * 320 + i
      (amp * sin(2.0 * PI * freqHz * idx / VOICE_RATE)).toFloat()
    }
    return ByteArray(320 * 2).also { floatToPcm16(samples, 0, samples.size, it, 0) }
  }

  private fun pcmRms(pcm: ByteArray): Float {
    val f = FloatArray(pcm.size / 2)
    pcm16ToFloat(pcm, 0, pcm.size, f, 0)
    return rmsFloat(f)
  }

  @Test
  fun residualGateClosesOnNonOwnerAtModerateTseAttenuationAndStrongSv() {
    val vf = enrolledStage2Filter(enhanceVocal = false)
    vf.speaking = true

    // 1) Borderline non-owner score (~0.35 < 0.39) + moderate TSE attenuation (-4.0 dB,
    //    strictly above the old -9.0 dB deadlock) MUST close the residual gate.
    vf.smoothedTseAttenDb = -4.0f
    vf.applySvEmbedding(floatArrayOf(0.35f, 0.9367f, 0f, 0f), VOICE_RATE, kind = "early", usedTse = true)
    assertTrue(vf.svConfirmedNonOwner)
    vf.updateResidualGate(usedTse = true)
    assertTrue(
      "expected residual gate to close at -4.0 dB TSE attenuation (above old -9.0 dB deadlock)",
      vf.suppressingResidual,
    )

    // Hysteresis + release hold: rising slightly to -1.8 dB (below -1.2 dB open threshold)
    // must keep the gate closed without chattering.
    vf.smoothedTseAttenDb = -1.8f
    vf.updateResidualGate(usedTse = true)
    assertTrue("expected hysteresis to prevent chatter at -1.8 dB", vf.suppressingResidual)

    // Rising above -1.2 dB opens smoothly only after GATE_RELEASE_HOLD_FRAMES (2) when SV score is borderline.
    vf.smoothedTseAttenDb = -0.8f
    vf.updateResidualGate(usedTse = true)
    assertTrue("expected 1st release frame to hold against chatter", vf.suppressingResidual)
    vf.updateResidualGate(usedTse = true)
    assertFalse("expected gate to release after hold when non-strong & >= -1.2 dB", vf.suppressingResidual)

    // 2) Dual-talk safety margin: a single borderline SV miss (~0.36) with minimal TSE
    //    attenuation (-1.0 dB) stays open to avoid chopping owner during dual-talk.
    vf.resetUtteranceSv()
    vf.smoothedTseAttenDb = -1.0f
    vf.applySvEmbedding(floatArrayOf(0.36f, 0.933f, 0f, 0f), VOICE_RATE, kind = "early", usedTse = true)
    vf.updateResidualGate(usedTse = true)
    assertFalse(
      "single borderline SV miss with -1.0 dB TSE attenuation should keep dual-talk safety margin open",
      vf.suppressingResidual,
    )

    // Second consecutive non-owner SV verdict confirms non-owner and closes the gate even at -1.0 dB.
    vf.applySvEmbedding(floatArrayOf(0.36f, 0.933f, 0f, 0f), VOICE_RATE, kind = "recheck", usedTse = true)
    vf.updateResidualGate(usedTse = true)
    assertTrue(
      "consecutive non-owner SV verdicts must close residual gate even with mild TSE attenuation",
      vf.suppressingResidual,
    )

    // 3) Clear low cosine similarity (orthogonal stranger ~0.0 << 0.40 - 0.06) closes the gate
    //    immediately even if VoxLock barely attenuated (-0.5 dB).
    vf.resetUtteranceSv()
    vf.suppressingResidual = false
    vf.smoothedTseAttenDb = -0.5f
    vf.applySvEmbedding(floatArrayOf(0f, 1f, 0f, 0f), VOICE_RATE, kind = "early", usedTse = true)
    vf.updateResidualGate(usedTse = true)
    assertTrue(
      "clear non-owner SV score must close residual gate even at -0.5 dB TSE attenuation",
      vf.suppressingResidual,
    )
  }

  @Test
  fun ownerSpeechStaysOpenWithoutFalseSuppressionUnderTseAttenuation() {
    val lastOut = ByteArrayOutputStream()
    val vf = enrolledStage2Filter(
      enhanceVocal = false,
      emit = { b, off, len -> lastOut.write(b, off, len) },
    )
    vf.speaking = true

    val tone = toneFrame320(0, amp = 0.40, freqHz = 700.0)

    // Unverified onset before SV verdict applies gentle attenuation (not full 1.0 blast).
    vf.push(tone, 0, tone.size)
    lastOut.reset()
    vf.push(tone, 0, tone.size)
    val onsetRms = pcmRms(lastOut.toByteArray())
    assertTrue(
      "expected unverified onset attenuation before owner confirmation, got onsetGain=${vf.onsetGain}",
      vf.onsetGain < 0.70f,
    )

    // Once SV confirms owner (even when TSE attenuated an overlapping interferer by -4 dB or -10 dB),
    // gate stays completely open and onsetGain attacks rapidly back to 1.0.
    vf.smoothedTseAttenDb = -4.0f
    vf.applySvEmbedding(floatArrayOf(0.98f, 0.1f, 0f, 0f), VOICE_RATE, kind = "early", usedTse = true)
    vf.updateResidualGate(usedTse = true)
    assertFalse("owner must never be suppressed at -4.0 dB TSE attenuation", vf.suppressingResidual)

    vf.smoothedTseAttenDb = -10.0f
    vf.updateResidualGate(usedTse = true)
    assertFalse("owner must never be suppressed at -10.0 dB TSE attenuation", vf.suppressingResidual)

    lastOut.reset()
    vf.push(tone, 0, tone.size)
    val ownerRms = pcmRms(lastOut.toByteArray())
    assertTrue(
      "expected fast attack to 1.0 once owner confirmed, got ${vf.onsetGain}",
      abs(vf.onsetGain - 1.0f) < 1e-4f,
    )
    assertTrue(
      "expected full unattenuated owner level > onset (owner=$ownerRms, onset=$onsetRms)",
      ownerRms > onsetRms * 1.4f && ownerRms > 0.20f,
    )
  }

  @Test
  fun vocalEnhancerDoesNotBoostConfirmedNonOwnerOrUnverifiedFrames() {
    val refPcm = toneFrame320(0, amp = 0.06, freqHz = 2500.0)
    val inFloats = FloatArray(320).also { pcm16ToFloat(refPcm, 0, refPcm.size, it, 0) }
    val inRms = rmsFloat(inFloats)

    // 1) Confirmed owner: VocalEnhancer boosts presence & quiet level.
    val ownerOut = ByteArrayOutputStream()
    val vfOwner = enrolledStage2Filter(
      enhanceVocal = true,
      emit = { b, off, len -> ownerOut.write(b, off, len) },
    )
    vfOwner.speaking = true
    vfOwner.applySvEmbedding(floatArrayOf(0.99f, 0.05f, 0f, 0f), VOICE_RATE, kind = "early", usedTse = false)
    assertTrue("confirmed owner must allow vocal boost", vfOwner.allowVocalBoost())
    var lastOwnerFrame = ByteArray(0)
    for (f in 0 until 8) {
      ownerOut.reset()
      val frame = toneFrame320(f, amp = 0.06, freqHz = 2500.0)
      vfOwner.push(frame, 0, frame.size)
      lastOwnerFrame = ownerOut.toByteArray()
    }
    val ownerRms = pcmRms(lastOwnerFrame)
    assertTrue(
      "expected confirmed owner 2.5 kHz speech boosted (in=$inRms, owner=$ownerRms)",
      ownerRms > inRms * 1.15f,
    )

    // 2) Confirmed non-owner: allowVocalBoost() MUST be false, VocalEnhancer MUST NOT boost
    //    (nor let rms >= 0.025 pollute noise floor), and residual gate mutes output to 0.
    val strangerOut = ByteArrayOutputStream()
    val vfStranger = enrolledStage2Filter(
      enhanceVocal = true,
      embedFn = { floatArrayOf(0f, 1f, 0f, 0f) },
      emit = { b, off, len -> strangerOut.write(b, off, len) },
    )
    vfStranger.speaking = true
    vfStranger.applySvEmbedding(floatArrayOf(0f, 1f, 0f, 0f), VOICE_RATE, kind = "early", usedTse = false)
    vfStranger.updateResidualGate(usedTse = false)
    assertFalse("vocal enhancer boost must be blocked for confirmed non-owner", vfStranger.allowVocalBoost())

    val unboosted = FloatArray(320)
    vfStranger.enhancer!!.process(inFloats, unboosted, 320, allowBoost = vfStranger.allowVocalBoost())
    val unboostedRms = rmsFloat(unboosted)
    assertTrue(
      "confirmed non-owner frame must never be boosted by VocalEnhancer (in=$inRms, out=$unboostedRms)",
      unboostedRms <= inRms * 1.01f,
    )
    val f0 = toneFrame320(0, amp = 0.06, freqHz = 2500.0)
    val f1 = toneFrame320(1, amp = 0.06, freqHz = 2500.0)
    vfStranger.push(f0, 0, f0.size)
    strangerOut.reset()
    vfStranger.push(f1, 0, f1.size)
    val mutedBytes = strangerOut.toByteArray()
    assertTrue("confirmed non-owner frame must be muted to 0", mutedBytes.all { it == 0.toByte() })

    // 3) Unverified speech onset (before SV confirms owner): NEVER boosted, gently attenuated.
    val onsetOut = ByteArrayOutputStream()
    val vfOnset = enrolledStage2Filter(
      enhanceVocal = true,
      emit = { b, off, len -> onsetOut.write(b, off, len) },
    )
    vfOnset.speaking = true
    assertFalse("vocal enhancer boost must be blocked during unverified speech onset", vfOnset.allowVocalBoost())
    var lastOnsetFrame = ByteArray(0)
    for (f in 0 until 4) {
      onsetOut.reset()
      val frame = toneFrame320(f, amp = 0.06, freqHz = 2500.0)
      vfOnset.push(frame, 0, frame.size)
      lastOnsetFrame = onsetOut.toByteArray()
    }
    val onsetRms = pcmRms(lastOnsetFrame)
    assertTrue(
      "unverified onset must be gently attenuated and never boosted (in=$inRms, onset=$onsetRms)",
      onsetRms < inRms,
    )

    // 4) Noise-floor cap on `!allowBoost`: loud unverified/non-owner frames (rms >= 0.025)
    //    must NOT pollute VocalEnhancer noise floor, so subsequent confirmed owner speech boosts cleanly.
    val enh = VocalEnhancer()
    val loudHop = FloatArray(VoiceFilter.HOP) { i -> (0.25 * sin(2.0 * PI * 1000.0 * i / VOICE_RATE)).toFloat() }
    val quietHop = FloatArray(VoiceFilter.HOP) { i -> (0.06 * sin(2.0 * PI * 2500.0 * i / VOICE_RATE)).toFloat() }
    val scratch = FloatArray(VoiceFilter.HOP)
    repeat(40) { enh.process(loudHop, scratch, VoiceFilter.HOP, allowBoost = false) }
    repeat(8) { enh.process(quietHop, scratch, VoiceFilter.HOP, allowBoost = true) }
    val quietInRms = rmsFloat(quietHop)
    val recoveredOutRms = rmsFloat(scratch)
    assertTrue(
      "loud !allowBoost frames must not pollute noise floor (in=$quietInRms, out=$recoveredOutRms)",
      recoveredOutRms > quietInRms * 1.15f,
    )
  }

  @Test
  fun earlySvWindowIsTightenedAndUtteranceEndResetsSvAndTseState() {
    assertTrue(
      "EARLY_VOICED_W should be tightened from 13 to reduce initial unverified speech leak",
      VoiceFilter.EARLY_VOICED_W <= 10,
    )
    assertEquals("EARLY_VOICED_W tightened to 8", 8, VoiceFilter.EARLY_VOICED_W)
    assertEquals("FULL_VOICED_W tightened to 22", 22, VoiceFilter.FULL_VOICED_W)
    assertEquals("RECHECK_STEP_W tightened to 16", 16, VoiceFilter.RECHECK_STEP_W)
    assertEquals("1.0s recheck window for faster speaker handoff", VOICE_RATE, VoiceFilter.RECHECK_WINDOW_SAMPLES)

    var speechActive = false
    val vf = enrolledStage2Filter(
      enhanceVocal = false,
      hasTse = true,
      vadProbFn = { if (speechActive) 0.92f else 0.02f },
    )
    vf.speaking = true
    vf.smoothedTseAttenDb = -8.0f
    vf.applySvEmbedding(floatArrayOf(0f, 1f, 0f, 0f), VOICE_RATE, kind = "early", usedTse = true)
    vf.updateResidualGate(usedTse = true)
    assertTrue("non-owner at -8.0 dB must be suppressing", vf.suppressingResidual)

    // Feed silence frames until END_WINDOWS (12 * 512 = 6144 samples -> 22 frames of 320 = 7040 samples).
    val silence320 = ByteArray(320 * 2)
    repeat(22) { vf.push(silence320, 0, silence320.size) }

    assertFalse("silence must end active utterance", vf.speaking)
    assertFalse("utterance end must clear residual suppression", vf.suppressingResidual)
    assertFalse("utterance end must clear svConfirmedNonOwner", vf.svConfirmedNonOwner)
    assertFalse("utterance end must clear svConfirmedOwner", vf.svConfirmedOwner)
    assertEquals("utterance end must clear stale smoothedTseAttenDb", 0f, vf.smoothedTseAttenDb, 1e-6f)
    assertEquals("utterance end must clear nonOwnerStreak", 0, vf.nonOwnerStreak)
  }
}
