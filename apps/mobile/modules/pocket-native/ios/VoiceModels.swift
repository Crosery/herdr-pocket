import Foundation
import onnxruntime_objc

/// Reads top-level ONNX ModelProto `metadata_props` (field 14) without loading graph weights into heap.
func parseOnnxCustomMetadata(atPath path: String) -> [String: String] {
  guard let data = try? Data(contentsOf: URL(fileURLWithPath: path), options: .mappedIfSafe) else {
    return [:]
  }
  var out: [String: String] = [:]
  data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
    guard let base = raw.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
    let end = raw.count

    func readVarint(_ idx: inout Int, limit: Int) -> UInt64? {
      var val: UInt64 = 0
      var shift: UInt64 = 0
      while idx < limit && shift < 64 {
        let b = base[idx]
        idx += 1
        val |= UInt64(b & 0x7F) << shift
        if (b & 0x80) == 0 { return val }
        shift += 7
      }
      return nil
    }

    var i = 0
    while i < end {
      guard let tag = readVarint(&i, limit: end) else { break }
      let field = Int(tag >> 3)
      let wire = Int(tag & 0x07)
      switch wire {
      case 0:
        if readVarint(&i, limit: end) == nil { return }
      case 1:
        guard i + 8 <= end else { return }
        i += 8
      case 5:
        guard i + 4 <= end else { return }
        i += 4
      case 2:
        guard let lenU = readVarint(&i, limit: end) else { return }
        let len = Int(lenU)
        guard len >= 0, i + len <= end else { return }
        if field == 14 {
          let subEnd = i + len
          var j = i
          var key = ""
          var val = ""
          while j < subEnd {
            guard let sTag = readVarint(&j, limit: subEnd) else { break }
            let sField = Int(sTag >> 3)
            let sWire = Int(sTag & 0x07)
            if sWire == 2 {
              guard let sLenU = readVarint(&j, limit: subEnd) else { break }
              let sLen = Int(sLenU)
              guard sLen >= 0, j + sLen <= subEnd else { break }
              let str = String(decoding: UnsafeBufferPointer(start: base.advanced(by: j), count: sLen), as: UTF8.self)
              if sField == 1 { key = str } else if sField == 2 { val = str }
              j += sLen
            } else if sWire == 0 {
              if readVarint(&j, limit: subEnd) == nil { break }
            } else if sWire == 1 {
              guard j + 8 <= subEnd else { break }
              j += 8
            } else if sWire == 5 {
              guard j + 4 <= subEnd else { break }
              j += 4
            } else {
              break
            }
          }
          if !key.isEmpty { out[key] = val }
        }
        i += len
      default:
        return
      }
    }
  }
  return out
}

struct DpdfConfig {
  let windowLength: Int
  let hopLength: Int
  let stateSize: Int
  let initState: [Float]

  static func fromModel(atPath path: String) -> DpdfConfig {
    let meta = parseOnnxCustomMetadata(atPath: path)
    let winLen = Int(meta["window_length"] ?? "") ?? 320
    let hopLen = Int(meta["hop_length"] ?? "") ?? 160
    let stateSize = Int(meta["state_size"] ?? "") ?? 38_256
    let erbSz = Int(meta["erb_norm_state_size"] ?? "") ?? 32
    let specSz = Int(meta["spec_norm_state_size"] ?? "") ?? 96

    var initState = [Float](repeating: 0, count: stateSize)
    let erbVals = (meta["erb_norm_init"] ?? "").split(separator: ",").compactMap { Float($0.trimmingCharacters(in: .whitespaces)) }
    if erbVals.count == erbSz && erbSz <= stateSize {
      for i in 0..<erbSz { initState[i] = erbVals[i] }
    } else if erbSz <= stateSize {
      for i in 0..<erbSz {
        initState[i] = -60.0 + (-30.0) * Float(i) / Float(max(1, erbSz - 1))
      }
    }

    let specVals = (meta["spec_norm_init"] ?? "").split(separator: ",").compactMap { Float($0.trimmingCharacters(in: .whitespaces)) }
    if specVals.count == specSz && erbSz + specSz <= stateSize {
      for i in 0..<specSz { initState[erbSz + i] = specVals[i] }
    } else if erbSz + specSz <= stateSize {
      for i in 0..<specSz {
        initState[erbSz + i] = 0.001 + (-0.0009) * Float(i) / Float(max(1, specSz - 1))
      }
    }
    return DpdfConfig(windowLength: winLen, hopLength: hopLen, stateSize: stateSize, initState: initState)
  }
}

final class VoiceModels {
  let env: ORTEnv
  let dpdfnet: ORTSession
  let dpdfConfig: DpdfConfig
  let vad: ORTSession
  let speaker: ORTSession?
  let tseEnroll: ORTSession?
  let tseChunk: ORTSession?

  private init(
    env: ORTEnv,
    dpdfnet: ORTSession,
    dpdfConfig: DpdfConfig,
    vad: ORTSession,
    speaker: ORTSession?,
    tseEnroll: ORTSession?,
    tseChunk: ORTSession?
  ) {
    self.env = env
    self.dpdfnet = dpdfnet
    self.dpdfConfig = dpdfConfig
    self.vad = vad
    self.speaker = speaker
    self.tseEnroll = tseEnroll
    self.tseChunk = tseChunk
  }

  static func load(
    dpdfPath: String,
    vadPath: String,
    speakerPath: String?,
    tseEnrollPath: String? = nil,
    tseChunkPath: String? = nil
  ) throws -> VoiceModels {
    let env = try ORTEnv(loggingLevel: .warning)
    func makeOpts(_ threads: Int32) throws -> ORTSessionOptions {
      let opts = try ORTSessionOptions()
      try opts.setIntraOpNumThreads(threads)
      try opts.setGraphOptimizationLevel(.all)
      try opts.addConfigEntry(withKey: "session.intra_op.allow_spinning", value: "0")
      try opts.addConfigEntry(withKey: "session.inter_op.allow_spinning", value: "0")
      return opts
    }
    let cfg = DpdfConfig.fromModel(atPath: dpdfPath)
    let dpdf = try ORTSession(env: env, modelPath: dpdfPath, sessionOptions: makeOpts(1))
    let v = try ORTSession(env: env, modelPath: vadPath, sessionOptions: makeOpts(1))
    let twoThreads: Int32 = ProcessInfo.processInfo.activeProcessorCount >= 2 ? 2 : 1
    let s = try speakerPath.map { try ORTSession(env: env, modelPath: $0, sessionOptions: makeOpts(twoThreads)) }
    let te = try tseEnrollPath.map { try ORTSession(env: env, modelPath: $0, sessionOptions: makeOpts(twoThreads)) }
    let tc = try tseChunkPath.map { try ORTSession(env: env, modelPath: $0, sessionOptions: makeOpts(twoThreads)) }
    return VoiceModels(env: env, dpdfnet: dpdf, dpdfConfig: cfg, vad: v, speaker: s, tseEnroll: te, tseChunk: tc)
  }
}

private func makeTensor(_ floats: inout [Float], shape: [Int]) throws -> ORTValue {
  let data = floats.withUnsafeBytes { NSMutableData(bytes: $0.baseAddress!, length: $0.count) }
  return try ORTValue(tensorData: data, elementType: .float, shape: shape.map { NSNumber(value: $0) })
}

private func makeTensorSlice(_ floats: [Float], count: Int, shape: [Int]) throws -> ORTValue {
  let byteLen = count * MemoryLayout<Float>.size
  let data = floats.withUnsafeBytes { NSMutableData(bytes: $0.baseAddress!, length: byteLen) }
  return try ORTValue(tensorData: data, elementType: .float, shape: shape.map { NSNumber(value: $0) })
}

private func copyFloats(from val: ORTValue, into dst: inout [Float], count: Int? = nil) throws {
  let data = try val.tensorData()
  let maxCount = dst.count
  let avail = data.length / MemoryLayout<Float>.size
  let n = min(count ?? maxCount, min(maxCount, avail))
  data.getBytes(&dst, length: n * MemoryLayout<Float>.size)
}

/// Streaming 16 kHz speech enhancement & vocal harmonics restoration on DPDFNet-baseline (10 ms hop, 20 ms Vorbis window).
final class Denoiser {
  static let hop = 160
  static let n = 320
  private static let bins = 161
  private static let dryDelayHops = 5 // 800 samples = 50 ms (1 STFT OLA + 4 DF lookahead in DPDFNet-baseline)
  private static let maxDryBlend: Float = 0.04
  private static let vorbisWin: [Double] = (0..<320).map { idx in
    let s = sin(0.5 * Double.pi * (Double(idx) + 0.5) / 160.0)
    return sin(0.5 * Double.pi * s * s)
  }
  private static let specShape = [1, 1, bins, 2]

  private let m: VoiceModels
  private let specInName: String
  private let stateInName: String
  private let specOutName: String
  private let stateOutName: String
  private let outNames: Set<String>
  private let stateShape: [Int]
  private let fftWs = Fft320.Workspace()

  private var spec = [Float](repeating: 0, count: bins * 2)
  private var state: [Float]
  private var ana = [Float](repeating: 0, count: n)
  private var ola = [Double](repeating: 0, count: n)
  private var re = [Double](repeating: 0, count: n)
  private var im = [Double](repeating: 0, count: n)
  private var dryRing = [Float](repeating: 0, count: dryDelayHops * hop)
  private var dryDelayed = [Float](repeating: 0, count: hop)
  private var dryCursor = 0
  private var dryGain: Float = 0

  init(_ m: VoiceModels) {
    self.m = m
    let ins = (try? m.dpdfnet.inputNames()) ?? ["spec", "state_in"]
    let outs = (try? m.dpdfnet.outputNames()) ?? ["spec_e", "state_out"]
    self.specInName = ins.count > 0 ? ins[0] : "spec"
    self.stateInName = ins.count > 1 ? ins[1] : "state_in"
    self.specOutName = outs.count > 0 ? outs[0] : "spec_e"
    self.stateOutName = outs.count > 1 ? outs[1] : "state_out"
    self.outNames = [specOutName, stateOutName]
    self.stateShape = [m.dpdfConfig.stateSize]
    self.state = m.dpdfConfig.initState
  }

  func reset() {
    state = m.dpdfConfig.initState
    ana.replaceSubrange(0..<ana.count, with: repeatElement(0, count: ana.count))
    ola.replaceSubrange(0..<ola.count, with: repeatElement(0.0, count: ola.count))
    dryRing.replaceSubrange(0..<dryRing.count, with: repeatElement(0, count: dryRing.count))
    dryDelayed.replaceSubrange(0..<dryDelayed.count, with: repeatElement(0, count: dryDelayed.count))
    dryCursor = 0
    dryGain = 0
  }

  @discardableResult
  func hop(_ x: [Float], off: Int, out: inout [Float], outOff: Int) throws -> Bool {
    for i in 0..<Self.hop {
      dryDelayed[i] = dryRing[dryCursor + i]
      dryRing[dryCursor + i] = x[off + i]
    }
    dryCursor += Self.hop
    if dryCursor >= dryRing.count { dryCursor = 0 }

    let keep = Self.n - Self.hop
    for i in 0..<keep { ana[i] = ana[i + Self.hop] }
    for i in 0..<Self.hop { ana[keep + i] = x[off + i] }

    for i in 0..<Self.n {
      re[i] = Double(ana[i]) * Self.vorbisWin[i]
      im[i] = 0
    }
    Fft320.run(&re, &im, fftWs)
    for k in 0..<Self.bins {
      spec[2 * k] = Float(re[k])
      spec[2 * k + 1] = Float(im[k])
    }

    let tSpec = try makeTensor(&spec, shape: Self.specShape)
    let tState = try makeTensor(&state, shape: stateShape)
    let res = try m.dpdfnet.run(
      withInputs: [specInName: tSpec, stateInName: tState],
      outputNames: outNames,
      runOptions: nil
    )
    if let sOut = res[stateOutName] {
      try copyFloats(from: sOut, into: &state)
    }
    if let enh = res[specOutName] {
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
    Fft320.run(&re, &im, fftWs)

    // Critical OLA order: shift left by 160 BEFORE adding irfft(spec_e) * vorbisWin.
    for i in 0..<keep { ola[i] = ola[i + Self.hop] }
    for i in keep..<Self.n { ola[i] = 0 }
    let invN = 1.0 / Double(Self.n)
    for i in 0..<Self.n {
      ola[i] += (re[i] * invN) * Self.vorbisWin[i]
    }

    // ~4% 5-hop (800-sample) phase-aligned dry speech floor so consonants stay natural without comb filtering.
    var enhSq = 0.0
    for i in 0..<Self.hop {
      let ev = ola[i]
      enhSq += ev * ev
    }
    let enhRms = Float((enhSq / Double(Self.hop)).squareRoot())
    let wantDry: Float = enhRms > 0.0025 ? Self.maxDryBlend : 0
    dryGain = wantDry > dryGain ? (0.65 * dryGain + 0.35 * wantDry) : (0.85 * dryGain + 0.15 * wantDry)
    let wet: Float = 1.0 - dryGain
    for i in 0..<Self.hop {
      out[outOff + i] = wet * Float(ola[i]) + dryGain * dryDelayed[i]
    }
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
  private let ws = Fbank.Workspace()

  init(_ m: VoiceModels) throws {
    guard let s = m.speaker else {
      throw NSError(domain: "PocketVoice", code: 1, userInfo: [NSLocalizedDescriptionKey: "no voiceprint model"])
    }
    self.m = m
    self.session = s
    self.inputName = (try s.inputNames()).first ?? "x"
    self.outputName = (try s.outputNames()).first ?? "embedding"
  }

  func embed(_ samples: [Float], off: Int = 0, len: Int? = nil) throws -> [Float] {
    var feats = Fbank.compute(samples, off: off, len: len, ws: ws)
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

/// Precomputed owner KV-attention conditioning tensors from `voxlock_enroll.onnx` (`[1, 48000]`).
final class VoxLockEnrollment {
  static let sampleCount = 48_000
  let enrollN: ORTValue
  let k: ORTValue
  let v: ORTValue

  private init(enrollN: ORTValue, k: ORTValue, v: ORTValue) {
    self.enrollN = enrollN
    self.k = k
    self.v = v
  }

  static func compute(_ m: VoiceModels, ownerSamples: [Float]) throws -> (VoxLockEnrollment, Int64) {
    guard let session = m.tseEnroll else {
      throw NSError(domain: "PocketVoice", code: 5, userInfo: [NSLocalizedDescriptionKey: "no TSE enroll model"])
    }
    var buf = [Float](repeating: 0, count: sampleCount)
    if !ownerSamples.isEmpty {
      for i in 0..<sampleCount {
        buf[i] = ownerSamples[i % ownerSamples.count]
      }
    }
    let t0 = DispatchTime.now().uptimeNanoseconds
    let inName = (try? session.inputNames().first) ?? "enroll"
    let outNames: Set<String> = ["enroll_n", "k", "v"]
    let tEnroll = try makeTensor(&buf, shape: [1, sampleCount])
    let res = try session.run(withInputs: [inName: tEnroll], outputNames: outNames, runOptions: nil)
    guard let en = res["enroll_n"], let kVal = res["k"], let vVal = res["v"] else {
      throw NSError(domain: "PocketVoice", code: 6, userInfo: [NSLocalizedDescriptionKey: "invalid TSE enroll outputs"])
    }
    let ms = Int64((DispatchTime.now().uptimeNanoseconds - t0) / 1_000_000)
    return (VoxLockEnrollment(enrollN: en, k: kVal, v: vVal), ms)
  }
}

/// Streaming VoxLock v2 INT8 target speaker extractor (`K=5` frames = 40 ms default, `K=8` = 64 ms overload step-up).
final class TargetExtractor {
  static let nfft = 512
  static let hop = 128
  static let overlapLen = 384
  static let reflectPad = 256
  private static let stateShape = [6, 32, 256]
  private static let stateCount = 6 * 32 * 256
  private static let outNames: Set<String> = ["frames", "h_out", "c_out"]
  private static let winSq: [Float] = (0..<512).map { i in
    let w = 0.5 - 0.5 * cos(2.0 * Double.pi * Double(i) / 512.0)
    return Float(w * w)
  }

  private let m: VoiceModels
  private let session: ORTSession
  private let enrollment: VoxLockEnrollment
  private var hVal: ORTValue
  private var cVal: ORTValue

  private(set) var kFrames: Int = 5
  private(set) var isFirstStep = true
  private var wavBuf = [Float](repeating: 0, count: 8 * hop + overlapLen)
  private var framesBuf = [Float](repeating: 0, count: 8 * nfft)
  private var overlap = [Float](repeating: 0, count: overlapLen)
  private var ola = [Float](repeating: 0, count: 8 * hop + nfft)
  private var wsum = [Float](repeating: 0, count: 8 * hop + nfft)

  var requiredInputSamples: Int {
    let step = kFrames * Self.hop
    return isFirstStep ? (step + Self.hop) : step
  }

  init(_ m: VoiceModels, enrollment: VoxLockEnrollment) throws {
    guard let s = m.tseChunk else {
      throw NSError(domain: "PocketVoice", code: 7, userInfo: [NSLocalizedDescriptionKey: "no TSE chunk model"])
    }
    self.m = m
    self.session = s
    self.enrollment = enrollment
    var z1 = [Float](repeating: 0, count: Self.stateCount)
    var z2 = [Float](repeating: 0, count: Self.stateCount)
    self.hVal = try makeTensor(&z1, shape: Self.stateShape)
    self.cVal = try makeTensor(&z2, shape: Self.stateShape)
  }

  func setKFrames(_ k: Int) {
    kFrames = max(4, min(8, k))
  }

  func reset() {
    var z1 = [Float](repeating: 0, count: Self.stateCount)
    var z2 = [Float](repeating: 0, count: Self.stateCount)
    if let h = try? makeTensor(&z1, shape: Self.stateShape),
       let c = try? makeTensor(&z2, shape: Self.stateShape) {
      hVal = h
      cVal = c
    }
    isFirstStep = true
    overlap.replaceSubrange(0..<overlap.count, with: repeatElement(0, count: overlap.count))
    ola.replaceSubrange(0..<ola.count, with: repeatElement(0, count: ola.count))
    wsum.replaceSubrange(0..<wsum.count, with: repeatElement(0, count: wsum.count))
  }

  /// Processes `requiredInputSamples` of clean HPF audio and returns `(extracted, alignedRaw, inferMs)`.
  func step(_ input: [Float]) throws -> (tse: [Float], raw: [Float], ms: Double) {
    let kf = kFrames
    let stepSamples = kf * Self.hop
    let ns = stepSamples + Self.overlapLen

    if isFirstStep {
      // Reflect-pad initial 256 samples (`padded[i] = call_wav[256 - i]`), followed by `stepSamples + 128` samples.
      let maxIdx = max(0, input.count - 1)
      for i in 0..<Self.reflectPad {
        let rIdx = min(maxIdx, Self.reflectPad - i)
        wavBuf[i] = input.isEmpty ? 0 : input[rIdx]
      }
      let copyCount = min(input.count, stepSamples + Self.hop)
      for i in 0..<copyCount {
        wavBuf[Self.reflectPad + i] = input[i]
      }
      if copyCount < stepSamples + Self.hop {
        for i in copyCount..<(stepSamples + Self.hop) {
          wavBuf[Self.reflectPad + i] = 0
        }
      }
    } else {
      for i in 0..<Self.overlapLen {
        wavBuf[i] = overlap[i]
      }
      let copyCount = min(input.count, stepSamples)
      for i in 0..<copyCount {
        wavBuf[Self.overlapLen + i] = input[i]
      }
      if copyCount < stepSamples {
        for i in copyCount..<stepSamples {
          wavBuf[Self.overlapLen + i] = 0
        }
      }
    }

    for i in 0..<Self.overlapLen {
      overlap[i] = wavBuf[stepSamples + i]
    }

    let t0 = DispatchTime.now().uptimeNanoseconds
    let tWav = try makeTensorSlice(wavBuf, count: ns, shape: [1, ns])
    let res = try session.run(
      withInputs: [
        "wav": tWav,
        "enroll_n": enrollment.enrollN,
        "k": enrollment.k,
        "v": enrollment.v,
        "h": hVal,
        "c": cVal,
      ],
      outputNames: Self.outNames,
      runOptions: nil
    )
    let ms = Double(DispatchTime.now().uptimeNanoseconds - t0) / 1_000_000.0

    if let nh = res["h_out"] { hVal = nh }
    if let nc = res["c_out"] { cVal = nc }
    if let fVal = res["frames"] {
      try copyFloats(from: fVal, into: &framesBuf, count: kf * Self.nfft)
    }

    for fi in 0..<kf {
      let pos = fi * Self.hop
      let fBase = fi * Self.nfft
      for j in 0..<Self.nfft {
        ola[pos + j] += framesBuf[fBase + j]
        wsum[pos + j] += Self.winSq[j]
      }
    }

    let startIdx = isFirstStep ? Self.reflectPad : 0
    let outCount = stepSamples - startIdx
    var tseOut = [Float](repeating: 0, count: outCount)
    var rawOut = [Float](repeating: 0, count: outCount)
    for idx in 0..<outCount {
      let p = startIdx + idx
      tseOut[idx] = ola[p] / max(wsum[p], 1e-8)
      rawOut[idx] = wavBuf[p]
    }

    for i in 0..<Self.overlapLen {
      ola[i] = ola[stepSamples + i]
      wsum[i] = wsum[stepSamples + i]
    }
    for i in Self.overlapLen..<(stepSamples + Self.nfft) where i < ola.count {
      ola[i] = 0
      wsum[i] = 0
    }

    isFirstStep = false
    return (tseOut, rawOut, ms)
  }
}
