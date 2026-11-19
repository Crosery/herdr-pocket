import AVFoundation
import Foundation

private let micRate = 16_000.0
private let speakerRate = 48_000
private let speakerPerMs = speakerRate / 1000
/// 20 ms of 16 kHz mono PCM16 (320 samples = 2 DPDFNet 10 ms hops).
private let micFrameBytes = 640
/// How often the play timer looks again for audio to schedule.
private let playLoopMs = 5
/// Speech scheduled ahead on the player at most: the size of the Android track's buffer.
private let aheadMs = 400

private struct CallError: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

/**
 * One voice call to the relay's /v1/assistant/live, the iOS side of VoiceCall.kt.
 * Audio never passes through JavaScript: the microphone goes straight through the
 * zero-stall native pipeline (`VoxLock -> DPDFNet-baseline -> VocalEnhancer`) to the
 * socket, speech straight to the speaker, and playback receipts follow what was
 * actually heard (MOSS-Live playback.* events).
 */
final class VoiceCall: NSObject, URLSessionWebSocketDelegate {
  private static let currentLock = NSLock()
  private static var _current: VoiceCall?
  static var current: VoiceCall? {
    get { currentLock.lock(); defer { currentLock.unlock() }; return _current }
    set { currentLock.lock(); _current = newValue; currentLock.unlock() }
  }

  static let sessionQueue = DispatchQueue(label: "dev.crosery.pocket.audio-session")

  static func start(server: String, token: String) {
    VoiceLab.stop()
    currentLock.lock()
    if _current != nil {
      currentLock.unlock()
      return
    }
    let call = VoiceCall(server: server, token: token)
    _current = call
    currentLock.unlock()
    call.q.async { call.begin() }
  }

  private struct Ref {
    let chunkId: String
    let runId: String
    let turnId: String
  }

  private final class Chunk: PlayoutPiece {
    let ref: Ref
    let buffer: AVAudioPCMBuffer
    let frames: Int
    let level: Float
    var run: String { ref.runId }

    init(ref: Ref, buffer: AVAudioPCMBuffer, level: Float) {
      self.ref = ref
      self.buffer = buffer
      self.frames = Int(buffer.frameLength)
      self.level = level
    }
  }

  private final class Scope {
    var turnId = ""
    var finished = false
    var drained = false
    var stopped = false
    var outstanding = 0
    var playedMs = 0.0
  }

  private let server: String
  private let token: String
  private let q = DispatchQueue(label: "dev.crosery.pocket.voice", qos: .userInteractive)
  private let micQueue = DispatchQueue(label: "dev.crosery.pocket.mic", qos: .userInteractive)
  private let tseQueue = DispatchQueue(label: "dev.crosery.pocket.tse", qos: .userInteractive)
  private let spkQueue = DispatchQueue(label: "dev.crosery.pocket.spk", qos: .userInitiated)

  private let useDenoise: Bool
  private let voiceThreshold: Float
  private let configuredTier: String
  private let effectiveTier: String
  private let useFirstSpeaker: Bool
  private let enrolledVoice: [Float]?
  private let voicePrototypes: [[Float]]
  private var voiceModels: VoiceModels?
  private var filter: VoiceFilter?
  private var modelsLoaded = false
  private var filterReset = false

  private var session: URLSession?
  private var ws: URLSessionWebSocketTask?
  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let speakerFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(speakerRate), channels: 1, interleaved: false)!
  private let micFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: micRate, channels: 1, interleaved: true)!
  private var micPending = Data()
  private let silence = Data(count: micFrameBytes)
  private var timers: [DispatchSourceTimer] = []
  private var observers: [NSObjectProtocol] = []

  // Call state; on `q`.
  private var startedAtMs: Int64 = monoMs()
  private var ended = false
  private var opened = false
  private var ready = false
  private var summarySent = false
  private var micLevel: Float = 0
  private var lastRoute = "speaker"
  private var pendingInitTelemetryJson: String?

  // Outbound PCM continuity telemetry; on `q`.
  private var framesIn: Int64 = 0
  private var framesOut: Int64 = 0
  private var lastWsSendAtMs: Int64 = 0
  private var wsGapMaxMsWindow: Int64 = 0
  private var wsGapMaxMsCall: Int64 = 0

  private let flagLock = NSLock()
  private var _muted = false
  var muted: Bool {
    get { flagLock.lock(); defer { flagLock.unlock() }; return _muted }
    set { flagLock.lock(); _muted = newValue; flagLock.unlock() }
  }

  // Playback ledger; on `q`.
  private var contexts: [Ref] = []
  private let playout = Playout<Chunk>(framesPerMs: speakerPerMs)
  private var inflight: [Chunk] = []
  private var headStartedAt: Int64 = 0
  private var generation = 0
  private var stops = 0
  private var scopes: [String: Scope] = [:]
  private var stoppedRuns = Set<String>()

  private init(server: String, token: String) {
    self.server = server
    self.token = token
    self.useDenoise = VoicePrefs.denoise
    self.voiceThreshold = VoicePrefs.threshold
    let tier = VoicePrefs.voiceTier
    self.configuredTier = tier
    let versionOk = VoicePrefs.isCurrentEnrolled
    let rawEnrolled = (VoicePrefs.filter && versionOk) ? VoicePrefs.embedding : nil
    let wantIdentity = rawEnrolled != nil || VoicePrefs.firstSpeaker
    if !wantIdentity || tier == "denoise" {
      self.effectiveTier = "denoise"
    } else if tier == "tse" {
      self.effectiveTier = "tse"
    } else if tier == "sv" {
      self.effectiveTier = "sv"
    } else if rawEnrolled != nil &&
      VoiceModelManager.isTseReady() &&
      (VoicePrefs.lastCallTseRtf <= 0 || VoicePrefs.lastCallTseRtf <= 0.85) &&
      (VoicePrefs.benchRecommendedTier == nil || VoicePrefs.benchRecommendedTier == "tse") {
      self.effectiveTier = "tse"
    } else {
      self.effectiveTier = "sv"
    }
    let enrolled = self.effectiveTier != "denoise" ? rawEnrolled : nil
    self.enrolledVoice = enrolled
    self.voicePrototypes = enrolled != nil ? (VoicePrefs.prototypes ?? []) : []
    self.useFirstSpeaker = self.effectiveTier != "denoise" && VoicePrefs.firstSpeaker && enrolled == nil
    super.init()
  }

  // MARK: - start

  private func begin() {
    startedAtMs = monoMs()
    PocketBus.emit("onCall", ["state": "connecting"])
    do {
      try openAudio()
      lastRoute = currentAudioRoute()
    } catch {
      end("打不开麦克风：\(error.localizedDescription)")
      return
    }

    let needSpeaker = effectiveTier != "denoise" && (enrolledVoice != nil || useFirstSpeaker) && VoiceModelManager.isSvOnlyReady()
    let ownerSample = (effectiveTier == "tse" && enrolledVoice != nil) ? VoiceModelManager.loadOwnerSample() : nil
    let needTse = effectiveTier == "tse" && ownerSample != nil && VoiceModelManager.isTseReady()

    if useDenoise || needSpeaker || needTse {
      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        guard let self else { return }
        let tLoad0 = DispatchTime.now().uptimeNanoseconds
        let loaded = try? VoiceModelManager.openModels(needSpeaker: needSpeaker, needTse: needTse)
        let loadMs = Int64((DispatchTime.now().uptimeNanoseconds - tLoad0) / 1_000_000)

        var tseEnr: VoxLockEnrollment?
        var enrollMs: Int64 = 0
        if let loaded, needTse, let sample = ownerSample {
          if let (enr, ms) = try? VoxLockEnrollment.compute(loaded, ownerSamples: sample) {
            tseEnr = enr
            enrollMs = ms
          }
        }

        var createdFilter: VoiceFilter?
        if let loaded, self.useDenoise || (needSpeaker && loaded.speaker != nil) || tseEnr != nil {
          createdFilter = VoiceFilter(
            loaded,
            VoiceFilter.Options(
              denoise: self.useDenoise,
              enrolled: self.enrolledVoice,
              prototypes: self.voicePrototypes,
              threshold: self.voiceThreshold,
              tseEnrollment: tseEnr,
              needAutoOwnerSample: self.effectiveTier == "tse" && self.enrolledVoice != nil && ownerSample == nil,
              lockFirstSpeaker: self.useFirstSpeaker
            ),
            worker: { [weak self] job in self?.spkQueue.async(execute: job) },
            tseWorker: { [weak self] job in self?.tseQueue.async(execute: job) },
            emit: { [weak self] pcm in
              self?.q.async { self?.onFilteredPcm(pcm) }
            },
            onUtterance: { [weak self] rep in
              self?.q.async { self?.emitUtteranceTelemetry(rep) }
            }
          )
        }

        self.micQueue.async { [weak self] in
          guard let self else { return }
          self.voiceModels = loaded
          self.filter = createdFilter
          self.modelsLoaded = true
          self.q.async {
            if self.ended { return }
            self.emitInitTelemetry(filter: createdFilter, loadMs: loadMs, enrollMs: enrollMs)
          }
        }
      }
    } else {
      micQueue.async { [weak self] in
        self?.modelsLoaded = true
      }
      emitInitTelemetry(filter: nil, loadMs: 0, enrollMs: 0)
    }

    guard let url = wsUrl(server, "/v1/assistant/live") else {
      end("服务器地址不对")
      return
    }
    var req = URLRequest(url: url)
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    let config = URLSessionConfiguration.default
    config.timeoutIntervalForRequest = 7 * 24 * 3600
    config.timeoutIntervalForResource = 7 * 24 * 3600
    let ops = OperationQueue()
    ops.maxConcurrentOperationCount = 1
    ops.underlyingQueue = q
    let s = URLSession(configuration: config, delegate: self, delegateQueue: ops)
    session = s
    let task = s.webSocketTask(with: req)
    task.maximumMessageSize = 16 * 1024 * 1024
    ws = task
    task.resume()
    receive(task)
    every(ms: playLoopMs) { [weak self] in self?.pump() }
    every(ms: 100) { [weak self] in self?.reportLevel() }
    every(ms: 5_000) { [weak self] in self?.emitPeriodicTelemetry() }
    every(ms: 20_000) { [weak self] in self?.ping() }
    q.asyncAfter(deadline: .now() + 15) { [weak self] in
      guard let self, !self.ended, !self.opened else { return }
      self.end("连接断了")
    }
  }

  private func every(ms: Int, _ body: @escaping () -> Void) {
    let t = DispatchSource.makeTimerSource(queue: q)
    t.schedule(deadline: .now() + .milliseconds(ms), repeating: .milliseconds(ms), leeway: .milliseconds(1))
    t.setEventHandler(handler: body)
    t.resume()
    timers.append(t)
  }

  // MARK: - audio

  private static func micAllowed() -> Bool {
    if #available(iOS 17.0, *) {
      return AVAudioApplication.shared.recordPermission == .granted
    }
    return AVAudioSession.sharedInstance().recordPermission == .granted
  }

  private func openAudio() throws {
    guard VoiceCall.micAllowed() else { throw CallError(message: "没有麦克风权限") }
    let audio = AVAudioSession.sharedInstance()
    try VoiceCall.sessionQueue.sync {
      try audio.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
      try? audio.setPreferredSampleRate(Double(speakerRate))
      try? audio.setPreferredIOBufferDuration(0.02)
      try audio.setActive(true)
    }
    #if !targetEnvironment(simulator)
    try? engine.inputNode.setVoiceProcessingEnabled(true)
    #endif
    engine.attach(player)
    engine.connect(player, to: engine.mainMixerNode, format: speakerFormat)
    try installMicTap()
    engine.prepare()
    try engine.start()
    player.play()

    let nc = NotificationCenter.default
    observers.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: audio, queue: nil) { [weak self] note in
      let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init(rawValue:))
      guard type == .began else { return }
      self?.q.async { self?.end("通话被系统打断了") }
    })
    observers.append(nc.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
      self?.q.async { self?.restartEngine() }
    })
  }

  private func installMicTap() throws {
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else { throw CallError(message: "找不到麦克风") }
    guard let converter = AVAudioConverter(from: format, to: micFormat) else { throw CallError(message: "麦克风的格式用不了") }
    let target = micFormat
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(max(256, format.sampleRate / 50)), format: format) { [weak self] buffer, _ in
      guard let data = VoiceCall.convert(buffer, with: converter, to: target) else { return }
      self?.micQueue.async { self?.onMicBuffer(data) }
    }
  }

  private static func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to format: AVAudioFormat) -> Data? {
    let ratio = format.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 64)
    guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
    var fed = false
    var error: NSError?
    let status = converter.convert(to: out, error: &error) { _, inputStatus in
      if fed {
        inputStatus.pointee = .noDataNow
        return nil
      }
      fed = true
      inputStatus.pointee = .haveData
      return buffer
    }
    guard status != .error, out.frameLength > 0, let channel = out.int16ChannelData else { return nil }
    return Data(bytes: channel[0], count: Int(out.frameLength) * 2)
  }

  private func restartEngine() {
    if ended { return }
    do {
      if !engine.isRunning {
        generation += 1
        player.stop()
        playout.requeue(inflight)
        inflight.removeAll()
      }
      try installMicTap()
      if !engine.isRunning {
        engine.prepare()
        try engine.start()
      }
      player.play()
      lastRoute = currentAudioRoute()
    } catch {
      end("音频设备变了，通话断了")
    }
  }

  private func closeAudio() {
    for o in observers { NotificationCenter.default.removeObserver(o) }
    observers.removeAll()
    engine.inputNode.removeTap(onBus: 0)
    player.stop()
    engine.stop()
  }

  // MARK: - microphone (`micQueue` -> `q`)

  private func onMicBuffer(_ data: Data) {
    micPending.append(data)
    let isMuted = self.muted
    while micPending.count >= micFrameBytes {
      let start = micPending.startIndex
      let frame = micPending.subdata(in: start ..< start + micFrameBytes)
      micPending = micPending.subdata(in: start + micFrameBytes ..< micPending.endIndex)
      q.async { [weak self] in self?.framesIn += 1 }
      if isMuted {
        if filterReset {
          filterReset = false
          filter?.reset()
        }
        q.async { [weak self] in self?.sendMutedSilence() }
      } else if let vf = filter {
        filterReset = false
        vf.push(frame)
      } else if !modelsLoaded && (useDenoise || enrolledVoice != nil) {
        // Models still loading (~150 ms at call start): send continuous silence if WS is already ready so stream never gaps.
        q.async { [weak self] in self?.sendMutedSilence() }
      } else {
        q.async { [weak self] in self?.onFilteredPcm(frame) }
      }
    }
  }

  private func sendMutedSilence() {
    if ended { return }
    micLevel = 0
    sendBinaryPcm(silence)
  }

  private func onFilteredPcm(_ pcm: Data) {
    if ended { return }
    if muted {
      micLevel = 0
      sendBinaryPcm(silence)
      return
    }
    micLevel = pcmLevel(pcm)
    sendBinaryPcm(pcm)
  }

  private func sendBinaryPcm(_ pcm: Data) {
    guard ready, let ws else { return }
    let now = monoMs()
    if lastWsSendAtMs > 0 {
      let gap = now - lastWsSendAtMs
      if gap > wsGapMaxMsWindow { wsGapMaxMsWindow = gap }
      if gap > wsGapMaxMsCall { wsGapMaxMsCall = gap }
    }
    lastWsSendAtMs = now
    framesOut += 1
    ws.send(.data(pcm)) { _ in }
  }

  // MARK: - AI telemetry (`client.ai_telemetry`)

  private func emitTelemetry(_ d: [String: Any]) {
    let payload: [String: Any] = ["action": "client.ai_telemetry", "data": d]
    guard let json = jsonString(payload) else { return }
    PocketBus.emit("onCallEvent", ["json": json])
    if ready {
      ws?.send(.string(json)) { _ in }
    } else if (d["stage"] as? String) == "init" {
      pendingInitTelemetryJson = json
    }
  }

  private func emitInitTelemetry(filter f: VoiceFilter?, loadMs: Int64, enrollMs: Int64) {
    lastRoute = currentAudioRoute()
    let svEnabled = f?.svEnabled ?? false
    let tseEnabled = f?.tseEnabled ?? false
    let vadEnabled = svEnabled || tseEnabled
    let denoiseActive = (useDenoise || tseEnabled) && f != nil
    var activeModels: [String] = []
    if denoiseActive { activeModels.append("dpdfnet_baseline") }
    if tseEnabled { activeModels.append("voxlock_v2_int8") }
    if svEnabled { activeModels.append("eres2netv2_zh") }
    if vadEnabled { activeModels.append("silero_vad_v4") }
    emitTelemetry([
      "stage": "init",
      "platform": "ios",
      "route": lastRoute,
      "models": activeModels,
      "denoise_enabled": denoiseActive,
      "denoise_model": denoiseActive ? "dpdfnet_baseline" : "none",
      "sv_enabled": svEnabled,
      "sv_model": svEnabled ? "eres2netv2_zh" : "none",
      "tse_enabled": tseEnabled,
      "tse_model": tseEnabled ? "voxlock_v2_int8" : "none",
      "vad_enabled": vadEnabled,
      "vad_model": vadEnabled ? "silero_vad_v4" : "none",
      "model_version": VOICEPRINT_MODEL_VERSION,
      "load_ms": loadMs,
      "enroll_ms": enrollMs,
      "threshold": finiteDouble(Double(voiceThreshold), digits: 3),
      "prototypes_count": voicePrototypes.count,
    ])
  }

  private func emitUtteranceTelemetry(_ r: VoiceFilter.UtteranceReport) {
    if ended { return }
    lastRoute = currentAudioRoute()
    emitTelemetry([
      "stage": "utterance",
      "route": lastRoute,
      "kind": r.kind,
      "pass": r.pass,
      "sv_score": finiteDouble(r.svScore, digits: 4),
      "sv_raw": finiteDouble(r.svRaw, digits: 4),
      "sv_proto": finiteDouble(r.svProto, digits: 4),
      "sv_sess": finiteDouble(r.svSess, digits: 4),
      "sv_ms": r.svMs,
      "used_ms": r.usedMs,
      "vad_prob": finiteDouble(r.vadProb, digits: 3),
      "raw_dbfs": finiteDouble(r.rawDbfs, digits: 1),
      "tse_dbfs": finiteDouble(r.tseDbfs, digits: 1),
      "enh_dbfs": finiteDouble(r.enhDbfs, digits: 1),
      "tse_atten_db": finiteDouble(r.tseAttenDb, digits: 1),
      "enh_gain_db": finiteDouble(r.enhGainDb, digits: 1),
      "tse_overruns": filter?.tseOverruns ?? 0,
    ])
  }

  private func emitPeriodicTelemetry() {
    guard ready, !ended else { return }
    lastRoute = currentAudioRoute()
    let gapMax = wsGapMaxMsWindow
    wsGapMaxMsWindow = 0
    let f = filter
    let hops = max(Int64(1), f?.hopsIn ?? 0)
    let dpdfUsAvg: Int64 = (f != nil && (f?.hopsIn ?? 0) > 0) ? ((f!.denoiseNs / 1000) / hops) : 0
    let dpdfUsMax: Int64 = (f?.denoiseMaxNs ?? 0) / 1000
    emitTelemetry([
      "stage": "periodic",
      "route": lastRoute,
      "frames_in": framesIn,
      "frames_out": framesOut,
      "ws_gap_max_ms": gapMax,
      "dpdf_us_avg": dpdfUsAvg,
      "dpdf_us_max": dpdfUsMax,
      "tse_ms_avg": finiteDouble(f?.tseMsAvg ?? 0, digits: 2),
      "tse_ms_max": finiteDouble(f?.tseMsMax ?? 0, digits: 2),
      "tse_rtf": finiteDouble(f?.tseRtf ?? 0, digits: 3),
      "tse_overruns": f?.tseOverruns ?? 0,
      "tse_k": f?.tseKFrames ?? 0,
      "tse_bypassed": f?.tseBypassed ?? false,
      "vad_speech_ratio": finiteDouble(f?.vadSpeechRatio ?? 0, digits: 3),
      "gated_ratio": finiteDouble(f?.gatedRatio ?? 0, digits: 3),
    ])
  }

  private func emitSummaryTelemetryOnce() {
    if summarySent { return }
    summarySent = true
    let f = filter
    let hops = max(Int64(1), f?.hopsIn ?? 0)
    let dpdfUsAvg: Int64 = (f != nil && (f?.hopsIn ?? 0) > 0) ? ((f!.denoiseNs / 1000) / hops) : 0
    let dpdfUsMax: Int64 = (f?.denoiseMaxNs ?? 0) / 1000
    let svChecks = f?.checks ?? 0
    let svMsAvg: Int64 = svChecks > 0 ? ((f?.checkMsSum ?? 0) / Int64(svChecks)) : 0
    let tseEnabled = f?.tseEnabled ?? false
    let denoiseActive = (useDenoise || tseEnabled) && f != nil
    let svPassed = f?.passed ?? 0
    let svBlocked = f?.blocked ?? 0
    emitTelemetry([
      "stage": "summary",
      "platform": "ios",
      "route": lastRoute,
      "duration_ms": max(0, monoMs() - startedAtMs),
      "frames_in": framesIn,
      "frames_out": framesOut,
      "ws_gap_max_ms": wsGapMaxMsCall,
      "denoise_model": denoiseActive ? "dpdfnet_baseline" : "none",
      "tse_enabled": tseEnabled,
      "tse_k": f?.tseKFrames ?? 0,
      "tse_bypassed": f?.tseBypassed ?? false,
      "sv_enabled": f?.svEnabled ?? false,
      "dpdf_us_avg": dpdfUsAvg,
      "dpdf_us_max": dpdfUsMax,
      "tse_ms_avg": finiteDouble(f?.tseMsAvg ?? 0, digits: 2),
      "tse_ms_max": finiteDouble(f?.tseMsMax ?? 0, digits: 2),
      "tse_rtf": finiteDouble(f?.tseRtf ?? 0, digits: 3),
      "tse_overruns": f?.tseOverruns ?? 0,
      "utterances": svChecks,
      "pass_count": svPassed,
      "mute_count": svBlocked,
      "sv_checks": svChecks,
      "sv_ms_avg": svMsAvg,
      "sv_ms_max": f?.checkMsMax ?? 0,
      "sv_passed": svPassed,
      "sv_blocked": svBlocked,
      "vad_speech_ratio": finiteDouble(f?.vadSpeechRatio ?? 0, digits: 3),
      "gated_ratio": finiteDouble(f?.gatedRatio ?? 0, digits: 3),
      "stalls": playout.stalls,
      "stops": stops,
    ])
  }

  // MARK: - speaker

  private func makeBuffer(_ pcm: Data) -> AVAudioPCMBuffer? {
    let frames = pcm.count / 2
    guard frames > 0,
          let buffer = AVAudioPCMBuffer(pcmFormat: speakerFormat, frameCapacity: AVAudioFrameCount(frames)),
          let out = buffer.floatChannelData?[0] else { return nil }
    pcm.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      for i in 0..<frames {
        out[i] = Float(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self))) / 32768
      }
    }
    buffer.frameLength = AVAudioFrameCount(frames)
    return buffer
  }

  private func pendingFrames(_ now: Int64) -> Int64 {
    guard let head = inflight.first else { return 0 }
    let total = inflight.reduce(Int64(0)) { $0 + Int64($1.frames) }
    let into = min(Int64(head.frames - 1), max(0, (now - headStartedAt) * Int64(speakerPerMs)))
    return max(1, total - into)
  }

  private func pump() {
    if ended { return }
    let now = monoMs()
    while !ended {
      let audio = pendingFrames(now)
      if audio >= Int64(aheadMs * speakerPerMs) { break }
      guard let next = playout.take(now: now, audioFrames: audio) else { break }
      if stoppedRuns.contains(next.ref.runId) { continue }
      schedule(next, now)
    }
  }

  private func schedule(_ chunk: Chunk, _ now: Int64) {
    if inflight.isEmpty { headStartedAt = now }
    inflight.append(chunk)
    let gen = generation
    player.scheduleBuffer(chunk.buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
      self?.q.async { self?.played(chunk, gen) }
    }
  }

  private func played(_ chunk: Chunk, _ gen: Int) {
    if ended || gen != generation { return }
    guard let i = inflight.firstIndex(where: { $0 === chunk }) else { return }
    var out: [[String: Any]] = []
    for c in inflight[...i] { acked(c, &out) }
    inflight.removeFirst(i + 1)
    headStartedAt = monoMs()
    send(out)
  }

  private func reportLevel() {
    if ended { return }
    PocketBus.emit("onLevel", ["mic": Double(micLevel), "out": Double(inflight.first?.level ?? 0)])
  }

  private func acked(_ chunk: Chunk, _ out: inout [[String: Any]]) {
    out.append(["action": "playback.chunk.completed", "chunk_id": chunk.ref.chunkId, "run_id": chunk.ref.runId, "turn_id": chunk.ref.turnId])
    let s = scope(chunk.ref.runId, chunk.ref.turnId)
    s.playedMs += Double(chunk.frames) * 1000 / Double(speakerRate)
    if s.outstanding > 0 { s.outstanding -= 1 }
    if let m = drained(chunk.ref.runId, s) { out.append(m) }
  }

  private func scope(_ runId: String, _ turnId: String) -> Scope {
    let s = scopes[runId] ?? Scope()
    scopes[runId] = s
    if !turnId.isEmpty { s.turnId = turnId }
    return s
  }

  private func drained(_ runId: String, _ s: Scope) -> [String: Any]? {
    if !s.finished || s.drained || s.stopped || s.outstanding > 0 { return nil }
    s.drained = true
    return ["action": "playback.completed", "run_id": runId, "turn_id": s.turnId]
  }

  private func stopRun(_ runId: String, _ turnId: String, _ reason: String) {
    var out: [[String: Any]] = []
    stoppedRuns.insert(runId)
    stops += 1
    playout.drop(runId)
    let s = scope(runId, turnId)
    s.stopped = true
    if inflight.contains(where: { $0.ref.runId == runId }) {
      let heard = min(Int64(inflight[0].frames), max(0, (monoMs() - headStartedAt) * Int64(speakerPerMs)))
      var back: [Chunk] = []
      for (i, c) in inflight.enumerated() {
        if c.ref.runId == runId {
          if i == 0 { s.playedMs += Double(heard) * 1000 / Double(speakerRate) }
        } else {
          back.append(c)
        }
      }
      generation += 1
      player.stop()
      player.play()
      inflight.removeAll()
      playout.requeue(back)
    }
    s.outstanding = 0
    s.finished = true
    s.stopped = true
    s.drained = true
    out.append(["action": "playback.stopped", "run_id": runId, "turn_id": s.turnId, "played_audio_ms": Int64(s.playedMs), "reason": reason])
    s.playedMs = 0
    send(out)
  }

  // MARK: - socket

  private func send(_ messages: [[String: Any]]) {
    for m in messages { sendJSON(m) }
  }

  private func sendJSON(_ m: [String: Any], done: ((Error?) -> Void)? = nil) {
    guard let ws, let text = jsonString(m) else {
      done?(nil)
      return
    }
    ws.send(.string(text)) { error in done?(error) }
  }

  private func receive(_ task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self else { return }
      self.q.async {
        guard !self.ended, task === self.ws else { return }
        switch result {
        case .success(let message):
          switch message {
          case .string(let text): self.onText(text)
          case .data(let data): self.onBinary(data)
          @unknown default: break
          }
          self.receive(task)
        case .failure:
          self.failed(task)
        }
      }
    }
  }

  private func ping() {
    guard opened, !ended else { return }
    ws?.sendPing { [weak self] error in
      guard error != nil else { return }
      self?.q.async { self?.end("连接断了") }
    }
  }

  private func failed(_ task: URLSessionTask) {
    let why: String
    switch (task.response as? HTTPURLResponse)?.statusCode {
    case 401: why = "授权失效，请重新配对"
    case 403: why = "只有手机可以打语音"
    case 503: why = "服务器还没开语音功能"
    default: why = "连接断了"
    }
    end(why)
  }

  private static func string(_ d: [String: Any], _ key: String) -> String {
    if let s = d[key] as? String { return s }
    if let n = d[key] as? NSNumber { return n.stringValue }
    return ""
  }

  private func onText(_ text: String) {
    if ended { return }
    guard let data = text.data(using: .utf8),
          let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
    let action = o["action"] as? String ?? ""
    let d = o["data"] as? [String: Any] ?? [:]
    let str = { (key: String) in VoiceCall.string(d, key) }
    switch action {
    case "relay.state":
      switch str("state") {
      case "ready":
        ready = true
        sendJSON(["action": "mic_state", "enabled": !muted])
        if let pendingInit = pendingInitTelemetryJson {
          pendingInitTelemetryJson = nil
          ws?.send(.string(pendingInit)) { _ in }
        }
        PocketBus.emit("onCall", ["state": "ready"])
      case "error", "closed":
        let message = str("message")
        end(message.isEmpty ? "通话结束了" : message)
        return
      default:
        break
      }
    case "response.audio.context":
      contexts.append(Ref(chunkId: str("chunk_id"), runId: str("run_id"), turnId: str("turn_id")))
      if contexts.count > 512 { contexts.removeFirst() }
    case "response.audio.started":
      let run = str("run_id")
      if !stoppedRuns.contains(run) {
        let s = scope(run, str("turn_id"))
        s.finished = false
        s.drained = false
        s.stopped = false
        s.playedMs = 0
      }
    case "response.audio.done":
      let run = str("run_id")
      if !stoppedRuns.contains(run) {
        playout.finish(run)
        let s = scope(run, str("turn_id"))
        s.finished = true
        if let m = drained(run, s) { sendJSON(m) }
      }
    case "response.audio.stop":
      let reason = str("reason")
      stopRun(str("run_id"), str("turn_id"), reason.isEmpty ? "interrupted" : reason)
    default:
      break
    }
    if action != "response.audio.context" { PocketBus.emit("onCallEvent", ["json": text]) }
  }

  private func onBinary(_ pcm: Data) {
    if ended || contexts.isEmpty { return }
    let ref = contexts.removeFirst()
    if stoppedRuns.contains(ref.runId) { return }
    guard let buffer = makeBuffer(pcm) else { return }
    scope(ref.runId, ref.turnId).outstanding += 1
    playout.push(Chunk(ref: ref, buffer: buffer, level: pcmLevel(pcm)), now: monoMs())
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    q.async { self.opened = true }
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    q.async { self.end("通话结束了") }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    q.async {
      if error != nil { self.failed(task) } else { self.end("通话结束了") }
    }
  }

  // MARK: - controls

  func setMuted(_ value: Bool) {
    muted = value
    micQueue.async {
      if value { self.filterReset = true }
    }
    q.async {
      if self.ended { return }
      if self.ready { self.sendJSON(["action": "mic_state", "enabled": !value]) }
      PocketBus.emit("onCall", ["state": "ready", "muted": value])
    }
  }

  func hangup() {
    q.async {
      if self.ended { return }
      guard self.opened else {
        self.end("挂断了")
        return
      }
      self.emitSummaryTelemetryOnce()
      var done = false
      let finish = {
        if done { return }
        done = true
        self.end("挂断了")
      }
      self.sendJSON(["action": "relay.hangup"]) { _ in self.q.async(execute: finish) }
      self.q.asyncAfter(deadline: .now() + 1, execute: finish)
    }
  }

  private func stats() -> [String: Any] {
    var d: [String: Any] = [
      "stalls": playout.stalls,
      "target_ms": Int64(playout.targetMs),
      "max_target_ms": Int64(playout.maxTargetMs),
      "underruns": -1,
      "stops": stops,
    ]
    if let f = filter {
      if f.hopsIn > 0 {
        d["denoise_us"] = f.denoiseNs / 1000 / f.hopsIn
        d["denoise_max_ms"] = f.denoiseMaxNs / 1_000_000
      }
      if f.checks > 0 {
        d["vp_checks"] = f.checks
        d["vp_max_ms"] = f.checkMsMax
        d["vp_passed"] = f.passed
        d["vp_blocked"] = f.blocked
        d["vp_hold_ms"] = 0
      }
    }
    return ["action": "call.stats", "data": d]
  }

  /// On `q`.
  private func end(_ message: String) {
    if ended { return }
    emitSummaryTelemetryOnce()
    if let f = filter, f.tseAudioMsSum > 0 {
      VoicePrefs.lastCallTseRtf = f.tseMsSum / f.tseAudioMsSum
    }
    ended = true
    ready = false
    VoiceCall.currentLock.lock()
    if VoiceCall._current === self { VoiceCall._current = nil }
    VoiceCall.currentLock.unlock()
    for t in timers { t.cancel() }
    timers.removeAll()
    ws?.cancel(with: .normalClosure, reason: "bye".data(using: .utf8))
    ws = nil
    session?.invalidateAndCancel()
    session = nil

    let s = stats()
    closeAudio()
    let filterToDrop = filter
    let modelsToDrop = voiceModels
    micQueue.async { [weak self] in
      self?.filter = nil
      self?.voiceModels = nil
      self?.tseQueue.async {
        self?.spkQueue.async {
          _ = filterToDrop
          _ = modelsToDrop
        }
      }
    }
    if let json = jsonString(s) {
      NSLog("PocketVoice %@", json)
      PocketBus.emit("onCallEvent", ["json": json])
    }
    PocketBus.emit("onCall", ["state": "ended", "message": message])
    VoiceCall.sessionQueue.async {
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
  }
}
