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
    val embedInputsRms = ArrayList<Float>()
    val utterances = ArrayList<VoiceFilter.UtteranceTelemetry>()
    val capturedSamples = ArrayList<FloatArray>()

    val backend = object : VoiceBackend {
      override val hasSpeaker: Boolean = true
      override val hasTse: Boolean = true
      override fun reset() {}

      override fun denoise(x: FloatArray, off: Int, out: FloatArray, outOff: Int): Boolean {
        // Deliberately scale denoiser output by 0.5x so we can prove `embed` NEVER sees denoised audio!
        for (i in 0 until Denoiser.HOP) out[outOff + i] = x[off + i] * 0.5f
        return true
      }

      override fun vadProb(win: FloatArray, off: Int): Float = if (currentSpeech) 0.92f else 0.02f

      override fun embed(x: FloatArray, off: Int, len: Int): FloatArray {
        embedInputsRms.add(rmsFloat(x, off, len))
        return if (currentIsOwner) ownerEmb.copyOf() else imposterEmb.copyOf()
      }

      override fun tseChunk(wav: FloatArray, wavLen: Int, kFrames: Int, framesOut: FloatArray) {
        // Owner passes at 1.0x; solo imposter is attenuated by -26 dB (0.05x -> tseAttenDb ~ -26 dB < -9 dB).
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

    // CLEAN-PATH DECOUPLING INVARIANT: 0.35 peak sine wave has RMS ~ 0.247; HighPass64 at 320 Hz keeps ~0.24.
    // Had denoised audio (0.5x) leaked into `embed`, RMS would have dropped to ~0.12!
    assertTrue("SV ran multiple checks", embedInputsRms.isNotEmpty())
    for (rms in embedInputsRms) {
      assertTrue("embed received clean HPF audio (rms=$rms, expected >0.20)", rms > 0.20f)
    }

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
}
