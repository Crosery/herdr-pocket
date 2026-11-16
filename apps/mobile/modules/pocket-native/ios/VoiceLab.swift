import AVFoundation
import Foundation

enum VoiceLab {
  private static let micRate = 16_000.0
  private static let maxEnrollSec: Float = 20
  private static let minEnrollSec: Float = 3.5

  private final class Session {
    let kind: String
    let models: VoiceModels
    let engine = AVAudioEngine()
    let q = DispatchQueue(label: "dev.crosery.pocket.vlab", qos: .userInteractive)
    let spkQueue = DispatchQueue(label: "dev.crosery.pocket.vlab-spk", qos: .userInitiated)
    var stopped = false
    var collector: SpeechCollector?
    var timer: DispatchSourceTimer?
    init(kind: String, models: VoiceModels) {
      self.kind = kind
      self.models = models
    }
  }

  private static let lock = NSLock()
  private static var current: Session?

  private static func callErr(_ msg: String) -> Error {
    NSError(domain: "PocketVoice", code: 10, userInfo: [NSLocalizedDescriptionKey: msg])
  }

  static func startEnroll() throws {
    stop()
    guard VoiceCall.current == nil else { throw callErr("正在通话中，挂断后再录声纹") }
    guard VoiceModelManager.isSpeakerReady() else { throw callErr("声纹模型还没准备好") }
    let models = try VoiceModelManager.openModels(needSpeaker: true)
    guard models.speaker != nil else { throw callErr("声纹模型打不开") }
    let s = Session(kind: "enroll", models: models)
    let col = SpeechCollector(models)
    s.collector = col
    do {
      try openMic(s) { pcm in
        if col.seconds < maxEnrollSec { col.push(pcm) }
      }
    } catch {
      closeEngine(s)
      throw error
    }
    let t = DispatchSource.makeTimerSource(queue: s.q)
    t.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
    t.setEventHandler {
      if s.stopped { return }
      PocketBus.emit("onEnrollProgress", [
        "level": Double(col.level),
        "seconds": Double(col.seconds),
        "full": col.seconds >= maxEnrollSec,
      ])
    }
    t.resume()
    s.timer = t
    lock.lock()
    current = s
    lock.unlock()
  }

  static func finishEnroll() throws -> [String: Any] {
    lock.lock()
    guard let s = current, s.kind == "enroll" else {
      lock.unlock()
      throw callErr("没有正在进行的录音")
    }
    current = nil
    lock.unlock()
    stopSession(s)
    guard let col = s.collector, let vp = try col.voiceprint(minSeconds: minEnrollSec) else {
      let got = s.collector?.seconds ?? 0
      throw callErr("录到的有效说话只有 \(String(format: "%.1f", got)) 秒，再多说几句试试")
    }
    VoicePrefs.embedding = vp.embedding
    VoicePrefs.filter = true
    return [
      "embedding": vp.embedding.map { Double($0) },
      "seconds": Double(vp.seconds),
      "consistency": Double(vp.consistency),
      "lowest": Double(vp.lowest),
    ]
  }

  static func startTest(threshold: Float) throws {
    stop()
    guard VoiceCall.current == nil else { throw callErr("正在通话中，挂断后再测试") }
    guard let enrolled = VoicePrefs.embedding else { throw callErr("还没有录入声纹") }
    guard VoiceModelManager.isSpeakerReady() else { throw callErr("声纹模型还没准备好") }
    let models = try VoiceModelManager.openModels(needSpeaker: true)
    let den = Denoiser(models)
    let vad = Vad(models)
    let sp = try Speaker(models)
    let s = Session(kind: "test", models: models)

    var hopIn = [Float](repeating: 0, count: Denoiser.hop)
    var hopLen = 0
    var win = [Float](repeating: 0, count: Vad.window)
    var winLen = 0
    var speechBuf: [Float] = []
    speechBuf.reserveCapacity(voiceRate * 2)
    var speaking = false
    var silRun = 0
    var checkPending = false
    var level: Float = 0

    func runCheck(_ copy: [Float], _ lv: Float) {
      if checkPending || copy.count < voiceRate * 2 / 5 { return }
      checkPending = true
      s.spkQueue.async {
        defer { s.q.async { checkPending = false } }
        let score = (try? cosine(sp.embed(copy), enrolled)) ?? -1
        if !s.stopped {
          PocketBus.emit("onVoiceTest", ["level": Double(lv), "speaking": true, "score": Double(score), "pass": score >= threshold])
        }
      }
    }

    do {
      try openMic(s) { pcm in
        var tmp = [Float](repeating: 0, count: pcm.count / 2)
        pcm16ToFloat(pcm, out: &tmp, outOff: 0)
        var i = 0
        while i < tmp.count && !s.stopped {
          let take = min(tmp.count - i, Denoiser.hop - hopLen)
          for k in 0..<take { hopIn[hopLen + k] = tmp[i + k] }
          hopLen += take
          i += take
          if hopLen < Denoiser.hop { continue }
          hopLen = 0
          guard (try? den.hop(hopIn, off: 0, out: &win, outOff: winLen)) == true else { continue }
          winLen += Denoiser.hop
          if winLen < Vad.window { continue }
          winLen = 0
          var e = 0.0
          for v in win { e += Double(v) * Double(v) }
          level = Float(min(1.0, (e / Double(Vad.window)).squareRoot() * 4.0))
          let p = (try? vad.prob(win)) ?? 0
          if p >= 0.35 {
            speaking = true
            silRun = 0
            speechBuf.append(contentsOf: win)
            if speechBuf.count > voiceRate * 2 {
              speechBuf.removeFirst(speechBuf.count - voiceRate * 2)
            }
            if speechBuf.count >= voiceRate * 4 / 5 { runCheck(speechBuf, level) }
          } else if speaking {
            silRun += 1
            if silRun >= 15 {
              speaking = false
              silRun = 0
              if speechBuf.count >= voiceRate * 2 / 5 { runCheck(speechBuf, level) }
              speechBuf.removeAll(keepingCapacity: true)
            }
          }
        }
      }
    } catch {
      closeEngine(s)
      throw error
    }

    let t = DispatchSource.makeTimerSource(queue: s.q)
    t.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
    t.setEventHandler {
      if s.stopped { return }
      PocketBus.emit("onVoiceTest", ["level": Double(level), "speaking": speaking])
    }
    t.resume()
    s.timer = t
    lock.lock()
    current = s
    lock.unlock()
  }

  static func stop() {
    lock.lock()
    guard let s = current else {
      lock.unlock()
      return
    }
    current = nil
    lock.unlock()
    stopSession(s)
  }

  private static func stopSession(_ s: Session) {
    s.stopped = true
    s.timer?.cancel()
    s.timer = nil
    closeEngine(s)
    s.q.sync {}
    s.spkQueue.sync {}
  }

  private static func closeEngine(_ s: Session) {
    s.engine.inputNode.removeTap(onBus: 0)
    s.engine.stop()
    VoiceCall.sessionQueue.async {
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
  }

  private static func openMic(_ s: Session, onPcm: @escaping (Data) -> Void) throws {
    let audio = AVAudioSession.sharedInstance()
    try VoiceCall.sessionQueue.sync {
      try audio.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
      try? audio.setPreferredIOBufferDuration(0.02)
      try audio.setActive(true)
    }
    #if !targetEnvironment(simulator)
    try? s.engine.inputNode.setVoiceProcessingEnabled(true)
    #endif
    let input = s.engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else { throw callErr("找不到麦克风") }
    let micFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: micRate, channels: 1, interleaved: true)!
    guard let converter = AVAudioConverter(from: format, to: micFormat) else { throw callErr("麦克风的格式用不了") }
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(max(256, format.sampleRate / 50)), format: format) { buffer, _ in
      guard let data = convert(buffer, with: converter, to: micFormat) else { return }
      s.q.async {
        if !s.stopped { onPcm(data) }
      }
    }
    s.engine.prepare()
    try s.engine.start()
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
}
