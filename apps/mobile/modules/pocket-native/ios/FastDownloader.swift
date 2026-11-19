import CryptoKit
import Darwin
import Foundation

/// Region-aware, multi-mirror parallel Range downloader for voiceprint models on iOS.
/// Matches `FastDownloader.kt` on Android:
/// 1. Detects mainland China via IANA timezone (including Asia/Beijing) + CN GMT+08 fallback.
/// 2. Expands GitHub URLs with domestic acceleration proxies (excluding dead ghproxy.net) and
///    orders mirrors first in China (origin first elsewhere).
/// 3. Concurrently probes up to 5 mirrors with a 64 KiB Range request (3.5 s timeout).
/// 4. Stripes 2 MiB chunks across up to 6 concurrent workers into a pre-allocated `.part` file
///    via POSIX `pwrite`, falling back to single-stream download, then verifies size and SHA-256.
enum FastDownloader {
  struct ProbedSource {
    let url: String
    let bytesPerSec: Double
    let supportsRange: Bool
    let totalSize: Int64
  }

  private struct Chunk {
    let index: Int
    let start: Int64
    let end: Int64
  }

  final class CancelToken: @unchecked Sendable {
    private let lock = NSLock()
    private var _cancelled = false
    private var tasks: [URLSessionTask] = []
    private var sessions: [URLSession] = []

    var cancelled: Bool {
      lock.lock()
      defer { lock.unlock() }
      return _cancelled
    }

    func track(task: URLSessionTask, session: URLSession? = nil) {
      lock.lock()
      let already = _cancelled
      if !already {
        tasks.append(task)
        if let session { sessions.append(session) }
      }
      lock.unlock()
      if already {
        task.cancel()
        session?.invalidateAndCancel()
      }
    }

    func untrack(task: URLSessionTask, session: URLSession? = nil) {
      lock.lock()
      tasks.removeAll { $0 === task }
      if let session { sessions.removeAll { $0 === session } }
      lock.unlock()
    }

    func cancel() {
      lock.lock()
      _cancelled = true
      let t = tasks
      let s = sessions
      tasks.removeAll()
      sessions.removeAll()
      lock.unlock()
      for task in t { task.cancel() }
      for session in s { session.invalidateAndCancel() }
    }
  }

  private static let chinaTimeZones: Set<String> = [
    "Asia/Shanghai",
    "Asia/Beijing",
    "Asia/Chongqing",
    "Asia/Chungking",
    "Asia/Harbin",
    "Asia/Urumqi",
    "Asia/Kashgar",
    "PRC",
  ]

  private static let chinaMirrors: [String] = [
    "https://ghfast.top/",
    "https://gh-proxy.com/",
    "https://cdn.gh-proxy.com/",
    "https://edgeone.gh-proxy.com/",
  ]

  private static let chinaMirrorHosts: Set<String> = [
    "ghfast.top",
    "gh-proxy.com",
    "cdn.gh-proxy.com",
    "edgeone.gh-proxy.com",
    "hf-mirror.com",
  ]

  private static let originHosts: Set<String> = [
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "huggingface.co",
  ]

  private static let deadMirrorHosts: Set<String> = ["ghproxy.net"]

  private static func currentCountryCode() -> String {
    if #available(iOS 16.0, macOS 13.0, *) {
      return Locale.current.region?.identifier ?? ""
    }
    return (Locale.current as NSLocale).object(forKey: .countryCode) as? String ?? ""
  }

  static func isMainlandChina(
    tzId: String = TimeZone.current.identifier,
    rawOffsetSec: Int = TimeZone.current.secondsFromGMT(),
    country: String = currentCountryCode()
  ) -> Bool {
    if chinaTimeZones.contains(tzId) { return true }
    let lower = tzId.lowercased()
    let offsetZone = tzId.isEmpty || lower.hasPrefix("gmt+08") || lower.hasPrefix("utc+08") || lower == "etc/gmt-8"
    return offsetZone && rawOffsetSec == 8 * 3600 && country.caseInsensitiveCompare("CN") == .orderedSame
  }

  static func expandGithubUrls(_ urls: [String], china: Bool = isMainlandChina()) -> [String] {
    var clean: [String] = []
    var githubUrl: String?
    for raw in urls {
      guard let host = hostOf(raw) else { continue }
      if deadMirrorHosts.contains(host) { continue }
      if host == "github.com", githubUrl == nil { githubUrl = raw }
      if !clean.contains(raw) { clean.append(raw) }
    }
    if let githubUrl {
      for prefix in chinaMirrors {
        let candidate = prefix + githubUrl
        if !clean.contains(candidate) { clean.append(candidate) }
      }
    }
    return orderByRegion(clean, china: china)
  }

  static func orderByRegion(_ urls: [String], china: Bool = isMainlandChina()) -> [String] {
    var domestic: [String] = []
    var neutral: [String] = []
    var global: [String] = []
    var seen = Set<String>()
    for raw in urls {
      guard seen.insert(raw).inserted else { continue }
      guard let host = hostOf(raw) else { continue }
      if deadMirrorHosts.contains(host) { continue }
      if chinaMirrorHosts.contains(host) {
        domestic.append(raw)
      } else if originHosts.contains(host) {
        global.append(raw)
      } else {
        neutral.append(raw)
      }
    }
    return china ? (domestic + neutral + global) : (global + neutral + domestic)
  }

  private static func hostOf(_ raw: String) -> String? {
    URL(string: raw)?.host?.lowercased()
  }

  private static func parseContentRangeTotal(_ header: String?) -> Int64 {
    guard let header else { return -1 }
    let trimmed = header.trimmingCharacters(in: .whitespaces)
    guard trimmed.lowercased().hasPrefix("bytes "),
          let slash = trimmed.lastIndex(of: "/") else { return -1 }
    let tail = String(trimmed[trimmed.index(after: slash)...]).trimmingCharacters(in: .whitespaces)
    return Int64(tail) ?? -1
  }

  static func probeSources(
    _ urls: [String],
    token: CancelToken,
    probeBytes: Int = 65_536,
    timeoutSec: TimeInterval = 3.5
  ) -> [ProbedSource] {
    var dedup: [String] = []
    for u in urls where !dedup.contains(u) {
      dedup.append(u)
      if dedup.count >= 5 { break }
    }
    if dedup.isEmpty { return [] }

    let cfg = URLSessionConfiguration.ephemeral
    cfg.timeoutIntervalForRequest = timeoutSec
    cfg.timeoutIntervalForResource = timeoutSec + 1.5
    cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
    let session = URLSession(configuration: cfg)
    defer { session.finishTasksAndInvalidate() }

    let group = DispatchGroup()
    let outLock = NSLock()
    var results: [ProbedSource] = []

    for u in dedup {
      guard let url = URL(string: u), !token.cancelled else { continue }
      group.enter()
      var req = URLRequest(url: url, timeoutInterval: timeoutSec)
      req.setValue("bytes=0-\(probeBytes - 1)", forHTTPHeaderField: "Range")
      req.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
      req.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
      let t0 = DispatchTime.now().uptimeNanoseconds
      var taskRef: URLSessionDataTask?
      let task = session.dataTask(with: req) { data, response, err in
        defer {
          if let t = taskRef { token.untrack(task: t) }
          group.leave()
        }
        if token.cancelled || err != nil { return }
        guard let http = response as? HTTPURLResponse,
              http.statusCode == 206 || http.statusCode == 200,
              let data, !data.isEmpty else { return }
        let supportsRange = http.statusCode == 206
        let contentRange = http.value(forHTTPHeaderField: "Content-Range")
        let totalSize: Int64
        if supportsRange {
          totalSize = parseContentRangeTotal(contentRange)
        } else {
          let lenStr = http.value(forHTTPHeaderField: "Content-Length")
          totalSize = lenStr.flatMap { Int64($0) } ?? -1
        }
        let elapsed = max(0.001, Double(DispatchTime.now().uptimeNanoseconds - t0) / 1_000_000_000.0)
        let probed = ProbedSource(
          url: u,
          bytesPerSec: Double(data.count) / elapsed,
          supportsRange: supportsRange,
          totalSize: totalSize
        )
        outLock.lock()
        results.append(probed)
        outLock.unlock()
      }
      taskRef = task
      token.track(task: task)
      task.resume()
    }

    _ = group.wait(timeout: .now() + timeoutSec + 2.0)
    results.sort { $0.bytesPerSec > $1.bytesPerSec }
    return results
  }

  static func download(
    urls: [String],
    partFile: URL,
    expectedSize: Int64 = -1,
    expectedSha256: String = "",
    token: CancelToken = CancelToken(),
    minParallelBytes: Int64 = 2 * 1024 * 1024,
    chunkBytes: Int64 = 2 * 1024 * 1024,
    maxWorkers: Int = 6,
    china: Bool = isMainlandChina(),
    onProgress: @escaping (Int64, Int64) -> Void = { _, _ in }
  ) throws {
    if token.cancelled { throw cancelledError() }
    let candidates = expandGithubUrls(urls, china: china)
    if candidates.isEmpty {
      throw dlError(code: 1, message: "没有可用的下载地址")
    }

    let probed = probeSources(candidates, token: token)
    if token.cancelled { throw cancelledError() }

    let total: Int64 = expectedSize > 0
      ? expectedSize
      : (probed.first(where: { $0.totalSize > 0 })?.totalSize ?? -1)
    let rangeSources = probed.filter { $0.supportsRange }

    var finished = false
    if total >= minParallelBytes && !rangeSources.isEmpty {
      let topSpeed = rangeSources[0].bytesPerSec
      var pool = rangeSources.filter { $0.bytesPerSec >= topSpeed * 0.30 }.prefix(4).map(\.url)
      if pool.isEmpty { pool = [rangeSources[0].url] }
      var allRangeUrls: [String] = []
      for u in pool + rangeSources.map(\.url) where !allRangeUrls.contains(u) {
        allRangeUrls.append(u)
      }
      finished = downloadParallel(
        poolUrls: pool,
        fallbackUrls: allRangeUrls,
        partFile: partFile,
        totalSize: total,
        chunkBytes: chunkBytes,
        maxWorkers: maxWorkers,
        token: token,
        onProgress: onProgress
      )
    }

    if !finished {
      if token.cancelled { throw cancelledError() }
      var fallbackOrder: [String] = []
      for u in probed.map(\.url) + candidates where !fallbackOrder.contains(u) {
        fallbackOrder.append(u)
      }
      try downloadSingleStream(
        urls: fallbackOrder,
        partFile: partFile,
        expectedSize: total,
        token: token,
        onProgress: onProgress
      )
    }

    if token.cancelled {
      try? FileManager.default.removeItem(at: partFile)
      throw cancelledError()
    }

    let attrs = try FileManager.default.attributesOfItem(atPath: partFile.path)
    let actualSize = (attrs[.size] as? NSNumber)?.int64Value ?? -1
    if expectedSize > 0 && actualSize != expectedSize {
      try? FileManager.default.removeItem(at: partFile)
      throw dlError(code: 4, message: "下载文件大小不完整 (\(actualSize) != \(expectedSize))")
    }
    if !expectedSha256.isEmpty {
      guard let got = sha256(partFile), got == expectedSha256.lowercased() else {
        try? FileManager.default.removeItem(at: partFile)
        throw dlError(code: 5, message: "SHA-256 校验失败，请重试")
      }
    }
  }

  private static func downloadParallel(
    poolUrls: [String],
    fallbackUrls: [String],
    partFile: URL,
    totalSize: Int64,
    chunkBytes: Int64,
    maxWorkers: Int,
    token: CancelToken,
    onProgress: @escaping (Int64, Int64) -> Void
  ) -> Bool {
    try? FileManager.default.removeItem(at: partFile)
    let dir = partFile.deletingLastPathComponent()
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

    let fd = open(partFile.path, O_RDWR | O_CREAT | O_TRUNC, 0o600)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    guard ftruncate(fd, off_t(totalSize)) == 0 else {
      try? FileManager.default.removeItem(at: partFile)
      return false
    }

    var chunks: [Chunk] = []
    var start: Int64 = 0
    var idx = 0
    while start < totalSize {
      let end = min(totalSize - 1, start + chunkBytes - 1)
      chunks.append(Chunk(index: idx, start: start, end: end))
      idx += 1
      start = end + 1
    }

    let queueLock = NSLock()
    var nextChunkIdx = 0
    let stateLock = NSLock()
    var received: Int64 = 0
    var lastReport: Int64 = 0
    var completedCount = 0
    var fatalFailed = false

    func popChunk() -> Chunk? {
      queueLock.lock()
      defer { queueLock.unlock() }
      if nextChunkIdx >= chunks.count { return nil }
      let c = chunks[nextChunkIdx]
      nextChunkIdx += 1
      return c
    }

    func recordWritten(_ delta: Int64) {
      stateLock.lock()
      received += delta
      let shouldEmit = received - lastReport >= 128 * 1024 || received >= totalSize
      if shouldEmit { lastReport = received }
      let cur = min(totalSize, received)
      stateLock.unlock()
      if shouldEmit { onProgress(cur, totalSize) }
    }

    func fetchRangeToFile(urlStr: String, chunk: Chunk, offsetInChunk: Int64) -> Int64 {
      guard let url = URL(string: urlStr), !token.cancelled else { return 0 }
      let reqStart = chunk.start + offsetInChunk
      let expectedLen = chunk.end - reqStart + 1
      if expectedLen <= 0 { return 0 }

      let cfg = URLSessionConfiguration.ephemeral
      cfg.timeoutIntervalForRequest = 15
      cfg.timeoutIntervalForResource = 35
      cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
      let session = URLSession(configuration: cfg)
      defer { session.finishTasksAndInvalidate() }

      let sem = DispatchSemaphore(value: 0)
      var gotData: Data?
      var statusOk = false

      var req = URLRequest(url: url, timeoutInterval: 20)
      req.setValue("bytes=\(reqStart)-\(chunk.end)", forHTTPHeaderField: "Range")
      req.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
      req.setValue("identity", forHTTPHeaderField: "Accept-Encoding")

      var taskRef: URLSessionDataTask?
      let task = session.dataTask(with: req) { data, response, err in
        defer {
          if let t = taskRef { token.untrack(task: t, session: session) }
          sem.signal()
        }
        guard err == nil,
              let http = response as? HTTPURLResponse,
              http.statusCode == 206,
              let data,
              Int64(data.count) <= expectedLen else { return }
        statusOk = true
        gotData = data
      }
      taskRef = task
      token.track(task: task, session: session)
      task.resume()
      _ = sem.wait(timeout: .now() + 36)

      guard statusOk, let data = gotData, !data.isEmpty, !token.cancelled else { return 0 }
      let written = data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Int64 in
        guard let base = raw.baseAddress else { return 0 }
        var writtenTotal = 0
        while writtenTotal < data.count {
          let w = Darwin.pwrite(fd, base.advanced(by: writtenTotal), data.count - writtenTotal, off_t(reqStart + Int64(writtenTotal)))
          if w <= 0 { return -1 }
          writtenTotal += w
        }
        return Int64(writtenTotal)
      }
      if written <= 0 { return -1 }
      recordWritten(written)
      return written
    }

    let workers = min(maxWorkers, chunks.count)
    let group = DispatchGroup()
    for wIdx in 0..<workers {
      group.enter()
      DispatchQueue.global(qos: .userInitiated).async {
        defer { group.leave() }
        let preferred = poolUrls[wIdx % poolUrls.count]
        var tryOrder: [String] = [preferred]
        for u in fallbackUrls where u != preferred { tryOrder.append(u) }

        while !token.cancelled {
          stateLock.lock()
          let abort = fatalFailed
          stateLock.unlock()
          if abort { return }
          guard let chunk = popChunk() else { return }

          let need = chunk.end - chunk.start + 1
          var chunkGot: Int64 = 0
          var urlCursor = 0
          var attempts = 0
          while chunkGot < need && attempts < tryOrder.count * 2 && !token.cancelled {
            let u = tryOrder[urlCursor % tryOrder.count]
            urlCursor += 1
            attempts += 1
            let n = fetchRangeToFile(urlStr: u, chunk: chunk, offsetInChunk: chunkGot)
            if n < 0 {
              stateLock.lock()
              fatalFailed = true
              stateLock.unlock()
              return
            }
            if n > 0 {
              chunkGot += n
            }
          }
          if chunkGot == need {
            stateLock.lock()
            completedCount += 1
            stateLock.unlock()
          } else {
            stateLock.lock()
            fatalFailed = true
            stateLock.unlock()
            return
          }
        }
      }
    }

    group.wait()
    stateLock.lock()
    let ok = !fatalFailed && !token.cancelled && completedCount == chunks.count
    stateLock.unlock()
    if !ok {
      try? FileManager.default.removeItem(at: partFile)
    }
    return ok
  }

  private static func downloadSingleStream(
    urls: [String],
    partFile: URL,
    expectedSize: Int64,
    token: CancelToken,
    onProgress: @escaping (Int64, Int64) -> Void
  ) throws {
    var lastError: Error?
    for u in urls {
      if token.cancelled { throw cancelledError() }
      guard let url = URL(string: u) else { continue }
      try? FileManager.default.removeItem(at: partFile)
      let res = SingleFetch(
        url: url,
        expectedSize: expectedSize,
        partFile: partFile,
        token: token,
        onProgress: onProgress
      ).run()
      switch res {
      case .success:
        return
      case .failure(let err):
        try? FileManager.default.removeItem(at: partFile)
        if token.cancelled || (err as NSError).code == NSURLErrorCancelled {
          throw err
        }
        lastError = err
      }
    }
    throw lastError ?? dlError(code: 3, message: "下载失败")
  }

  private final class SingleFetch: NSObject, URLSessionDownloadDelegate {
    private let url: URL
    private let expectedSize: Int64
    private let partFile: URL
    private let token: CancelToken
    private let onProgress: (Int64, Int64) -> Void
    private let sem = DispatchSemaphore(value: 0)
    private var result: Result<Void, Error> = .failure(NSError(domain: "FastDownloader", code: -1))
    private var lastReport: Int64 = 0
    private var settled = false

    init(
      url: URL,
      expectedSize: Int64,
      partFile: URL,
      token: CancelToken,
      onProgress: @escaping (Int64, Int64) -> Void
    ) {
      self.url = url
      self.expectedSize = expectedSize
      self.partFile = partFile
      self.token = token
      self.onProgress = onProgress
    }

    func run() -> Result<Void, Error> {
      let cfg = URLSessionConfiguration.default
      cfg.timeoutIntervalForRequest = 20
      cfg.timeoutIntervalForResource = 1800
      let s = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
      let task = s.downloadTask(with: url)
      token.track(task: task, session: s)
      task.resume()
      sem.wait()
      token.untrack(task: task, session: s)
      s.finishTasksAndInvalidate()
      return result
    }

    func urlSession(
      _ session: URLSession,
      downloadTask: URLSessionDownloadTask,
      didWriteData bytesWritten: Int64,
      totalBytesWritten: Int64,
      totalBytesExpectedToWrite: Int64
    ) {
      let total = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : expectedSize
      if totalBytesWritten - lastReport >= 128 * 1024 || (total > 0 && totalBytesWritten >= total) {
        lastReport = totalBytesWritten
        onProgress(totalBytesWritten, max(0, total))
      }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
      guard !settled else { return }
      settled = true
      defer { sem.signal() }
      if let http = downloadTask.response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
        result = .failure(dlError(code: http.statusCode, message: "HTTP \(http.statusCode)"))
        return
      }
      do {
        let dir = partFile.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: partFile)
        try FileManager.default.copyItem(at: location, to: partFile)
        result = .success(())
      } catch {
        result = .failure(error)
      }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
      guard !settled else { return }
      if let error {
        settled = true
        result = .failure(error)
        sem.signal()
      }
    }
  }

  static func sha256(_ url: URL) -> String? {
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

  private static func cancelledError() -> NSError {
    NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled, userInfo: [NSLocalizedDescriptionKey: "已取消下载"])
  }

  private static func dlError(code: Int, message: String) -> NSError {
    NSError(domain: "FastDownloader", code: code, userInfo: [NSLocalizedDescriptionKey: message])
  }
}
