import Foundation

/// What the jitter buffer holds: a piece of one reply ("run") of `frames` samples.
protocol PlayoutPiece: AnyObject {
  var run: String { get }
  var frames: Int { get }
}

/// Tuning of the jitter buffer; the same numbers as Playout.kt's companion object.
enum PlayoutTuning {
  /// Audio held back before a reply starts, at least and at most.
  static let minTargetMs = 200.0
  static let maxTargetMs = 400.0
  /// The next reply's target: what the last few replies needed, plus a margin.
  static let historyRuns = 4
  static let marginMs = 20.0
  /// A stall in the middle of a reply raises the target by this much right away.
  static let stepMs = 60.0
  /// After a stall in the middle of a reply, play again once this share of the target is in.
  static let rebufferShare = 0.5
  static let rebufferMinMs = 80.0
  /// Waiting for the target never takes longer than the target plus this.
  static let holdSlackMs = 120.0
}

/**
 * The speaker's jitter buffer, a line-for-line port of the Android Playout.kt:
 * tells the player what to schedule next, or nothing. A reply starts once a
 * cushion of its audio is in (sized from how late the last few replies' audio
 * came); a reply that runs dry waits for a smaller cushion instead of playing
 * scraps, which is what sounds choppy.
 *
 * android/.../Playout.kt and apps/relay/test/voice/playout.ts are the same
 * logic: keep the three in step. Not thread-safe: VoiceCall uses it on its queue.
 * Times are in ms.
 */
final class Playout<T: PlayoutPiece> {
  private let framesPerMs: Int
  private var queue: [T] = []
  private var queued: Int64 = 0
  private var holding = true
  /// Holding after a stall in the middle of a reply, not before one.
  private var rebuffering = false
  private var holdSince: Int64 = -1
  private var playing = ""
  private var finished: [String] = []
  // How late the arriving run's audio is against a steady playout from its first chunk.
  private var arrivingRun = ""
  private var arrivingSince: Int64 = 0
  private var arrivingMs = 0.0
  private var lateMs = 0.0
  private var needed: [Double] = []

  private(set) var targetMs = PlayoutTuning.minTargetMs
  private(set) var maxTargetMs = PlayoutTuning.minTargetMs
  private(set) var stalls = 0

  var queuedMs: Double { Double(queued) / Double(framesPerMs) }

  init(framesPerMs: Int) {
    self.framesPerMs = framesPerMs
  }

  func push(_ p: T, now: Int64) {
    if p.run != arrivingRun {
      if !arrivingRun.isEmpty { learn(lateMs) }
      arrivingRun = p.run
      arrivingSince = now
      arrivingMs = 0
      lateMs = 0
    } else {
      lateMs = max(lateMs, Double(now - arrivingSince) - arrivingMs)
    }
    arrivingMs += Double(p.frames) / Double(framesPerMs)
    queue.append(p)
    queued += Int64(p.frames)
  }

  /// A run's audio has all come: the next target covers what the last few needed.
  private func learn(_ late: Double) {
    needed.append(late)
    if needed.count > PlayoutTuning.historyRuns { needed.removeFirst() }
    targetMs = min(max((needed.max() ?? 0) + PlayoutTuning.marginMs, PlayoutTuning.minTargetMs), PlayoutTuning.maxTargetMs)
    maxTargetMs = max(maxTargetMs, targetMs)
  }

  /// The service has sent all of this run's audio.
  func finish(_ run: String) {
    if finished.contains(run) { return }
    finished.append(run)
    if finished.count > 64 { finished.removeFirst() }
  }

  /// The run was stopped: its queued audio goes.
  func drop(_ run: String) {
    let before = queue.count
    queue.removeAll { $0.run == run }
    if queue.count != before { queued = queue.reduce(0) { $0 + Int64($1.frames) } }
    if playing == run { playing = "" }
    holding = true
    rebuffering = false
    holdSince = -1
  }

  /// Pieces flushed out of the player that still have to be played, back at the front.
  func requeue(_ pieces: [T]) {
    queue.insert(contentsOf: pieces, at: 0)
    for p in pieces { queued += Int64(p.frames) }
  }

  /// What to schedule next, or nil for nothing. `audioFrames`: speech the player holds and has not played yet.
  func take(now: Int64, audioFrames: Int64) -> T? {
    if holding {
      guard let first = queue.first, let last = queue.last else { return nil }
      if holdSince < 0 { holdSince = now }
      let want = rebuffering ? max(PlayoutTuning.rebufferMinMs, targetMs * PlayoutTuning.rebufferShare) : targetMs
      let ready = queuedMs >= want ||
        finished.contains(first.run) ||
        finished.contains(last.run) ||
        Double(now - holdSince) >= want + PlayoutTuning.holdSlackMs
      if !ready { return nil }
      holding = false
      rebuffering = false
      holdSince = -1
    }
    if queue.isEmpty {
      if audioFrames <= 0 {
        // Ran dry in the middle of a reply: wait for a cushion instead of playing scraps.
        let midReply = !playing.isEmpty && !finished.contains(playing)
        if midReply {
          stalls += 1
          targetMs = min(PlayoutTuning.maxTargetMs, targetMs + PlayoutTuning.stepMs)
          maxTargetMs = max(maxTargetMs, targetMs)
        }
        holding = true
        rebuffering = midReply
      }
      return nil
    }
    let p = queue.removeFirst()
    queued -= Int64(p.frames)
    playing = p.run
    return p
  }
}
