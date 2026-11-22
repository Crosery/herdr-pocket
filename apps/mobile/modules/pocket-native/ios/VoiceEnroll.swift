import CryptoKit
import Darwin
import Foundation

enum VoicePrefs {
  private static let d = UserDefaults.standard
  private static let kDenoise = "pocket.voiceDenoise"
  private static let kFilter = "pocket.voiceFilter"
  private static let kThreshold = "pocket.voiceThreshold"
  private static let kVoiceTier = "pocket.voiceTier"
  private static let kFirstSpeaker = "pocket.voiceFirstSpeaker"
  private static let kLastCallTseRtf = "pocket.lastCallTseRtf"
  private static let kBenchTier = "pocket.benchRecommendedTier"
  private static let kBenchReason = "pocket.benchReason"
  private static let kBenchDpdfUs = "pocket.benchDpdfUs"
  private static let kBenchTseRtf = "pocket.benchTseRtf"
  private static let kBenchAt = "pocket.benchAt"
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

  /// `"auto" | "denoise" | "sv" | "tse"`
  static var voiceTier: String {
    get {
      let raw = d.string(forKey: kVoiceTier) ?? "auto"
      return ["auto", "denoise", "sv", "tse"].contains(raw) ? raw : "auto"
    }
    set {
      let clean = ["auto", "denoise", "sv", "tse"].contains(newValue) ? newValue : "auto"
      d.set(clean, forKey: kVoiceTier)
    }
  }

  static var firstSpeaker: Bool {
    get { d.object(forKey: kFirstSpeaker) == nil ? false : d.bool(forKey: kFirstSpeaker) }
    set { d.set(newValue, forKey: kFirstSpeaker) }
  }

  static var lastCallTseRtf: Double {
    get { d.object(forKey: kLastCallTseRtf) == nil ? -1.0 : d.double(forKey: kLastCallTseRtf) }
    set { d.set(newValue, forKey: kLastCallTseRtf) }
  }

  static var benchRecommendedTier: String? {
    get {
      guard let s = d.string(forKey: kBenchTier), !s.isEmpty else { return nil }
      return s
    }
    set {
      if let v = newValue, !v.isEmpty { d.set(v, forKey: kBenchTier) }
      else { d.removeObject(forKey: kBenchTier) }
    }
  }

  static var benchReason: String? {
    get {
      guard let s = d.string(forKey: kBenchReason), !s.isEmpty else { return nil }
      return s
    }
    set {
      if let v = newValue, !v.isEmpty { d.set(v, forKey: kBenchReason) }
      else { d.removeObject(forKey: kBenchReason) }
    }
  }

  static var benchDpdfUs: Double {
    get { d.object(forKey: kBenchDpdfUs) == nil ? -1.0 : d.double(forKey: kBenchDpdfUs) }
    set { d.set(newValue, forKey: kBenchDpdfUs) }
  }

  static var benchTseRtf: Double {
    get { d.object(forKey: kBenchTseRtf) == nil ? -1.0 : d.double(forKey: kBenchTseRtf) }
    set { d.set(newValue, forKey: kBenchTseRtf) }
  }

  static var benchAt: Int64 {
    get { Int64(d.double(forKey: kBenchAt)) }
    set { d.set(Double(newValue), forKey: kBenchAt) }
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
    size: 71_441_527,
    sha256: "eda0bf86422a9725a3523d5a1d3d75dedf340664e0ba65cfc1c7b2a78b6cf0b5",
    urls: [
      "https://hf-mirror.com/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
      "https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
      "https://ghfast.top/https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
      "https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
      "https://cdn.gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
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
  static let svSize: Int64 = eres2netSpec.size // 71_441_527
  static let speakerSize: Int64 = 149_025_915

  private static let lock = NSLock()
  private static var activeToken: FastDownloader.CancelToken?
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

  static func isTseModelsReady() -> Bool {
    isSpecReady(voxlockEnrollSpec) && isSpecReady(voxlockChunkSpec)
  }

  static func isTseReady() -> Bool {
    isTseModelsReady() && hasOwnerSample()
  }

  static func benchmarkDevice() throws -> [String: Any] {
    let models = try openModels(needSpeaker: false, needTse: isTseModelsReady())
    let denoiser = Denoiser(models)
    let vad = Vad(models)
    let hopIn = [Float](repeating: 0.01, count: Denoiser.hop)
    var hopOut = [Float](repeating: 0, count: Denoiser.hop)
    let vadWin = [Float](repeating: 0, count: Vad.window)
    for _ in 0..<5 {
      _ = try? denoiser.hop(hopIn, off: 0, out: &hopOut, outOff: 0)
      _ = try? vad.prob(vadWin)
    }
    let t0 = DispatchTime.now().uptimeNanoseconds
    for _ in 0..<25 {
      _ = try? denoiser.hop(hopIn, off: 0, out: &hopOut, outOff: 0)
    }
    let dpdfUsAvg = Double(DispatchTime.now().uptimeNanoseconds - t0) / 25.0 / 1_000.0

    var benchTseRtf = -1.0
    if models.tseEnroll != nil && models.tseChunk != nil {
      let dummySample = [Float](repeating: 0.01, count: VoxLockEnrollment.sampleCount)
      if let (enr, _) = try? VoxLockEnrollment.compute(models, ownerSamples: dummySample),
         let extractor = try? TargetExtractor(models, enrollment: enr) {
        let firstInput = [Float](repeating: 0.01, count: extractor.requiredInputSamples)
        _ = try? extractor.step(firstInput)
        let stepInput = [Float](repeating: 0.01, count: extractor.requiredInputSamples)
        let ts0 = DispatchTime.now().uptimeNanoseconds
        for _ in 0..<3 {
          _ = try? extractor.step(stepInput)
        }
        let tseMsAvg = Double(DispatchTime.now().uptimeNanoseconds - ts0) / 3.0 / 1_000_000.0
        benchTseRtf = tseMsAvg / 40.0
      }
    }

    let cores = ProcessInfo.processInfo.activeProcessorCount
    let ramMb = Int(ProcessInfo.processInfo.physicalMemory / (1024 * 1024))
    var sys = utsname()
    uname(&sys)
    let machine = withUnsafePointer(to: &sys.machine) {
      $0.withMemoryRebound(to: CChar.self, capacity: Int(_SYS_NAMELEN)) {
        String(cString: $0)
      }
    }

    let realCallTseRtf = VoicePrefs.lastCallTseRtf
    let measuredTseRtf = max(realCallTseRtf, benchTseRtf)
    let dpdfRtf = dpdfUsAvg / 10_000.0

    let recommended: String
    let reason: String
    if measuredTseRtf > 0.0 {
      if measuredTseRtf <= 0.80 {
        recommended = "tse"
        reason = String(format: "实测分离负载 %.0f%%（单帧降噪 %.2f ms），可流畅运行旗舰分离模型", measuredTseRtf * 100.0, dpdfUsAvg / 1000.0)
      } else if dpdfRtf <= 0.75 {
        recommended = "sv"
        reason = String(format: "实测人声分离负载 %.2fx 超出实时上限，推荐 68 MB 灵巧声纹门控（不吞字、不断流）", measuredTseRtf)
      } else {
        recommended = "denoise"
        reason = String(format: "设备当前负载较高（降噪单帧 %.2f ms），推荐仅开内置轻量降噪", dpdfUsAvg / 1000.0)
      }
    } else if dpdfUsAvg <= 1650.0 && cores >= 6 && ramMb >= 5500 {
      recommended = "tse"
      reason = String(format: "芯片算力充裕（降噪 %.2f ms/帧 · %d核），支持 142 MB 旗舰人声分离", dpdfUsAvg / 1000.0, cores)
    } else if dpdfUsAvg <= 6800.0 {
      recommended = "sv"
      reason = String(format: "实测降噪 %.2f ms/帧（%d核），推荐 68 MB 灵巧声纹门控（稳且省空间）", dpdfUsAvg / 1000.0, cores)
    } else {
      recommended = "denoise"
      reason = String(format: "实测降噪 %.2f ms/帧，推荐内置轻量降噪保证零卡顿", dpdfUsAvg / 1000.0)
    }

    let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
    VoicePrefs.benchRecommendedTier = recommended
    VoicePrefs.benchReason = reason
    VoicePrefs.benchDpdfUs = dpdfUsAvg
    if measuredTseRtf > 0.0 { VoicePrefs.benchTseRtf = measuredTseRtf }
    VoicePrefs.benchAt = nowMs

    return [
      "recommendedTier": recommended,
      "reason": reason,
      "dpdfUs": dpdfUsAvg,
      "tseRtf": measuredTseRtf > 0.0 ? measuredTseRtf : -1.0,
      "cores": cores,
      "ramMb": ramMb,
      "soc": machine,
      "at": Double(nowMs),
    ]
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

  static func downloadModels(
    tier: String,
    onProgress: @escaping (Int64, Int64) -> Void,
    done: @escaping (Error?) -> Void
  ) {
    let specs = (tier == "sv") ? [eres2netSpec] : allSpecs
    let totalSize = specs.reduce(Int64(0)) { $0 + $1.size }
    if specs.allSatisfy({ isSpecReady($0) }) {
      onProgress(totalSize, totalSize)
      done(nil)
      return
    }
    let cancelToken = FastDownloader.CancelToken()
    lock.lock()
    if _downloading {
      lock.unlock()
      done(NSError(domain: "PocketVoice", code: 8, userInfo: [NSLocalizedDescriptionKey: "正在下载模型"]))
      return
    }
    _downloading = true
    cancelled = false
    activeToken = cancelToken
    lock.unlock()

    DispatchQueue.global(qos: .userInitiated).async {
      defer {
        lock.lock()
        activeToken = nil
        _downloading = false
        lock.unlock()
      }
      if let d = try? dir() {
        try? FileManager.default.removeItem(at: d.appendingPathComponent("speaker.onnx"))
        try? FileManager.default.removeItem(at: d.appendingPathComponent("speaker.ok"))
      }
      var completedBytes: Int64 = 0
      for spec in specs {
        if isCancelled() || cancelToken.cancelled {
          done(NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled, userInfo: [NSLocalizedDescriptionKey: "已取消下载"]))
          return
        }
        if isSpecReady(spec) {
          completedBytes += spec.size
          onProgress(min(totalSize, completedBytes), totalSize)
          continue
        }
        do {
          let target = try modelURL(spec)
          let stamp = try stampURL(spec)
          let part = target.deletingLastPathComponent().appendingPathComponent("\(spec.fileName).part")
          try? FileManager.default.removeItem(at: part)
          try FastDownloader.download(
            urls: spec.urls,
            partFile: part,
            expectedSize: spec.size,
            expectedSha256: spec.sha256,
            token: cancelToken,
            onProgress: { got, _ in
              onProgress(min(totalSize, completedBytes + min(spec.size, got)), totalSize)
            }
          )
          try? FileManager.default.removeItem(at: stamp)
          try? FileManager.default.removeItem(at: target)
          try FileManager.default.moveItem(at: part, to: target)
          try "\(spec.size):\(spec.sha256)".write(to: stamp, atomically: true, encoding: .utf8)
          completedBytes += spec.size
          onProgress(min(totalSize, completedBytes), totalSize)
        } catch {
          done(error)
          return
        }
      }
      onProgress(totalSize, totalSize)
      done(nil)
    }
  }

  static func downloadSpeaker(onProgress: @escaping (Int64, Int64) -> Void, done: @escaping (Error?) -> Void) {
    downloadModels(tier: "tse", onProgress: onProgress, done: done)
  }

  static func cancelDownload() {
    lock.lock()
    cancelled = true
    let t = activeToken
    activeToken = nil
    lock.unlock()
    t?.cancel()
  }

  private static func isCancelled() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return cancelled
  }

  private static func sha256(_ url: URL) -> String? {
    FastDownloader.sha256(url)
  }
}
