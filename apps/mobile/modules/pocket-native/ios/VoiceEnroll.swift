import CryptoKit
import Foundation

enum VoicePrefs {
  private static let d = UserDefaults.standard
  private static let kDenoise = "pocket.voiceDenoise"
  private static let kFilter = "pocket.voiceFilter"
  private static let kThreshold = "pocket.voiceThreshold"
  private static let kEmbedding = "pocket.voiceEmbedding"
  private static let kPrototypes = "pocket.voicePrototypes"
  private static let kModelVersion = "pocket.voiceModelVersion"

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

  static var prototypes: [[Float]]? {
    get {
      guard let arr = d.array(forKey: kPrototypes) as? [[Double]], !arr.isEmpty else { return nil }
      let mapped = arr.filter { !$0.isEmpty }.map { $0.map { Float($0) } }
      return mapped.isEmpty ? nil : mapped
    }
    set {
      if let v = newValue, !v.isEmpty {
        d.set(v.map { $0.map { Double($0) } }, forKey: kPrototypes)
      } else {
        d.removeObject(forKey: kPrototypes)
      }
    }
  }

  static var modelVersion: String? {
    get {
      guard let s = d.string(forKey: kModelVersion), !s.isEmpty else { return nil }
      return s
    }
    set {
      if let v = newValue, !v.isEmpty {
        d.set(v, forKey: kModelVersion)
      } else {
        d.removeObject(forKey: kModelVersion)
      }
    }
  }

  static var isCurrentEnrolled: Bool {
    embedding != nil && modelVersion == VOICEPRINT_MODEL_VERSION
  }

  static var isLegacyEnrolled: Bool {
    embedding != nil && modelVersion != VOICEPRINT_MODEL_VERSION
  }

  static func clearVoiceprint() {
    embedding = nil
    prototypes = nil
    modelVersion = nil
    VoiceModelManager.deleteOwnerSample()
  }
}

final class SpeechCollector {
  private static let keepProb: Float = 0.42
  private static let piece = voiceRate * 3 / 2
  private static let pieceHop = voiceRate * 3 / 4
  private static let sampleTarget = VoxLockEnrollment.sampleCount

  struct Voiceprint {
    let embedding: [Float]
    let prototypes: [[Float]]
    let ownerSample: [Float]
    let snrDb: Float
    let seconds: Float
    let consistency: Float
    let lowest: Float
  }

  private let m: VoiceModels
  private let hpf = HighPass64()
  private let vad: Vad
  private let vadBoost = QuietVadBoost()
  private var inWin = [Float](repeating: 0, count: Vad.window)
  private var hpfWin = [Float](repeating: 0, count: Vad.window)
  private var vadWin = [Float](repeating: 0, count: Vad.window)
  private var winLen = 0
  private var speech: [Float] = []

  private var noiseRms: Float = 0.0015
  private var noiseWindows = 0
  private var speechSqSum = 0.0
  private var speechSamples = 0

  private let levelLock = NSLock()
  private var _level: Float = 0
  var level: Float {
    get { levelLock.lock(); defer { levelLock.unlock() }; return _level }
    set { levelLock.lock(); _level = newValue; levelLock.unlock() }
  }
  var seconds: Float { Float(speech.count) / Float(voiceRate) }

  init(_ m: VoiceModels) {
    self.m = m
    self.vad = Vad(m)
    speech.reserveCapacity(voiceRate * 20)
  }

  func push(_ pcm: Data) {
    let total = pcm.count / 2
    var i = 0
    while i < total {
      let n = min(total - i, Vad.window - winLen)
      pcm16ToFloat(pcm.subdata(in: (i * 2) ..< ((i + n) * 2)), out: &inWin, outOff: winLen)
      winLen += n
      i += n
      if winLen < Vad.window { continue }
      winLen = 0

      // CRITICAL: Extract speaker embeddings ONLY from HPF-filtered clean mic audio, NEVER denoised audio.
      hpf.process(inWin, srcOff: 0, dst: &hpfWin, dstOff: 0, count: Vad.window)

      var e = 0.0
      for v in hpfWin { e += Double(v) * Double(v) }
      let winRms = Float((e / Double(Vad.window)).squareRoot())
      level = min(1.0, winRms * 4.0)

      vadBoost.prepare(hpfWin, into: &vadWin)
      let p = (try? vad.prob(vadWin)) ?? 0
      if p < 0.25 {
        if noiseWindows == 0 {
          noiseRms = max(0.0002, winRms)
        } else {
          noiseRms = 0.90 * noiseRms + 0.10 * max(0.0002, winRms)
        }
        noiseWindows += 1
        continue
      }
      if p < Self.keepProb { continue }

      speechSqSum += e
      speechSamples += Vad.window
      speech.append(contentsOf: hpfWin)
    }
  }

  func voiceprint(minSeconds: Float) throws -> Voiceprint? {
    if seconds < minSeconds { return nil }
    let sp = try Speaker(m)
    var pieces: [[Float]] = []
    var s = 0
    while s + Self.piece <= speech.count {
      let emb = normalizeEmbedding(try sp.embed(speech, off: s, len: Self.piece))
      if !emb.isEmpty { pieces.append(emb) }
      s += Self.pieceHop
    }
    if pieces.isEmpty {
      let emb = normalizeEmbedding(try sp.embed(speech, off: 0, len: speech.count))
      if !emb.isEmpty { pieces.append(emb) }
    }
    guard !pieces.isEmpty else { return nil }

    var kept = pieces
    var mean = meanEmbedding(kept)
    var scores = kept.map { cosine($0, mean) }
    if pieces.count >= 4 {
      let sorted = scores.sorted()
      let median = sorted[sorted.count / 2]
      let floor = max(Float(0.35), median - 0.22)
      let filtered = pieces.indices.filter { scores[$0] >= floor }.map { pieces[$0] }
      if filtered.count >= 3 && filtered.count < pieces.count {
        kept = filtered
        mean = meanEmbedding(kept)
        scores = kept.map { cosine($0, mean) }
      }
    }

    let protos = selectPrototypes(kept, centroid: mean, maxCount: 6)
    let ownerSample = Self.pickCleanestSample(speech, targetLen: Self.sampleTarget)
    let speechRms = speechSamples > 0 ? Float((speechSqSum / Double(speechSamples)).squareRoot()) : 0.02
    let rawSnr = 20.0 * log10(Double(max(speechRms, 1e-4)) / Double(max(noiseRms, 1e-4)))
    let snrDb = Float(min(60.0, max(0.0, rawSnr)))
    let sum = scores.reduce(0, +)

    return Voiceprint(
      embedding: mean,
      prototypes: protos,
      ownerSample: ownerSample,
      snrDb: snrDb,
      seconds: seconds,
      consistency: sum / Float(scores.count),
      lowest: scores.min() ?? 0
    )
  }

  private static func pickCleanestSample(_ speech: [Float], targetLen: Int) -> [Float] {
    guard !speech.isEmpty else { return [Float](repeating: 0, count: targetLen) }
    if speech.count <= targetLen {
      var out = [Float](repeating: 0, count: targetLen)
      for i in 0..<targetLen { out[i] = speech[i % speech.count] }
      return out
    }
    let step = 1_600 // 100 ms stride
    var bestOff = 0
    var bestScore = -1.0
    var off = 0
    while off + targetLen <= speech.count {
      var sq = 0.0
      var clipped = 0
      for i in 0..<targetLen {
        let v = speech[off + i]
        let av = abs(v)
        if av > 0.97 { clipped += 1 }
        sq += Double(v) * Double(v)
      }
      let rms = (sq / Double(targetLen)).squareRoot()
      let clipPenalty = clipped > 0 ? max(0.1, 1.0 - Double(clipped) / 200.0) : 1.0
      let quality = rms * clipPenalty
      if quality > bestScore {
        bestScore = quality
        bestOff = off
      }
      off += step
    }
    return Array(speech[bestOff ..< (bestOff + targetLen)])
  }
}

enum VoiceModelManager {
  private struct ModelSpec {
    let fileName: String
    let stampName: String
    let size: Int64
    let sha256: String
    let urls: [String]
  }

  private static let eres2netSpec = ModelSpec(
    fileName: "3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
    stampName: "eres2netv2.ok",
    size: 71_441_526,
    sha256: "bf1a75b9930474cf3389ef415e6e5d38ca96fea4a3a00f7e301d080a58ee2239",
    urls: [
      "https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
      "https://ghproxy.net/https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
      "https://hf-mirror.com/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
      "https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
    ]
  )

  private static let voxlockEnrollSpec = ModelSpec(
    fileName: "voxlock_enroll.onnx",
    stampName: "voxlock_enroll.ok",
    size: 21_023_799,
    sha256: "81f305c9b7a32f13d1401f53bb4c6301826a607c9e807e60912f36ef1b9fae29",
    urls: [
      "https://hf-mirror.com/arbazsiddiqui/voxlock/resolve/main/onnx/v2/enroll.onnx",
      "https://huggingface.co/arbazsiddiqui/voxlock/resolve/main/onnx/v2/enroll.onnx",
    ]
  )

  private static let voxlockChunkSpec = ModelSpec(
    fileName: "voxlock_chunk_int8.onnx",
    stampName: "voxlock_chunk_int8.ok",
    size: 56_560_589,
    sha256: "c50ffdc8d723fd4f91cb08889f3d0143491f95967b705f35c444a0b4afe88172",
    urls: [
      "https://hf-mirror.com/arbazsiddiqui/voxlock/resolve/main/onnx/v2/chunk_int8.onnx",
      "https://huggingface.co/arbazsiddiqui/voxlock/resolve/main/onnx/v2/chunk_int8.onnx",
    ]
  )

  private static let allSpecs: [ModelSpec] = [eres2netSpec, voxlockEnrollSpec, voxlockChunkSpec]
  static let speakerSize: Int64 = 149_025_914

  private static let lock = NSLock()
  private static var activeTask: URLSessionDownloadTask?
  private static var cancelled = false
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

  private static func modelURL(_ spec: ModelSpec) throws -> URL {
    try dir().appendingPathComponent(spec.fileName)
  }

  private static func stampURL(_ spec: ModelSpec) throws -> URL {
    try dir().appendingPathComponent(spec.stampName)
  }

  static func ownerSampleURL() throws -> URL {
    try dir().appendingPathComponent("owner_sample.pcm")
  }

  static func hasOwnerSample() -> Bool {
    guard let url = try? ownerSampleURL(),
          let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
          let size = (attrs[.size] as? NSNumber)?.int64Value else { return false }
    return size >= Int64(VoxLockEnrollment.sampleCount * 2)
  }

  @discardableResult
  static func saveOwnerSample(_ samples: [Float]) -> Bool {
    guard !samples.isEmpty, let url = try? ownerSampleURL() else { return false }
    var exact = [Float](repeating: 0, count: VoxLockEnrollment.sampleCount)
    for i in 0..<VoxLockEnrollment.sampleCount {
      exact[i] = samples[i % samples.count]
    }
    let pcm = floatToPcm16(exact, count: exact.count)
    do {
      try pcm.write(to: url, options: .atomic)
      return true
    } catch {
      return false
    }
  }

  static func loadOwnerSample() -> [Float]? {
    guard hasOwnerSample(),
          let url = try? ownerSampleURL(),
          let data = try? Data(contentsOf: url),
          data.count >= VoxLockEnrollment.sampleCount * 2 else { return nil }
    let sub = data.prefix(VoxLockEnrollment.sampleCount * 2)
    var out = [Float](repeating: 0, count: VoxLockEnrollment.sampleCount)
    pcm16ToFloat(Data(sub), out: &out, outOff: 0)
    return out
  }

  static func deleteOwnerSample() {
    if let url = try? ownerSampleURL() {
      try? FileManager.default.removeItem(at: url)
    }
  }

  private static func isSpecReady(_ spec: ModelSpec) -> Bool {
    guard let url = try? modelURL(spec),
          let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
          let size = (attrs[.size] as? NSNumber)?.int64Value,
          size == spec.size else { return false }
    let expectedStamp = "\(spec.size):\(spec.sha256)"
    if let ok = try? stampURL(spec),
       let text = try? String(contentsOf: ok, encoding: .utf8),
       text == expectedStamp {
      return true
    }
    if sha256(url) == spec.sha256 {
      if let ok = try? stampURL(spec) {
        try? expectedStamp.write(to: ok, atomically: true, encoding: .utf8)
      }
      return true
    }
    return false
  }

  static func isSpeakerReady() -> Bool {
    allSpecs.allSatisfy { isSpecReady($0) }
  }

  static func isSvOnlyReady() -> Bool {
    isSpecReady(eres2netSpec)
  }

  static func isTseReady() -> Bool {
    isSpecReady(voxlockEnrollSpec) && isSpecReady(voxlockChunkSpec) && hasOwnerSample()
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

  static func openModels(needSpeaker: Bool, needTse: Bool = false) throws -> VoiceModels {
    guard let dpdf = bundledModelPath("dpdfnet_baseline"), let vad = bundledModelPath("silero_vad") else {
      throw NSError(domain: "PocketVoice", code: 2, userInfo: [NSLocalizedDescriptionKey: "缺少语音基础模型"])
    }
    let spk = (needSpeaker && isSpecReady(eres2netSpec)) ? (try? modelURL(eres2netSpec).path) : nil
    let te = (needTse && isSpecReady(voxlockEnrollSpec) && isSpecReady(voxlockChunkSpec)) ? (try? modelURL(voxlockEnrollSpec).path) : nil
    let tc = (needTse && te != nil) ? (try? modelURL(voxlockChunkSpec).path) : nil
    return try VoiceModels.load(dpdfPath: dpdf, vadPath: vad, speakerPath: spk, tseEnrollPath: te, tseChunkPath: tc)
  }

  static func downloadSpeaker(onProgress: @escaping (Int64, Int64) -> Void, done: @escaping (Error?) -> Void) {
    if isSpeakerReady() {
      onProgress(speakerSize, speakerSize)
      done(nil)
      return
    }
    lock.lock()
    if _downloading {
      lock.unlock()
      done(NSError(domain: "PocketVoice", code: 8, userInfo: [NSLocalizedDescriptionKey: "正在下载模型"]))
      return
    }
    _downloading = true
    cancelled = false
    lock.unlock()

    DispatchQueue.global(qos: .userInitiated).async {
      // Remove obsolete 28 MB CAM++ file if present from older builds.
      if let d = try? dir() {
        try? FileManager.default.removeItem(at: d.appendingPathComponent("speaker.onnx"))
        try? FileManager.default.removeItem(at: d.appendingPathComponent("speaker.ok"))
      }
      downloadSpecAt(0, completedBytes: 0, onProgress: onProgress) { err in
        downloading = false
        done(err)
      }
    }
  }

  static func cancelDownload() {
    lock.lock()
    cancelled = true
    let t = activeTask
    activeTask = nil
    lock.unlock()
    t?.cancel()
  }

  private static func isCancelled() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return cancelled
  }

  private static func downloadSpecAt(
    _ specIdx: Int,
    completedBytes: Int64,
    onProgress: @escaping (Int64, Int64) -> Void,
    done: @escaping (Error?) -> Void
  ) {
    if isCancelled() {
      done(NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled, userInfo: [NSLocalizedDescriptionKey: "已取消下载"]))
      return
    }
    if specIdx >= allSpecs.count {
      onProgress(speakerSize, speakerSize)
      done(nil)
      return
    }
    let spec = allSpecs[specIdx]
    if isSpecReady(spec) {
      let nextCompleted = min(speakerSize, completedBytes + spec.size)
      onProgress(nextCompleted, speakerSize)
      downloadSpecAt(specIdx + 1, completedBytes: nextCompleted, onProgress: onProgress, done: done)
      return
    }
    trySpecUrls(spec, urlIdx: 0, completedBytes: completedBytes, lastError: nil, onProgress: onProgress) { err in
      if let err {
        done(err)
      } else {
        let nextCompleted = min(speakerSize, completedBytes + spec.size)
        onProgress(nextCompleted, speakerSize)
        downloadSpecAt(specIdx + 1, completedBytes: nextCompleted, onProgress: onProgress, done: done)
      }
    }
  }

  private static func trySpecUrls(
    _ spec: ModelSpec,
    urlIdx: Int,
    completedBytes: Int64,
    lastError: Error?,
    onProgress: @escaping (Int64, Int64) -> Void,
    done: @escaping (Error?) -> Void
  ) {
    if isCancelled() {
      done(NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled, userInfo: [NSLocalizedDescriptionKey: "已取消下载"]))
      return
    }
    if urlIdx >= spec.urls.count {
      done(lastError ?? NSError(domain: "PocketVoice", code: 3, userInfo: [NSLocalizedDescriptionKey: "下载声纹模型失败"]))
      return
    }
    guard let url = URL(string: spec.urls[urlIdx]) else {
      trySpecUrls(spec, urlIdx: urlIdx + 1, completedBytes: completedBytes, lastError: lastError, onProgress: onProgress, done: done)
      return
    }
    let dl = MirrorFetch(
      url: url,
      expectedFileBytes: spec.size,
      onProgress: { fileGot in
        let cumulative = min(speakerSize, completedBytes + min(spec.size, fileGot))
        onProgress(cumulative, speakerSize)
      },
      done: { result in
        switch result {
        case .success(let tmp):
          do {
            let target = try modelURL(spec)
            let stamp = try stampURL(spec)
            let attrs = try FileManager.default.attributesOfItem(atPath: tmp.path)
            let gotSize = (attrs[.size] as? NSNumber)?.int64Value ?? -1
            guard gotSize == spec.size, sha256(tmp) == spec.sha256 else {
              try? FileManager.default.removeItem(at: tmp)
              throw NSError(domain: "PocketVoice", code: 4, userInfo: [NSLocalizedDescriptionKey: "模型校验失败"])
            }
            try? FileManager.default.removeItem(at: target)
            try FileManager.default.moveItem(at: tmp, to: target)
            try "\(spec.size):\(spec.sha256)".write(to: stamp, atomically: true, encoding: .utf8)
            done(nil)
          } catch {
            trySpecUrls(spec, urlIdx: urlIdx + 1, completedBytes: completedBytes, lastError: error, onProgress: onProgress, done: done)
          }
        case .failure(let err):
          if (err as NSError).code == NSURLErrorCancelled || isCancelled() {
            done(err)
          } else {
            trySpecUrls(spec, urlIdx: urlIdx + 1, completedBytes: completedBytes, lastError: err, onProgress: onProgress, done: done)
          }
        }
      }
    )
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
    private let expectedFileBytes: Int64
    private let onProgress: (Int64) -> Void
    private let done: (Result<URL, Error>) -> Void
    private var lastReport: Int64 = 0
    private var finished = false
    private var session: URLSession?

    init(
      url: URL,
      expectedFileBytes: Int64,
      onProgress: @escaping (Int64) -> Void,
      done: @escaping (Result<URL, Error>) -> Void
    ) {
      self.url = url
      self.expectedFileBytes = expectedFileBytes
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

    func urlSession(
      _ session: URLSession,
      downloadTask: URLSessionDownloadTask,
      didWriteData bytesWritten: Int64,
      totalBytesWritten: Int64,
      totalBytesExpectedToWrite: Int64
    ) {
      let total = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : expectedFileBytes
      if totalBytesWritten - lastReport >= 256 * 1024 || totalBytesWritten >= total {
        lastReport = totalBytesWritten
        onProgress(totalBytesWritten)
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
      let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("voice-\(UUID().uuidString).onnx")
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
