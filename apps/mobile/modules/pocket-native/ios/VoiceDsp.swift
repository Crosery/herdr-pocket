import Foundation

let voiceRate = 16_000
let VOICEPRINT_MODEL_VERSION = "eres2netv2-voxlock-v2"

/// Zero-allocation mixed-radix 5 * 64 complex FFT of size 320 for DPDFNet-baseline 20 ms STFT/ISTFT.
enum Fft320 {
  static let n = 320
  static let bins = 161
  private static let m = 64

  final class Workspace {
    var subRe = [Double](repeating: 0, count: 320)
    var subIm = [Double](repeating: 0, count: 320)
  }

  private static let rev64: [Int] = {
    var r = [Int](repeating: 0, count: 64)
    var j = 0
    for i in 0..<64 {
      r[i] = j
      var bit = 32
      while (j & bit) != 0 {
        j ^= bit
        bit >>= 1
      }
      j |= bit
    }
    return r
  }()

  private static let cos64: [Double] = (0..<32).map { cos(2.0 * Double.pi * Double($0) / 64.0) }
  private static let sin64: [Double] = (0..<32).map { -sin(2.0 * Double.pi * Double($0) / 64.0) }

  private static let twCos: [Double] = {
    var t = [Double](repeating: 1.0, count: 5 * 64)
    for r in 1..<5 {
      for p in 1..<64 {
        t[r * 64 + p] = cos(2.0 * Double.pi * Double(r * p) / 320.0)
      }
    }
    return t
  }()

  private static let twSin: [Double] = {
    var t = [Double](repeating: 0.0, count: 5 * 64)
    for r in 1..<5 {
      for p in 1..<64 {
        t[r * 64 + p] = -sin(2.0 * Double.pi * Double(r * p) / 320.0)
      }
    }
    return t
  }()

  private static let c1 = cos(2.0 * Double.pi / 5.0)
  private static let s1 = sin(2.0 * Double.pi / 5.0)
  private static let c2 = cos(4.0 * Double.pi / 5.0)
  private static let s2 = sin(4.0 * Double.pi / 5.0)

  private static func run64(_ re: inout [Double], _ im: inout [Double], base: Int) {
    for i in 0..<m {
      let j = rev64[i]
      if j > i {
        re.swapAt(base + i, base + j)
        im.swapAt(base + i, base + j)
      }
    }
    var size = 2
    while size <= m {
      let half = size >> 1
      let step = m / size
      var s = 0
      while s < m {
        for k in 0..<half {
          let wr = cos64[k * step]
          let wi = sin64[k * step]
          let a = base + s + k
          let b = a + half
          let xr = re[b] * wr - im[b] * wi
          let xi = re[b] * wi + im[b] * wr
          re[b] = re[a] - xr
          im[b] = im[a] - xi
          re[a] += xr
          im[a] += xi
        }
        s += size
      }
      size <<= 1
    }
  }

  static func run(_ re: inout [Double], _ im: inout [Double], _ ws: Workspace) {
    for r in 0..<5 {
      let base = r * 64
      for k in 0..<64 {
        let idx = 5 * k + r
        ws.subRe[base + k] = re[idx]
        ws.subIm[base + k] = im[idx]
      }
      run64(&ws.subRe, &ws.subIm, base: base)
      if r > 0 {
        for p in 1..<64 {
          let ti = base + p
          let wr = twCos[ti]
          let wi = twSin[ti]
          let zr = ws.subRe[ti] * wr - ws.subIm[ti] * wi
          let zi = ws.subRe[ti] * wi + ws.subIm[ti] * wr
          ws.subRe[ti] = zr
          ws.subIm[ti] = zi
        }
      }
    }
    for p in 0..<64 {
      let r0 = ws.subRe[p], i0 = ws.subIm[p]
      let r1 = ws.subRe[64 + p], i1 = ws.subIm[64 + p]
      let r2 = ws.subRe[128 + p], i2 = ws.subIm[128 + p]
      let r3 = ws.subRe[192 + p], i3 = ws.subIm[192 + p]
      let r4 = ws.subRe[256 + p], i4 = ws.subIm[256 + p]

      let sr14 = r1 + r4, si14 = i1 + i4
      let dr14 = r1 - r4, di14 = i1 - i4
      let sr23 = r2 + r3, si23 = i2 + i3
      let dr23 = r2 - r3, di23 = i2 - i3

      re[p] = r0 + sr14 + sr23
      im[p] = i0 + si14 + si23

      let tr1 = r0 + c1 * sr14 + c2 * sr23
      let ti1 = i0 + c1 * si14 + c2 * si23
      let ur1 = s1 * di14 + s2 * di23
      let ui1 = -s1 * dr14 - s2 * dr23
      re[p + 64] = tr1 + ur1
      im[p + 64] = ti1 + ui1
      re[p + 256] = tr1 - ur1
      im[p + 256] = ti1 - ui1

      let tr2 = r0 + c2 * sr14 + c1 * sr23
      let ti2 = i0 + c2 * si14 + c1 * si23
      let ur2 = s2 * di14 - s1 * di23
      let ui2 = -s2 * dr14 + s1 * dr23
      re[p + 128] = tr2 + ur2
      im[p + 128] = ti2 + ui2
      re[p + 192] = tr2 - ur2
      im[p + 192] = ti2 - ui2
    }
  }
}

/// In-place iterative radix-2 complex FFT of size 512 for Kaldi fbank.
enum Fft512 {
  static let n = 512
  private static let rev: [Int] = {
    var r = [Int](repeating: 0, count: 512)
    var j = 0
    for i in 0..<512 {
      r[i] = j
      var bit = 256
      while (j & bit) != 0 {
        j ^= bit
        bit >>= 1
      }
      j |= bit
    }
    return r
  }()
  private static let cosT: [Double] = (0..<256).map { cos(2 * Double.pi * Double($0) / 512.0) }
  private static let sinT: [Double] = (0..<256).map { -sin(2 * Double.pi * Double($0) / 512.0) }

  static func run(_ re: inout [Double], _ im: inout [Double]) {
    for i in 0..<n {
      let j = rev[i]
      if j > i {
        re.swapAt(i, j)
        im.swapAt(i, j)
      }
    }
    var size = 2
    while size <= n {
      let half = size >> 1
      let step = n / size
      var s = 0
      while s < n {
        for k in 0..<half {
          let wr = cosT[k * step]
          let wi = sinT[k * step]
          let a = s + k
          let b = a + half
          let xr = re[b] * wr - im[b] * wi
          let xi = re[b] * wi + im[b] * wr
          re[b] = re[a] - xr
          im[b] = im[a] - xi
          re[a] += xr
          im[a] += xi
        }
        s += size
      }
      size <<= 1
    }
  }
}

/// Kaldi-compatible 80-dim log-mel filterbank matching kaldi-native-fbank / Dsp.kt.
/// Scales input samples to PCM16 range before `FLT_EPS` energy floor so soft speech never clips.
enum Fbank {
  static let bins = 80
  private static let flen = 400
  private static let shift = 160
  private static let nfft = 512
  private static let fltEps = 1.1920928955078125e-7
  private static let pcm16Scale = 32768.0

  final class Workspace {
    var re = [Double](repeating: 0, count: Fbank.nfft)
    var im = [Double](repeating: 0, count: Fbank.nfft)
    var win = [Double](repeating: 0, count: Fbank.flen)
  }

  private static let povey: [Double] = (0..<400).map {
    pow(0.5 - 0.5 * cos(2 * Double.pi * Double($0) / 399.0), 0.85)
  }

  private static func mel(_ f: Double) -> Double { 1127.0 * log(1.0 + f / 700.0) }

  private static let bank: [(first: Int, weights: [Double])] = {
    let width = Double(voiceRate) / Double(nfft)
    let lo = mel(20.0)
    let hi = mel(Double(voiceRate) / 2.0 - 400.0)
    let delta = (hi - lo) / Double(bins + 1)
    var out: [(Int, [Double])] = []
    for b in 0..<bins {
      let l = lo + Double(b) * delta
      let c = lo + Double(b + 1) * delta
      let r = lo + Double(b + 2) * delta
      var first = -1
      var w: [Double] = []
      for i in 0..<(nfft / 2) {
        let m = mel(width * Double(i))
        if m > l && m < r {
          if first < 0 { first = i }
          w.append(m <= c ? (m - l) / (c - l) : (r - m) / (r - c))
        }
      }
      out.append((first, w))
    }
    return out
  }()

  static func frames(_ len: Int) -> Int { (len + shift / 2) / shift }

  static func compute(_ wave: [Float], off: Int = 0, len: Int? = nil, ws: Workspace = Workspace()) -> [Float] {
    let nSamples = len ?? (wave.count - off)
    if nSamples <= 0 { return [Float](repeating: 0, count: bins) }
    let nFrames = max(1, frames(nSamples))
    var feats = [Float](repeating: 0, count: nFrames * bins)
    for f in 0..<nFrames {
      let start = f * shift + shift / 2 - flen / 2
      var mean = 0.0
      for i in 0..<flen {
        var s = start + i
        while s < 0 || s >= nSamples {
          s = s < 0 ? -s - 1 : 2 * nSamples - 1 - s
        }
        ws.win[i] = Double(wave[off + s]) * pcm16Scale
        mean += ws.win[i]
      }
      mean /= Double(flen)
      for i in 0..<flen { ws.win[i] -= mean }
      for i in stride(from: flen - 1, through: 1, by: -1) { ws.win[i] -= 0.97 * ws.win[i - 1] }
      ws.win[0] -= 0.97 * ws.win[0]
      for i in 0..<flen { ws.re[i] = ws.win[i] * povey[i] }
      for i in flen..<nfft { ws.re[i] = 0 }
      for i in 0..<nfft { ws.im[i] = 0 }
      Fft512.run(&ws.re, &ws.im)
      for b in 0..<bins {
        let (first, w) = bank[b]
        var e = 0.0
        for k in 0..<w.count {
          let i = first + k
          e += w[k] * (ws.re[i] * ws.re[i] + ws.im[i] * ws.im[i])
        }
        feats[f * bins + b] = Float(log(max(e, fltEps)))
      }
    }
    if nFrames > 0 {
      for b in 0..<bins {
        var m = 0.0
        for f in 0..<nFrames { m += Double(feats[f * bins + b]) }
        m /= Double(nFrames)
        for f in 0..<nFrames { feats[f * bins + b] = Float(Double(feats[f * bins + b]) - m) }
      }
    }
    return feats
  }
}

/// 1-pole ~64 Hz high-pass filter removing DC offset, wind, and handling rumble.
final class HighPass64 {
  private var x1: Float = 0
  private var y1: Float = 0

  func reset() {
    x1 = 0
    y1 = 0
  }

  func process(_ src: [Float], srcOff: Int = 0, dst: inout [Float], dstOff: Int = 0, count: Int) {
    var px = x1
    var py = y1
    for i in 0..<count {
      let x = src[srcOff + i]
      let y = 0.975 * (py + x - px)
      px = x
      py = y
      dst[dstOff + i] = y
    }
    x1 = px
    y1 = py
  }
}

/// Tracks residual noise floor to lift soft speech ONLY on a temporary Silero VAD probe buffer.
final class QuietVadBoost {
  private var noiseRms: Float = 0.002

  func reset() {
    noiseRms = 0.002
  }

  func prepare(_ src: [Float], into dst: inout [Float]) {
    var sum = 0.0
    for v in src { sum += Double(v) * Double(v) }
    let rms = Float((sum / Double(src.count)).squareRoot())
    if rms < noiseRms {
      noiseRms = 0.88 * noiseRms + 0.12 * rms
    } else if rms < noiseRms * 1.8 {
      noiseRms = 0.992 * noiseRms + 0.008 * rms
    }
    noiseRms = min(0.012, max(0.0003, noiseRms))
    let gain: Float = (rms > max(0.0015, noiseRms * 2.5) && rms < 0.03) ? min(4.0, 0.04 / rms) : 1.0
    if gain == 1.0 {
      for i in 0..<src.count { dst[i] = src[i] }
    } else {
      for i in 0..<src.count { dst[i] = src[i] * gain }
    }
  }
}

/// Gentle vocal presence clarity + smooth noise-gated leveler + soft limiter applied ONLY to outbound call audio.
final class VocalEnhancer {
  private var noiseRms: Float = 0.002
  private(set) var lastGain: Float = 1.0
  private var prevX: Float = 0

  func reset() {
    noiseRms = 0.002
    lastGain = 1.0
    prevX = 0
  }

  func relaxSilence() {
    lastGain = 0.94 * lastGain + 0.06
    prevX = 0
  }

  func process(_ src: [Float], into dst: inout [Float]) {
    var sum = 0.0
    var peak: Float = 0
    for v in src {
      sum += Double(v) * Double(v)
      let av = abs(v)
      if av > peak { peak = av }
    }
    let rms = Float((sum / Double(max(1, src.count))).squareRoot())
    if rms < noiseRms {
      noiseRms = 0.88 * noiseRms + 0.12 * rms
    } else if rms < noiseRms * 1.8 {
      noiseRms = 0.992 * noiseRms + 0.008 * rms
    }
    noiseRms = min(0.012, max(0.0004, noiseRms))

    let activeSpeech = rms > max(0.002, noiseRms * 2.2)
    var want: Float = activeSpeech ? min(3.5, max(1.0, 0.11 / max(rms, 0.002))) : 1.0
    if peak > 1e-4 { want = min(want, max(1.0, 0.85 / peak)) }

    if want < lastGain {
      lastGain = 0.45 * lastGain + 0.55 * want
    } else if want > lastGain && want > 1.05 {
      lastGain = 0.72 * lastGain + 0.28 * want
    } else {
      lastGain = 0.94 * lastGain + 0.06 * want
    }

    let presence: Float = activeSpeech ? 0.08 : 0.0
    var px = prevX
    let g = lastGain
    for i in 0..<src.count {
      let cur = src[i]
      let shaped = cur + presence * (cur - px)
      px = cur
      let x = shaped * g
      let ax = abs(x)
      if ax <= 0.88 {
        dst[i] = x
      } else {
        let sign: Float = x >= 0 ? 1 : -1
        dst[i] = sign * (0.88 + 0.11 * Float(tanh(Double(ax - 0.88) / 0.11)))
      }
    }
    prevX = px
  }
}

struct SvScore {
  let raw: Float
  let proto: Float
  let blended: Float
}

func scoreVoiceprint(_ normEmb: [Float], centroid: [Float], prototypes: [[Float]]) -> SvScore {
  let raw = cosine(normEmb, centroid)
  guard !prototypes.isEmpty else {
    return SvScore(raw: raw, proto: raw, blended: raw)
  }
  var best: Float = -1
  for p in prototypes {
    let c = cosine(normEmb, p)
    if c > best { best = c }
  }
  let blended = 0.65 * raw + 0.35 * best
  return SvScore(raw: raw, proto: best, blended: blended)
}

/// Selects up to `maxCount` diverse L2-normalized prototypes from outlier-filtered enrollment segments.
func selectPrototypes(_ kept: [[Float]], centroid: [Float], maxCount: Int = 6) -> [[Float]] {
  if kept.isEmpty { return [] }
  let normed = kept.map { normalizeEmbedding($0) }
  if normed.count <= maxCount { return normed }
  var chosen: [Int] = []
  var bestFirst = 0
  var bestFirstCos: Float = -2
  for i in 0..<normed.count {
    let c = cosine(normed[i], centroid)
    if c > bestFirstCos {
      bestFirstCos = c
      bestFirst = i
    }
  }
  chosen.append(bestFirst)
  while chosen.count < maxCount {
    var nextIdx = -1
    var lowestMaxSim: Float = 2
    for i in 0..<normed.count where !chosen.contains(i) {
      var maxSim: Float = -2
      for cIdx in chosen {
        let sim = cosine(normed[i], normed[cIdx])
        if sim > maxSim { maxSim = sim }
      }
      if maxSim < lowestMaxSim {
        lowestMaxSim = maxSim
        nextIdx = i
      }
    }
    if nextIdx < 0 { break }
    chosen.append(nextIdx)
  }
  return chosen.map { normed[$0] }
}

func cosine(_ a: [Float], _ b: [Float]) -> Float {
  var d = 0.0, na = 0.0, nb = 0.0
  for i in 0..<min(a.count, b.count) {
    let x = Double(a[i]), y = Double(b[i])
    d += x * y; na += x * x; nb += y * y
  }
  return na == 0 || nb == 0 ? 0 : Float(d / sqrt(na * nb))
}

func normalizeEmbedding(_ e: [Float]) -> [Float] {
  var n = 0.0
  for v in e { n += Double(v) * Double(v) }
  let s = sqrt(n)
  if s == 0 { return e }
  return e.map { Float(Double($0) / s) }
}

func meanEmbedding(_ list: [[Float]]) -> [Float] {
  guard let first = list.first else { return [] }
  var out = [Float](repeating: 0, count: first.count)
  let count = Double(list.count)
  for e in list {
    var n = 0.0
    for v in e { n += Double(v) * Double(v) }
    let s = sqrt(n)
    if s == 0 { continue }
    for i in 0..<e.count { out[i] += Float(Double(e[i]) / s / count) }
  }
  return normalizeEmbedding(out)
}

func rmsSamples(_ x: [Float], off: Int = 0, count: Int? = nil) -> Float {
  let n = count ?? (x.count - off)
  if n <= 0 { return 0 }
  var sum = 0.0
  for i in 0..<n {
    let v = Double(x[off + i])
    sum += v * v
  }
  return Float((sum / Double(n)).squareRoot())
}

func dbfsFromRms(_ rmsVal: Float) -> Double {
  let clamped = max(Double(rmsVal), 1e-5)
  return finiteDouble(20.0 * log10(clamped), digits: 1)
}

func finiteDouble(_ v: Double, digits: Int = 3) -> Double {
  guard v.isFinite else { return 0.0 }
  var scale = 1.0
  for _ in 0..<max(0, digits) { scale *= 10.0 }
  return (v * scale).rounded() / scale
}

func pcm16ToFloat(_ pcm: Data, out: inout [Float], outOff: Int) {
  let n = pcm.count / 2
  pcm.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
    for i in 0..<n {
      let s = Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self))
      out[outOff + i] = Float(s) / 32768.0
    }
  }
}

func floatToPcm16(_ x: [Float], count: Int) -> Data {
  var data = Data(count: count * 2)
  data.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) in
    for i in 0..<count {
      let scaled = (x[i] * 32768.0).rounded()
      let clamped = Int16(max(-32768.0, min(32767.0, scaled)))
      var le = clamped.littleEndian
      withUnsafeBytes(of: &le) { src in
        raw.baseAddress!.advanced(by: i * 2).copyMemory(from: src.baseAddress!, byteCount: 2)
      }
    }
  }
  return data
}
