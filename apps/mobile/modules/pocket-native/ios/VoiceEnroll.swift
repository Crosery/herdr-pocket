import CryptoKit
import Foundation

enum VoicePrefs {
  private static let d = UserDefaults.standard
  private static let kDenoise = "pocket.voiceDenoise"
  private static let kFilter = "pocket.voiceFilter"
  private static let kThreshold = "pocket.voiceThreshold"
  private static let kEmbedding = "pocket.voiceEmbedding"

  static var denoise: Bool {
    get { d.object(forKey: kDenoise) == nil ? true : d.bool(forKey: kDenoise) }
    set { d.set(newValue, forKey: kDenoise) }
  }

  static var filter: Bool {
    get { d.object(forKey: kFilter) == nil ? true : d.bool(forKey: kFilter) }
    set { d.set(newValue, forKey: kFilter) }
  }

  static var threshold: Float {
    get {
      let v = d.float(forKey: kThreshold)
      return v > 0 ? v : 0.38
    }
    set { d.set(newValue, forKey: kThreshold) }
  }

  static var embedding: [Float]? {
    get {
      guard let arr = d.array(forKey: kEmbedding) as? [Double], !arr.isEmpty else { return nil }
      return arr.map { Float($0) }
    }
    set {
      if let v = newValue, !v.isEmpty {
        d.set(v.map { Double($0) }, forKey: kEmbedding)
      } else {
        d.removeObject(forKey: kEmbedding)
      }
    }
  }
}

final class SpeechCollector {
  private static let keepProb: Float = 0.35
  private static let piece = voiceRate * 3 / 2
  private static let pieceHop = voiceRate * 3 / 4

  struct Voiceprint {
    let embedding: [Float]
    let seconds: Float
    let consistency: Float
    let lowest: Float
  }

  private let m: VoiceModels
  private let denoiser: Denoiser
  private let vad: Vad
  private var inBuf = [Float](repeating: 0, count: Denoiser.hop)
  private var inLen = 0
  private var win = [Float](repeating: 0, count: Vad.window)
  private var winLen = 0
  private var speech: [Float] = []

  private let levelLock = NSLock()
  private var _level: Float = 0
  var level: Float {
    get { levelLock.lock(); defer { levelLock.unlock() }; return _level }
    set { levelLock.lock(); _level = newValue; levelLock.unlock() }
  }
  var seconds: Float { Float(speech.count) / Float(voiceRate) }

  init(_ m: VoiceModels) {
    self.m = m
    self.denoiser = Denoiser(m)
    self.vad = Vad(m)
    speech.reserveCapacity(voiceRate * 20)
  }

  func push(_ pcm: Data) {
    let total = pcm.count / 2
    var i = 0
    while i < total {
      let n = min(total - i, Denoiser.hop - inLen)
      pcm16ToFloat(pcm.subdata(in: (i * 2) ..< ((i + n) * 2)), out: &inBuf, outOff: inLen)
      inLen += n
      i += n
      if inLen < Denoiser.hop { continue }
      inLen = 0
      guard (try? denoiser.hop(inBuf, off: 0, out: &win, outOff: winLen)) == true else { continue }
      winLen += Denoiser.hop
      if winLen < Vad.window { continue }
      winLen = 0
      var e = 0.0
      for v in win { e += Double(v) * Double(v) }
      level = Float(min(1.0, (e / Double(Vad.window)).squareRoot() * 4.0))
      if ((try? vad.prob(win)) ?? 0) < Self.keepProb { continue }
      speech.append(contentsOf: win)
    }
  }

  func voiceprint(minSeconds: Float) throws -> Voiceprint? {
    if seconds < minSeconds { return nil }
    let sp = try Speaker(m)
    var pieces: [[Float]] = []
    var s = 0
    while s + Self.piece <= speech.count {
      pieces.append(try sp.embed(speech, off: s, len: Self.piece))
      s += Self.pieceHop
    }
    if pieces.isEmpty { pieces.append(try sp.embed(speech, off: 0, len: speech.count)) }
    let mean = meanEmbedding(pieces)
    let scores = pieces.map { cosine($0, mean) }
    let sum = scores.reduce(0, +)
    return Voiceprint(embedding: mean, seconds: seconds, consistency: sum / Float(scores.count), lowest: scores.min() ?? 0)
  }
}

enum VoiceModelManager {
  static let speakerSize: Int64 = 28_281_164
  static let speakerSha256 = "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2"

  private static let speakerUrls = [
    "https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
    "https://ghproxy.net/https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
    "https://hf-mirror.com/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
  ]

  private static let lock = NSLock()
  private static var activeTask: URLSessionDownloadTask?
  private static var _downloading = false
  static var downloading: Bool {
    get { lock.lock(); defer { lock.unlock() }; return _downloading }
    set { lock.lock(); _downloading = newValue; lock.unlock() }
  }

  private static func dir() throws -> URL {
    let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let d = base.appendingPathComponent("voice", isDirectory: true)
    try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    var vals = URLResourceValues()
    vals.isExcludedFromBackup = true
    var mut = d
    try? mut.setResourceValues(vals)
    return d
  }

  static func speakerURL() throws -> URL { try dir().appendingPathComponent("speaker.onnx") }
  private static func stampURL() throws -> URL { try dir().appendingPathComponent("speaker.ok") }
  private static var stampText: String { "\(speakerSize):\(speakerSha256)" }

  static func isSpeakerReady() -> Bool {
    guard let url = try? speakerURL(),
          let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
          let size = (attrs[.size] as? NSNumber)?.int64Value,
          size == speakerSize else { return false }
    if let ok = try? stampURL(), let text = try? String(contentsOf: ok, encoding: .utf8), text == stampText {
      return true
    }
    if sha256(url) == speakerSha256 {
      if let ok = try? stampURL() { try? stampText.write(to: ok, atomically: true, encoding: .utf8) }
      return true
    }
    return false
  }

  private static func bundledModelPath(_ name: String) -> String? {
    let mod = Bundle(for: PocketNativeModule.self)
    if let bUrl = mod.url(forResource: "PocketNativeVoice", withExtension: "bundle"),
       let b = Bundle(url: bUrl),
       let p = b.path(forResource: name, ofType: "onnx") {
      return p
    }
    if let p = mod.path(forResource: name, ofType: "onnx") { return p }
    return Bundle.main.path(forResource: name, ofType: "onnx")
  }

  static func openModels(needSpeaker: Bool) throws -> VoiceModels {
    guard let gtcrn = bundledModelPath("gtcrn_simple"), let vad = bundledModelPath("silero_vad") else {
      throw NSError(domain: "PocketVoice", code: 2, userInfo: [NSLocalizedDescriptionKey: "缺少语音基础模型"])
    }
    let spk = (needSpeaker && isSpeakerReady()) ? (try? speakerURL().path) : nil
    return try VoiceModels.load(gtcrnPath: gtcrn, vadPath: vad, speakerPath: spk)
  }

  static func downloadSpeaker(onProgress: @escaping (Int64, Int64) -> Void, done: @escaping (Error?) -> Void) {
    if isSpeakerReady() {
      onProgress(speakerSize, speakerSize)
      done(nil)
      return
    }
    downloading = true
    DispatchQueue.global(qos: .userInitiated).async {
      tryUrls(0, lastError: nil, onProgress: onProgress) { err in
        downloading = false
        done(err)
      }
    }
  }

  static func cancelDownload() {
    lock.lock()
    let t = activeTask
    activeTask = nil
    lock.unlock()
    t?.cancel()
  }

  private static func tryUrls(_ idx: Int, lastError: Error?, onProgress: @escaping (Int64, Int64) -> Void, done: @escaping (Error?) -> Void) {
    if idx >= speakerUrls.count {
      done(lastError ?? NSError(domain: "PocketVoice", code: 3, userInfo: [NSLocalizedDescriptionKey: "下载声纹模型失败"]))
      return
    }
    guard let url = URL(string: speakerUrls[idx]) else {
      tryUrls(idx + 1, lastError: lastError, onProgress: onProgress, done: done)
      return
    }
    let dl = MirrorFetch(url: url, onProgress: onProgress) { result in
      switch result {
      case .success(let tmp):
        do {
          let target = try speakerURL()
          let stamp = try stampURL()
          guard sha256(tmp) == speakerSha256 else {
            try? FileManager.default.removeItem(at: tmp)
            throw NSError(domain: "PocketVoice", code: 4, userInfo: [NSLocalizedDescriptionKey: "模型校验失败"])
          }
          try? FileManager.default.removeItem(at: target)
          try FileManager.default.moveItem(at: tmp, to: target)
          try stampText.write(to: stamp, atomically: true, encoding: .utf8)
          done(nil)
        } catch {
          tryUrls(idx + 1, lastError: error, onProgress: onProgress, done: done)
        }
      case .failure(let err):
        if (err as NSError).code == NSURLErrorCancelled {
          done(err)
        } else {
          tryUrls(idx + 1, lastError: err, onProgress: onProgress, done: done)
        }
      }
    }
    lock.lock()
    activeTask = dl.start()
    lock.unlock()
  }

  private static func sha256(_ url: URL) -> String? {
    guard let stream = InputStream(url: url) else { return nil }
    stream.open()
    defer { stream.close() }
    var h = SHA256()
    var buf = [UInt8](repeating: 0, count: 64 * 1024)
    while stream.hasBytesAvailable {
      let n = stream.read(&buf, maxLength: buf.count)
      if n < 0 { return nil }
      if n == 0 { break }
      h.update(data: Data(bytes: buf, count: n))
    }
    return h.finalize().map { String(format: "%02x", $0) }.joined()
  }

  private final class MirrorFetch: NSObject, URLSessionDownloadDelegate {
    private let url: URL
    private let onProgress: (Int64, Int64) -> Void
    private let done: (Result<URL, Error>) -> Void
    private var lastReport: Int64 = 0
    private var finished = false
    private var session: URLSession?

    init(url: URL, onProgress: @escaping (Int64, Int64) -> Void, done: @escaping (Result<URL, Error>) -> Void) {
      self.url = url
      self.onProgress = onProgress
      self.done = done
    }

    func start() -> URLSessionDownloadTask {
      let s = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
      session = s
      let task = s.downloadTask(with: url)
      task.resume()
      return task
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
      let total = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : VoiceModelManager.speakerSize
      if totalBytesWritten - lastReport >= 256 * 1024 || totalBytesWritten >= total {
        lastReport = totalBytesWritten
        onProgress(totalBytesWritten, total)
      }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
      guard !finished else { return }
      finished = true
      defer { session.finishTasksAndInvalidate() }
      if let http = downloadTask.response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
        done(.failure(NSError(domain: "PocketVoice", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: "HTTP \(http.statusCode)"])))
        return
      }
      let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("speaker-\(UUID().uuidString).onnx")
      do {
        try FileManager.default.copyItem(at: location, to: tmp)
        done(.success(tmp))
      } catch {
        done(.failure(error))
      }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
      guard !finished, let error else { return }
      finished = true
      session.finishTasksAndInvalidate()
      done(.failure(error))
    }
  }
}
