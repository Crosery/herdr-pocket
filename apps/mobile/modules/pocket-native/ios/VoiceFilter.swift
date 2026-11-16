import Foundation

/// Swift counterpart to VoiceFilter.kt: GTCRN denoise -> Silero VAD -> CAM++ owner voiceprint gate.
final class VoiceFilter {
  struct Options {
    let denoise: Bool
    let enrolled: [Float]?
    let threshold: Float
    var early: Float { threshold + 0.10 }
    var short: Float { threshold + 0.07 }
    init(denoise: Bool, enrolled: [Float]?, threshold: Float = 0.38) {
      self.denoise = denoise
      self.enrolled = enrolled
      self.threshold = threshold
    }
  }

  private final class Chunk {
    let a: [Float]
    var prob: Float = 0
    init(_ a: [Float]) { self.a = a }
  }

  private enum State { case idle, hold, open, blocked }
  private enum Kind: String { case early, full, end, recheck }
  private struct Verdict { let job: Int; let score: Float; let ms: Int64 }

  private static let hop = Denoiser.hop
  private static let wMs = 32
  private static func windows(_ ms: Int) -> Int { (ms + wMs - 1) / wMs }
  private static func hops(_ ms: Int) -> Int { (ms * voiceRate / 1000 + hop - 1) / hop }

  private static let startProb: Float = 0.5
  private static let speechProb: Float = 0.35
  private static let startW = windows(96)
  private static let endW = windows(500)
  private static let earlyW = windows(500)
  private static let fullW = windows(1000)
  private static let shortW = windows(300)
  private static let openRecheckW = windows(1500)
  private static let trustedRecheckW = windows(500)
  private static let blockedRecheckW = windows(500)
  private static let preRoll = hops(300)
  private static let recentMax = hops(1000)
  private static let minSpeech = hops(250)
  private static let trust = hops(1000)
  private static let maxHold = hops(4000)
  private static let repayAfter = hops(300)
  private static let sendMax = 3200

  private let m: VoiceModels
  private let o: Options
  private let worker: (@escaping () -> Void) -> Void
  private let emit: (Data) -> Void
  private let onVerdict: (Bool, Float, String) -> Void

  private let gate: Bool
  private let denoiser: Denoiser?
  private let vad: Vad?
  private let speaker: Speaker?

  private var inBuf = [Float](repeating: 0, count: hop * 4)
  private var inLen = 0
  private var windowChunk: Chunk?
  private var winBuf = [Float](repeating: 0, count: Vad.window)
  private var outFloats = [Float]()

  private var state: State = .idle
  private var t: Int64 = 0
  private var ring: [Chunk] = []
  private var held: [Chunk] = []
  private var heldPre = 0
  private var holdStart: Int64 = 0
  private var recent: [Chunk] = []
  private var speaking = false
  private var startRun = 0
  private var silRun = 0
  private var speechW = 0
  private var sinceCheckW = 0
  private var recheckW = openRecheckW
  private var trusted = false
  private var earlyTried = false
  private var fullTried = false
  private var lastOwner: Int64 = Int64.min / 2
  private var idleHops = 0
  private var debt = 0

  private var jobSeq = 0
  private var job = 0
  private var jobKind: Kind = .full
  private var jobSpeechW = 0
  private let verdictLock = NSLock()
  private var verdicts: [Verdict] = []

  private(set) var hopsIn: Int64 = 0
  private(set) var denoiseNs: Int64 = 0
  private(set) var denoiseMaxNs: Int64 = 0
  private(set) var checks = 0
  private(set) var checkMsMax: Int64 = 0
  private(set) var checkMsSum: Int64 = 0
  private(set) var passed = 0
  private(set) var blocked = 0
  private(set) var holdMsMax: Int64 = 0
  private(set) var holdMsSum: Int64 = 0
  private(set) var holds = 0

  init(
    _ m: VoiceModels,
    _ o: Options,
    worker: @escaping (@escaping () -> Void) -> Void,
    emit: @escaping (Data) -> Void,
    onVerdict: @escaping (Bool, Float, String) -> Void = { _, _, _ in }
  ) {
    self.m = m
    self.o = o
    self.worker = worker
    self.emit = emit
    self.onVerdict = onVerdict
    self.gate = o.enrolled != nil && m.speaker != nil
    self.denoiser = o.denoise ? Denoiser(m) : nil
    self.vad = self.gate ? Vad(m) : nil
    self.speaker = self.gate ? (try? Speaker(m)) : nil
  }

  func reset() {
    denoiser?.reset()
    vad?.reset()
    inLen = 0
    windowChunk = nil
    state = .idle
    ring.removeAll(keepingCapacity: true)
    held.removeAll(keepingCapacity: true)
    recent.removeAll(keepingCapacity: true)
    heldPre = 0
    speaking = false
    startRun = 0
    silRun = 0
    speechW = 0
    sinceCheckW = 0
    job = 0
    verdictLock.lock()
    verdicts.removeAll()
    verdictLock.unlock()
    idleHops = 0
    debt = 0
  }

  func push(_ pcm: Data) {
    let totalSamples = pcm.count / 2
    var i = 0
    while i < totalSamples {
      let n = min(totalSamples - i, Self.hop - inLen)
      let sub = pcm.subdata(in: (i * 2) ..< ((i + n) * 2))
      pcm16ToFloat(sub, out: &inBuf, outOff: inLen)
      inLen += n
      i += n
      if inLen == Self.hop {
        inLen = 0
        hop()
      }
    }
    flushOut()
  }

  private func hop() {
    hopsIn += 1
    var a = [Float](repeating: 0, count: Self.hop)
    if let d = denoiser {
      let t0 = DispatchTime.now().uptimeNanoseconds
      let ok = (try? d.hop(inBuf, off: 0, out: &a, outOff: 0)) ?? false
      let ns = Int64(DispatchTime.now().uptimeNanoseconds - t0)
      denoiseNs += ns
      if ns > denoiseMaxNs { denoiseMaxNs = ns }
      if !ok { return }
    } else {
      a.replaceSubrange(0..<Self.hop, with: inBuf[0..<Self.hop])
    }
    if !gate {
      send(a)
      return
    }
    t += 1
    take()
    let c = Chunk(a)
    place(c)
    guard let w = windowChunk else {
      windowChunk = c
      return
    }
    windowChunk = nil
    for i in 0..<Self.hop {
      winBuf[i] = w.a[i]
      winBuf[Self.hop + i] = c.a[i]
    }
    let p = (try? vad?.prob(winBuf)) ?? 0
    w.prob = p
    c.prob = p
    onWindow(p)
    take()
  }

  private func place(_ c: Chunk) {
    switch state {
    case .idle:
      ring.append(c)
      if ring.count > Self.preRoll { ring.removeFirst() }
      idleHops += 1
      if debt > 0 && idleHops >= Self.repayAfter && t % 2 == 0 {
        debt -= 1
      } else {
        send(nil)
      }
    case .hold:
      held.append(c)
      keep(c)
      if held.count - heldPre >= Self.maxHold {
        job = 0
        reject()
      }
    case .blocked:
      held.append(c)
      keep(c)
      if held.count >= Self.maxHold {
        job = 0
        flushHeld(false)
      }
    case .open:
      send(c.a)
      keep(c)
    }
  }

  private func keep(_ c: Chunk) {
    recent.append(c)
    if recent.count > Self.recentMax { recent.removeFirst() }
  }

  private func onWindow(_ p: Float) {
    var started = false
    var ended = false
    if !speaking {
      startRun = p >= Self.startProb ? startRun + 1 : 0
      if startRun >= Self.startW {
        speaking = true
        silRun = 0
        started = true
      }
    } else {
      silRun = p < Self.speechProb ? silRun + 1 : 0
      if silRun >= Self.endW {
        speaking = false
        startRun = 0
        ended = true
      }
    }
    if p >= Self.speechProb {
      speechW += 1
      sinceCheckW += 1
    }
    if started { onStart() }
    switch state {
    case .idle:
      break
    case .hold:
      if job != 0 { return }
      if !speaking {
        if speechW >= Self.shortW { check(.end, held) } else { reject() }
      } else if speechW >= Self.fullW && !fullTried {
        fullTried = true
        check(.full, held)
      } else if speechW >= Self.earlyW && !earlyTried {
        earlyTried = true
        check(.early, held)
      }
    case .open:
      if ended {
        lastOwner = t
        toIdle()
      } else if job == 0 && sinceCheckW >= recheckW {
        check(.recheck, recent)
      }
    case .blocked:
      if job != 0 { return }
      if ended {
        if sinceCheckW > 0 { check(.end, recent) } else { flushHeld(false); toIdle() }
      } else if sinceCheckW >= Self.blockedRecheckW {
        check(.recheck, recent)
      }
    }
  }

  private func onStart() {
    if state != .idle { return }
    speechW = 0
    sinceCheckW = 0
    earlyTried = false
    fullTried = false
    if t - lastOwner <= Self.trust {
      recent = ring
      flushRing(true)
      state = .open
      recheckW = Self.trustedRecheckW
      trusted = true
      return
    }
    recent = ring
    held = ring
    heldPre = ring.count
    ring.removeAll(keepingCapacity: true)
    holdStart = t
    state = .hold
  }

  private func check(_ kind: Kind, _ chunks: [Chunk]) {
    guard let enrolled = o.enrolled, let sp = speaker else { return }
    let voiced = chunks.filter { $0.prob >= Self.speechProb }
    let speech = voiced.count >= Self.minSpeech ? voiced : chunks
    var x = [Float]()
    x.reserveCapacity(speech.count * Self.hop)
    for c in speech { x.append(contentsOf: c.a) }
    let id = jobSeq + 1
    jobSeq = id
    job = id
    jobKind = kind
    jobSpeechW = (kind == .recheck || state == .blocked) ? sinceCheckW : speechW
    sinceCheckW = 0
    worker { [weak self] in
      let t0 = DispatchTime.now().uptimeNanoseconds
      let score: Float
      do {
        score = cosine(try sp.embed(x), enrolled)
      } catch {
        score = -1
      }
      let ms = Int64((DispatchTime.now().uptimeNanoseconds - t0) / 1_000_000)
      guard let self else { return }
      self.verdictLock.lock()
      self.verdicts.append(Verdict(job: id, score: score, ms: ms))
      self.verdictLock.unlock()
    }
  }

  private func take() {
    verdictLock.lock()
    let pending = verdicts
    verdicts.removeAll(keepingCapacity: true)
    verdictLock.unlock()
    var v: Verdict?
    for item in pending where item.job == job { v = item }
    guard let v else { return }
    job = 0
    checks += 1
    checkMsSum += v.ms
    if v.ms > checkMsMax { checkMsMax = v.ms }
    let s = v.score
    switch state {
    case .hold:
      let pass: Bool?
      switch jobKind {
      case .early: pass = s >= o.early ? true : nil
      case .full: pass = s >= o.threshold
      default: pass = s >= (jobSpeechW >= Self.earlyW ? o.threshold : o.short)
      }
      if let pass {
        onVerdict(pass, s, jobKind.rawValue)
        if pass { accept() } else { reject() }
      }
    case .open:
      if s < o.threshold - (trusted ? 0 : 0.05) {
        onVerdict(false, s, trusted ? "trusted" : "recheck")
        blocked += 1
        state = .blocked
        held.removeAll(keepingCapacity: true)
        heldPre = 0
      } else {
        lastOwner = t
        recheckW = Self.openRecheckW
      }
      trusted = false
    case .blocked:
      if s >= o.threshold {
        onVerdict(true, s, "recheck")
        passed += 1
        flushHeld(true)
        lastOwner = t
        if speaking { state = .open; recheckW = Self.openRecheckW; trusted = false } else { toIdle() }
      } else {
        flushHeld(false)
        if !speaking { toIdle() }
      }
    case .idle:
      break
    }
  }

  private func accept() {
    passed += 1
    noteHold()
    flushHeld(true)
    lastOwner = t
    if speaking {
      state = .open
      recheckW = Self.openRecheckW
      trusted = false
    } else {
      toIdle()
    }
  }

  private func reject() {
    blocked += 1
    noteHold()
    flushHeld(false)
    if speaking { state = .blocked } else { toIdle() }
  }

  private func noteHold() {
    let ms = (t - holdStart) * Int64(Self.hop) * 1000 / Int64(voiceRate)
    holds += 1
    holdMsSum += ms
    if ms > holdMsMax { holdMsMax = ms }
  }

  private func flushHeld(_ audio: Bool) {
    if audio {
      for c in held { send(c.a) }
      debt += heldPre
    } else {
      for i in heldPre..<held.count {
        if debt > 0 && i % 2 == 0 { debt -= 1 } else { send(nil) }
      }
    }
    held.removeAll(keepingCapacity: true)
    heldPre = 0
  }

  private func flushRing(_ audio: Bool) {
    if audio {
      for c in ring { send(c.a) }
      debt += ring.count
    }
    ring.removeAll(keepingCapacity: true)
  }

  private func toIdle() {
    state = .idle
    job = 0
    idleHops = 0
    held.removeAll(keepingCapacity: true)
    heldPre = 0
    recent.removeAll(keepingCapacity: true)
  }

  private func send(_ a: [Float]?) {
    if let a {
      outFloats.append(contentsOf: a)
    } else {
      outFloats.append(contentsOf: repeatElement(Float(0), count: Self.hop))
    }
  }

  private func flushOut() {
    guard !outFloats.isEmpty else { return }
    let data = floatToPcm16(outFloats, count: outFloats.count)
    outFloats.removeAll(keepingCapacity: true)
    var off = 0
    while off < data.count {
      let n = min(Self.sendMax, data.count - off)
      emit(data.subdata(in: off ..< (off + n)))
      off += n
    }
  }
}
