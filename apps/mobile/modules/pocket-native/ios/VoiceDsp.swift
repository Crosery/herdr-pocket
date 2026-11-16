import Foundation

let voiceRate = 16_000

/// In-place iterative radix-2 complex FFT of size 512, shared by GTCRN STFT and Kaldi fbank.
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

/// Kaldi-compatible log-mel filterbank matching kaldi-native-fbank / Dsp.kt.
enum Fbank {
  static let bins = 80
  private static let flen = 400
  private static let shift = 160
  private static let nfft = 512
  private static let fltEps = 1.1920928955078125e-7

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

  static func compute(_ wave: [Float], off: Int = 0, len: Int? = nil) -> [Float] {
    let nSamples = len ?? (wave.count - off)
    let nFrames = frames(nSamples)
    var feats = [Float](repeating: 0, count: nFrames * bins)
    var re = [Double](repeating: 0, count: nfft)
    var im = [Double](repeating: 0, count: nfft)
    var win = [Double](repeating: 0, count: flen)
    for f in 0..<nFrames {
      let start = f * shift + shift / 2 - flen / 2
      var mean = 0.0
      for i in 0..<flen {
        var s = start + i
        while s < 0 || s >= nSamples {
          s = s < 0 ? -s - 1 : 2 * nSamples - 1 - s
        }
        win[i] = Double(wave[off + s])
        mean += win[i]
      }
      mean /= Double(flen)
      for i in 0..<flen { win[i] -= mean }
      for i in stride(from: flen - 1, through: 1, by: -1) { win[i] -= 0.97 * win[i - 1] }
      win[0] -= 0.97 * win[0]
      for i in 0..<flen { re[i] = win[i] * povey[i] }
      for i in flen..<nfft { re[i] = 0 }
      for i in 0..<nfft { im[i] = 0 }
      Fft512.run(&re, &im)
      for b in 0..<bins {
        let (first, w) = bank[b]
        var e = 0.0
        for k in 0..<w.count {
          let i = first + k
          e += w[k] * (re[i] * re[i] + im[i] * im[i])
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

func cosine(_ a: [Float], _ b: [Float]) -> Float {
  var d = 0.0, na = 0.0, nb = 0.0
  for i in 0..<min(a.count, b.count) {
    let x = Double(a[i]), y = Double(b[i])
    d += x * y; na += x * x; nb += y * y
  }
  return na == 0 || nb == 0 ? 0 : Float(d / sqrt(na * nb))
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
  return out
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
