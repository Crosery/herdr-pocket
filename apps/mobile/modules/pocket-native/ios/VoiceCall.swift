import AVFoundation
import Foundation

private let micRate = 16_000.0
private let speakerRate = 48_000
private let speakerPerMs = speakerRate / 1000
/// 20 ms of 16 kHz mono PCM16.
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
 * Audio never passes through JavaScript: the microphone goes straight to the
 * socket, speech straight to the speaker, and playback receipts follow what was
 * actually heard (MOSS-Live playback.* events). JS only gets the text events for
 * captions and state, through the same onCall / onCallEvent / onLevel events.
 *
 * Everything but the microphone tap runs on one serial queue `q` (the Kotlin
 * side's `lock`). AVAudioEngine's voice processing gives echo cancellation,
 * noise suppression and gain control; the session's voiceChat mode routes to a
 * headset when one is connected, otherwise to the loudspeaker.
 */
final class VoiceCall: NSObject, URLSessionWebSocketDelegate {
  private static let currentLock = NSLock()
  private static var _current: VoiceCall?
  static var current: VoiceCall? {
    get { currentLock.lock(); defer { currentLock.unlock() }; return _current }
    set { currentLock.lock(); _current = newValue; currentLock.unlock() }
  }

  /**
   * Audio session changes, one at a time across calls. Switching the session off
   * can block for seconds while the system stops I/O; it runs after the call has
   * reported its end, and a call started meanwhile waits for it here instead of
   * having its own session switched off by the one before.
   */
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
  private let spkQueue = DispatchQueue(label: "dev.crosery.pocket.spk", qos: .userInitiated)
  private let useDenoise: Bool
  private let voiceThreshold: Float
  private let enrolledVoice: [Float]?
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
  private var ended = false
  private var opened = false
  private var ready = false
  private var micLevel: Float = 0

  private let flagLock = NSLock()
  private var _muted = false
  /// Read from the JS thread (callState), so behind a lock.
  var muted: Bool {
    get { flagLock.lock(); defer { flagLock.unlock() }; return _muted }
    set { flagLock.lock(); _muted = newValue; flagLock.unlock() }
  }

  // Playback ledger; on `q`.
  private var contexts: [Ref] = []
  /// Audio received and not yet scheduled on the player: the jitter buffer.
  private let playout = Playout<Chunk>(framesPerMs: speakerPerMs)
  /// Chunks scheduled on the player and not yet heard in full, oldest first.
  private var inflight: [Chunk] = []
  /// When the first of `inflight` started playing.
  private var headStartedAt: Int64 = 0
  /// Bumped by a flush: receipts from the player for what was flushed are ignored.
  private var generation = 0
  /// Replies the service stopped (response.audio.stop), for the call's stats.
  private var stops = 0
  private var scopes: [String: Scope] = [:]
  private var stoppedRuns = Set<String>()

  private init(server: String, token: String) {
    self.server = server
    self.token = token
    self.useDenoise = VoicePrefs.denoise
    self.voiceThreshold = VoicePrefs.threshold
    self.enrolledVoice = VoicePrefs.filter ? VoicePrefs.embedding : nil
    super.init()
  }

  // MARK: - start

  private func begin() {
    PocketBus.emit("onCall", ["state": "connecting"])
    let needSpeaker = enrolledVoice != nil && VoiceModelManager.isSpeakerReady()
    if useDenoise || needSpeaker {
      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        let loaded = try? VoiceModelManager.openModels(needSpeaker: needSpeaker)
        self?.q.async {
          guard let self else { return }
          if self.ended { return }
          self.voiceModels = loaded
          if let loaded, self.useDenoise || (self.enrolledVoice != nil && loaded.speaker != nil) {
            self.filter = VoiceFilter(
              loaded,
              VoiceFilter.Options(denoise: self.useDenoise, enrolled: self.enrolledVoice, threshold: self.voiceThreshold),
              worker: { [weak self] job in self?.spkQueue.async(execute: job) },
              emit: { [weak self] pcm in
                guard let self, !self.ended else { return }
                let lv = pcmLevel(pcm)
                self.micLevel = self.muted ? 0 : lv
                if self.ready && !self.muted { self.ws?.send(.data(pcm)) { _ in } }
              }
            )
          }
          self.modelsLoaded = true
        }
      }
    } else {
      modelsLoaded = true
    }
    do {
      try openAudio()
    } catch {
      end("打不开麦克风：\(error.localizedDescription)")
      return
    }
    guard let url = wsUrl(server, "/v1/assistant/live") else {
      end("服务器地址不对")
      return
    }
    var req = URLRequest(url: url)
    // The token rides in a header: a URL ends up in reverse-proxy access logs.
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    let config = URLSessionConfiguration.default
    // The socket stays open for the whole call; the connect timeout is the timer below.
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
      // Voice chat: a headset when one is connected, otherwise the loudspeaker (a hands-free call).
      try audio.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
      try? audio.setPreferredSampleRate(Double(speakerRate))
      try? audio.setPreferredIOBufferDuration(0.02)
      try audio.setActive(true)
    }
    #if !targetEnvironment(simulator)
    // Hear the person, not our own voice coming out of the speaker.
    try? engine.inputNode.setVoiceProcessingEnabled(true)
    #endif
    // Not in the iOS Simulator: its audio server deadlocks on voice processing and
    // CoreAudio aborts the app ("RPC timeout. Apparently deadlocked"). The Mac's
    // microphone and speakers are enough to check a call there.
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

  /// The microphone at its own rate, turned into 16 kHz mono PCM16 on the tap's thread.
  private func installMicTap() throws {
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else { throw CallError(message: "找不到麦克风") }
    guard let converter = AVAudioConverter(from: format, to: micFormat) else { throw CallError(message: "麦克风的格式用不了") }
    let target = micFormat
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(max(256, format.sampleRate / 50)), format: format) { [weak self] buffer, _ in
      guard let data = VoiceCall.convert(buffer, with: converter, to: target) else { return }
      self?.q.async { self?.onMic(data) }
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

  /// A headset came or went (or the system reset the audio): carry on with the new hardware.
  private func restartEngine() {
    if ended { return }
    do {
      if !engine.isRunning {
        // What was on the player may not have been heard: it goes back to be played again.
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

  // MARK: - microphone

  private func onMic(_ data: Data) {
    if ended { return }
    micPending.append(data)
    let muted = self.muted
    while micPending.count >= micFrameBytes {
      let start = micPending.startIndex
      let frame = micPending.subdata(in: start ..< start + micFrameBytes)
      micPending = micPending.subdata(in: start + micFrameBytes ..< micPending.endIndex)
      if muted {
        if filterReset {
          filterReset = false
          filter?.reset()
        }
        micLevel = 0
        // Silence keeps flowing while muted: the model expects a continuous realtime stream.
        if ready { ws?.send(.data(silence)) { _ in } }
      } else if let vf = filter {
        filterReset = false
        let before = vf.hopsIn
        micLevel *= 0.6
        vf.push(frame)
        if vf.hopsIn == before { micLevel = 0 }
      } else if !modelsLoaded && (useDenoise || enrolledVoice != nil) {
        // Models are still loading (~150 ms at call start); hold mic frames until ready instead of leaking raw audio.
        micLevel = 0
      } else {
        micLevel = pcmLevel(frame)
        if ready { ws?.send(.data(frame)) { _ in } }
      }
    }
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

  /// Speech on the player not heard yet, in frames. The chunk playing counts until the player says it is done.
  private func pendingFrames(_ now: Int64) -> Int64 {
    guard let head = inflight.first else { return 0 }
    let total = inflight.reduce(Int64(0)) { $0 + Int64($1.frames) }
    let into = min(Int64(head.frames - 1), max(0, (now - headStartedAt) * Int64(speakerPerMs)))
    return max(1, total - into)
  }

  /**
   * Feeds the speaker. The jitter buffer (Playout) says when a reply has enough
   * audio in to start, and when one that ran dry may go on; up to `aheadMs` of it
   * is scheduled on the player at a time, like the Android track's buffer.
   */
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

  /// The player has played `chunk` in full: its receipt, and those of any before it.
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

  /// A chunk the speaker has played in full: its receipt, and the reply's when it was the last.
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

  /// The model was interrupted: stop its speech now and report how much was heard.
  private func stopRun(_ runId: String, _ turnId: String, _ reason: String) {
    var out: [[String: Any]] = []
    stoppedRuns.insert(runId)
    stops += 1
    playout.drop(runId)
    let s = scope(runId, turnId)
    // Stopped, not completed: no playback.completed for it from the receipts.
    s.stopped = true
    if inflight.contains(where: { $0.ref.runId == runId }) {
      // Chunks heard in full already have their receipts; this adds the part of the one playing.
      let heard = min(Int64(inflight[0].frames), max(0, (monoMs() - headStartedAt) * Int64(speakerPerMs)))
      var back: [Chunk] = []
      for (i, c) in inflight.enumerated() {
        if c.ref.runId == runId {
          if i == 0 { s.playedMs += Double(heard) * 1000 / Double(speakerRate) }
        } else {
          // Another reply's audio on the player: it goes back to be played after the flush.
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
    // All of the reply that was heard; the relay turns it into what each service expects.
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
        // A short reply that is all in plays at once, without waiting for the cushion.
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
    // Captions and state for the UI; audio contexts are only plumbing.
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
    q.async {
      if self.ended { return }
      if value { self.filterReset = true }
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
      // Close only once the hangup is out (or after a second), so the relay hears it.
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

  /// Mid-reply stalls of the jitter buffer, its cushion and stopped replies. iOS reports no underruns: -1.
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
        d["vp_hold_ms"] = f.holds > 0 ? f.holdMsSum / Int64(f.holds) : 0
      }
    }
    return ["action": "call.stats", "data": d]
  }

  /// On `q`.
  private func end(_ message: String) {
    if ended { return }
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
    // How the speaker did, for the app's log: what a real call leaves to look at afterwards.
    let s = stats()
    closeAudio()
    filter = nil
    let modelsToDrop = voiceModels
    voiceModels = nil
    spkQueue.async {
      _ = modelsToDrop
    }
    if let json = jsonString(s) {
      NSLog("PocketVoice %@", json)
      PocketBus.emit("onCallEvent", ["json": json])
    }
    PocketBus.emit("onCall", ["state": "ended", "message": message])
    // Last, and off the call's queue: this can block (see sessionQueue). Other apps' audio may resume.
    VoiceCall.sessionQueue.async {
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
  }
}
