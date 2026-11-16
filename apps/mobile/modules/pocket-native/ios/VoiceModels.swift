import Foundation
import onnxruntime_objc

final class VoiceModels {
  let env: ORTEnv
  let gtcrn: ORTSession
  let vad: ORTSession
  let speaker: ORTSession?

  private init(env: ORTEnv, gtcrn: ORTSession, vad: ORTSession, speaker: ORTSession?) {
    self.env = env
    self.gtcrn = gtcrn
    self.vad = vad
    self.speaker = speaker
  }

  static func load(gtcrnPath: String, vadPath: String, speakerPath: String?) throws -> VoiceModels {
    let env = try ORTEnv(loggingLevel: .warning)
    let opts = try ORTSessionOptions()
    try opts.setIntraOpNumThreads(1)
    try opts.setGraphOptimizationLevel(.all)
    try opts.addConfigEntry(withKey: "session.intra_op.allow_spinning", value: "0")
    try opts.addConfigEntry(withKey: "session.inter_op.allow_spinning", value: "0")
    let g = try ORTSession(env: env, modelPath: gtcrnPath, sessionOptions: opts)
    let v = try ORTSession(env: env, modelPath: vadPath, sessionOptions: opts)
    let s = try speakerPath.map { try ORTSession(env: env, modelPath: $0, sessionOptions: opts) }
    return VoiceModels(env: env, gtcrn: g, vad: v, speaker: s)
  }
}

private func makeTensor(_ floats: inout [Float], shape: [Int]) throws -> ORTValue {
  let data = floats.withUnsafeBytes { NSMutableData(bytes: $0.baseAddress!, length: $0.count) }
  return try ORTValue(tensorData: data, elementType: .float, shape: shape.map { NSNumber(value: $0) })
}

private func copyFloats(from val: ORTValue, into dst: inout [Float]) throws {
  let data = try val.tensorData()
  let n = min(dst.count, data.length / MemoryLayout<Float>.size)
  data.getBytes(&dst, length: n * MemoryLayout<Float>.size)
}

final class Denoiser {
  static let hop = 256
  private static let n = 512
  private static let bins = 257
  private static let win: [Double] = (0..<512).map { sqrt(0.5 - 0.5 * cos(2 * Double.pi * Double($0) / 512.0)) }
  private static let mixShape = [1, bins, 1, 2]
  private static let convShape = [2, 1, 16, 16, 33]
  private static let traShape = [2, 3, 1, 1, 16]
  private static let interShape = [2, 1, 33, 16]
  private static let outNames: Set<String> = ["enh", "conv_cache_out", "tra_cache_out", "inter_cache_out"]

  private let m: VoiceModels
  private var mix = [Float](repeating: 0, count: bins * 2)
  private var conv = [Float](repeating: 0, count: 2 * 1 * 16 * 16 * 33)
  private var tra = [Float](repeating: 0, count: 2 * 3 * 1 * 1 * 16)
  private var inter = [Float](repeating: 0, count: 2 * 1 * 33 * 16)
  private var ana = [Float](repeating: 0, count: n)
  private var ola = [Double](repeating: 0, count: n)
  private var re = [Double](repeating: 0, count: n)
  private var im = [Double](repeating: 0, count: n)
  private var started = false

  init(_ m: VoiceModels) {
    self.m = m
  }

  func reset() {
    conv.replaceSubrange(0..<conv.count, with: repeatElement(0, count: conv.count))
    tra.replaceSubrange(0..<tra.count, with: repeatElement(0, count: tra.count))
    inter.replaceSubrange(0..<inter.count, with: repeatElement(0, count: inter.count))
    ana.replaceSubrange(0..<ana.count, with: repeatElement(0, count: ana.count))
    ola.replaceSubrange(0..<ola.count, with: repeatElement(0.0, count: ola.count))
    started = false
  }

  func hop(_ x: [Float], off: Int, out: inout [Float], outOff: Int) throws -> Bool {
    let keep = Self.n - Self.hop
    for i in 0..<keep { ana[i] = ana[i + Self.hop] }
    for i in 0..<Self.hop { ana[keep + i] = x[off + i] }
    for i in 0..<Self.n {
      re[i] = Double(ana[i]) * Self.win[i]
      im[i] = 0
    }
    Fft512.run(&re, &im)
    for k in 0..<Self.bins {
      mix[2 * k] = Float(re[k])
      mix[2 * k + 1] = Float(im[k])
    }
    let tMix = try makeTensor(&mix, shape: Self.mixShape)
    let tConv = try makeTensor(&conv, shape: Self.convShape)
    let tTra = try makeTensor(&tra, shape: Self.traShape)
    let tInter = try makeTensor(&inter, shape: Self.interShape)
    let res = try m.gtcrn.run(
      withInputs: ["mix": tMix, "conv_cache": tConv, "tra_cache": tTra, "inter_cache": tInter],
      outputNames: Self.outNames,
      runOptions: nil
    )
    if let v = res["conv_cache_out"] { try copyFloats(from: v, into: &conv) }
    if let v = res["tra_cache_out"] { try copyFloats(from: v, into: &tra) }
    if let v = res["inter_cache_out"] { try copyFloats(from: v, into: &inter) }
    if let enh = res["enh"] {
      let data = try enh.tensorData() as Data
      data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        let e = raw.bindMemory(to: Float.self)
        re[0] = Double(e[0]); im[0] = 0
        re[Self.n / 2] = Double(e[2 * (Self.bins - 1)]); im[Self.n / 2] = 0
        for k in 1..<(Self.bins - 1) {
          let a = Double(e[2 * k])
          let b = Double(e[2 * k + 1])
          re[k] = a; im[k] = -b
          re[Self.n - k] = a; im[Self.n - k] = b
        }
      }
    }
    Fft512.run(&re, &im)
    for i in 0..<keep { ola[i] = ola[i + Self.hop] }
    for i in keep..<Self.n { ola[i] = 0 }
    for i in 0..<Self.n { ola[i] += re[i] / Double(Self.n) * Self.win[i] }
    if !started {
      started = true
      return false
    }
    for i in 0..<Self.hop { out[outOff + i] = Float(ola[i]) }
    return true
  }
}

final class Vad {
  static let window = 512
  private static let xShape = [1, window]
  private static let stateShape = [2, 1, 64]
  private static let outNames: Set<String> = ["prob", "new_h", "new_c"]

  private let m: VoiceModels
  private var x = [Float](repeating: 0, count: window)
  private var h = [Float](repeating: 0, count: 128)
  private var c = [Float](repeating: 0, count: 128)

  init(_ m: VoiceModels) { self.m = m }

  func reset() {
    h.replaceSubrange(0..<h.count, with: repeatElement(0, count: h.count))
    c.replaceSubrange(0..<c.count, with: repeatElement(0, count: c.count))
  }

  func prob(_ w: [Float], off: Int = 0) throws -> Float {
    for i in 0..<Self.window { x[i] = w[off + i] }
    let tx = try makeTensor(&x, shape: Self.xShape)
    let th = try makeTensor(&h, shape: Self.stateShape)
    let tc = try makeTensor(&c, shape: Self.stateShape)
    let res = try m.vad.run(withInputs: ["x": tx, "h": th, "c": tc], outputNames: Self.outNames, runOptions: nil)
    if let nh = res["new_h"] { try copyFloats(from: nh, into: &h) }
    if let nc = res["new_c"] { try copyFloats(from: nc, into: &c) }
    guard let pVal = res["prob"] else { return 0 }
    let data = try pVal.tensorData() as Data
    return data.withUnsafeBytes { $0.load(as: Float.self) }
  }
}

final class Speaker {
  private let m: VoiceModels
  private let session: ORTSession
  private let inputName: String
  private let outputName: String

  init(_ m: VoiceModels) throws {
    guard let s = m.speaker else { throw NSError(domain: "PocketVoice", code: 1, userInfo: [NSLocalizedDescriptionKey: "no voiceprint model"]) }
    self.m = m
    self.session = s
    self.inputName = (try s.inputNames()).first ?? "x"
    self.outputName = (try s.outputNames()).first ?? "embedding"
  }

  func embed(_ samples: [Float], off: Int = 0, len: Int? = nil) throws -> [Float] {
    var feats = Fbank.compute(samples, off: off, len: len)
    let frames = feats.count / Fbank.bins
    let tx = try makeTensor(&feats, shape: [1, frames, Fbank.bins])
    let res = try session.run(withInputs: [inputName: tx], outputNames: [outputName], runOptions: nil)
    guard let outVal = res[outputName] else { return [] }
    let data = try outVal.tensorData()
    let n = data.length / MemoryLayout<Float>.size
    var out = [Float](repeating: 0, count: n)
    data.getBytes(&out, length: n * MemoryLayout<Float>.size)
    return out
  }
}
