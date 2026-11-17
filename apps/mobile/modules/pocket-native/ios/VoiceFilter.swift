import Foundation

/// Zero-stall continuous streaming voice pipeline:
/// - Clean Path A: Mic PCM16 -> HighPass64 -> Silero VAD + ERes2NetV2-zh multi-prototype SV (NEVER denoised/TSE audio).
/// - Audio Path B: HighPass64 -> VoxLock v2 INT8 TSE (40 ms async ring) -> DPDFNet-baseline (10 ms Vorbis STFT) -> VocalEnhancer -> 16 ms cosine residual gate -> continuous PCM16 stream.
final class VoiceFilter {
  struct Options {
    let denoise: Bool
    let enrolled: [Float]?
    let prototypes: [[Float]]
    let threshold: Float
    let tseEnrollment: VoxLockEnrollment?
    let needAutoOwnerSample: Bool

    init(
      denoise: Bool,
      enrolled: [Float]?,
      prototypes: [[Float]] = [],
      threshold: Float = 0.38,
      tseEnrollment: VoxLockEnrollment? = nil,
      needAutoOwnerSample: Bool = false
    ) {
      self.denoise = denoise
      self.enrolled = enrolled
      self.prototypes = prototypes
      self.threshold = threshold
      self.tseEnrollment = tseEnrollment
      self.needAutoOwnerSample = needAutoOwnerSample
    }
  }

  struct UtteranceReport {
    let kind: String
    let pass: Bool
    let svScore: Double
    let svRaw: Double
    let svProto: Double
    let svSess: Double
    let svMs: Int64
    let usedMs: Int64
    let vadProb: Double
    let rawDbfs: Double
    let tseDbfs: Double
    let enhDbfs: Double
    let tseAttenDb: Double
    let enhGainDb: Double
  }

  private enum Kind: String {
    case early, full, recheck, end
  }

  private struct SvVerdict {
    let job: Int
    let kind: Kind
    let raw: Float
    let proto: Float
    let blended: Float
    let sessCos: Float
    let score: Float
    let normEmb: [Float]?
    let cleanSamples: [Float]
    let usedSamples: Int
    let ms: Int64
  }

  private static let hop = Denoiser.hop // 160 samples = 10 ms
  private static let rampSamples = 256  // 16 ms raised-cosine ramp
  private static let tsePrebufferSamples = 896 // 56 ms fixed cushion for zero-underflow K=5 streaming
  private static let sendMax = 3_200

  private static let startProb: Float = 0.45
  private static let speechProb: Float = 0.35
  private static let startWindows = 3   // 96 ms
  private static let endWindows = 12    // 384 ms
  private static let earlyVoicedW = 13  // ~416 ms
  private static let fullVoicedW = 26   // ~832 ms
  private static let recheckStepW = 20  // ~640 ms
  private static let minEndVoicedW = 8  // ~256 ms
  private static let maxCleanSpeechSamples = voiceRate * 3 / 2 // 24,000 samples (1.5 s)

  private let m: VoiceModels
  private let o: Options
  private let spkWorker: (@escaping () -> Void) -> Void
  private let tseWorker: (@escaping () -> Void) -> Void
  private let emit: (Data) -> Void
  private let onUtterance: (UtteranceReport) -> Void

  private let hasSv: Bool
  private let enrolledNorm: [Float]?
  private let prototypesNorm: [[Float]]
  private let hpf = HighPass64()
  private let denoiser: Denoiser?
  private let vad: Vad?
  private let vadBoost: QuietVadBoost?
  private let enhancer: VocalEnhancer?
  private let speaker: Speaker?
  private let tse: TargetExtractor?

  // Input staging (160-sample hop)
  private var inBuf = [Float](repeating: 0, count: hop)
  private var hpfBuf = [Float](repeating: 0, count: hop)
  private var tseHopBuf = [Float](repeating: 0, count: hop)
  private var rawAlignedHopBuf = [Float](repeating: 0, count: hop)
  private var dpdfOutBuf = [Float](repeating: 0, count: hop)
  private var enhOutBuf = [Float](repeating: 0, count: hop)
  private var inLen = 0
  private var outFloats: [Float] = []

  // TSE async ring state
  private let tseLock = NSLock()
  private var tseInRing: [Float] = []
  private var tseInRead = 0
  private var tseOutTse: [Float] = []
  private var tseOutRaw: [Float] = []
  private var tseOutRead = 0
  private var tseJobRunning = false
  private var consecutiveSlowTse = 0
  private var _tseBypassed = false
  private var _tseChunks = 0
  private var _tseMsSum = 0.0
  private var _tseMsMax = 0.0
  private var _tseAudioMsSum = 0.0
  private var _tseOverruns = 0

  var tseEnabled: Bool { tse != nil }
  var tseBypassed: Bool { tseLock.lock(); defer { tseLock.unlock() }; return _tseBypassed }
  var tseChunks: Int { tseLock.lock(); defer { tseLock.unlock() }; return _tseChunks }
  var tseMsAvg: Double {
    tseLock.lock(); defer { tseLock.unlock() }
    return _tseChunks > 0 ? _tseMsSum / Double(_tseChunks) : 0.0
  }
  var tseMsMax: Double { tseLock.lock(); defer { tseLock.unlock() }; return _tseMsMax }
  var tseRtf: Double {
    tseLock.lock(); defer { tseLock.unlock() }
    return _tseAudioMsSum > 0 ? _tseMsSum / _tseAudioMsSum : 0.0
  }
  var tseOverruns: Int { tseLock.lock(); defer { tseLock.unlock() }; return _tseOverruns }
  var tseKFrames: Int { tseLock.lock(); defer { tseLock.unlock() }; return tse?.kFrames ?? 0 }
  var svEnabled: Bool { hasSv }

  // Clean VAD + SV state
  private var vadAccum: [Float] = []
  private var cleanWin = [Float](repeating: 0, count: Vad.window)
  private var vadProbeWin = [Float](repeating: 0, count: Vad.window)
  private var cleanSpeechBuf: [Float] = []
  private var unverifiedAutoSpeech: [Float] = []
  private var verifiedOwnerBuf: [Float] = []
  private var needOwnerSample: Bool

  private var speaking = false
  private var startRun = 0
  private var silRun = 0
  private var uttVoicedW = 0
  private var sinceCheckW = 0
  private var earlyTried = false
  private var fullTried = false
  private var lastVadProb: Float = 0

  // Smooth residual gate & rolling acoustic metrics
  private var gatePhase: Int = rampSamples // 256 = gain 1.0 (open), 0 = gain 0.0 (muted)
  private var suppressingResidual = false
  private var svConfirmedNonOwner = false
  private var lastSvScore: Float = 1.0
  private var smoothedTseAttenDb: Double = 0.0
  private var uttRawSqSum = 0.0
  private var uttTseSqSum = 0.0
  private var uttEnhSqSum = 0.0
  private var uttAudioSamples = 0

  private var sessionEmb: [Float]?
  private var jobSeq = 0
  private var activeJob = 0
  private let verdictLock = NSLock()
  private var verdicts: [SvVerdict] = []

  // Performance & telemetry counters
  private(set) var hopsIn: Int64 = 0
  private(set) var hopsGated: Int64 = 0
  private(set) var vadWindowsTotal: Int64 = 0
  private(set) var vadSpeechWindows: Int64 = 0
  private(set) var denoiseNs: Int64 = 0
  private(set) var denoiseMaxNs: Int64 = 0
  private(set) var checks = 0
  private(set) var checkMsMax: Int64 = 0
  private(set) var checkMsSum: Int64 = 0
  private(set) var passed = 0
  private(set) var blocked = 0
  let holdMsMax: Int64 = 0
  let holdMsSum: Int64 = 0
  let holds = 0

  var vadSpeechRatio: Double {
    vadWindowsTotal > 0 ? Double(vadSpeechWindows) / Double(vadWindowsTotal) : 0.0
  }

  var gatedRatio: Double {
    hopsIn > 0 ? Double(hopsGated) / Double(hopsIn) : 0.0
  }

  init(
    _ m: VoiceModels,
    _ o: Options,
    worker: @escaping (@escaping () -> Void) -> Void,
    tseWorker: ((@escaping () -> Void) -> Void)? = nil,
    emit: @escaping (Data) -> Void,
    onUtterance: @escaping (UtteranceReport) -> Void = { _ in }
  ) {
    self.m = m
    self.o = o
    self.spkWorker = worker
    self.tseWorker = tseWorker ?? worker
    self.emit = emit
    self.onUtterance = onUtterance

    let sp = (o.enrolled != nil && m.speaker != nil) ? (try? Speaker(m)) : nil
    self.speaker = sp
    self.hasSv = o.enrolled != nil && sp != nil
    self.enrolledNorm = o.enrolled.map { normalizeEmbedding($0) }
    self.prototypesNorm = o.prototypes.map { normalizeEmbedding($0) }
    self.needOwnerSample = o.needAutoOwnerSample && self.hasSv

    if let enr = o.tseEnrollment, m.tseChunk != nil {
      self.tse = try? TargetExtractor(m, enrollment: enr)
    } else {
      self.tse = nil
    }

    let runAudioChain = o.denoise || self.tse != nil
    self.denoiser = runAudioChain ? Denoiser(m) : nil
    self.enhancer = runAudioChain ? VocalEnhancer() : nil

    let needVad = self.hasSv || self.tse != nil
    self.vad = needVad ? Vad(m) : nil
    self.vadBoost = needVad ? QuietVadBoost() : nil

    vadAccum.reserveCapacity(Vad.window + Self.hop * 2)
    cleanSpeechBuf.reserveCapacity(Self.maxCleanSpeechSamples + Vad.window)
    outFloats.reserveCapacity(Self.hop * 4)

    if self.tse != nil {
      seedTsePrebuffer()
    }
  }

  private func seedTsePrebuffer() {
    tseLock.lock()
    tseInRing.removeAll(keepingCapacity: true)
    tseInRead = 0
    tseOutTse = [Float](repeating: 0, count: Self.tsePrebufferSamples)
    tseOutRaw = [Float](repeating: 0, count: Self.tsePrebufferSamples)
    tseOutRead = 0
    tseLock.unlock()
  }

  func reset() {
    hpf.reset()
    denoiser?.reset()
    vad?.reset()
    vadBoost?.reset()
    enhancer?.reset()
    inLen = 0
    vadAccum.removeAll(keepingCapacity: true)
    cleanSpeechBuf.removeAll(keepingCapacity: true)
    unverifiedAutoSpeech.removeAll(keepingCapacity: true)
    speaking = false
    startRun = 0
    silRun = 0
    uttVoicedW = 0
    sinceCheckW = 0
    earlyTried = false
    fullTried = false
    gatePhase = Self.rampSamples
    suppressingResidual = false
    svConfirmedNonOwner = false
    lastSvScore = 1.0
    smoothedTseAttenDb = 0.0
    uttRawSqSum = 0
    uttTseSqSum = 0
    uttEnhSqSum = 0
    uttAudioSamples = 0
    activeJob = 0
    verdictLock.lock()
    verdicts.removeAll()
    verdictLock.unlock()

    if let tse {
      tseLock.lock()
      if !tseJobRunning {
        tse.reset()
      }
      tseInRing.removeAll(keepingCapacity: true)
      tseInRead = 0
      tseOutTse = [Float](repeating: 0, count: Self.tsePrebufferSamples)
      tseOutRaw = [Float](repeating: 0, count: Self.tsePrebufferSamples)
      tseOutRead = 0
      tseLock.unlock()
    }
  }

  func push(_ pcm: Data) {
    let totalSamples = pcm.count / 2
    var i = 0
    while i < totalSamples {
      let n = min(totalSamples - i, Self.hop - inLen)
      let sub = pcm.subdata(in: (i * 2) ..< ((i + n) * 2))
      pcm16ToFloat(sub, out: &inBuf, outOff: inLen)
      inLen += n
      i += n
      if inLen == Self.hop {
        inLen = 0
        processHop()
      }
    }
    flushOut()
  }

  private func processHop() {
    hopsIn += 1
    takeSvVerdicts()

    // 1. Always run HighPass64 first so SV/VAD and TSE/DPDFNet share DC-free 64 Hz clean input.
    hpf.process(inBuf, srcOff: 0, dst: &hpfBuf, dstOff: 0, count: Self.hop)

    // 2. Clean Path A: feed unmodified HPF audio to Silero VAD & ERes2NetV2-zh ring.
    if vad != nil {
      vadAccum.append(contentsOf: hpfBuf)
      while vadAccum.count >= Vad.window {
        for i in 0..<Vad.window { cleanWin[i] = vadAccum[i] }
        vadAccum.removeFirst(Vad.window)
        onCleanVadWindow()
      }
    }

    // 3. Audio Path B: VoxLock TSE (if active & not bypassed) -> DPDFNet-baseline -> VocalEnhancer.
    let useTse = tse != nil && !tseBypassed
    if useTse {
      pushAndPopTseHop(hpfBuf, outTse: &tseHopBuf, outRaw: &rawAlignedHopBuf)
    } else {
      for i in 0..<Self.hop {
        tseHopBuf[i] = hpfBuf[i]
        rawAlignedHopBuf[i] = hpfBuf[i]
      }
    }

    var rawSq = 0.0
    var tseSq = 0.0
    for i in 0..<Self.hop {
      let rv = Double(rawAlignedHopBuf[i])
      let tv = Double(tseHopBuf[i])
      rawSq += rv * rv
      tseSq += tv * tv
    }
    let hopRawRms = Float((rawSq / Double(Self.hop)).squareRoot())
    let hopTseRms = Float((tseSq / Double(Self.hop)).squareRoot())
    if useTse && hopRawRms > 0.012 && lastVadProb >= Self.speechProb {
      let hopAtten = 20.0 * log10(max(Double(hopTseRms), 1e-5) / max(Double(hopRawRms), 1e-5))
      smoothedTseAttenDb = 0.78 * smoothedTseAttenDb + 0.22 * hopAtten
    } else if !useTse {
      smoothedTseAttenDb = 0.0
    }

    if let d = denoiser {
      let t0 = DispatchTime.now().uptimeNanoseconds
      let ok = (try? d.hop(tseHopBuf, off: 0, out: &dpdfOutBuf, outOff: 0)) ?? false
      let ns = Int64(DispatchTime.now().uptimeNanoseconds - t0)
      denoiseNs += ns
      if ns > denoiseMaxNs { denoiseMaxNs = ns }
      if !ok {
        for i in 0..<Self.hop { dpdfOutBuf[i] = tseHopBuf[i] }
      }
    } else {
      for i in 0..<Self.hop { dpdfOutBuf[i] = tseHopBuf[i] }
    }

    if let enh = enhancer {
      enh.process(dpdfOutBuf, into: &enhOutBuf)
    } else {
      for i in 0..<Self.hop { enhOutBuf[i] = dpdfOutBuf[i] }
    }

    var enhSq = 0.0
    for i in 0..<Self.hop {
      let ev = Double(enhOutBuf[i])
      enhSq += ev * ev
    }
    if speaking {
      uttRawSqSum += rawSq
      uttTseSqSum += tseSq
      uttEnhSqSum += enhSq
      uttAudioSamples += Self.hop
    }

    // 4. Smooth 16 ms raised-cosine residual gate ONLY when non-owner is confirmed.
    updateResidualGateTarget(useTse: useTse)
    if gatePhase < Self.rampSamples / 2 {
      hopsGated += 1
    }
    for i in 0..<Self.hop {
      if suppressingResidual {
        if gatePhase > 0 { gatePhase -= 1 }
      } else {
        if gatePhase < Self.rampSamples { gatePhase += 1 }
      }
      let g: Float
      if gatePhase >= Self.rampSamples {
        g = 1.0
      } else if gatePhase <= 0 {
        g = 0.0
      } else {
        g = 0.5 - 0.5 * cos(Float.pi * Float(gatePhase) / Float(Self.rampSamples))
      }
      outFloats.append(enhOutBuf[i] * g)
    }

    takeSvVerdicts()
  }

  private func updateResidualGateTarget(useTse: Bool) {
    guard hasSv else {
      suppressingResidual = false
      return
    }
    if !speaking || !svConfirmedNonOwner {
      suppressingResidual = false
      return
    }
    if useTse {
      // Hysteresis: engage residual gate only when VoxLock attenuated > 9 dB AND SV confirmed non-owner;
      // release immediately if owner speaks (tseAttenDb >= -7.5 dB).
      if suppressingResidual {
        if smoothedTseAttenDb >= -7.5 { suppressingResidual = false }
      } else {
        if smoothedTseAttenDb < -9.0 { suppressingResidual = true }
      }
    } else {
      suppressingResidual = true
    }
  }

  private func pushAndPopTseHop(_ hpfHop: [Float], outTse: inout [Float], outRaw: inout [Float]) {
    var shouldLaunch = false
    tseLock.lock()
    tseInRing.append(contentsOf: hpfHop)
    if let tse, !tseJobRunning, !_tseBypassed, (tseInRing.count - tseInRead) >= tse.requiredInputSamples {
      tseJobRunning = true
      shouldLaunch = true
    }
    tseLock.unlock()

    if shouldLaunch {
      scheduleTseStep()
    }

    tseLock.lock()
    let avail = tseOutTse.count - tseOutRead
    let takeCount = min(Self.hop, avail)
    for i in 0..<takeCount {
      outTse[i] = tseOutTse[tseOutRead + i]
      outRaw[i] = tseOutRaw[tseOutRead + i]
    }
    tseOutRead += takeCount
    if tseOutRead >= 4096 && tseOutRead * 2 >= tseOutTse.count {
      tseOutTse.removeFirst(tseOutRead)
      tseOutRaw.removeFirst(tseOutRead)
      tseOutRead = 0
    }
    if takeCount < Self.hop {
      _tseOverruns += 1
      for i in takeCount..<Self.hop {
        outTse[i] = hpfHop[i]
        outRaw[i] = hpfHop[i]
      }
    }
    tseLock.unlock()
  }

  private func scheduleTseStep() {
    tseWorker { [weak self] in
      self?.runTseLoop()
    }
  }

  private func runTseLoop() {
    guard let tse else { return }
    while true {
      tseLock.lock()
      if _tseBypassed {
        tseJobRunning = false
        tseInRing.removeAll(keepingCapacity: true)
        tseInRead = 0
        tseLock.unlock()
        return
      }
      let need = tse.requiredInputSamples
      let avail = tseInRing.count - tseInRead
      guard avail >= need else {
        tseJobRunning = false
        tseLock.unlock()
        return
      }
      let inputSlice = Array(tseInRing[tseInRead ..< (tseInRead + need)])
      tseInRead += need
      if tseInRead >= 4096 && tseInRead * 2 >= tseInRing.count {
        tseInRing.removeFirst(tseInRead)
        tseInRead = 0
      }
      let curK = tse.kFrames
      tseLock.unlock()

      let stepRes = try? tse.step(inputSlice)

      tseLock.lock()
      if let (tseAudio, rawAudio, ms) = stepRes {
        _tseChunks += 1
        _tseMsSum += ms
        if ms > _tseMsMax { _tseMsMax = ms }
        _tseAudioMsSum += Double(curK * TargetExtractor.hop) * 1000.0 / Double(voiceRate)

        let budgetMs = curK <= 5 ? 38.0 : 60.0
        if ms > budgetMs {
          consecutiveSlowTse += 1
          if consecutiveSlowTse >= 3 {
            consecutiveSlowTse = 0
            if curK <= 5 {
              tse.setKFrames(8)
              NSLog("PocketVoice TSE overload (%.1f ms > 38 ms), stepping up to K=8 (64 ms)", ms)
            } else {
              _tseBypassed = true
              NSLog("PocketVoice TSE overload (%.1f ms > 60 ms), bypassing TSE to DPDFNet + SV soft-gate", ms)
            }
          }
        } else {
          consecutiveSlowTse = 0
        }

        tseOutTse.append(contentsOf: tseAudio)
        tseOutRaw.append(contentsOf: rawAudio)
      } else {
        _tseBypassed = true
        tseJobRunning = false
        tseLock.unlock()
        NSLog("PocketVoice TSE step failed, bypassing TSE")
        return
      }
      tseLock.unlock()
    }
  }

  private func onCleanVadWindow() {
    vadWindowsTotal += 1
    vadBoost?.prepare(cleanWin, into: &vadProbeWin)
    let p = (try? vad?.prob(vadProbeWin)) ?? 0
    lastVadProb = p
    let isVoiced = p >= Self.speechProb
    if isVoiced {
      vadSpeechWindows += 1
      cleanSpeechBuf.append(contentsOf: cleanWin)
      if cleanSpeechBuf.count > Self.maxCleanSpeechSamples {
        cleanSpeechBuf.removeFirst(cleanSpeechBuf.count - Self.maxCleanSpeechSamples)
      }
      if needOwnerSample && unverifiedAutoSpeech.count < VoxLockEnrollment.sampleCount {
        unverifiedAutoSpeech.append(contentsOf: cleanWin)
      }
    }

    var justEnded = false
    if !speaking {
      startRun = p >= Self.startProb ? (startRun + 1) : 0
      if startRun >= Self.startWindows {
        speaking = true
        silRun = 0
        uttVoicedW = isVoiced ? 1 : 0
        sinceCheckW = 0
        earlyTried = false
        fullTried = false
        svConfirmedNonOwner = false
        uttRawSqSum = 0
        uttTseSqSum = 0
        uttEnhSqSum = 0
        uttAudioSamples = 0
        unverifiedAutoSpeech.removeAll(keepingCapacity: true)
        if needOwnerSample && isVoiced {
          unverifiedAutoSpeech.append(contentsOf: cleanWin)
        }
      }
    } else {
      if isVoiced {
        silRun = 0
        uttVoicedW += 1
        sinceCheckW += 1
      } else {
        silRun += 1
        if silRun >= Self.endWindows {
          speaking = false
          startRun = 0
          justEnded = true
        }
      }
    }

    guard hasSv else { return }
    if speaking && activeJob == 0 {
      if !earlyTried && uttVoicedW >= Self.earlyVoicedW {
        earlyTried = true
        launchSvCheck(kind: .early, maxSamples: voiceRate * 3 / 5) // up to 0.6 s
      } else if !fullTried && uttVoicedW >= Self.fullVoicedW {
        fullTried = true
        launchSvCheck(kind: .full, maxSamples: voiceRate) // up to 1.0 s
      } else if fullTried && sinceCheckW >= Self.recheckStepW {
        launchSvCheck(kind: .recheck, maxSamples: voiceRate * 5 / 4) // up to 1.25 s
      }
    } else if justEnded {
      if activeJob == 0 && !fullTried && uttVoicedW >= Self.minEndVoicedW {
        launchSvCheck(kind: .end, maxSamples: voiceRate)
      }
      suppressingResidual = false
      svConfirmedNonOwner = false
      cleanSpeechBuf.removeAll(keepingCapacity: true)
    }
  }

  private func launchSvCheck(kind: Kind, maxSamples: Int) {
    guard let enrolled = enrolledNorm, let sp = speaker, !cleanSpeechBuf.isEmpty else { return }
    let takeLen = min(cleanSpeechBuf.count, maxSamples)
    guard takeLen >= voiceRate / 5 else { return } // at least 200 ms of clean voiced speech
    let slice = Array(cleanSpeechBuf.suffix(takeLen))
    let autoCandidate: [Float]
    if needOwnerSample && !unverifiedAutoSpeech.isEmpty {
      autoCandidate = unverifiedAutoSpeech
      unverifiedAutoSpeech.removeAll(keepingCapacity: true)
    } else {
      autoCandidate = []
    }

    jobSeq += 1
    let id = jobSeq
    activeJob = id
    sinceCheckW = 0
    let protos = prototypesNorm
    let sess = sessionEmb
    let th = o.threshold

    spkWorker { [weak self] in
      let t0 = DispatchTime.now().uptimeNanoseconds
      var raw: Float = -1
      var proto: Float = -1
      var blended: Float = -1
      var sessCos: Float = -1
      var finalScore: Float = -1
      var normEmb: [Float]?
      do {
        let emb = try sp.embed(slice)
        let norm = normalizeEmbedding(emb)
        normEmb = norm
        let sv = scoreVoiceprint(norm, centroid: enrolled, prototypes: protos)
        raw = sv.raw
        proto = sv.proto
        blended = sv.blended
        if let sess {
          sessCos = cosine(norm, sess)
          if blended >= th - 0.12 {
            finalScore = max(blended, 0.65 * blended + 0.35 * sessCos)
          } else {
            finalScore = blended
          }
        } else {
          sessCos = raw
          finalScore = blended
        }
      } catch {
      }
      let ms = Int64((DispatchTime.now().uptimeNanoseconds - t0) / 1_000_000)
      guard let self else { return }
      self.verdictLock.lock()
      self.verdicts.append(
        SvVerdict(
          job: id,
          kind: kind,
          raw: raw,
          proto: proto,
          blended: blended,
          sessCos: sessCos,
          score: finalScore,
          normEmb: normEmb,
          cleanSamples: autoCandidate,
          usedSamples: takeLen,
          ms: ms
        )
      )
      self.verdictLock.unlock()
    }
  }

  private func takeSvVerdicts() {
    verdictLock.lock()
    if verdicts.isEmpty {
      verdictLock.unlock()
      return
    }
    let items = verdicts
    verdicts.removeAll(keepingCapacity: true)
    verdictLock.unlock()

    for v in items {
      if v.job == activeJob { activeJob = 0 }
      guard v.score >= -0.99 else { continue }

      checks += 1
      checkMsSum += v.ms
      if v.ms > checkMsMax { checkMsMax = v.ms }
      lastSvScore = v.score

      let req: Float = v.kind == .end ? (o.threshold - 0.03) : (o.threshold - 0.01)
      let pass = v.score >= req
      if pass {
        passed += 1
        svConfirmedNonOwner = false
        suppressingResidual = false
        maybeUpdateSession(v)
        maybeCaptureOwnerSample(v)
      } else {
        blocked += 1
        if speaking {
          svConfirmedNonOwner = true
        }
      }

      let denom = Double(max(1, uttAudioSamples))
      let rawRms = Float((uttRawSqSum / denom).squareRoot())
      let tseRms = Float((uttTseSqSum / denom).squareRoot())
      let enhRms = Float((uttEnhSqSum / denom).squareRoot())
      let rDb = dbfsFromRms(rawRms)
      let tDb = dbfsFromRms(tseRms)
      let eDb = dbfsFromRms(enhRms)
      let uttAtten = 20.0 * log10(max(Double(tseRms), 1e-5) / max(Double(rawRms), 1e-5))
      let atten = (tse != nil && !tseBypassed) ? finiteDouble(uttAtten, digits: 1) : 0.0
      let enhGain = finiteDouble(eDb - tDb, digits: 1)

      onUtterance(
        UtteranceReport(
          kind: v.kind.rawValue,
          pass: pass,
          svScore: Double(v.score),
          svRaw: Double(v.raw),
          svProto: Double(v.proto),
          svSess: Double(v.sessCos),
          svMs: v.ms,
          usedMs: Int64(v.usedSamples * 1000 / voiceRate),
          vadProb: Double(lastVadProb),
          rawDbfs: rDb,
          tseDbfs: tDb,
          enhDbfs: eDb,
          tseAttenDb: atten,
          enhGainDb: enhGain
        )
      )
    }
  }

  private func maybeUpdateSession(_ v: SvVerdict) {
    guard let emb = v.normEmb, v.usedSamples >= voiceRate * 3 / 5 else { return }
    guard v.blended >= max(o.threshold + 0.08, 0.46) else { return }
    if tse != nil && !tseBypassed && smoothedTseAttenDb < -6.0 { return }
    if let cur = sessionEmb {
      var blended = [Float](repeating: 0, count: cur.count)
      for i in 0..<cur.count { blended[i] = 0.80 * cur[i] + 0.20 * emb[i] }
      sessionEmb = normalizeEmbedding(blended)
    } else {
      sessionEmb = emb
    }
  }

  private func maybeCaptureOwnerSample(_ v: SvVerdict) {
    guard needOwnerSample, !v.cleanSamples.isEmpty else { return }
    guard v.score >= o.threshold + 0.10 else { return }
    verifiedOwnerBuf.append(contentsOf: v.cleanSamples)
    if verifiedOwnerBuf.count >= VoxLockEnrollment.sampleCount {
      let ok = VoiceModelManager.saveOwnerSample(Array(verifiedOwnerBuf.prefix(VoxLockEnrollment.sampleCount)))
      if ok {
        needOwnerSample = false
        verifiedOwnerBuf.removeAll()
        unverifiedAutoSpeech.removeAll()
      }
    }
  }

  private func flushOut() {
    guard !outFloats.isEmpty else { return }
    let data = floatToPcm16(outFloats, count: outFloats.count)
    outFloats.removeAll(keepingCapacity: true)
    var off = 0
    while off < data.count {
      let n = min(Self.sendMax, data.count - off)
      emit(data.subdata(in: off ..< (off + n)))
      off += n
    }
  }
}
