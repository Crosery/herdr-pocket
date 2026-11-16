import Foundation

/// Events for the JS side, delivered while the app's module is alive (same as Prefs.kt's PocketBus).
enum PocketBus {
  private static let lock = NSLock()
  private static var _listener: ((String, [String: Any?]) -> Void)?

  static var listener: ((String, [String: Any?]) -> Void)? {
    get { lock.lock(); defer { lock.unlock() }; return _listener }
    set { lock.lock(); _listener = newValue; lock.unlock() }
  }

  static func emit(_ name: String, _ body: [String: Any?]) {
    listener?(name, body)
  }
}

/// http(s)://host -> ws(s)://host + path, like wsUrl in Prefs.kt.
func wsUrl(_ server: String, _ path: String) -> URL? {
  var base = server
  while base.hasSuffix("/") { base.removeLast() }
  let lower = base.lowercased()
  if lower.hasPrefix("https://") {
    base = "wss://" + base.dropFirst(8)
  } else if lower.hasPrefix("http://") {
    base = "ws://" + base.dropFirst(7)
  }
  return URL(string: base + path)
}

/// Monotonic milliseconds, for audio timing (SystemClock.elapsedRealtime on Android).
func monoMs() -> Int64 {
  Int64(DispatchTime.now().uptimeNanoseconds / 1_000_000)
}

/// Wall-clock milliseconds, for notice timestamps.
func wallMs() -> Int64 {
  Int64(Date().timeIntervalSince1970 * 1000)
}

func jsonString(_ object: [String: Any]) -> String? {
  guard JSONSerialization.isValidJSONObject(object), let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
  return String(data: data, encoding: .utf8)
}

/// Loudness 0..1 of little-endian PCM16, the same scale as rms() in VoiceCall.kt.
func pcmLevel(_ data: Data) -> Float {
  let n = data.count / 2
  if n == 0 { return 0 }
  var sum = 0.0
  data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
    for i in 0..<n {
      let s = Double(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self)))
      sum += s * s
    }
  }
  return Float(min(1.0, (sum / Double(n)).squareRoot() / 32768.0 * 4))
}
